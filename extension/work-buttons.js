(() => {
  "use strict";
  const api = globalThis.BookStatsExporter ||= {};
  if (api.buttonController) {
    api.buttonController.refresh();
    return;
  }
  const BUTTON_CLASS = "book-stats-download";
  const MESSAGE_CLASS = "book-stats-message";
  const buttonSelector = "button." + BUTTON_CLASS;
  let scheduled = false, stopped = false;

  function isTargetPage() {
    return Boolean(api.getPageContext());
  }
  function readWorkId(wrapper) {
    const source = findOwned(wrapper, ".work-id-copy[data-clipboard]");
    if (!source) return null;
    const value = source.getAttribute("data-clipboard")?.trim() || "";
    return /^\d+$/.test(value) ? value : null;
  }
  function findOwned(wrapper, selector) {
    return [...wrapper.querySelectorAll(selector)].find(node => node.closest(".buttons-wrapper") === wrapper);
  }
  function setMessage(wrapper, text, kind = "info") {
    let message = findOwned(wrapper, "." + MESSAGE_CLASS);
    if (!message) {
      message = document.createElement("span");
      message.className = MESSAGE_CLASS;
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");
      wrapper.append(message);
    }
    message.textContent = text;
    message.dataset.kind = kind;
  }
  function removeControls(wrapper) {
    wrapper.querySelectorAll(buttonSelector + ", ." + MESSAGE_CLASS).forEach(node => {
      if (node.closest(".buttons-wrapper") === wrapper) node.remove();
    });
  }
  function refresh() {
    if (stopped) return;
    if (!isTargetPage()) {
      document.querySelectorAll(buttonSelector + ", ." + MESSAGE_CLASS).forEach(node => node.remove());
      return;
    }
    document.querySelectorAll(".buttons-wrapper").forEach(wrapper => {
      const workId = readWorkId(wrapper);
      if (!workId) { removeControls(wrapper); return; }
      const existing = [...wrapper.querySelectorAll(buttonSelector)].filter(button => button.closest(".buttons-wrapper") === wrapper);
      let button = existing.shift();
      existing.forEach(duplicate => duplicate.remove());
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-default hint-top mr-sm " + BUTTON_CLASS;
        button.textContent = "Скачать статистику";
        button.setAttribute("data-hint", "Скачать статистику");
        wrapper.append(button);
      }
      if (button.dataset.workId !== workId) {
        button.dataset.workId = workId;
        button.setAttribute("aria-label", "Скачать статистику книги #" + workId);
        findOwned(wrapper, "." + MESSAGE_CLASS)?.remove();
      }
    });
  }
  function scheduleRefresh() {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; refresh(); });
  }
  async function handleClick(event) {
    const button = event.target?.closest?.(buttonSelector);
    if (!button || !isTargetPage()) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    const wrapper = button.closest(".buttons-wrapper");
    const workId = wrapper && readWorkId(wrapper);
    if (!workId) {
      if (wrapper) setMessage(wrapper, "Не удалось определить ID произведения.");
      return;
    }
    button.dataset.workId = workId;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Выбор периода…";
    findOwned(wrapper, "." + MESSAGE_CLASS)?.remove();
    try {
      const result = await api.downloadStatistics(workId, {
        onProgress(message) {
          if (readWorkId(wrapper) !== workId) return;
          button.textContent = "Загрузка…";
          setMessage(wrapper, message);
        }
      });
      if (result?.report && readWorkId(wrapper) === workId) {
        const report = result.report;
        const count = report.requests.filter(request => request.status === "success").length;
        const formats = (result.filenames || [result.filename]).filter(Boolean).map(name => name.endsWith(".xlsx") ? "Excel" : "JSON").join(" и ") || "Файл";
        const exportWarnings = result.exportWarnings?.join(" ") || "";
        setMessage(wrapper, report.complete
          ? formats + ": файлы переданы браузеру для скачивания." + (report.hasWarnings ? " API вернул предупреждения — они сохранены в файле." : "") + (exportWarnings ? " " + exportWarnings : "")
          : formats + ": неполная выгрузка, получено " + count + " из 3 разделов. Ошибки сохранены в файле." + (exportWarnings ? " " + exportWarnings : ""),
        report.complete && !report.hasWarnings && !exportWarnings ? "success" : "warning");
      }
    } catch (error) {
      if (readWorkId(wrapper) === workId) setMessage(wrapper, error?.message || "Не удалось скачать статистику книги #" + workId + ".", "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Скачать статистику";
    }
  }
  api.getWorkIdsOnPage = () => isTargetPage()
    ? [...new Set([...document.querySelectorAll(".buttons-wrapper")].map(readWorkId).filter(Boolean))]
    : [];

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-clipboard"]
  });
  // Capture only our button's click before the page's delegated PJAX handlers.
  document.addEventListener("click", handleClick, true);
  refresh();
  api.buttonController = {
    refresh,
    disconnect() {
      stopped = true;
      observer.disconnect();
      document.removeEventListener("click", handleClick, true);
      document.querySelectorAll(buttonSelector + ", ." + MESSAGE_CLASS).forEach(node => node.remove());
      delete api.buttonController;
    }
  };
})();
