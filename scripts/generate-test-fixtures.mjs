// All IDs, chapter titles, dates and statistics in these fixtures are synthetic.
// Generation is deterministic and never reads the network or a browser session.
import { mkdir, writeFile } from "node:fs/promises";

const directory = new URL("../tests/fixtures/", import.meta.url);
const days = Array.from({ length: 7 }, (_, index) => {
  const iso = new Date(Date.UTC(2042, 2, 10 + index)).toISOString().slice(0, 10);
  return { key: "c" + iso.replaceAll("-", ""), date: iso.split("-").reverse().join(".") };
});
const values = generate => Object.fromEntries(days.flatMap((day, index) => {
  const value = generate(index);
  return value === undefined ? [] : [[day.key, value]];
}));
const chapterHits = [
  { id: -1, title: "Страница книги", data: values(index => 70 + index * 9) },
  { id: 910010001, title: "Тестовая часть Альфа", data: values(index => 21 + index * 4) },
  { id: 910010002, title: "Тестовая часть Бета", data: values(index => index === 1 ? 0 : index === 2 || index === 3 ? null : 46 + index * 5) },
  { id: 910010003, title: "Тестовая часть Гамма", data: values(index => index === 6 ? 47 : undefined) }
];
const chapterTime = [
  { id: 910010001, title: "Тестовая часть Альфа", data: values(index => 360 * (index + 3)) },
  { id: 910010002, title: "Тестовая часть Бета", data: values(index => index === 1 ? 0 : index === 2 || index === 3 ? null : 7884 + index * 901) },
  { id: 910010003, title: "Тестовая часть Гамма", data: values(index => index === 6 ? 1111 : undefined) }
];
const sum = (rows, key) => rows.reduce((total, row) => total + (row.data[key] ?? 0), 0);
const general = days.map((day, index) => ({
  date: day.date,
  totalViewCount: sum(chapterHits, day.key),
  uniqueViewCount: Math.floor(sum(chapterHits, day.key) * 0.67),
  spentTime: Number((sum(chapterTime, day.key) / 3600).toFixed(2)),
  commentCount: (index * 3 + 2) % 7,
  likeCount: (index + 2) % 5,
  libraryCount: index === 1 ? -4 : (index * 2 + 3) % 11
}));
const envelope = data => ({ isSuccessful: true, isWarning: false, messages: null, data });
await mkdir(directory, { recursive: true });
for (const [name, data] of [
  ["general", general],
  ["chapter-hits", { stats: chapterHits, period: "day" }],
  ["chapter-time", { stats: chapterTime, period: "day" }]
]) await writeFile(new URL(name + ".json", directory), JSON.stringify(envelope(data), null, 2) + "\n");
console.log("Generated 3 synthetic API fixtures (2042-03-10 through 2042-03-16).");
