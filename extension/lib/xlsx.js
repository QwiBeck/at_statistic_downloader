// Small dependency-free OOXML writer. ZIP uses uncompressed entries, so no
// dynamic code or network/CDN is needed inside a Manifest V3 extension.
(() => {
"use strict";
const api = globalThis.BookStatsExporter ||= {};
const encoder = new TextEncoder();
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function xml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .toWellFormed().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function columnName(index) {
  let name = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
function join(chunks) {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function zipStore(files) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = encoder.encode(path), data = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(data);
    const header = new Uint8Array(30), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); view.setUint16(12, 33, true);
    view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, name.length, true);
    chunks.push(header, name, data);
    const central = new Uint8Array(46), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(14, 33, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    directory.push(central, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = join(directory), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralBytes.length, true); ev.setUint32(16, offset, true);
  return join([...chunks, centralBytes, end]);
}

function makeXlsx(sheets) {
  if (!sheets.length || sheets.length > 1000) throw new Error("Недопустимое число листов Excel.");
  let totalCells = 0;
  const names = new Set(), files = [];
  const workbookSheets = [], relationships = [], contentTypes = [];
  for (let index = 0; index < sheets.length; index++) {
    const sheet = sheets[index], id = index + 1, headerRow = sheet.headerRow || 1;
    const name = sheet.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
    if (!name || names.has(name.toLowerCase())) throw new Error("Имена листов Excel должны быть уникальны.");
    names.add(name.toLowerCase());
    if (sheet.rows.length > 1048576 || sheet.rows.some(row => row.length > 16384)) throw new Error("Превышен размер листа Excel.");
    totalCells += sheet.rows.reduce((count, row) => count + row.length, 0);
    if (totalCells > 500000) throw new Error("Слишком большой Excel. Выберите меньше файлов или используйте JSON.");
    const columns = sheet.rows.reduce((max, row) => Math.max(max, row.length), 1);
    const rows = sheet.rows.map((row, r) => {
      const lines = r >= headerRow ? Math.max(1, ...(sheet.wrapColumns || []).map(c => Math.ceil(String(row[c] ?? "").length / (sheet.widths?.[c] || 20)))) : 1;
      const height = r + 1 === headerRow ? 44 : r === 0 ? 30 : Math.min(400, 22 * lines);
      return '<row r="' + (r + 1) + '" ht="' + height + '" customHeight="1">' + row.map((value, c) => {
      const date = Object.prototype.toString.call(value) === "[object Date]" && Number.isFinite(value.getTime());
      const number = typeof value === "number" && Number.isFinite(value);
      const styleId = r + 1 === headerRow ? 1 : r === 0 && headerRow > 1 ? 2 : r < headerRow - 1 ? 3 : date ? 6 : number ? (sheet.types?.[c] === "decimal" ? 5 : 4) : sheet.wrapColumns?.includes(c) ? 7 : 0;
      const ref = columnName(c) + (r + 1), style = ' s="' + styleId + '"';
      if (value === null || value === undefined || value === "") return '<c r="' + ref + '"' + style + '/>';
      if (date) return '<c r="' + ref + '"' + style + '><v>' + ((value.getTime() - Date.UTC(1899, 11, 30)) / 86400000) + '</v></c>';
      if (number) return '<c r="' + ref + '"' + style + '><v>' + value + '</v></c>';
      // Even "=SUM(...)" is an inline string, never an executable formula.
      return '<c r="' + ref + '" t="inlineStr"' + style + '><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
    }).join("") + '</row>'; }).join("");
    files.push(["xl/worksheets/sheet" + id + ".xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:' + columnName(columns - 1) + Math.max(sheet.rows.length, 1) + '"/>' +
      '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="' + headerRow + '" topLeftCell="A' + (headerRow + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<cols>' + Array.from({ length: columns }, (_, col) => '<col min="' + (col + 1) + '" max="' + (col + 1) + '" width="' + (sheet.widths?.[col] || 20) + '" customWidth="1"/>').join("") + '</cols><sheetData>' + rows + '</sheetData>' +
      (sheet.rows.length > headerRow ? '<autoFilter ref="A' + headerRow + ':' + columnName(columns - 1) + sheet.rows.length + '"/>' : "") + '</worksheet>']);
    workbookSheets.push('<sheet name="' + xml(name) + '" sheetId="' + id + '" r:id="rId' + id + '"/>');
    relationships.push('<Relationship Id="rId' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + id + '.xml"/>');
    contentTypes.push('<Override PartName="/xl/worksheets/sheet' + id + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
  }
  const styles = '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0;[Red]-#,##0;0"/><numFmt numFmtId="165" formatCode="0.00;[Red]-0.00;0.00"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd"/></numFmts>' +
    '<fonts count="4"><font><sz val="11"/><color rgb="FF233447"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF24689D"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF24689D"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  files.push(
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + contentTypes.join("") + '</Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + workbookSheets.join("") + '</sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + relationships.join("") + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", styles]
  );
  return zipStore(files);
}
api.makeXlsx = makeXlsx;
})();
