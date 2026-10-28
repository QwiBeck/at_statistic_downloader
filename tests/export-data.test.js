import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Document } from "./dom.mjs";

const scripts = ["page-context.js", "lib/xlsx.js", "export-data.js"].map(path => readFileSync(new URL("../extension/" + path, import.meta.url), "utf8"));
export function fixture(workId = "910000001") {
  return {
    schemaVersion: "1.0.0", platform: "author.today", workId, complete: true, hasWarnings: false,
    application: { name: "AT Statistic Downloader", version: "1.0.0-beta" },
    source: { username: "synthetic-author-a" },
    requestedAt: "2042-03-16T15:00:00.000Z",
    period: { from: "2042-03-10", to: "2042-03-16", timeZone: "Europe/Moscow" },
    responses: Object.fromEntries([["general", "general"], ["chapterHits", "chapter-hits"], ["chapterTime", "chapter-time"]].map(([key, file]) => [key, JSON.parse(readFileSync(new URL("./fixtures/" + file + ".json", import.meta.url), "utf8"))])),
    requests: ["general", "chapterHits", "chapterTime"].map(section => ({ section, status: "success", httpStatus: 200, url: "https://author.today/report/fixture", error: null }))
  };
}
export function setupExport() {
  const document = new Document(), blobs = [];
  class TestURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return "blob:fixture-" + blobs.length; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({ document, URL: TestURL, Blob, TextEncoder,
    setTimeout(callback, ms) { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
    location: { href: "chrome-extension://fixture/converter.html" },
    fetch() { throw new Error("Offline conversion must not access the network."); }
  });
  for (const source of scripts) vm.runInContext(source, context);
  return { api: context.ATStatisticDownloader, context, document, blobs };
}
export function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = new Map();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extra;
    files.set(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), new TextDecoder().decode(bytes.subarray(start, start + length)));
    offset = start + length;
  }
  return files;
}
test("Excel has four analytical sheets with preserved zero, null, missing and signed counts", () => {
  const { api } = setupExport(), report = fixture();
  const original = JSON.stringify(report), sheets = api.makeReportSheets(report);
  assert.deepEqual(Array.from(sheets, sheet => sheet.name), ["Общая статистика", "Просмотры глав", "Время чтения", "Сведения"]);
  assert.equal(sheets[0].rows[6][7], -4);
  assert.equal(sheets[0].rows[5][4], 2.49);
  assert.equal(sheets[0].rows[5][1].toISOString(), "2042-03-10T00:00:00.000Z");
  const times = sheets[2].rows.slice(5);
  assert.equal(times.some(row => row[5] === 0), true);
  assert.equal(times.some(row => row[5] === "null"), true);
  assert.equal(times.some(row => row[5] === "нет ключа"), true);
  assert.equal(times.some(row => row[1] === "-1"), false);
  assert.equal(sheets[1].rows.slice(5).some(row => row[1] === "-1"), true);
  assert.equal(JSON.stringify(report), original);
});
test("multiple works and overlapping snapshots retain identity instead of summing daily uniques", async () => {
  const { api, blobs } = setupExport();
  const inputs = [fixture(), fixture("910000002"), fixture()];
  const collection = api.combineReports(inputs);
  assert.equal(collection.reports.length, 3);
  const general = api.makeReportSheets(collection)[0].rows.slice(5);
  assert.equal(general.length, 21);
  assert.deepEqual([...new Set(general.map(row => row[8]))], [1, 2, 3]);
  const result = api.saveReports(collection, "both");
  assert.equal(result.filenames.length, 2);
  const saved = JSON.parse(await blobs[1].text());
  assert.equal(saved.kind, "collection");
  assert.deepEqual(saved.reports, inputs);
});
test("Excel cells are typed safely, with real dates, escaped source titles and no formulas", () => {
  const { api } = setupExport(), report = fixture();
  report.responses.chapterHits.data.stats[0].title = '=HYPERLINK("https://example.invalid", "<test>&")';
  const files = unzip(api.makeXlsx(api.makeReportSheets(report)));
  assert.equal(files.size, 9);
  const general = files.get("xl/worksheets/sheet1.xml"), hits = files.get("xl/worksheets/sheet2.xml");
  assert.match(general, /<c r="B6" s="6"><v>\d+<\/v><\/c>/);
  assert.match(general, /<c r="C6" s="4"><v>137<\/v><\/c>/);
  assert.match(hits, /t="inlineStr"[^>]*><is><t[^>]*>=HYPERLINK\(&quot;/);
  assert.match(hits, /&lt;test&gt;&amp;/);
  assert.equal([...files.values()].some(xml => /<f[\s>]/.test(xml)), false);
  assert.match(general, /autoFilter ref="A5:I12"/);
  assert.match(general, /state="frozen"/);
});
test("partial reports expose failed sections and API warnings without manufacturing chapter data", () => {
  const { api } = setupExport(), report = fixture();
  report.complete = false;
  report.requests[2] = { section: "chapterTime", status: "error", httpStatus: 500, error: { message: "HTTP 500." } };
  report.responses.chapterTime = { isSuccessful: false, isWarning: true, messages: "Fixture failure", data: null };
  const sheets = api.makeReportSheets(report);
  assert.equal(sheets[2].rows.length, 5);
  assert.equal(sheets[3].rows[7][7], "Ошибка");
  assert.match(sheets[3].rows[7][10], /HTTP 500.*Fixture failure/);
  assert.equal(sheets[3].rows[7][9], "Да");
  assert.match(api.saveReports(report, "xlsx").filenames[0], /_partial\.xlsx$/);
});
test("unknown aggregation labels and source keys are retained verbatim", () => {
  const { api } = setupExport(), report = fixture();
  report.responses.chapterHits.data = { period: "month", stats: [{ id: 1, title: "Chapter", data: { c204203: 12, custom: null } }] };
  const rows = api.makeReportSheets(report)[1].rows.slice(5);
  assert.equal(rows[0][3], "month");
  assert.equal(rows[0][4], "c204203");
  assert.equal(rows[0][6], "c204203");
});
test("malformed imports and oversize Excel are rejected, while both mode still saves original JSON", async () => {
  const { api, blobs } = setupExport();
  for (const input of [[], {}, { kind: "collection", reports: [] }, { ...fixture(), workId: "../outside" }, { ...fixture(), period: { from: "2042-02-30", to: "2042-03-16" } }]) {
    assert.throws(() => api.normalizeReports(input));
  }
  const report = fixture();
  report.responses.chapterHits.data.stats = Array.from({ length: 10000 }, (_, id) => ({ id, title: "Fixture", data: Object.fromEntries(Array.from({ length: 7 }, (_, day) => ["c204203" + (10 + day), 1])) }));
  assert.throws(() => api.makeReportSheets(report), /большой Excel/);
  const saved = api.saveReports(report, "both");
  assert.equal(saved.filenames.length, 1);
  assert.match(saved.filenames[0], /\.json$/);
  assert.match(saved.warnings[0], /Excel не создан/);
  assert.equal(JSON.parse(await blobs[0].text()).responses.chapterHits.data.stats.length, 10000);
});
test("the popup combines local files without needing an AT page or any network requests", async () => {
  const { context, document, blobs } = setupExport();
  const elements = Object.fromEntries([["converter-form", "form"], ["files", "input"], ["format", "select"], ["save", "button"], ["status", "p"]].map(([id, tag]) => [id, document.createElement(tag)]));
  document.getElementById = id => elements[id];
  elements.files.files = [fixture(), fixture("910000002")].map((report, index) => ({ name: "fixture-" + index + ".json", size: 1000, text: async () => JSON.stringify(report) }));
  elements.format.value = "both";
  vm.runInContext(readFileSync(new URL("../extension/converter.js", import.meta.url), "utf8"), context);
  await elements["converter-form"].emit("submit");
  assert.equal(document.downloads.length, 2);
  assert.equal(elements.status.dataset.kind, "success");
  assert.equal(elements.save.disabled, false);
  assert.equal(JSON.parse(await blobs[1].text()).reports.length, 2);
});
