// Checks a phone that already has points on it opening the new version: the
// points survive, still work, and can be handed off straight away. Not part of `node --test`; it needs a server and Playwright:
//
//   npx http-server docs -p 8099 -s &
//   node tests/upgrade.browser.js
//
const { chromium } = require("playwright");
const URL = "http://127.0.0.1:8099/index.html";
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : ` -> ${JSON.stringify(actual)}`}`);
}

// Exactly what the shipped version writes today.
const v1 = {
  schemaVersion: 1,
  type: "field-map-collection",
  lastExportedUtc: "2026-08-30T18:00:00.000Z",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [-101.2401, 45.1702] },
      properties: { id: "collected-1756000000000-a1b2c3", kind: "collected", address: "1409 W Main St", name: "green barn",
        label: "1409 W Main St", subtitle: "Collected Aug 29, 2026 - green barn",
        collectedUtc: "2026-08-29T12:00:00.000Z", updatedUtc: "2026-08-29T12:00:00.000Z", exportedUtc: "2026-08-30T18:00:00.000Z" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-101.2500, 45.1750] },
      properties: { id: "collected-1756000100000-d4e5f6", kind: "collected", address: "", name: "gate, no mailbox",
        label: "gate, no mailbox", subtitle: "Collected Aug 31, 2026",
        collectedUtc: "2026-08-31T09:00:00.000Z", updatedUtc: "2026-08-31T09:00:00.000Z", exportedUtc: null } },
  ],
};

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 900, height: 780 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.FieldMapSync === "object");
  await page.waitForTimeout(400);

  // Put the old shape back into storage, exactly where the old version kept it.
  await page.evaluate((payload) => new Promise((resolve, reject) => {
    const request = indexedDB.open("field-map-local-data", 1);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("updates", "readwrite");
      transaction.objectStore("updates").put(payload, "collected-points");
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  }), v1);

  console.log("== a phone that already has points opens the new version ==");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof collectedState === "object" && Array.isArray(collectedState.features));
  await page.waitForTimeout(500);

  const state = await page.evaluate(() => JSON.parse(JSON.stringify(collectedState)));
  check("both points survived", state.features.map((f) => f.properties.label).sort(), ["1409 W Main St", "gate, no mailbox"]);
  check("they are on the map", await page.evaluate(() => collectedLayers.size), 2);
  check("the phone was given a name", state.deviceId.length, 5);
  check("the old ids were kept for reference", state.features.every((f) => String(f.properties.legacyId).startsWith("collected-")), true);
  check("the first hand-off carries all of them", await page.evaluate(() => FieldMapSync.pendingRecords(collectedState).length), 2);

  console.log("\n== the old points still work ==");
  await page.fill("#search-input", "green barn");
  await page.waitForTimeout(250);
  check("an old point is still searchable", /1409 W Main St/.test(await page.textContent("#search-results")), true);
  await page.click(".result-item");
  await page.waitForTimeout(600);

  const oldId = state.features.find((f) => f.properties.label === "1409 W Main St").properties.id;
  await page.evaluate((id) => { const layer = collectedLayers.get(id); openPointForm(layer.getLatLng(), id); }, oldId);
  await page.waitForSelector("#point-dialog[open]");
  check("editing an old point loads what was typed before", [
    await page.inputValue("#point-address"),
    await page.inputValue("#point-name"),
  ], ["1409 W Main St", "green barn"]);
  await page.fill("#point-address", "1409 W Main St, checked");
  await page.click("#save-point");
  await page.waitForTimeout(300);
  check("the edit stuck", await page.evaluate(() => collectedState.features.some((f) => f.properties.label === "1409 W Main St, checked")), true);

  page.on("dialog", (dialog) => dialog.accept());
  const otherId = state.features.find((f) => f.properties.label === "gate, no mailbox").properties.id;
  await page.evaluate((id) => deleteCollectedPoint(id), otherId);
  await page.waitForTimeout(300);
  check("deleting an old point works", await page.evaluate(() => collectedState.features.length), 1);
  check("and leaves a removal to hand on", await page.evaluate(() => collectedState.tombstones.length), 1);

  console.log("\n== and it can hand off straight away ==");
  await page.click("#data-button");
  await page.waitForSelector("#data-dialog[open]");
  const block = await page.inputValue("#handoff-text");
  block.split("\n").forEach((line) => console.log(`  ${line}`));
  check("the block is readable", /^EBMAP1 /.test(block) && /\nEND$/.test(block), true);
  check("it carries the surviving point and the removal", [
    (block.match(/^\+ /gm) || []).length, (block.match(/^- /gm) || []).length,
  ], [1, 1]);

  await browser.close();
  console.log(`\n${failures.length ? `FAILED (${failures.length})` : "ALL UPGRADE CHECKS PASSED"}`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(failures.length ? 1 : 0);
})();
