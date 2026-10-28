(() => {
  "use strict";
  const api = globalThis.ATStatisticDownloader;
  const form = document.getElementById("converter-form"), files = document.getElementById("files");
  const format = document.getElementById("format"), save = document.getElementById("save"), status = document.getElementById("status");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    status.dataset.kind = "";
    status.textContent = "Чтение файлов…";
    try {
      const selected = Array.from(files.files || []);
      const outputFormat = format.value;
      if (!selected.length) throw new Error("Выберите JSON-файлы.");
      if (selected.length > 100 || selected.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) throw new Error("Выберите не более 100 файлов общим размером до 20 МБ.");
      const inputs = [];
      for (const file of selected) {
        let input;
        try { input = JSON.parse(await file.text()); }
        catch { throw new Error("Не удалось прочитать JSON: " + file.name); }
        try { api.normalizeReports(input); }
        catch (error) { throw new Error(file.name + ": " + error.message); }
        inputs.push(input);
      }
      const collection = api.combineReports(inputs);
      const saved = api.saveReports(collection, outputFormat);
      status.dataset.kind = saved.warnings.length ? "error" : "success";
      status.textContent = "Отчётов: " + collection.reports.length + ". Передано браузеру: " + saved.filenames.join(", ") + "." + (saved.warnings.length ? " " + saved.warnings.join(" ") : "");
    } catch (error) {
      status.dataset.kind = "error";
      status.textContent = error.message || "Не удалось объединить файлы.";
    } finally { save.disabled = false; }
  });
})();
