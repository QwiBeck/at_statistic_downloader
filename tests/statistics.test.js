import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Document } from "./dom.mjs";

const pageContext = readFileSync(new URL("../extension/page-context.js", import.meta.url), "utf8");
const core = readFileSync(new URL("../extension/statistics-core.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../extension/statistics.js", import.meta.url), "utf8");
const writer = readFileSync(new URL("../extension/lib/xlsx.js", import.meta.url), "utf8");
const exporter = readFileSync(new URL("../extension/export-data.js", import.meta.url), "utf8");
const bodies = Object.fromEntries([["general", "general"], ["chapterHits", "chapter-hits"], ["chapterTime", "chapter-time"]].map(([key, name]) => [key, JSON.parse(readFileSync(new URL("./fixtures/" + name + ".json", import.meta.url), "utf8"))]));
const dates = { from: "2042-03-10", to: "2042-03-16", format: "json" };
const plain = value => JSON.parse(JSON.stringify(value));
function section(url) { const parsed = new URL(url); return parsed.pathname.endsWith("user-activity-data") ? "general" : parsed.searchParams.get("valueType") === "hit" ? "chapterHits" : "chapterTime"; }
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) }; }
function setup(fetchOverride) {
  const calls = [], blobs = [];
  const document = new Document();
  class TestURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return "blob:test-" + blobs.length; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    document, URL: TestURL, Blob, AbortController, TextEncoder,
    location: { href: "https://author.today/u/synthetic-author-a/works/edit" },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); if (ms === 30000) timer.unref(); return timer; },
    clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetchOverride ? fetchOverride(url, options, calls.length) : response(bodies[section(url)]);
    }
  });
  vm.runInContext(pageContext, context);
  vm.runInContext(writer, context);
  vm.runInContext(exporter, context);
  vm.runInContext(core, context);
  vm.runInContext(ui, context);
  return { api: context.BookStatsExporter, calls, document, blobs, context };
}
test("Moscow date boundaries match the synthetic reporting period", () => {
  const { api } = setup();
  const period = api.makePeriod(dates.from, dates.to);
  assert.equal(period.startDate, "2042-03-09T21:00:00.000Z");
  assert.equal(period.endDate, "2042-03-16T20:59:59.999Z");
  assert.deepEqual(plain(api.getDefaultDates(new Date("2042-03-15T22:30:00Z"))), { from: dates.from, to: dates.to });
  assert.equal(api.makePeriod("2042-12-31", "2043-01-01").endDate, "2043-01-01T20:59:59.999Z");
  for (const [from, to] of [["2042-03-16", "2042-03-10"], ["2042-02-30", "2042-03-01"], ["2042-13-01", "2042-13-02"], ["", "2042-03-16"]]) assert.throws(() => api.makePeriod(from, to));
});
test("all three URLs, GET credentials and raw response contents match the contract", async () => {
  const { api, calls } = setup();
  const report = await api.collectStatistics("910000001", dates);
  assert.equal(report.complete, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => section(call.url)), ["general", "chapterHits", "chapterTime"]);
  for (const [index, call] of calls.entries()) {
    const url = new URL(call.url);
    assert.equal(url.origin, "https://author.today");
    assert.equal(url.searchParams.get("startDate"), "2042-03-09T21:00:00.000Z");
    assert.equal(url.searchParams.get("endDate"), "2042-03-16T20:59:59.999Z");
    assert.match(url.searchParams.get("_"), /^\d+$/);
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.credentials, "same-origin");
    assert.equal(call.options.headers["X-Requested-With"], "XMLHttpRequest");
    assert.equal(url.searchParams.get(index === 0 ? "itemId" : "workId"), "910000001");
    assert.equal(url.searchParams.has("auId"), index !== 2);
    if (index === 0) assert.equal(url.searchParams.get("groupBy"), "work");
  }
  assert.deepEqual(plain(report.responses), bodies);
  assert.equal(report.responses.general.data[1].libraryCount, -4);
  assert.equal(report.responses.general.data[0].spentTime, 2.49);
  assert.equal(report.responses.chapterTime.data.stats[1].data.c20420311, 0);
  assert.equal(report.responses.chapterTime.data.stats[1].data.c20420312, null);
  assert.equal(Object.hasOwn(report.responses.chapterTime.data.stats[2].data, "c20420310"), false);
  assert.equal(report.responses.chapterHits.data.stats[0].id, -1);
  assert.equal(report.responses.chapterTime.data.stats.some(row => row.id === -1), false);
});
test("two books share one queue, including JSON body reads", async () => {
  let active = 0, maximum = 0;
  const { api, calls } = setup(async url => {
    active++; maximum = Math.max(maximum, active);
    return { ok: true, status: 200, json: async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      active--; return structuredClone(bodies[section(url)]);
    } };
  });
  const reports = await Promise.all([api.collectStatistics("910000001", dates), api.collectStatistics("910000003", dates)]);
  assert.equal(maximum, 1);
  assert.equal(reports.every(report => report.complete), true);
  assert.deepEqual(calls.map(call => { const p = new URL(call.url).searchParams; return p.get("itemId") || p.get("workId"); }), ["910000001", "910000001", "910000001", "910000003", "910000003", "910000003"]);
});
test("API errors keep successful sections and the original failed response", async () => {
  const failed = { isSuccessful: false, isWarning: true, messages: ["Ошибка тестового API"], data: null };
  const { api } = setup(async url => response(section(url) === "chapterHits" ? failed : bodies[section(url)]));
  const report = await api.collectStatistics("910000001", dates);
  assert.equal(report.complete, false);
  assert.equal(report.hasWarnings, true);
  assert.deepEqual(plain(report.requests.map(request => request.status)), ["success", "error", "success"]);
  assert.deepEqual(plain(report.responses.chapterHits), failed);
  assert.equal(report.requests[1].error.code, "API_ERROR");
  assert.deepEqual(plain(report.responses.general), bodies.general);
});
test("HTTP 401 and 429 stop subsequent requests and do not download empty statistics", async () => {
  for (const status of [401, 429]) {
    const { api, calls, document } = setup(async () => response({ isSuccessful: false, messages: null, data: null }, status));
    await assert.rejects(api.downloadStatistics("910000001", dates), /HTTP/);
    assert.equal(calls.length, 1);
    assert.equal(document.downloads.length, 0);
  }
});
test("HTML and schema mismatches are errors, not successful JSON exports", async () => {
  const { api } = setup(async (url, options, number) => number === 1
    ? { ok: true, status: 200, json: async () => { throw new SyntaxError("HTML"); } }
    : response({ isSuccessful: true, data: {} }));
  const report = await api.collectStatistics("910000001", dates);
  assert.equal(report.complete, false);
  assert.equal(report.requests[0].error.code, "INVALID_JSON");
  assert.equal(report.requests[1].error.code, "INVALID_RESPONSE");
  assert.equal(report.responses.general, null);
});
test("JSON download contains the collected synthetic report and a stable readable filename", async () => {
  const { api, document, blobs } = setup();
  const result = await api.downloadStatistics("910000001", dates);
  assert.equal(result.filename, "at-statistics-910000001_2042-03-10_2042-03-16.json");
  assert.equal(document.downloads.length, 1);
  const saved = JSON.parse(await blobs[0].text());
  assert.equal(saved.workId, "910000001");
  assert.deepEqual(saved.responses, bodies);
  assert.equal(saved.period.timeZone, "Europe/Moscow");
  assert.equal(saved.complete, true);
});
test("partial files are explicitly marked, with statuses and error details", async () => {
  const { api, document, blobs } = setup(async url => section(url) === "chapterTime" ? response(null, 500) : response(bodies[section(url)]));
  const result = await api.downloadStatistics("910000001", dates);
  assert.match(result.filename, /_partial\.json$/);
  assert.equal(document.downloads.length, 1);
  const report = JSON.parse(await blobs[0].text());
  assert.equal(report.complete, false);
  assert.equal(report.requests[2].httpStatus, 500);
  assert.equal(report.requests[2].error.code, "HTTP_ERROR");
});
test("canceling date selection sends no requests", async () => {
  const { api, document, calls } = setup();
  const promise = api.downloadStatistics("910000001");
  const dialog = document.querySelector("dialog.book-stats-period-dialog");
  assert.equal(dialog.open, true);
  const cancel = dialog.querySelectorAll("button").find(button => button.textContent === "Отмена");
  await cancel.emit("click");
  assert.equal((await promise).cancelled, true);
  assert.equal(document.querySelector("dialog.book-stats-period-dialog"), null);
  assert.equal(calls.length, 0);
});
test("selected dates from the dialog reach the three requests and the saved file", async () => {
  const { api, document, calls } = setup();
  const promise = api.downloadStatistics("910000001");
  const dialog = document.querySelector("dialog.book-stats-period-dialog");
  const inputs = dialog.querySelectorAll("input");
  inputs[0].value = dates.from; inputs[1].value = dates.to;
  await dialog.querySelector("form").emit("submit");
  assert.equal((await promise).report.period.startDate, "2042-03-09T21:00:00.000Z");
  assert.equal(calls.length, 3);
  assert.equal(document.downloads.length, 1);
});
test("timeouts are recorded and invalid inputs never reach fetch", async () => {
  const { api, calls } = setup(async (url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
  const report = await api.collectStatistics("910000001", { ...dates, timeoutMs: 5 });
  assert.equal(report.requests.every(request => request.error.code === "TIMEOUT"), true);
  const count = calls.length;
  await assert.rejects(api.collectStatistics("../other", dates));
  await assert.rejects(api.collectStatistics("910000001", { from: "2042-02-30", to: dates.to }));
  assert.equal(calls.length, count);
});
test("cancellation immediately before a queued request prevents fetch", async () => {
  const { api, calls } = setup();
  const controller = new AbortController();
  const report = await api.collectStatistics("910000001", {
    ...dates, signal: controller.signal,
    onProgress(message) { if (message.startsWith("Запрос ")) controller.abort(); }
  });
  assert.equal(calls.length, 0);
  assert.equal(report.requests.every(request => request.status === "skipped"), true);
});
test("username is read from the address, not hard-coded or inserted into API parameters", async () => {
  const { api, calls, context } = setup();
  context.location.href = "https://author.today/u/synthetic-author-b/works/edit?page=2";
  assert.equal(api.getPageContext().username, "synthetic-author-b");
  const report = await api.collectStatistics("910000003", dates);
  assert.equal(report.source.username, "synthetic-author-b");
  assert.equal(report.source.pageUrl, "https://author.today/u/synthetic-author-b/works/edit");
  assert.equal(calls.some(call => call.url.includes("synthetic-author-a") || call.url.includes("synthetic-author-b")), false);
  context.location.href = "https://author.today/u/author%2Fother/works/edit";
  assert.equal(api.getPageContext(), null);
});
test("GET uses the cookie session without reading or forwarding a POST verification token", async () => {
  const { api, document, calls } = setup();
  const input = document.createElement("input");
  input.setAttribute("name", "__RequestVerificationToken");
  Object.defineProperty(input, "value", { get() { throw new Error("GET must not read this token."); } });
  document.body.append(input);
  const report = await api.collectStatistics("910000001", dates);
  assert.equal(report.complete, true);
  assert.equal(calls.every(call => call.options.headers.RequestVerificationToken === undefined), true);
  assert.equal(calls.every(call => call.options.credentials === "same-origin"), true);
  assert.equal(calls.every(call => new URL(call.url).origin === "https://author.today"), true);
  assert.equal(JSON.stringify(report).includes("RequestVerificationToken"), false);
});
test("both formats use the same three responses without duplicate REST requests", async () => {
  const { api, calls, document, blobs } = setup();
  const result = await api.downloadStatistics("910000001", { ...dates, format: "both" });
  assert.equal(calls.length, 3);
  assert.equal(document.downloads.length, 2);
  assert.deepEqual(Array.from(result.filenames), ["at-statistics-910000001_2042-03-10_2042-03-16.xlsx", "at-statistics-910000001_2042-03-10_2042-03-16.json"]);
  assert.equal(new DataView(await blobs[0].arrayBuffer()).getUint32(0, true), 0x04034b50);
  assert.deepEqual(JSON.parse(await blobs[1].text()).responses, bodies);
});
test("format selection defaults to Excel and reaches the export without extra requests", async () => {
  const { api, calls, document, blobs } = setup();
  const pending = api.downloadStatistics("910000001");
  const dialog = document.querySelector("dialog.book-stats-period-dialog");
  const format = dialog.querySelector("select");
  assert.equal(format.value, "xlsx");
  format.value = "both";
  await dialog.querySelector("form").emit("submit");
  const result = await pending;
  assert.equal(calls.length, 3);
  assert.equal(result.filenames.length, 2);
  assert.equal(blobs[0].type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});
test("invalid formats are rejected before the first network request", async () => {
  const { api, calls } = setup();
  await assert.rejects(api.downloadStatistics("910000001", { ...dates, format: "csv" }), /формат/);
  assert.equal(calls.length, 0);
});
test("auId comparison proves equivalence using six sequential requests before enabling omission", async () => {
  const { api, calls } = setup();
  const checked = await api.verifyAuId("910000001", dates);
  assert.equal(checked.allEquivalent, true);
  assert.equal(calls.length, 6);
  assert.equal(calls.slice(0, 3).every(call => new URL(call.url).searchParams.has("auId")), true);
  assert.equal(calls.slice(3, 6).every(call => !new URL(call.url).searchParams.has("auId")), true);
  await api.collectStatistics("910000001", dates);
  assert.equal(calls.slice(6).every(call => !new URL(call.url).searchParams.has("auId")), true);
  await api.collectStatistics("910000003", dates);
  assert.equal(new URL(calls[9].url).searchParams.has("auId"), true);
});
test("different data and failed authorization do not count as proof that auId can be omitted", async () => {
  const { api, calls } = setup(async url => {
    const body = structuredClone(bodies[section(url)]);
    if (section(url) === "general" && !new URL(url).searchParams.has("auId")) body.data[1].libraryCount = 0;
    return response(body);
  });
  const checked = await api.verifyAuId("910000001", dates);
  assert.equal(checked.allEquivalent, false);
  assert.equal(checked.checks[0].canOmit, null);
  assert.equal(checked.checks[0].reason, "different_data");
  await api.collectStatistics("910000001", dates);
  assert.equal(new URL(calls[6].url).searchParams.has("auId"), true);
  const unauthorized = setup(async () => response({ isSuccessful: false, data: null }, 401));
  const denied = await unauthorized.api.verifyAuId("910000001", dates);
  assert.equal(denied.allEquivalent, false);
  assert.equal(denied.checks.every(check => check.canOmit === null), true);
  assert.equal(unauthorized.calls.length, 1);
});
test("auId verification in the date dialog updates the subsequent download's parameters", async () => {
  const { api, document, calls } = setup();
  const pending = api.downloadStatistics("910000001");
  const dialog = document.querySelector("dialog.book-stats-period-dialog");
  const inputs = dialog.querySelectorAll("input");
  inputs[0].value = dates.from; inputs[1].value = dates.to;
  const check = dialog.querySelectorAll("button").find(button => button.textContent === "Проверить auId");
  await check.emit("click");
  assert.equal(calls.length, 6);
  assert.match(dialog.querySelector(".book-stats-period-check-status").textContent, /ответы совпали/);
  await dialog.querySelector("form").emit("submit");
  assert.equal((await pending).report.complete, true);
  assert.equal(calls.slice(6).every(call => !new URL(call.url).searchParams.has("auId")), true);
});
