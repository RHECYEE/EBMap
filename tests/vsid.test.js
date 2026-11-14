// Reading the VSID form's .csv. Every row here is invented: real responses are
// residents' homes and phone numbers and never belong in this repository.
//
//   node --test tests/vsid.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const vsid = require("../docs/vsid.js");

// The header exactly as the Google Form writes it.
const HEADER = "Timestamp,Address,Latitude,Longitude,Phone Number";
const MAP_BOUNDS = [[44.6, -102.4], [45.6, -100.3]];

function csv(...lines) {
  return [HEADER, ...lines].join("\n");
}

test("reads a plain form export", () => {
  const { points, problems } = vsid.parseVsidCsv(csv(
    "1/2/2026 9:00:00,100 Test Rd,45.1,-101.2,",
    "1/2/2026 9:05:00,200 Sample St,45.2,-101.3,6055550100",
  ));
  assert.deepEqual(problems, []);
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], {
    id: "vsid-2", row: 2, address: "100 Test Rd", latitude: 45.1, longitude: -101.2, phone: "", submitted: "1/2/2026",
  });
  assert.equal(points[1].phone, "6055550100");
});

test("keeps commas, quotes, line breaks and curly apostrophes inside quoted cells", () => {
  const { points } = vsid.parseVsidCsv(csv(
    '1/2/2026 9:00:00,"1 Main St, Testville, SD 57000",45.1,-101.2,',
    '1/2/2026 9:00:00,"The ""blue"" house",45.1,-101.21,',
    '1/2/2026 9:00:00,"Line one\nline two",45.1,-101.22,',
    "1/2/2026 9:00:00,Sam and Pat Example’s House,45.1,-101.23,",
  ));
  assert.deepEqual(points.map((point) => point.address), [
    "1 Main St, Testville, SD 57000",
    'The "blue" house',
    "Line one line two",
    "Sam and Pat Example’s House",
  ]);
});

test("row numbers match the sheet even when a cell holds a line break", () => {
  const { points } = vsid.parseVsidCsv(csv(
    '1/2/2026 9:00:00,"two\nlines",45.1,-101.2,',
    "1/2/2026 9:00:00,next,45.1,-101.3,",
  ));
  assert.deepEqual(points.map((point) => point.row), [2, 3]);
});

test("copes with Windows line endings, a byte-order mark, and trailing blank lines", () => {
  const text = `﻿${HEADER}\r\n1/2/2026 9:00:00,100 Test Rd,45.1,-101.2,\r\n,,,,\r\n\r\n`;
  const { points, problems } = vsid.parseVsidCsv(text);
  assert.equal(points.length, 1);
  assert.equal(points[0].address, "100 Test Rd");
  assert.deepEqual(problems, []);
});

test("lists rows it cannot place, with the sheet's row number and the reason", () => {
  const { points, problems } = vsid.parseVsidCsv(csv(
    "1/2/2026 9:00:00,No coords,,,",
    "1/2/2026 9:00:00,Words,forty five,-101.2,",
    "1/2/2026 9:00:00,Swapped,-101.2,45.1,",
    "1/2/2026 9:00:00,Degrees,45.1°,-101.2,",
    "1/2/2026 9:00:00,Fine,45.1,-101.2,",
  ));
  assert.equal(points.length, 1);
  assert.deepEqual(problems, [
    { row: 2, label: "No coords", reason: "no latitude, no longitude" },
    { row: 3, label: "Words", reason: 'latitude "forty five" is not a number' },
    { row: 4, label: "Swapped", reason: "latitude -101.2 is out of range" },
    { row: 5, label: "Degrees", reason: 'latitude "45.1°" is not a number' },
  ]);
});

test("a response sent twice appears once", () => {
  const { points, problems } = vsid.parseVsidCsv(csv(
    "1/2/2026 9:00:00,100 Test Rd,45.1,-101.2,6055550100",
    "1/2/2026 9:30:00,100 test rd,45.1,-101.2,(605) 555-0100",
    "1/2/2026 9:40:00,100 Test Rd,45.1,-101.25,6055550100",
  ));
  assert.equal(points.length, 2, "a moved pin is a different response, not a repeat");
  assert.deepEqual(problems, [{ row: 3, label: "100 test rd", reason: "same as row 2" }]);
});

test("a row with coordinates but no address is kept and says so", () => {
  const { points } = vsid.parseVsidCsv(csv("1/2/2026 9:00:00,,45.1,-101.2,6055550100"));
  assert.equal(points.length, 1);
  assert.equal(vsid.pointProperties(points[0]).label, vsid.NO_ADDRESS_LABEL);
});

test("finds the columns by name, in any order and with longer question titles", () => {
  const text = [
    "Phone Number,Your longitude,Your latitude,What is your address?,Timestamp",
    "6055550100,-101.2,45.1,100 Test Rd,1/2/2026 9:00:00",
  ].join("\n");
  const { points } = vsid.parseVsidCsv(text);
  assert.deepEqual(points[0], {
    id: "vsid-2", row: 2, address: "100 Test Rd", latitude: 45.1, longitude: -101.2, phone: "6055550100", submitted: "1/2/2026",
  });
});

test("refuses a file that is not a VSID list", () => {
  assert.throws(() => vsid.parseVsidCsv("Name,Notes\nA,B"), /no Latitude and Longitude columns/);
  assert.throws(() => vsid.parseVsidCsv(""), /empty/);
  assert.throws(() => vsid.parseVsidCsv(`${HEADER}\n1/2/2026,"cut off`), /cut off/);
});

test("formats US phone numbers and makes them dialable", () => {
  assert.equal(vsid.formatPhone("6055550100"), "(605) 555-0100");
  assert.equal(vsid.formatPhone("(605) 555-0100"), "(605) 555-0100");
  assert.equal(vsid.formatPhone("1-605-555-0100"), "(605) 555-0100");
  assert.equal(vsid.phoneHref("605.555.0100"), "tel:+16055550100");
  assert.equal(vsid.formatPhone("555-0100"), "555-0100", "anything else is shown as typed");
  assert.equal(vsid.phoneHref("555-0100"), "tel:5550100");
  assert.equal(vsid.phoneHref("ask at the store"), "");
  assert.equal(vsid.phoneHref(""), "");
});

test("shows the submitted date exactly as the form wrote it", () => {
  assert.equal(vsid.submittedDate("11/12/2026 9:31:53"), "11/12/2026");
  assert.equal(vsid.submittedDate(""), "");
});

test("holds back a point far outside the map, keeps one just past its edge", () => {
  assert.equal(vsid.outsideArea({ latitude: 36.03, longitude: -115.12 }, MAP_BOUNDS), true);
  assert.equal(vsid.outsideArea({ latitude: 45.0, longitude: -101.2 }, MAP_BOUNDS), false);
  assert.equal(vsid.outsideArea({ latitude: 44.3, longitude: -102.7 }, MAP_BOUNDS), false, "within the margin");
  assert.equal(vsid.outsideArea({ latitude: 45.0, longitude: 101.2 }, MAP_BOUNDS), true, "a dropped minus sign");
  assert.equal(vsid.outsideArea({ latitude: 45.0, longitude: -101.2 }, [[45.6, -100.3], [44.6, -102.4]]), false, "corners in either order");
  assert.equal(vsid.outsideArea({ latitude: 36.03, longitude: -115.12 }, null), false, "no map, nothing to compare with");
});

test("map properties mark every point as VSID and make it findable", () => {
  const [point] = vsid.parseVsidCsv(csv("1/2/2026 9:00:00,100 Test Rd,45.1,-101.2,(605) 555-0100")).points;
  const properties = vsid.pointProperties(point);
  assert.equal(properties.kind, "vsid");
  assert.equal(properties.label, "100 Test Rd");
  assert.equal(properties.mapLabel, "VSID: 100 Test Rd");
  assert.match(properties.subtitle, /last resort/);
  assert.match(properties.searchText, /\bvsid\b/);
  assert.match(properties.searchText, /6055550100/, "findable by the number a caller rang from");
  assert.equal(properties.phoneHref, "tel:+16055550100");
});

test("the stored record is the file itself and reads back the same", () => {
  const text = csv("1/2/2026 9:00:00,100 Test Rd,45.1,-101.2,");
  const record = vsid.makeVsidRecord({ text, fileName: "responses.csv", importedUtc: "2026-01-02T15:00:00.000Z" });
  assert.equal(record.text, text);
  assert.deepEqual(Object.keys(record).sort(), ["fileName", "importedUtc", "schemaVersion", "text", "type"]);
  const loaded = vsid.loadVsidRecord(structuredClone(record));
  assert.equal(loaded.points.length, 1);
  assert.equal(loaded.fileName, "responses.csv");
  assert.equal(vsid.loadVsidRecord(null), null);
  assert.equal(vsid.loadVsidRecord({ type: "something-else", text }), null);
  assert.equal(vsid.loadVsidRecord({ ...record, text: "Name\nA" }), null);
});
