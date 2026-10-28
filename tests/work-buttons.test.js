import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { Document, Element } from "./dom.mjs";

const pageContext = readFileSync(new URL("../extension/page-context.js", import.meta.url), "utf8");
const statistics = readFileSync(new URL("../extension/statistics.js", import.meta.url), "utf8");
const buttons = readFileSync(new URL("../extension/work-buttons.js", import.meta.url), "utf8");
function card(id) {
  const wrapper = new Element();
  wrapper.className = "buttons-wrapper";
  const source = new Element("a");
  source.className = "btn work-id-copy";
  source.setAttribute("data-clipboard", id);
  source.textContent = "#" + id;
  wrapper.append(source);
  return { wrapper, source };
}
function setup(ids, url = "https://author.today/u/synthetic-author-a/works/edit") {
  const document = new Document(), cards = ids.map(card);
  cards.forEach(item => document.documentElement.append(item.wrapper));
  let observer;
  class MutationObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() {}
  }
  const context = vm.createContext({ document, location: { href: url }, URL, MutationObserver, queueMicrotask });
  vm.runInContext(pageContext, context);
  vm.runInContext(statistics, context);
  vm.runInContext(buttons, context);
  return { document, cards, context, observer };
}
test("adds one button per book and retains each book's own ID", () => {
  const { cards, context } = setup(["910000001", "910000002"]);
  assert.equal(cards[0].wrapper.querySelectorAll("button.book-stats-download").length, 1);
  assert.equal(cards[0].wrapper.querySelector("button.book-stats-download").getAttribute("data-work-id"), "910000001");
  assert.equal(cards[1].wrapper.querySelector("button.book-stats-download").getAttribute("data-work-id"), "910000002");
  assert.equal(cards[0].source.getAttribute("data-clipboard"), "910000001");
  assert.deepEqual(Array.from(context.BookStatsExporter.getWorkIdsOnPage()), ["910000001", "910000002"]);
  context.BookStatsExporter.buttonController.refresh();
  vm.runInContext(buttons, context);
  assert.equal(cards[0].wrapper.querySelectorAll("button.book-stats-download").length, 1);
});
test("routes a click to downloadStatistics with the ID read from that card", async () => {
  const { cards, context, document } = setup(["910000001", "910000002"]);
  const received = [];
  context.BookStatsExporter.downloadStatistics = async id => received.push(id);
  const button = cards[1].wrapper.querySelector("button.book-stats-download");
  const event = await document.click(button);
  assert.deepEqual(received, ["910000002"]);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Скачать статистику");
  assert.equal(button.getAttribute("aria-busy"), null);
});
test("inserts buttons after a DOM update and refreshes reused cards", async () => {
  const { cards, context, document, observer } = setup(["910000001"]);
  const next = card("910000003");
  document.documentElement.append(next.wrapper);
  observer.callback([]);
  observer.callback([]);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(next.wrapper.querySelectorAll("button.book-stats-download").length, 1);
  cards[0].source.setAttribute("data-clipboard", "910000004");
  observer.callback([]);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(cards[0].wrapper.querySelector("button.book-stats-download").dataset.workId, "910000004");
  assert.deepEqual(Array.from(context.BookStatsExporter.getWorkIdsOnPage()), ["910000004", "910000003"]);
});
test("a download error is displayed for the selected book", async () => {
  const { cards, document, context } = setup(["910000001"]);
  context.BookStatsExporter.downloadStatistics = async id => { throw new Error("Ошибка API для книги #" + id); };
  await document.click(cards[0].wrapper.querySelector("button.book-stats-download"));
  const message = cards[0].wrapper.querySelector(".book-stats-message");
  assert.match(message.textContent, /910000001/);
  assert.match(message.textContent, /Ошибка API/);
  assert.equal(message.getAttribute("role"), "status");
});
test("an outer wrapper does not remove a nested book's button", () => {
  const { cards, document, context } = setup(["910000001"]);
  const outer = new Element();
  outer.className = "buttons-wrapper";
  document.documentElement.append(outer);
  outer.append(cards[0].wrapper);
  context.BookStatsExporter.buttonController.refresh();
  const button = cards[0].wrapper.querySelector("button.book-stats-download");
  context.BookStatsExporter.buttonController.refresh();
  assert.equal(cards[0].wrapper.querySelector("button.book-stats-download"), button);
});
test("ignores invalid IDs and URLs outside the editing list", () => {
  assert.equal(setup(["oops"]).document.querySelectorAll("button.book-stats-download").length, 0);
  for (const url of ["https://author.today/work/910000001", "https://author.today/u/synthetic-author-a/works/edit/content", "https://author.today.evil.test/u/synthetic-author-a/works/edit"]) {
    assert.equal(setup(["910000001"], url).document.querySelectorAll("button.book-stats-download").length, 0);
  }
  assert.equal(setup(["910000001"], "https://author.today/u/synthetic-author-a/works/edit?page=2").document.querySelectorAll("button.book-stats-download").length, 1);
  assert.equal(setup(["910000003"], "https://author.today/u/synthetic-author-b/works/edit").document.querySelectorAll("button.book-stats-download").length, 1);
});
