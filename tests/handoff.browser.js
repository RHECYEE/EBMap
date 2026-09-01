// Drives the real app in a browser: two phones, collected in the field, handed
// off by text. Not part of `node --test`; it needs a server and Playwright:
//
//   npx http-server docs -p 8099 -s &
//   node tests/handoff.browser.js
//
const { chromium } = require("playwright");

const URL = "http://127.0.0.1:8099/index.html";
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : ` -> ${JSON.stringify(actual)}`}`);
}

async function openPhone(browser, name) {
  const context = await browser.newContext({ viewport: { width: 900, height: 780 }, permissions: [] });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`${name} page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/tile|favicon|net::ERR/i.test(message.text())) {
      failures.push(`${name} console error: ${message.text()}`);
    }
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.FieldMapSync === "object" && document.querySelector("#collect-button"));
  await page.waitForTimeout(400);
  return { name, context, page };
}

// Collects a point by actually using the app: pin button, tap the map, fill in
// the form, save.
async function collect(phone, x, y, address, pointName = "") {
  const { page } = phone;
  await page.click("#collect-button");
  await page.mouse.click(x, y);
  await page.waitForSelector("#point-dialog[open]");
  await page.fill("#point-address", address);
  if (pointName) await page.fill("#point-name", pointName);
  await page.click("#save-point");
  await page.waitForSelector("#point-dialog[open]", { state: "detached" }).catch(() => {});
  await page.waitForTimeout(120);
}

async function openData(phone) {
  await phone.page.click("#data-button");
  await phone.page.waitForSelector("#data-dialog[open]");
}

async function closeData(phone) {
  await phone.page.click("#close-data-dialog");
  await phone.page.waitForTimeout(100);
}

const liveLabels = (phone) => phone.page.evaluate(() => collectedState.features.map((f) => f.properties.label).sort());
const stateOf = (phone) => phone.page.evaluate(() => JSON.parse(JSON.stringify(collectedState)));

(async () => {
  const browser = await chromium.launch();
  const me = await openPhone(browser, "me");
  const johnny = await openPhone(browser, "johnny");

  console.log("\n== each phone gets its own name ==");
  const myId = (await stateOf(me)).deviceId;
  const hisId = (await stateOf(johnny)).deviceId;
  check("device ids are 5 characters", [myId.length, hisId.length], [5, 5]);
  check("the two phones have different names", myId !== hisId, true);

  console.log("\n== I collect 5 points ==");
  const spots = [[420, 300], [500, 340], [560, 420], [430, 470], [600, 300]];
  const names = ["1409 W Main St", "1412 W Main St", "220 Cutbank Rd", "18 Ridge Access", "77 Mile Rd"];
  for (let i = 0; i < spots.length; i += 1) await collect(me, spots[i][0], spots[i][1], names[i]);
  check("I have 5 points", (await liveLabels(me)).length, 5);

  console.log("\n== Johnny collects 3: two new, one on top of my first ==");
  await collect(johnny, 640, 480, "310 Coulee Rd");
  await collect(johnny, 380, 520, "412 Section Line Rd");
  // He drives to the same driveway I already pinned and drops his own pin a
  // couple of metres off, not knowing mine exists. Zoom in so a few pixels is
  // a few metres, the way it would be on a phone standing at the gate.
  const mineFirst = await me.page.evaluate(() => {
    const feature = collectedState.features.find((f) => f.properties.label === "1409 W Main St");
    return { latitude: FieldMapSync.featureLatitude(feature), longitude: FieldMapSync.featureLongitude(feature) };
  });
  await johnny.page.evaluate((at) => map.setView([at.latitude, at.longitude], 18), mineFirst);
  await johnny.page.waitForTimeout(300);
  await collect(johnny, 454, 393, "1409 West Main Street", "same driveway as the barn");
  check("Johnny has 3 points", (await liveLabels(johnny)).length, 3);
  const apart = await johnny.page.evaluate((at) => {
    const feature = collectedState.features.find((f) => f.properties.label === "1409 West Main Street");
    return Math.round(FieldMapSync.distanceMetres(at, FieldMapSync.featurePosition(feature)));
  }, mineFirst);
  console.log(`  his pin is ${apart} m from mine`);
  check("his pin is close enough to be the same place", apart > 0 && apart < 25, true);

  console.log("\n== I hand off: copy the block ==");
  await openData(me);
  const scopeNote = await me.page.textContent("#handoff-scope-note");
  check("the default scope is what changed since last time", /since you last handed off/.test(scopeNote), true);
  const block = await me.page.inputValue("#handoff-text");
  check("the block has a header, 5 points and an END", [
    /^EBMAP1 /.test(block),
    (block.match(/^\+ /gm) || []).length,
    /\nEND$/.test(block),
  ], [true, 5, true]);
  await me.page.click("#copy-handoff");
  await me.page.waitForTimeout(150);
  // The block stays put: both people going off shift send to whoever is coming
  // on, and that person passes the same text to their partner and the crew
  // after them. It only clears when a person says everyone has it.
  check("the block survives being copied, for the next recipient", await me.page.inputValue("#handoff-text"), block);
  check("copy is still available", await me.page.isDisabled("#copy-handoff"), false);
  await me.page.click("#finish-handoff");
  await me.page.waitForTimeout(200);
  check("closing it empties the block", await me.page.inputValue("#handoff-text"), "Nothing new since your last hand-off was closed.");
  await closeData(me);

  console.log("\n== Johnny pastes it in and checks before merging ==");
  await openData(johnny);
  await johnny.page.fill("#merge-text", `Here you go, thanks\n\n${block}\n\nSee you tomorrow`);
  await johnny.page.click("#check-merge");
  await johnny.page.waitForSelector("#merge-preview:not([hidden])");
  const preview = (await johnny.page.textContent("#merge-preview")).replace(/\s+/g, " ").trim();
  console.log(`  preview: ${preview}`);
  check("the preview says 5 new points", /5\s*new points/.test(preview), true);
  check("the preview warns about the duplicate", /within 25 m/.test(preview), true);
  check("nothing has changed yet", (await liveLabels(johnny)).length, 3);

  await johnny.page.click("#apply-merge");
  await johnny.page.waitForTimeout(250);
  const afterMerge = await liveLabels(johnny);
  check("Johnny now has 8 points", afterMerge.length, 8);
  check("the merge is reported", /5 points added/.test(await johnny.page.textContent("#merge-status")), true);
  check("Johnny's map shows 8 pins", await johnny.page.evaluate(() => collectedLayers.size), 8);

  console.log("\n== Johnny deletes the duplicate he collected ==");
  const duplicateId = await johnny.page.evaluate(() => collectedState.features
    .find((f) => f.properties.label === "1409 West Main Street").properties.id);
  johnny.page.on("dialog", (dialog) => dialog.accept());
  await johnny.page.evaluate((id) => deleteCollectedPoint(id), duplicateId);
  await johnny.page.waitForTimeout(250);
  check("Johnny is down to 7", (await liveLabels(johnny)).length, 7);
  check("the removal is remembered so it cannot come back", (await stateOf(johnny)).tombstones.length, 1);

  console.log("\n== Johnny hands back: his 3 changes, not my 5 ==");
  const backBlock = await johnny.page.inputValue("#handoff-text");
  console.log("  ----------------------------------------");
  backBlock.split("\n").forEach((line) => console.log(`  ${line}`));
  console.log("  ----------------------------------------");
  // His first ever hand-off carries everything he holds, mine included, because
  // whoever takes over from him needs all of it. Mine are marked as mine.
  check("it carries his 2, my 5 relayed, and the removal", [
    (backBlock.match(/^\+ /gm) || []).length,
    (backBlock.match(/^- /gm) || []).length,
    (backBlock.match(/@/g) || []).length,
  ], [7, 1, 5]);
  await johnny.page.click("#copy-handoff");
  await johnny.page.waitForTimeout(150);
  await johnny.page.click("#finish-handoff");
  await johnny.page.waitForTimeout(200);
  check("once he closes it, he has nothing left to hand off", await johnny.page.inputValue("#handoff-text"), "Nothing new since your last hand-off was closed.");
  await closeData(johnny);

  console.log("\n== I take his hand-off ==");
  await openData(me);
  await me.page.fill("#merge-text", backBlock);
  await me.page.click("#check-merge");
  await me.page.waitForSelector("#merge-preview:not([hidden])");
  const backPreview = (await me.page.textContent("#merge-preview")).replace(/\s+/g, " ").trim();
  console.log(`  preview: ${backPreview}`);
  check("my own 5 come back as points I already have, not as changes", /5\s*you already have/.test(backPreview), true);
  check("his 2 are new to me", /2\s*new points/.test(backPreview), true);
  // The pin he deleted was his own copy of the driveway, so there is nothing of
  // mine to remove - I just quietly record that it is gone so it cannot return.
  check("nothing of mine is removed", /point removed/.test(backPreview), false);
  await me.page.click("#apply-merge");
  await me.page.waitForTimeout(250);

  const mine = await liveLabels(me);
  const his = await liveLabels(johnny);
  check("I have 7 points", mine.length, 7);
  check("we hold exactly the same map", mine, his);
  check("my map shows 7 pins", await me.page.evaluate(() => collectedLayers.size), 7);
  // His two points are now mine to pass on to whoever I hand over to next.
  // That is one onward hop, not a bounce: once I have handed off, it is empty.
  const onward = await me.page.inputValue("#handoff-text");
  check("I carry his work onward once", (onward.match(/^\+ /gm) || []).length, 2);
  await me.page.click("#copy-handoff");
  await me.page.waitForTimeout(150);
  await me.page.click("#finish-handoff");
  await me.page.waitForTimeout(200);
  check("and then there is nothing left to send", await me.page.inputValue("#handoff-text"), "Nothing new since your last hand-off was closed.");

  console.log("\n== swapping again with nothing new costs nothing ==");
  const settled = await me.page.evaluate(() => FieldMapSync.encodePacket({
    deviceId: collectedState.deviceId,
    generatedUtc: new Date().toISOString(),
    records: FieldMapSync.pendingRecords(collectedState, { full: true }),
  }));
  await johnny.page.evaluate(() => { document.querySelector("#data-button").click(); });
  await johnny.page.waitForSelector("#data-dialog[open]");
  await johnny.page.fill("#merge-text", settled);
  await johnny.page.click("#check-merge");
  await johnny.page.waitForTimeout(150);
  const settledPreview = (await johnny.page.textContent("#merge-preview")).replace(/\s+/g, " ").trim();
  console.log(`  preview: ${settledPreview}`);
  check("a full re-send of a settled map changes nothing", await johnny.page.isDisabled("#apply-merge"), true);
  check("and says so plainly", /Nothing in this hand-off is new to you/.test(settledPreview), true);

  console.log("\n== the duplicate stays gone at the next swap ==");
  const replay = await me.page.evaluate(() => FieldMapSync.encodePacket({
    deviceId: "OLDPH",
    generatedUtc: new Date().toISOString(),
    records: [{ op: "upsert", id: "STALE-1", latitude: 45.2, longitude: -101.3, updatedUtc: "2026-08-01T10:00:00.000Z", address: "unrelated", name: "" }],
  }));
  await me.page.fill("#merge-text", replay);
  await me.page.click("#check-merge");
  await me.page.click("#apply-merge");
  await me.page.waitForTimeout(200);
  check("an unrelated hand-off still merges normally", (await liveLabels(me)).length, 8);

  console.log("\n== searching finds a collected point ==");
  await closeData(me);
  await me.page.fill("#search-input", "Coulee");
  await me.page.waitForTimeout(250);
  const results = await me.page.textContent("#search-results");
  check("Johnny's point is searchable on my phone", /310 Coulee Rd/.test(results), true);
  await me.page.click(".filter-chip[data-filter='collected']");
  await me.page.waitForTimeout(200);
  check("the Collected filter still finds it", /310 Coulee Rd/.test(await me.page.textContent("#search-results")), true);

  console.log("\n== it all survives closing the app ==");
  await me.page.reload({ waitUntil: "domcontentloaded" });
  await me.page.waitForFunction(() => typeof collectedState === "object" && collectedState.features);
  await me.page.waitForTimeout(400);
  check("points are still there after a reload", (await liveLabels(me)).length, 8);
  check("the phone kept its name", (await stateOf(me)).deviceId, myId);

  console.log("\n== a mangled paste is refused, not half-merged ==");
  await openData(me);
  await me.page.fill("#merge-text", "no hand-off text in here at all");
  await me.page.click("#check-merge");
  await me.page.waitForTimeout(150);
  check("junk text is rejected with an explanation", /No hand-off text found/.test(await me.page.textContent("#merge-status")), true);
  check("merge stays disabled", await me.page.isDisabled("#apply-merge"), true);

  await browser.close();

  console.log(`\n${failures.length ? `FAILED (${failures.length})` : "ALL BROWSER CHECKS PASSED"}`);
  failures.forEach((failure) => console.log(`  - ${failure}`));
  process.exit(failures.length ? 1 : 0);
})();
