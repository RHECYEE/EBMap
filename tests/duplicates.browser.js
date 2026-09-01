// The question that decides whether this is usable: after weeks of merging,
// does the search fill up with the same point over and over? Needs a server
// and Playwright:
//
//   npx http-server docs -p 8099 -s &
//   node tests/duplicates.browser.js
//
const { chromium } = require("playwright");
const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> ${JSON.stringify(actual)}`}`);
};

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 900, height: 780 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  await page.goto("http://127.0.0.1:8099/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.FieldMapSync === "object");
  await page.waitForTimeout(400);

  // Build the coworker's 20 and merge them, the way Monday actually goes.
  const coworkerBlock = await page.evaluate(() => {
    const s = FieldMapSync.normalizeCollection(null, { makeDeviceId: () => "W1XQ8" });
    for (let i = 0; i < 20; i += 1) {
      FieldMapSync.upsertPoint(s, { latitude: 45.10 + i * 0.004, longitude: -101.30 + i * 0.006, address: `${100 + i * 7} County Rd` }, "2026-08-31T07:10:00Z");
    }
    return FieldMapSync.encodePacket({ deviceId: "W1XQ8", records: FieldMapSync.pendingRecords(s), generatedUtc: "2026-08-31T08:00:00Z" });
  });

  const mergeIt = async (block) => {
    await page.click("#data-button");
    await page.waitForSelector("#data-dialog[open]");
    await page.fill("#merge-text", block);
    await page.click("#check-merge");
    await page.waitForTimeout(200);
    const disabled = await page.isDisabled("#apply-merge");
    if (!disabled) { await page.click("#apply-merge"); await page.waitForTimeout(400); }
    await page.click("#close-data-dialog");
    await page.waitForTimeout(150);
    return !disabled;
  };

  console.log("== merging the coworker's 20 ==");
  await mergeIt(coworkerBlock);
  check("20 points on the map", await page.evaluate(() => collectedLayers.size), 20);
  check("20 rows in the search index", await page.evaluate(() => searchDocuments.filter((d) => d.kind === "collected").length), 20);

  console.log("\n== pasting the very same block three more times ==");
  for (let i = 0; i < 3; i += 1) {
    const applied = await mergeIt(coworkerBlock);
    check(`paste ${i + 2} was a no-op`, applied, false);
  }
  check("still 20 points", await page.evaluate(() => collectedState.features.length), 20);
  check("still 20 pins", await page.evaluate(() => collectedLayers.size), 20);
  check("still 20 search rows - nothing accumulated", await page.evaluate(() => searchDocuments.filter((d) => d.kind === "collected").length), 20);

  console.log("\n== searching for a term every one of them matches ==");
  await page.fill("#search-input", "County Rd");
  await page.waitForTimeout(300);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".result-item")].map((el) => el.dataset.id));
  check("every result is a distinct point", rows.length, new Set(rows).size);
  check("20 results, not 80", rows.length, 20);

  console.log("\n== an edited point replaces its row instead of adding one ==");
  const firstId = await page.evaluate(() => collectedState.features[0].properties.id);
  await page.evaluate((id) => { const l = collectedLayers.get(id); openPointForm(l.getLatLng(), id); }, firstId);
  await page.waitForSelector("#point-dialog[open]");
  await page.fill("#point-address", "100 County Rd, gate code 4412");
  await page.click("#save-point");
  await page.waitForTimeout(300);
  check("still 20 search rows after an edit", await page.evaluate(() => searchDocuments.filter((d) => d.kind === "collected").length), 20);
  await page.fill("#search-input", "gate code");
  await page.waitForTimeout(300);
  check("the edit is findable, once", await page.evaluate(() => document.querySelectorAll(".result-item").length), 1);

  console.log("\n== and after a reload ==");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof collectedState === "object" && collectedState.features.length);
  await page.waitForTimeout(500);
  check("20 points", await page.evaluate(() => collectedState.features.length), 20);
  check("20 search rows", await page.evaluate(() => searchDocuments.filter((d) => d.kind === "collected").length), 20);

  await browser.close();
  console.log(`\n${failures.length ? `FAILED (${failures.length})` : "NO DUPLICATES ANYWHERE"}`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(failures.length ? 1 : 0);
})();
