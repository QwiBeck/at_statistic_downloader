(() => {
  "use strict";
  const api = globalThis.BookStatsExporter ||= {};
  if (api.restCoreVersion === "1.0.0-beta") return;
  const ORIGIN = "https://author.today";
  const SECTIONS = [
    { key: "general", label: "общая статистика", path: "/report/user-activity-data", includeAuId: true },
    { key: "chapterHits", label: "просмотры по главам", path: "/report/work/stats/data", valueType: "hit", includeAuId: true },
    { key: "chapterTime", label: "время чтения по главам", path: "/report/work/stats/data", valueType: "time", includeAuId: false }
  ];
  let requestQueue = Promise.resolve();
  const verifiedOmissions = new Map();
  const contextKey = (source, id, period) => JSON.stringify([source.username, id, period.from, period.to]);
  function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function checkDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure("INVALID_PERIOD", "Укажи даты в формате ГГГГ-ММ-ДД.");
    const parsed = new Date(value + "T00:00:00.000Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw failure("INVALID_PERIOD", "Укажи существующие календарные даты.");
  }
  api.makePeriod = function makePeriod(from, to) {
    checkDate(from); checkDate(to);
    if (from > to) throw failure("INVALID_PERIOD", "Дата начала периода позже даты окончания.");
    return {
      from, to, timeZone: "Europe/Moscow", utcOffset: "+03:00",
      startDate: new Date(from + "T00:00:00.000+03:00").toISOString(),
      endDate: new Date(to + "T23:59:59.999+03:00").toISOString()
    };
  };
  api.getDefaultDates = function getDefaultDates(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
      timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now).map(part => [part.type, part.value]));
    const to = parts.year + "-" + parts.month + "-" + parts.day;
    const from = new Date(Date.parse(to + "T12:00:00.000Z") - 6 * 86400000).toISOString().slice(0, 10);
    return { from, to };
  };
  function requestUrl(section, id, period, options, source) {
    const url = new URL(section.path, ORIGIN);
    url.searchParams.set("startDate", period.startDate);
    url.searchParams.set("endDate", period.endDate);
    if (section.key === "general") {
      url.searchParams.set("groupBy", "work");
      url.searchParams.set("itemId", id);
    } else {
      url.searchParams.set("workId", id);
      url.searchParams.set("valueType", section.valueType);
    }
    const verified = verifiedOmissions.get(contextKey(source, id, period))?.has(section.key);
    if (options.auIdMode === "empty" || options.auIdMode !== "omit" && !verified && section.includeAuId) url.searchParams.set("auId", "");
    url.searchParams.set("_", String(Date.now()));
    return url.href;
  }
  function notify(callback, message) {
    try { callback?.(message); } catch { /* Progress display must not interrupt data collection. */ }
  }
  function checkPayload(section, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("INVALID_RESPONSE", "Сервер вернул неожиданную структуру JSON.");
    if (body.isSuccessful !== true) {
      const message = body.messages == null ? "" : typeof body.messages === "string" ? body.messages : JSON.stringify(body.messages);
      throw failure("API_ERROR", "API сообщил об ошибке" + (message ? ": " + message.slice(0, 1500) : "."));
    }
    if (section.key === "general" ? !Array.isArray(body.data) :
      !body.data || !Array.isArray(body.data.stats) || typeof body.data.period !== "string") {
      throw failure("INVALID_RESPONSE", "Структура данных отличается от предоставленной модели API.");
    }
  }
  async function collect(id, period, options, source) {
    if (new URL(location.href).origin !== ORIGIN) throw failure("WRONG_ORIGIN", "Открой страницу Author.Today.");
    const report = {
      schemaVersion: "1.0.0",
      application: { ...api.application },
      platform: "author.today",
      source,
      workId: id,
      requestedAt: new Date().toISOString(),
      completedAt: null,
      period,
      complete: false,
      hasWarnings: false,
      responses: { general: null, chapterHits: null, chapterTime: null },
      requests: []
    };
    let stopReason = null;
    for (const [index, section] of SECTIONS.entries()) {
      const request = {
        section: section.key, method: "GET", url: requestUrl(section, id, period, options, source),
        startedAt: null, completedAt: null, httpStatus: null, status: "pending", error: null
      };
      report.requests.push(request);
      if (stopReason || options.signal?.aborted) {
        request.status = "skipped";
        request.error = { code: "SKIPPED", message: stopReason || "Сбор отменён." };
        continue;
      }
      notify(options.onProgress, "Запрос " + (index + 1) + "/3: " + section.label + "…");
      if (options.signal?.aborted) {
        stopReason = "Сбор отменён.";
        request.status = "skipped";
        request.error = { code: "SKIPPED", message: stopReason };
        continue;
      }
      request.startedAt = new Date().toISOString();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs || 30000);
      try {
        const response = await fetch(request.url, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          // Author.Today's native helper adds RequestVerificationToken only
          // to POST. These GET requests use the browser's cookie session.
          headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
          signal: controller.signal
        });
        request.httpStatus = response.status;
        let body;
        try { body = await response.json(); }
        catch (error) {
          if (!response.ok) throw failure("HTTP_ERROR", "HTTP " + response.status + ".");
          if (controller.signal.aborted) throw error;
          throw failure("INVALID_JSON", "Сервер вернул не JSON. Проверь авторизацию и повтори запрос.");
        }
        report.responses[section.key] = body;
        if (!response.ok) throw failure("HTTP_ERROR", "HTTP " + response.status + (response.status === 401 || response.status === 403 ? ": проверь авторизацию." : "."));
        checkPayload(section, body);
        request.status = "success";
      } catch (error) {
        request.status = "error";
        const cancelled = options.signal?.aborted;
        request.error = {
          code: cancelled ? "ABORTED" : timedOut ? "TIMEOUT" : typeof error.code === "string" ? error.code : "NETWORK_ERROR",
          message: cancelled ? "Сбор отменён." : timedOut ? "Сервер не ответил за отведённое время." :
            typeof error.code === "string" ? error.message : "Не удалось выполнить запрос: " + (error.message || "сетевая ошибка") + "."
        };
        if (cancelled || [401, 403, 429].includes(request.httpStatus)) {
          stopReason = request.httpStatus === 429 ? "API ограничил частоту запросов (HTTP 429). Повтори сбор позже." : request.error.message;
        }
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", forwardAbort);
        request.completedAt = new Date().toISOString();
      }
    }
    report.completedAt = new Date().toISOString();
    report.complete = report.requests.every(request => request.status === "success");
    report.hasWarnings = Object.values(report.responses).some(body => body?.isWarning === true);
    return report;
  }
  function prepare(workId, options) {
    const id = String(workId);
    if (!/^\d+$/.test(id)) throw failure("INVALID_WORK_ID", "Некорректный ID произведения.");
    const source = api.getPageContext();
    if (!source) throw failure("WRONG_PAGE", "Открой список редактирования произведений на Author.Today.");
    const period = api.makePeriod(options.from, options.to);
    if (options.auIdMode !== undefined && !["empty", "omit"].includes(options.auIdMode)) throw failure("INVALID_PARAMETER", "auIdMode должен быть empty или omit.");
    return { id, source, period };
  }
  function enqueue(run, options) {
    notify(options.onProgress, "Статистика поставлена в очередь…");
    const task = requestQueue.then(run);
    requestQueue = task.catch(() => {});
    return task;
  }
  api.collectStatistics = function collectStatistics(workId, options = {}) {
    let prepared;
    try { prepared = prepare(workId, options); } catch (error) { return Promise.reject(error); }
    const settings = { ...options };
    return enqueue(() => collect(prepared.id, prepared.period, settings, prepared.source), settings);
  };
  function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  api.verifyAuId = function verifyAuId(workId, options = {}) {
    let prepared;
    try { prepared = prepare(workId, options); } catch (error) { return Promise.reject(error); }
    const { id, period, source } = prepared;
    const settings = { ...options };
    return enqueue(async () => {
      notify(settings.onProgress, "Проверка auId: запросы с пустым параметром…");
      const withEmpty = await collect(id, period, { ...settings, auIdMode: "empty" }, source);
      const blocked = withEmpty.requests.some(request => [401, 403, 429].includes(request.httpStatus)) || settings.signal?.aborted;
      notify(settings.onProgress, blocked ? "Проверка auId не завершена." : "Проверка auId: запросы без параметра…");
      const omitted = blocked ? null : await collect(id, period, { ...settings, auIdMode: "omit" }, source);
      const verified = new Set();
      const checks = SECTIONS.map(section => {
        const first = withEmpty.requests.find(request => request.section === section.key);
        const second = omitted?.requests.find(request => request.section === section.key);
        const comparable = first.status === "success" && second?.status === "success";
        const equivalent = comparable ? canonical(withEmpty.responses[section.key]) === canonical(omitted.responses[section.key]) : null;
        if (equivalent === true) verified.add(section.key);
        return {
          section: section.key, label: section.label,
          withEmptyStatus: first.status, withoutStatus: second?.status || "skipped",
          equivalent, canOmit: equivalent === true ? true : null,
          reason: equivalent === true ? "equivalent" : comparable ? "different_data" : "request_failed"
        };
      });
      const key = contextKey(source, id, period);
      if (verified.size) verifiedOmissions.set(key, verified);
      else verifiedOmissions.delete(key);
      return {
        kind: "auIdParameterCheck", workId: id, source, period,
        checkedAt: new Date().toISOString(),
        allEquivalent: checks.every(check => check.equivalent === true),
        checks,
        reports: { withEmpty, omitted }
      };
    }, settings);
  };
  api.restCoreVersion = "1.0.0-beta";
})();
