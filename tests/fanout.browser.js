// One block going to several people: both crews going off shift send to the
// one coming on, who passes the same text to their partner and the pair after
// them. Needs a server and Playwright:
//
//   npx http-server docs -p 8099 -s &
//   node tests/fanout.browser.js
//
const { chromium } = require("playwright");
const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> ${JSON.stringify(actual)}`}`);
};

async function phone(browser, label) {
  const context = await browser.newContext({ viewport: { width: 900, height: 780 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => failures.push(`${label}: ${e.message}`));
  await page.goto("http://127.0.0.1:8099/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.FieldMapSync === "object" && document.querySelector("#collect-button"));
  await page.waitForTimeout(300);
  await page.click("#data-button");
  await page.waitForSelector("#data-dialog[open]");
  return { label, page };
}
const add = (p, address, lat, lon) => p.page.evaluate(async (a) => {
  FieldMapSync.upsertPoint(collectedState, { latitude: a.lat, longitude: a.lon, address: a.address });
  await persistCollectedPoints(); renderAllCollectedPoints();
}, { address, lat, lon });
const count = (p) => p.page.evaluate(() => collectedState.features.length);
const labels = (p) => p.page.evaluate(() => collectedState.features.map((f) => f.properties.label).sort());
const block = (p) => p.page.inputValue("#handoff-text");

async function takeFrom(p, text) {
  await p.page.fill("#merge-text", text);
  await p.page.click("#check-merge");
  await p.page.waitForTimeout(200);
  if (!(await p.page.isDisabled("#apply-merge"))) { await p.page.click("#apply-merge"); await p.page.waitForTimeout(300); }
}

(async () => {
  const browser = await chromium.launch();
  // Two going off shift, two coming on, and the pair after them.
  const [a, b, c, d, e, f] = await Promise.all(["A", "B", "C", "D", "E", "F"].map((l) => phone(browser, l)));

  console.log("== A and B both collect on their shift ==");
  await add(a, "1409 W Main St", 45.1702, -101.2401);
  await add(a, "220 Cutbank Rd", 45.1910, -101.2105);
  await add(b, "310 Coulee Rd", 45.2240, -101.1880);
  check("A has 2, B has 1", [await count(a), await count(b)], [2, 1]);

  console.log("\n== both of them send to C, the one coming on ==");
  const fromA = await block(a);
  const fromB = await block(b);
  await takeFrom(c, fromA);
  await takeFrom(c, fromB);
  check("C has all 3", await count(c), 3);

  console.log("\n== C copies once, and sends the SAME block to three people ==");
  await c.page.click("#copy-handoff");
  await c.page.waitForTimeout(200);
  const firstCopy = await block(c);
  check("the block did not empty after copying", firstCopy.startsWith("EBMAP1"), true);
  check("it offers to close the hand-off", await c.page.isVisible("#finish-handoff"), true);
  check("the status says it works for everyone", /works for everyone taking over/.test(await c.page.textContent("#handoff-status")), true);

  await c.page.click("#copy-handoff");
  await c.page.waitForTimeout(200);
  check("copying again gives the identical block", await block(c), firstCopy);

  // Partner, and the two coming on after them.
  await takeFrom(d, firstCopy);
  await takeFrom(e, firstCopy);
  await takeFrom(f, firstCopy);
  check("partner D has all 3", await count(d), 3);
  check("oncoming E has all 3", await count(e), 3);
  check("oncoming F has all 3", await count(f), 3);
  check("and they match C exactly", [await labels(d), await labels(e), await labels(f)], [await labels(c), await labels(c), await labels(c)]);

  console.log("\n== C collects one more while the hand-off is still open ==");
  await add(c, "77 Mile Rd", 45.2031, -101.1987);
  await c.page.waitForTimeout(200);
  const grown = await block(c);
  check("the block now carries all 4, not just the new one", (grown.match(/^\+ /gm) || []).length, 4);
  check("nothing that was already sent got dropped", /1409 W Main St/.test(grown) && /310 Coulee Rd/.test(grown) && /77 Mile Rd/.test(grown), true);
  check("and it no longer looks already-sent", await c.page.isHidden("#finish-handoff"), true);

  console.log("\n== C closes the hand-off once the whole crew has it ==");
  await c.page.click("#copy-handoff");
  await c.page.waitForTimeout(200);
  await takeFrom(d, await block(c));
  await c.page.click("#finish-handoff");
  await c.page.waitForTimeout(300);
  check("the block is now empty", await block(c), "Nothing new since your last hand-off was closed.");
  check("the close is confirmed", /Hand-off closed/.test(await c.page.textContent("#handoff-status")), true);

  console.log("\n== next shift, C collects one thing and hands off again ==");
  await add(c, "18 Ridge Access", 45.1604, -101.2660);
  await c.page.waitForTimeout(200);
  const nextBlock = await block(c);
  console.log(nextBlock.split("\n").map((l) => `    ${l}`).join("\n"));
  check("only the one new point goes out", (nextBlock.match(/^\+ /gm) || []).length, 1);

  await browser.close();
  console.log(`\n${failures.length ? `FAILED (${failures.length})` : "FAN-OUT WORKS"}`);
  failures.forEach((x) => console.log(`  - ${x}`));
  process.exit(failures.length ? 1 : 0);
})();
