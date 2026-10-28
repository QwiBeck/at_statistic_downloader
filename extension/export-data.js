(() => {
  "use strict";
  const api = globalThis.BookStatsExporter ||= {};
  const sections = [
    ["general", "Общая статистика"], ["chapterHits", "Просмотры глав"], ["chapterTime", "Время чтения"]
  ];
  const metrics = ["totalViewCount", "uniqueViewCount", "spentTime", "commentCount", "likeCount", "libraryCount"];
  const formats = new Set(["xlsx", "json", "both"]);
  function fail(message) { throw new Error(message); }
  function validDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  }
  function validate(report) {
    if (!report || report.schemaVersion !== "1.0.0" || report.platform !== "author.today" ||
      !/^\d{1,20}$/.test(String(report.workId)) || !validDate(report.period?.from) ||
      !validDate(report.period?.to) || report.period.from > report.period.to ||
      !report.responses || !Array.isArray(report.requests)) {
      fail("Нужен JSON-отчёт AT Statistic Downloader версии 0.3.0 или новее с тремя разделами responses.");
    }
    return report;
  }
  api.normalizeReports = function normalizeReports(input) {
    const reports = Array.isArray(input) ? input : input?.kind === "collection" ? input.reports : [input];
    if (!Array.isArray(reports) || !reports.length || reports.length > 100) fail("Выберите от 1 до 100 отчётов.");
    return reports.map(validate);
  };
  api.combineReports = function combineReports(inputs) {
    const reports = inputs.flatMap(input => api.normalizeReports(input));
    if (!reports.length || reports.length > 100) fail("В одной выгрузке может быть от 1 до 100 отчётов.");
    return {
      schemaVersion: "1.0.0", kind: "collection", application: { ...api.application },
      platform: "author.today", exportedAt: new Date().toISOString(), reports
    };
  };
  function cell(object, key) {
    if (!Object.hasOwn(object, key)) return "нет ключа";
    const value = object[key];
    if (value === null) return "null";
    return typeof value === "object" ? JSON.stringify(value) : value;
  }
  function dateCell(value) {
    // Unknown aggregation labels remain literal source text.
    let iso = value;
    const chapterDate = String(value).match(/^c(\d{4})(\d{2})(\d{2})$/);
    const generalDate = String(value).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (chapterDate) iso = chapterDate.slice(1).join("-");
    if (generalDate) iso = generalDate[3] + "-" + generalDate[2] + "-" + generalDate[1];
    return validDate(iso) && iso >= "1900-03-01" ? new Date(iso + "T00:00:00Z") : String(value ?? "");
  }
  function message(body, request) {
    const parts = [request?.error?.message];
    if (body?.messages != null) parts.push(typeof body.messages === "string" ? body.messages : JSON.stringify(body.messages));
    return parts.filter(Boolean).join("; ");
  }
  api.makeReportSheets = function makeReportSheets(input) {
    const reports = api.normalizeReports(input);
    const period = reports.length === 1
      ? "Книга #" + reports[0].workId + ". " + reports[0].period.from + " — " + reports[0].period.to + ". Москва (UTC+3)."
      : reports.length + " отчётов. Номер снимка связывает строки с листом «Сведения». Пересекающиеся периоды не суммируются.";
    const make = (name, headers, widths, types, note) => ({
      name, headerRow: 5, widths, types,
      rows: [[name], [period], [note], [], headers]
    });
    const general = make("Общая статистика", ["Книга ID", "Дата", "Просмотры", "Уникальные просмотры", "Время чтения (API)", "Комментарии", "Лайки", "В библиотеку: изменение", "Снимок"],
      [15, 15, 17, 22, 23, 18, 15, 24, 12], ["text", "date", "integer", "integer", "decimal"],
      "Числа сохранены как в API. Уникальные просмотры за разные дни не складываются в уникальных читателей за период.");
    const chapterHeaders = ["Книга ID", "Глава ID", "Глава / страница книги", "Период API", "Дата / метка периода"];
    const hits = make("Просмотры глав", [...chapterHeaders, "Просмотры", "Ключ API", "Снимок"],
      [15, 15, 42, 16, 22, 18, 18, 12], [], "0 — числовой ноль; null — значение null из API; «нет ключа» — дата отсутствует у этой главы.");
    const time = make("Время чтения", [...chapterHeaders, "Время чтения (API)", "Ключ API", "Снимок"],
      [15, 15, 42, 16, 22, 23, 18, 12], ["text", "integer", "text", "text", "date", "decimal"],
      "Единицы времени не преобразованы. 0, null и «нет ключа» различаются. Исходные названия глав сохранены.");
    const info = make("Сведения", ["Снимок", "Книга ID", "Пользователь", "Период с", "Период по", "Часовой пояс", "Раздел", "Результат", "HTTP", "Предупреждение API", "Сообщение", "URL запроса"],
      [12, 15, 22, 15, 15, 23, 25, 18, 12, 22, 45, 60], [],
      "Неофициальное расширение. Время — без пересчёта: spentTime и valueType=time могут иметь разные единицы. Полные ответы — в JSON.");
    hits.wrapColumns = time.wrapColumns = [2];
    info.wrapColumns = [10, 11];
    let cells = 250;
    const append = (sheet, row) => {
      cells += row.length;
      if (cells > 500000) fail("Слишком большой Excel. Выберите меньше файлов или используйте JSON.");
      sheet.rows.push(row);
    };
    reports.forEach((report, index) => {
      const snapshot = index + 1;
      for (const [key, label] of sections) {
        const body = report.responses[key], request = report.requests.find(item => item?.section === key);
        const successful = request?.status === "success" && body?.isSuccessful === true;
        append(info, [snapshot, String(report.workId), report.source?.username || "", dateCell(report.period.from), dateCell(report.period.to),
          report.period.timeZone || "Europe/Moscow", label, successful ? "Успешно" : request?.status === "skipped" ? "Пропущено" : "Ошибка",
          request?.httpStatus ?? "", body == null ? "Нет ответа" : body.isWarning === true ? "Да" : body.isWarning === false ? "Нет" : "Не указано", message(body, request), request?.url || ""]);
        if (!successful) continue;
        if (key === "general") {
          if (!Array.isArray(body.data)) fail("Неверная таблица общей статистики в отчёте #" + snapshot + ".");
          for (const row of body.data) {
            if (!row || typeof row !== "object" || Array.isArray(row)) fail("Неверная строка общей статистики.");
            append(general, [String(report.workId), dateCell(row.date), ...metrics.map(metric => cell(row, metric)), snapshot]);
          }
        } else {
          if (!Array.isArray(body.data?.stats)) fail("Неверная таблица глав в отчёте #" + snapshot + ".");
          const stats = body.data.stats;
          const keys = [...new Set(stats.flatMap(row => {
            if (!row || typeof row !== "object" || !row.data || typeof row.data !== "object" || Array.isArray(row.data)) fail("Неверная строка главы.");
            return Object.keys(row.data);
          }))].sort();
          if (cells + stats.length * Math.max(keys.length, 1) * 8 > 500000) fail("Слишком большой Excel. Выберите меньший период или используйте JSON.");
          const sheet = key === "chapterHits" ? hits : time;
          for (const row of stats) for (const date of keys.length ? keys : [""]) {
            append(sheet, [String(report.workId), String(cell(row, "id")), cell(row, "title"), body.data.period,
              dateCell(date), cell(row.data, date), date, snapshot]);
          }
        }
      }
    });
    return [general, hits, time, info];
  };
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  }
  api.saveReports = function saveReports(input, format = "xlsx") {
    if (!formats.has(format)) fail("Выберите формат Excel, JSON или оба формата.");
    const reports = api.normalizeReports(input);
    const partial = reports.some(report => report.complete !== true);
    const stem = reports.length === 1
      ? "at-statistics-" + reports[0].workId + "_" + reports[0].period.from + "_" + reports[0].period.to
      : "at-statistics-collection_" + reports.length + "_" + new Date().toISOString().slice(0, 10);
    const base = stem + (partial ? "_partial" : "");
    const files = [], warnings = [];
    if (format !== "json") {
      try {
        files.push({ filename: base + ".xlsx", blob: new Blob([api.makeXlsx(api.makeReportSheets(reports))], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) });
      } catch (error) {
        if (format !== "both") throw error;
        warnings.push("Excel не создан: " + error.message);
      }
    }
    if (format !== "xlsx") {
      const json = reports.length === 1 ? reports[0] : api.combineReports(reports);
      files.push({ filename: base + ".json", blob: new Blob([JSON.stringify(json, null, 2)], { type: "application/json;charset=utf-8" }) });
    }
    for (const file of files) downloadBlob(file.blob, file.filename);
    return { filenames: files.map(file => file.filename), warnings };
  };
  api.saveReportAsJson = report => api.saveReports(report, "json").filenames[0];
})();
