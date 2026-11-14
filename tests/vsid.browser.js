// Drives the real app through a VSID list: import, how it looks, how it
// searches, and that it lives apart from the map update. Every row is invented.
// Not part of `node --test`; it needs a server and Playwright:
//
//   npx http-server docs -p 8099 -s &
//   node tests/vsid.browser.js
//
const { chromium } = require("playwright");
const URL = "http://127.0.0.1:8099/index.html";
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : ` -> ${JSON.stringify(actual)}`}`);
}

const update = {
  type: "field-map-update",
  schemaVersion: 1,
  meta: { bounds: [[44.6, -102.4], [45.6, -100.3]], generatedUtc: "2026-11-01T00:00:00.000Z" },
  roads: { type: "FeatureCollection", features: [] },
  locations: {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [-101.25, 45.05] },
      properties: { id: "official-1", kind: "address", label: "100 Test Rd", subtitle: "Official address" },
    }],
  },
};

const vsidCsv = [
  "Timestamp,Address,Latitude,Longitude,Phone Number",
  "11/12/2026 9:00:00,100 Test Rd,45.0501,-101.2402,",
  '11/12/2026 9:10:00,"200 Sample St, Testville, SD",45.0602,-101.2303,6055550100',
  "11/12/2026 9:20:00,Pat Example’s home,45.0703,-101.2204,(605) 555-0199",
  "11/12/2026 9:30:00,Far Away Diner,36.03,-115.12,",
  "11/12/2026 9:40:00,No pin,,,",
].join("\n");

const file = (name, text, mimeType) => ({ name, mimeType, buffer: Buffer.from(text, "utf8") });

async function openData(page) {
  if (!(await page.locator("#data-dialog").evaluate((dialog) => dialog.open))) await page.click("#data-button");
}

async function closeData(page) {
  if (await page.locator("#data-dialog").evaluate((dialog) => dialog.open)) await page.click("#close-data-dialog");
}

async function ready(page) {
  await page.waitForFunction(() => typeof vsidLayers === "object" && document.querySelector("#loading").hidden);
  await page.waitForTimeout(300);
}

// Set SHOT_DIR to a folder to keep screenshots of the panel and the popup.
async function shot(page, name) {
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
}

async function search(page, text, filter = "all") {
  await page.click(`.filter-chip[data-filter="${filter}"]`);
  await page.fill("#search-input", text);
  return page.$$eval(".result-item", (items) => items.map((item) => `${item.dataset.kind}:${item.querySelector(".result-label").textContent}`));
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 900, height: 820 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await ready(page);

  console.log("== a map update, then a VSID list ==");
  await openData(page);
  await Promise.all([
    page.waitForNavigation(),
    page.setInputFiles("#data-file-input", file("test.fieldmap.json", JSON.stringify(update), "application/json")),
  ]);
  await ready(page);
  await openData(page);
  check("no VSID list yet", await page.textContent("#vsid-summary"), "No VSID list on this device");
  check("send is off with nothing to send", await page.isDisabled("#share-vsid"), true);

  await page.setInputFiles("#vsid-file-input", file("Form Responses 1.csv", vsidCsv, "text/csv"));
  await page.waitForFunction(() => /imported/.test(document.querySelector("#vsid-status").textContent));
  check("three points drawn", await page.evaluate(() => vsidLayers.size), 3);
  check("three diamonds on the map", await page.locator(".vsid-marker").count(), 3);
  check("panel count", await page.textContent("#vsid-summary"), "3 VSID points on the map");
  check("status says what was left off", await page.textContent("#vsid-status"),
    "VSID list imported: 3 points on the map, 2 rows left off - listed above. It replaces any earlier list.");
  check("the rows left off are listed by sheet row", await page.$$eval("#vsid-problems li", (items) => items.map((item) => item.textContent)), [
    "Row 5 - Far Away Diner: far outside the map area (36.03, -115.12)",
    "Row 6 - No pin: no latitude, no longitude",
  ]);
  check("header counts VSID", (await page.textContent("#data-summary")).endsWith(" - 3 VSID"), true);
  await shot(page, "vsid-panel");
  await closeData(page);

  console.log("== search ranks VSID last ==");
  check("official address before the VSID with the same text", await search(page, "100 test rd"), ["address:100 Test Rd", "vsid:100 Test Rd"]);
  check("'vsid' finds every VSID point", (await search(page, "vsid")).length, 3);
  check("VSID chip shows only VSID", await search(page, "test rd", "vsid"), ["vsid:100 Test Rd"]);
  check("findable by the caller's number", await search(page, "6055550100", "all"), ["vsid:200 Sample St, Testville, SD"]);
  check("search result says last resort", await page.textContent(".result-item .result-subtitle"), "VSID - last resort, not verified");
  check("far-away response is not searchable", await search(page, "far away", "all"), []);

  console.log("== the popup and label say VSID ==");
  await search(page, "6055550100", "all");
  await page.click(".result-item");
  await page.waitForSelector(".vsid-popup");
  await page.waitForTimeout(700);
  check("popup badge", await page.textContent(".vsid-badge"), "VSID - last resort only");
  check("popup warning", (await page.textContent(".vsid-warning")).includes("not verified"), true);
  check("popup submitted date", await page.textContent(".vsid-submitted"), "Submitted 11/12/2026");
  check("tap to call", await page.getAttribute(".vsid-call", "href"), "tel:+16055550100");
  check("coordinate card names it VSID", await page.textContent("#coordinate-context"), "VSID (last resort): 200 Sample St, Testville, SD");
  // The three points are about a kilometre apart, so only the selected one is in view.
  check("label at street zoom", await page.$$eval(".vsid-label", (labels) => labels.map((label) => label.textContent)),
    ["VSID: 200 Sample St, Testville, SD"]);
  await shot(page, "vsid-popup");

  console.log("== it stays apart from the map update ==");
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
  check("still there after a reload", await page.evaluate(() => vsidLayers.size), 3);
  await openData(page);
  await Promise.all([page.waitForNavigation(), page.click("#reset-data")]);
  await ready(page);
  check("removing the map update keeps the VSID list", await page.locator(".vsid-marker").count(), 4);
  check("with no map to compare against, the far one shows too", await page.evaluate(() => vsidOutsideArea.length), 0);
  check("search still works on VSID alone", await page.isDisabled("#search-input"), false);

  console.log("== the wrong button and the remove button ==");
  await openData(page);
  await page.setInputFiles("#data-file-input", file("Form Responses 1.csv", vsidCsv, "text/csv"));
  check("a .csv in the update importer points to the right button", await page.textContent("#data-status"),
    "That is a VSID list, not a map update. Use Import VSID list further down.");
  await page.setInputFiles("#vsid-file-input", file("notes.csv", "Name,Notes\nA,B", "text/csv"));
  await page.waitForFunction(() => /failed/.test(document.querySelector("#vsid-status").textContent));
  check("a .csv that is not the form is refused", await page.textContent("#vsid-status"),
    "Import failed: The .csv has no Latitude and Longitude columns - is it the VSID form responses?");
  check("and the list on the phone is untouched", await page.evaluate(() => vsidLayers.size), 4);
  await page.click("#remove-vsid");
  await page.waitForFunction(() => vsidLayers.size === 0);
  check("removed", await page.textContent("#vsid-summary"), "No VSID list on this device");
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
  check("and gone after a reload", await page.locator(".vsid-marker").count(), 0);

  await browser.close();
  if (failures.length) {
    console.log(`\n${failures.length} failure(s)`);
    failures.forEach((failure) => console.log(` - ${failure}`));
    process.exit(1);
  }
  console.log("\nall VSID checks passed");
})();
