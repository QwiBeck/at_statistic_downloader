(() => {
  "use strict";
  const api = globalThis.BookStatsExporter ||= {};
  let lastDates = null, lastFormat = "xlsx", dialogOpen = false;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  api.choosePeriod = function choosePeriod(workId) {
    if (dialogOpen) return Promise.reject(new Error("Уже открыто окно выбора периода."));
    dialogOpen = true;
    return new Promise((resolve, reject) => {
      const dialog = element("dialog", "", "book-stats-period-dialog");
      let checkController = null;
      let done = false;
      function finish(value) {
        if (done) return;
        done = true;
        checkController?.abort();
        if (dialog.open) dialog.close();
        dialog.remove();
        dialogOpen = false;
        resolve(value);
      }
      try {
        const dates = lastDates || api.getDefaultDates();
        const form = element("form");
        const title = element("h3", "Статистика книги #" + workId);
        title.id = "book-stats-period-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const hint = element("p", "Период включительно, московское время (UTC+3).", "book-stats-period-hint");
        const fields = element("div", "", "book-stats-period-fields");
        const fromLabel = element("label", "Дата с");
        const toLabel = element("label", "Дата по");
        const from = element("input"), to = element("input");
        from.type = to.type = "date";
        from.name = "from"; to.name = "to";
        from.required = to.required = true;
        from.value = dates.from; to.value = dates.to;
        fromLabel.append(from); toLabel.append(to); fields.append(fromLabel, toLabel);
        const formatLabel = element("label", "Формат файла", "book-stats-format-label");
        const format = element("select");
        format.name = "format";
        for (const [value, text] of [["xlsx", "Excel (.xlsx)"], ["json", "JSON — исходные ответы"], ["both", "Excel и JSON"]]) {
          const option = element("option", text);
          option.value = value;
          format.append(option);
        }
        format.value = lastFormat;
        formatLabel.append(format);
        const error = element("p", "", "book-stats-period-error");
        error.setAttribute("role", "alert");
        const checkHint = element("p", "Проверка auId сравнит ответы с пустым параметром и без него. Для сравнения выбери завершившийся период.", "book-stats-period-hint");
        const checkStatus = element("p", "", "book-stats-period-check-status");
        checkStatus.setAttribute("role", "status");
        const diagnostics = element("details", "", "book-stats-diagnostics");
        diagnostics.append(element("summary", "Диагностика запросов"));
        const actions = element("div", "", "book-stats-period-actions");
        const check = element("button", "Проверить auId", "btn btn-default");
        check.type = "button";
        const cancel = element("button", "Отмена", "btn btn-default");
        cancel.type = "button";
        const submit = element("button", "Скачать", "btn btn-primary");
        submit.type = "submit";
        diagnostics.append(checkHint, check, checkStatus);
        actions.append(cancel, submit);
        form.append(title, hint, fields, formatLabel, error, diagnostics, actions);
        dialog.append(form);
        form.addEventListener("submit", event => {
          event.preventDefault();
          if (!form.reportValidity()) return;
          try {
            api.makePeriod(from.value, to.value);
            lastDates = { from: from.value, to: to.value };
            lastFormat = format.value;
            finish({ ...lastDates, format: lastFormat });
          } catch (problem) { error.textContent = problem.message; }
        });
        cancel.addEventListener("click", () => finish(null));
        check.addEventListener("click", async () => {
          if (!form.reportValidity()) return;
          try { api.makePeriod(from.value, to.value); } catch (problem) { error.textContent = problem.message; return; }
          error.textContent = "";
          from.disabled = to.disabled = format.disabled = check.disabled = submit.disabled = true;
          checkController = new AbortController();
          try {
            const result = await api.verifyAuId(workId, {
              from: from.value, to: to.value, signal: checkController.signal,
              onProgress(message) { if (!done) checkStatus.textContent = message; }
            });
            if (!done) checkStatus.textContent = result.checks.map(item => item.label + ": " + (item.canOmit
              ? "auId можно убрать — ответы совпали"
              : item.reason === "different_data" ? "не подтверждено — ответы различаются" : "не подтверждено — запросы не завершились успешно")).join("\n");
          } catch (problem) { if (!done) error.textContent = problem.message; }
          finally {
            checkController = null;
            if (!done) from.disabled = to.disabled = format.disabled = check.disabled = submit.disabled = false;
          }
        });
        dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
        document.body.append(dialog);
        dialog.showModal();
      } catch (error) {
        dialog.remove(); dialogOpen = false; reject(error);
      }
    });
  };
  api.downloadStatistics = async function downloadStatistics(workId, options = {}) {
    const dates = options.from !== undefined || options.to !== undefined
      ? { from: options.from, to: options.to }
      : await api.choosePeriod(workId);
    if (!dates) return { cancelled: true };
    const format = options.format ?? dates.format ?? "xlsx";
    if (!["xlsx", "json", "both"].includes(format)) throw new Error("Выберите формат Excel, JSON или оба формата.");
    const report = await api.collectStatistics(workId, { ...options, ...dates });
    const successes = report.requests.filter(request => request.status === "success").length;
    if (!successes) {
      const error = new Error(report.requests.find(request => request.error)?.error.message || "Статистику получить не удалось.");
      error.report = report;
      throw error;
    }
    const saved = api.saveReports(report, format);
    return { cancelled: false, filename: saved.filenames[0], filenames: saved.filenames, exportWarnings: saved.warnings, report };
  };
})();
