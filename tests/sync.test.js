"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("../docs/sync.js");

// A device with a fixed name, so tie-breaks and ids are predictable in tests.
function device(deviceId) {
  const state = sync.emptyCollection(deviceId);
  return state;
}

function addPoint(state, input, when) {
  return sync.upsertPoint(state, input, when);
}

function handOff(state, options = {}) {
  const records = sync.pendingRecords(state, options);
  const text = sync.encodePacket({ deviceId: state.deviceId, records, generatedUtc: options.now || "2026-09-01T14:22:00.000Z" });
  sync.markShared(state, options.now || "2026-09-01T14:22:00.000Z");
  return text;
}

function receive(state, text, now = "2026-09-01T15:00:00.000Z") {
  const packet = sync.decodePacket(text);
  assert.equal(packet.ok, true, packet.error);
  return sync.applyMerge(state, packet, now);
}

function labels(state) {
  return state.features.map((feature) => feature.properties.label).sort();
}

// --- stamps and coordinates -------------------------------------------------

test("stamps round trip to the minute in UTC", () => {
  assert.equal(sync.encodeStamp("2026-09-01T14:22:37.500Z"), "2609011422");
  assert.equal(sync.decodeStamp("2609011422"), "2026-09-01T14:22:00.000Z");
});

test("a nonsense stamp is rejected rather than guessed at", () => {
  assert.equal(sync.decodeStamp("2613011422"), null);
  assert.equal(sync.decodeStamp("260901142"), null);
  assert.equal(sync.decodeStamp("2609311422"), null);
  assert.equal(sync.encodeStamp("not a date"), null);
});

// --- the text format --------------------------------------------------------

test("a packet round trips through text", () => {
  const state = device("K7Q2M");
  addPoint(state, { latitude: 45.171234, longitude: -101.238899, address: "1409 W Main St", name: "Smith barn" }, "2026-09-01T14:01:00.000Z");
  addPoint(state, { latitude: 45.180011, longitude: -101.241002, address: "1412 W Main St" }, "2026-09-01T14:05:00.000Z");

  const text = handOff(state);
  const packet = sync.decodePacket(text);

  assert.equal(packet.ok, true);
  assert.equal(packet.origin, "K7Q2M");
  assert.equal(packet.checksumOk, true);
  assert.deepEqual(packet.warnings, []);
  assert.equal(packet.records.length, 2);
  assert.equal(packet.records[0].address, "1409 W Main St");
  assert.equal(packet.records[0].name, "Smith barn");
  assert.equal(packet.records[1].name, "");
  assert.ok(Math.abs(packet.records[0].latitude - 45.171234) < 0.00001);
  assert.ok(Math.abs(packet.records[0].longitude - -101.238899) < 0.00001);
});

test("a name with no address survives the round trip", () => {
  const state = device("K7Q2M");
  addPoint(state, { latitude: 45.1, longitude: -101.2, name: "green gate, no mailbox" }, "2026-09-01T14:01:00.000Z");
  const packet = sync.decodePacket(handOff(state));
  assert.equal(packet.records[0].address, "");
  assert.equal(packet.records[0].name, "green gate, no mailbox");
});

test("a pipe inside an address does not split the field", () => {
  const state = device("K7Q2M");
  addPoint(state, { latitude: 45.1, longitude: -101.2, address: "Lot 3 | rear", name: "back shed" }, "2026-09-01T14:01:00.000Z");
  const packet = sync.decodePacket(handOff(state));
  assert.equal(packet.records[0].address, "Lot 3 | rear");
  assert.equal(packet.records[0].name, "back shed");
});

test("the block is read out of a quoted reply with an email wrapped around it", () => {
  const state = device("K7Q2M");
  addPoint(state, { latitude: 45.171234, longitude: -101.238899, address: "1409 W Main St" }, "2026-09-01T14:01:00.000Z");
  const block = handOff(state);

  const email = [
    "Hi - here is the handoff from today, see below.",
    "",
    "On Tuesday, someone wrote:",
    ...block.split("\n").map((line) => `> ${line}`),
    "",
    "Thanks,",
    "Dispatch",
  ].join("\n");

  const packet = sync.decodePacket(email);
  assert.equal(packet.ok, true);
  assert.equal(packet.records.length, 1);
  assert.equal(packet.checksumOk, true);
  assert.deepEqual(packet.warnings, []);
});

test("a line the mail client wrapped is joined back together", () => {
  const state = device("K7Q2M");
  addPoint(state, { latitude: 45.171234, longitude: -101.238899, address: "14099 West Rural Access Road Northeast", name: "second gate past the cattle guard" }, "2026-09-01T14:01:00.000Z");
  const block = handOff(state);

  const lines = block.split("\n");
  const pointLine = lines[1];
  const cut = pointLine.lastIndexOf(" ", 60);
  const wrapped = [lines[0], pointLine.slice(0, cut), pointLine.slice(cut + 1), lines[2]].join("\n");

  const packet = sync.decodePacket(wrapped);
  assert.equal(packet.ok, true);
  assert.equal(packet.records.length, 1);
  assert.equal(packet.records[0].address, "14099 West Rural Access Road Northeast");
  assert.equal(packet.records[0].name, "second gate past the cattle guard");
  assert.equal(packet.checksumOk, true);
});

test("text with no block in it is refused with an explanation", () => {
  const packet = sync.decodePacket("just a normal message about the map");
  assert.equal(packet.ok, false);
  assert.match(packet.error, /No hand-off text/);
});

test("a truncated paste reports what is missing and keeps what arrived", () => {
  const state = device("K7Q2M");
  addPoint(state, { latitude: 45.10, longitude: -101.20, address: "one" }, "2026-09-01T14:01:00.000Z");
  addPoint(state, { latitude: 45.11, longitude: -101.21, address: "two" }, "2026-09-01T14:02:00.000Z");
  addPoint(state, { latitude: 45.12, longitude: -101.22, address: "three" }, "2026-09-01T14:03:00.000Z");
  const lines = handOff(state).split("\n");

  const truncated = lines.slice(0, 3).join("\n");
  const packet = sync.decodePacket(truncated);

  assert.equal(packet.ok, true);
  assert.equal(packet.records.length, 2);
  assert.equal(packet.checksumOk, false);
  assert.ok(packet.warnings.some((warning) => /3 changes but 2 could be read/.test(warning)));
});

// --- merging ----------------------------------------------------------------

test("a hand-off adds the other crew's points", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "1409 W Main St" }, "2026-09-01T14:01:00.000Z");
  addPoint(alice, { latitude: 45.20, longitude: -101.30, address: "1412 W Main St" }, "2026-09-01T14:02:00.000Z");

  const { summary } = receive(bob, handOff(alice));

  assert.equal(summary.added, 2);
  assert.equal(summary.updated, 0);
  assert.deepEqual(labels(bob), ["1409 W Main St", "1412 W Main St"]);
});

test("merging the same hand-off twice changes nothing the second time", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "1409 W Main St" }, "2026-09-01T14:01:00.000Z");
  const text = handOff(alice);

  receive(bob, text);
  const seqAfterFirst = bob.seq;
  const second = receive(bob, text);

  assert.equal(second.summary.added, 0);
  assert.equal(second.summary.unchanged, 1);
  assert.equal(bob.features.length, 1);
  assert.equal(bob.seq, seqAfterFirst, "an unchanged merge must not queue anything to send back");
});

test("the later edit wins when both crews changed the same point", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "1409 W Main" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  // Bob corrects it, and only afterwards does Alice's older correction arrive.
  sync.upsertPoint(bob, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "1409 W Main St" }, "2026-09-01T16:00:00.000Z");
  sync.upsertPoint(alice, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "1409 Main" }, "2026-09-01T15:00:00.000Z");

  const { summary } = receive(bob, handOff(alice, { now: "2026-09-01T15:05:00.000Z" }));

  assert.equal(summary.stale, 1);
  assert.equal(summary.updated, 0);
  assert.deepEqual(labels(bob), ["1409 W Main St"]);
});

test("an incoming later edit replaces what we hold", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "1409 W Main" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  sync.upsertPoint(alice, { id: point.properties.id, latitude: 45.101, longitude: -101.201, address: "1409 W Main St", name: "red gate" }, "2026-09-01T16:00:00.000Z");
  const { summary } = receive(bob, handOff(alice, { now: "2026-09-01T16:05:00.000Z" }));

  assert.equal(summary.updated, 1);
  assert.deepEqual(labels(bob), ["1409 W Main St"]);
  assert.equal(bob.features[0].properties.name, "red gate");
  assert.ok(Math.abs(sync.featureLatitude(bob.features[0]) - 45.101) < 0.00001);
});

test("a same-minute clash settles the same way on both devices", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "start" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  sync.upsertPoint(alice, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "alice version" }, "2026-09-01T16:00:10.000Z");
  sync.upsertPoint(bob, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "bob version" }, "2026-09-01T16:00:40.000Z");

  const aliceToBob = handOff(alice, { now: "2026-09-01T16:01:00.000Z" });
  const bobToAlice = handOff(bob, { now: "2026-09-01T16:01:00.000Z" });
  receive(bob, aliceToBob, "2026-09-01T16:02:00.000Z");
  receive(alice, bobToAlice, "2026-09-01T16:02:00.000Z");

  assert.deepEqual(labels(alice), labels(bob), "both devices must land on the same answer");
  assert.deepEqual(labels(bob), ["bob version"]);
});

// --- deletes ----------------------------------------------------------------

test("a delete travels and does not come back at the next hand-off", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "duplicate of the barn" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));
  assert.equal(bob.features.length, 1);

  sync.deletePoint(alice, point.properties.id, "2026-09-01T15:00:00.000Z");
  const { summary } = receive(bob, handOff(alice, { now: "2026-09-01T15:01:00.000Z" }));

  assert.equal(summary.removed, 1);
  assert.equal(bob.features.length, 0);

  // Bob still holds the tombstone, so Alice re-sending her whole list from
  // before the delete cannot resurrect it.
  const oldFull = sync.encodePacket({
    deviceId: "CCCCC",
    generatedUtc: "2026-09-01T15:30:00.000Z",
    records: [{ op: "upsert", id: point.properties.id, latitude: 45.10, longitude: -101.20, updatedUtc: "2026-09-01T14:00:00.000Z", address: "duplicate of the barn", name: "" }],
  });
  const { summary: replay } = receive(bob, oldFull, "2026-09-01T15:31:00.000Z");
  assert.equal(replay.stale, 1);
  assert.equal(bob.features.length, 0);
});

test("a point deliberately re-added after a delete comes back", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "the barn" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));
  sync.deletePoint(bob, point.properties.id, "2026-09-01T15:00:00.000Z");

  sync.upsertPoint(alice, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "the barn, it is real" }, "2026-09-01T16:00:00.000Z");
  const { summary } = receive(bob, handOff(alice, { now: "2026-09-01T16:01:00.000Z" }));

  assert.equal(summary.added, 1);
  assert.deepEqual(labels(bob), ["the barn, it is real"]);
});

test("an edit made after somebody else's delete keeps the point", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "the barn" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  sync.deletePoint(alice, point.properties.id, "2026-09-01T15:00:00.000Z");
  sync.upsertPoint(bob, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "the barn, checked on site" }, "2026-09-01T16:00:00.000Z");

  const { summary } = receive(bob, handOff(alice, { now: "2026-09-01T16:30:00.000Z" }));
  assert.equal(summary.stale, 1);
  assert.deepEqual(labels(bob), ["the barn, checked on site"]);
});

// --- only sending what is new -----------------------------------------------

test("a hand-off carries only what changed since the last one", () => {
  const alice = device("AAAAA");
  for (let index = 0; index < 100; index += 1) {
    addPoint(alice, { latitude: 45 + index / 1000, longitude: -101.2, address: `point ${index}` }, "2026-09-01T14:00:00.000Z");
  }
  const first = sync.decodePacket(handOff(alice));
  assert.equal(first.records.length, 100);

  addPoint(alice, { latitude: 46.5, longitude: -101.9, address: "the new one" }, "2026-09-02T09:00:00.000Z");
  const second = sync.decodePacket(handOff(alice, { now: "2026-09-02T09:05:00.000Z" }));

  assert.equal(second.records.length, 1, "the first hundred must not go out a second time");
  assert.equal(second.records[0].address, "the new one");

  assert.equal(sync.pendingRecords(alice).length, 0, "nothing is left to hand off");
});

test("an empty block is refused rather than merged as a no-op", () => {
  const empty = sync.encodePacket({ deviceId: "AAAAA", records: [], generatedUtc: "2026-09-02T10:00:00.000Z" });
  const packet = sync.decodePacket(empty);
  assert.equal(packet.ok, false);
  assert.match(packet.error, /no points/);
});

test("the full list is available when a phone joins the rotation", () => {
  const alice = device("AAAAA");
  addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "one" }, "2026-09-01T14:00:00.000Z");
  addPoint(alice, { latitude: 45.11, longitude: -101.21, address: "two" }, "2026-09-01T14:01:00.000Z");
  handOff(alice);

  const everything = sync.pendingRecords(alice, { full: true });
  assert.equal(everything.length, 2);
  assert.equal(sync.pendingRecords(alice).length, 0);
});

test("a full hand-off includes the deletes as well as the points", () => {
  const alice = device("AAAAA");
  const keep = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "keep" }, "2026-09-01T14:00:00.000Z");
  const drop = addPoint(alice, { latitude: 45.11, longitude: -101.21, address: "drop" }, "2026-09-01T14:01:00.000Z");
  sync.deletePoint(alice, drop.properties.id, "2026-09-01T15:00:00.000Z");

  const records = sync.pendingRecords(alice, { full: true });
  assert.equal(records.length, 2);
  assert.equal(records.filter((record) => record.op === "delete").length, 1);
  assert.equal(records.find((record) => record.op === "upsert").id, keep.properties.id);
});

test("a point picked up from one crew is passed on to the next", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const carol = device("CCCCC");

  addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "from Alice" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  // Bob adds one of his own, then hands the shift to Carol.
  addPoint(bob, { latitude: 45.30, longitude: -101.40, address: "from Bob" }, "2026-09-01T16:00:00.000Z");
  const bobToCarol = sync.decodePacket(handOff(bob, { now: "2026-09-01T17:00:00.000Z" }));

  assert.equal(bobToCarol.records.length, 2, "Bob's hand-off must carry Alice's point onward");
  receive(carol, handOff(bob, { full: true, now: "2026-09-01T17:00:00.000Z" }));
  assert.deepEqual(labels(carol), ["from Alice", "from Bob"]);
});

// --- duplicates -------------------------------------------------------------

test("a point landing on top of one we already have is flagged, not dropped", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  addPoint(bob, { latitude: 45.100000, longitude: -101.200000, address: "1409 W Main St" }, "2026-09-01T14:00:00.000Z");
  addPoint(alice, { latitude: 45.100050, longitude: -101.200000, address: "1409 West Main Street" }, "2026-09-01T14:30:00.000Z");

  const packet = sync.decodePacket(handOff(alice));
  const plan = sync.planMerge(bob, packet);

  assert.equal(plan.added.length, 1);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].existing, "1409 W Main St");
});

test("points a normal distance apart are not called duplicates", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  addPoint(bob, { latitude: 45.100, longitude: -101.200, address: "1409 W Main St" }, "2026-09-01T14:00:00.000Z");
  addPoint(alice, { latitude: 45.105, longitude: -101.200, address: "1412 W Main St" }, "2026-09-01T14:30:00.000Z");

  const plan = sync.planMerge(bob, sync.decodePacket(handOff(alice)));
  assert.equal(plan.duplicates.length, 0);
});

test("planning a merge does not change anything", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "one" }, "2026-09-01T14:00:00.000Z");

  const before = JSON.stringify(bob);
  sync.planMerge(bob, sync.decodePacket(handOff(alice)));
  assert.equal(JSON.stringify(bob), before);
});

// --- upgrading an existing phone --------------------------------------------

test("points collected before this feature are carried over and renamed", () => {
  const stored = {
    schemaVersion: 1,
    type: "field-map-collection",
    lastExportedUtc: "2026-08-30T12:00:00.000Z",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-101.2, 45.1] },
        properties: {
          id: "collected-1756000000000-a1b2c3",
          kind: "collected",
          address: "1409 W Main St",
          name: "",
          collectedUtc: "2026-08-29T12:00:00.000Z",
          updatedUtc: "2026-08-29T12:00:00.000Z",
          exportedUtc: "2026-08-30T12:00:00.000Z",
        },
      },
    ],
  };

  const state = sync.normalizeCollection(stored, { makeDeviceId: () => "K7Q2M" });

  assert.equal(state.schemaVersion, 2);
  assert.equal(state.deviceId, "K7Q2M");
  assert.equal(state.features.length, 1);
  assert.equal(state.features[0].properties.id, "K7Q2M-1");
  assert.equal(state.features[0].properties.legacyId, "collected-1756000000000-a1b2c3");
  assert.equal(state.features[0].properties.label, "1409 W Main St");
  assert.equal(state.sharedSeq, 0, "the first hand-off after upgrading should carry everything");
  assert.equal(sync.pendingRecords(state).length, 1);
});

test("a device keeps its name and its hand-off mark across restarts", () => {
  const first = sync.normalizeCollection(null, { makeDeviceId: () => "K7Q2M" });
  addPoint(first, { latitude: 45.1, longitude: -101.2, address: "one" }, "2026-09-01T14:00:00.000Z");
  sync.markShared(first, "2026-09-01T14:30:00.000Z");
  addPoint(first, { latitude: 45.2, longitude: -101.3, address: "two" }, "2026-09-01T15:00:00.000Z");

  const reloaded = sync.normalizeCollection(JSON.parse(JSON.stringify(first)), { makeDeviceId: () => "NOPE1" });

  assert.equal(reloaded.deviceId, "K7Q2M");
  assert.equal(reloaded.sharedSeq, first.sharedSeq);
  assert.equal(reloaded.seq, first.seq);
  assert.equal(sync.pendingRecords(reloaded).length, 1);
  assert.equal(sync.pendingRecords(reloaded)[0].address, "two");
});

test("unreadable stored data gives an empty collection rather than an error", () => {
  const state = sync.normalizeCollection({ features: "not a list" }, { makeDeviceId: () => "K7Q2M" });
  assert.equal(state.features.length, 0);
  assert.equal(state.tombstones.length, 0);
  assert.equal(state.deviceId, "K7Q2M");
});

test("a point with no usable position is dropped on load", () => {
  const state = sync.normalizeCollection({
    schemaVersion: 2,
    tombstones: [],
    deviceId: "K7Q2M",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [-101.2, 45.1] }, properties: { id: "K7Q2M-1", address: "good", updatedUtc: "2026-09-01T14:00:00.000Z", seq: 1 } },
      { type: "Feature", geometry: { type: "Point", coordinates: ["x", null] }, properties: { id: "K7Q2M-2", address: "bad", updatedUtc: "2026-09-01T14:00:00.000Z", seq: 2 } },
    ],
  });
  assert.equal(state.features.length, 1);
  assert.equal(state.features[0].properties.address, "good");
});

test("tombstones older than the retention window are dropped", () => {
  const state = device("K7Q2M");
  state.tombstones = [
    { id: "K7Q2M-1", deletedUtc: "2024-01-01T00:00:00.000Z", origin: "K7Q2M", seq: 1 },
    { id: "K7Q2M-2", deletedUtc: "2026-08-01T00:00:00.000Z", origin: "K7Q2M", seq: 2 },
  ];
  sync.pruneTombstones(state, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(state.tombstones.map((entry) => entry.id), ["K7Q2M-2"]);
});

// --- changes made within the same minute ------------------------------------

test("deleting a point seconds after editing it still deletes it everywhere", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "wrong place" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  sync.upsertPoint(alice, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "still wrong" }, "2026-09-01T16:00:05.000Z");
  sync.deletePoint(alice, point.properties.id, "2026-09-01T16:00:40.000Z");

  const { summary } = receive(bob, handOff(alice, { full: true, now: "2026-09-01T16:01:00.000Z" }));
  assert.equal(summary.removed, 1);
  assert.equal(bob.features.length, 0);
});

test("re-adding a point seconds after deleting it brings it back everywhere", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "the barn" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  sync.deletePoint(alice, point.properties.id, "2026-09-01T16:00:05.000Z");
  sync.upsertPoint(alice, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "the barn, deleted by mistake" }, "2026-09-01T16:00:40.000Z");

  assert.equal(alice.tombstones.length, 0, "the point is live again, so no tombstone should remain");
  const { summary } = receive(bob, handOff(alice, { full: true, now: "2026-09-01T16:01:00.000Z" }));
  assert.equal(summary.added + summary.updated, 1);
  assert.deepEqual(labels(bob), ["the barn, deleted by mistake"]);
});

test("a point is never both live and deleted on the same device", () => {
  const alice = device("AAAAA");
  const point = addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "one" }, "2026-09-01T14:00:00.000Z");
  sync.deletePoint(alice, point.properties.id, "2026-09-01T15:00:00.000Z");
  sync.upsertPoint(alice, { id: point.properties.id, latitude: 45.10, longitude: -101.20, address: "one again" }, "2026-09-01T16:00:00.000Z");

  const records = sync.pendingRecords(alice, { full: true });
  assert.equal(records.length, 1);
  assert.equal(records[0].op, "upsert");
});

// --- everybody ends up with the same map ------------------------------------

test("crews swapping in any order converge on the same points", () => {
  // A small deterministic shuffle, so a failure can be reproduced exactly.
  let seed = 20260901;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];

  const crews = ["AAAAA", "BBBBB", "CCCCC", "DDDDD"].map(device);
  const start = new Date("2026-09-01T08:00:00.000Z").getTime();
  let minute = 0;

  for (let step = 0; step < 400; step += 1) {
    minute += 1 + Math.floor(random() * 3);
    const now = new Date(start + minute * 60000).toISOString();
    const crew = pick(crews);
    const roll = random();

    if (roll < 0.4) {
      sync.upsertPoint(crew, {
        latitude: 45 + Math.floor(random() * 40) / 100,
        longitude: -101 - Math.floor(random() * 40) / 100,
        address: `point ${step}`,
      }, now);
    } else if (roll < 0.6 && crew.features.length) {
      const target = pick(crew.features);
      sync.upsertPoint(crew, {
        id: target.properties.id,
        latitude: sync.featureLatitude(target),
        longitude: sync.featureLongitude(target),
        address: `edited at ${step}`,
      }, now);
    } else if (roll < 0.7 && crew.features.length) {
      sync.deletePoint(crew, pick(crew.features).properties.id, now);
    } else {
      // A hand-off to somebody else, sometimes the full list, sometimes only
      // what has changed since this crew last handed over.
      const other = pick(crews.filter((entry) => entry !== crew));
      const full = random() < 0.25;
      const records = sync.pendingRecords(crew, { full });
      if (!records.length) continue;
      const text = sync.encodePacket({ deviceId: crew.deviceId, records, generatedUtc: now });
      sync.markShared(crew, now);
      const packet = sync.decodePacket(text);
      assert.equal(packet.ok, true, packet.error);
      assert.equal(packet.checksumOk, true);
      sync.applyMerge(other, packet, now);
    }
  }

  // Settle: everyone sends everything to everyone, twice, so every change has
  // reached every device.
  const settleTime = new Date(start + (minute + 1000) * 60000).toISOString();
  for (let round = 0; round < 2; round += 1) {
    crews.forEach((from) => {
      const text = sync.encodePacket({
        deviceId: from.deviceId,
        records: sync.pendingRecords(from, { full: true }),
        generatedUtc: settleTime,
      });
      crews.filter((entry) => entry !== from).forEach((to) => {
        sync.applyMerge(to, sync.decodePacket(text), settleTime);
      });
    });
  }

  const expected = labels(crews[0]);
  assert.ok(expected.length > 20, `the run should leave a real map behind, got ${expected.length}`);
  crews.forEach((crew) => {
    assert.deepEqual(labels(crew), expected, `${crew.deviceId} disagrees with ${crews[0].deviceId}`);
  });
});

// --- passing a point on down a chain ----------------------------------------

test("a relayed point still belongs to the crew who collected it", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "the barn" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  const relayed = handOff(bob, { now: "2026-09-01T15:00:00.000Z" });
  assert.match(relayed, /@AAAAA/, "the line should name Alice, not Bob");
  assert.equal(sync.decodePacket(relayed).records[0].origin, "AAAAA");
});

test("a point handed back to the crew who made it is not a change", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "the barn" }, "2026-09-01T14:00:00.000Z");
  receive(bob, handOff(alice));

  const before = alice.seq;
  const { summary } = receive(alice, handOff(bob, { now: "2026-09-01T15:00:00.000Z" }));

  assert.equal(summary.updated, 0);
  assert.equal(summary.unchanged, 1);
  assert.equal(alice.seq, before, "nothing new should be queued to send back again");
});

test("a point round-tripping between two crews settles instead of bouncing", () => {
  const alice = device("AAAAA");
  const bob = device("BBBBB");
  addPoint(alice, { latitude: 45.10, longitude: -101.20, address: "the barn" }, "2026-09-01T14:00:00.000Z");

  // Alice hands over. Bob now holds it, and passes it on to whoever is next -
  // which this time happens to be Alice again.
  receive(bob, handOff(alice, { now: "2026-09-01T14:10:00.000Z" }), "2026-09-01T14:11:00.000Z");
  assert.equal(sync.pendingRecords(bob).length, 1, "Bob should carry it onward once");

  receive(alice, handOff(bob, { now: "2026-09-01T14:20:00.000Z" }), "2026-09-01T14:21:00.000Z");
  assert.equal(sync.pendingRecords(alice).length, 0, "it is Alice's own point coming home; nothing to pass on");
  assert.equal(sync.pendingRecords(bob).length, 0, "Bob has already handed it over");

  assert.deepEqual(labels(alice), ["the barn"]);
  assert.deepEqual(labels(bob), ["the barn"]);
});

test("an author mark is optional, and an address is never mistaken for one", () => {
  const withoutMark = ["EBMAP1 AAAAA 2609011422 1 XXXX", "+ AAAAA-2 45.10000 -101.20000 2609011400 12345 Main St", "END"].join("\n");
  const packet = sync.decodePacket(withoutMark);
  assert.equal(packet.records[0].origin, "AAAAA", "with no mark the sender is the author");
  assert.equal(packet.records[0].address, "12345 Main St", "a numeric house number is not an author");
  assert.equal(sync.readAuthor("@AAAAA"), "AAAAA");
  assert.equal(sync.readAuthor("12345"), "");
});

// --- a whole week, with points inherited from a third crew -------------------

function idsOf(state) {
  return state.features.map((feature) => feature.properties.id).sort();
}

function duplicateIds(state) {
  const seen = new Set();
  return state.features.map((feature) => feature.properties.id)
    .filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
}

function weekWithInheritedPoints() {
  const you = device("R4T9K");
  const johnny = device("J8M2P");
  const coworker = device("W1XQ8");

  // Monday: a third crew hands both of you the same twenty.
  for (let index = 0; index < 20; index += 1) {
    addPoint(coworker, {
      latitude: 45.10 + index * 0.004,
      longitude: -101.30 + index * 0.006,
      address: `${100 + index * 7} County Rd`,
    }, "2026-08-31T07:10:00.000Z");
  }
  const monday = handOff(coworker, { now: "2026-08-31T08:00:00.000Z" });
  receive(you, monday, "2026-08-31T08:05:00.000Z");
  receive(johnny, monday, "2026-08-31T08:06:00.000Z");

  // Tuesday: you collect five, Johnny three, one of his on a driveway you
  // already pinned.
  ["1409 W Main St", "1412 W Main St", "220 Cutbank Rd", "18 Ridge Access", "77 Mile Rd"]
    .forEach((address, index) => addPoint(you, {
      latitude: 45.17 + index * 0.008, longitude: -101.24 - index * 0.006, address,
    }, `2026-09-01T08:${String(10 + index * 6).padStart(2, "0")}:00.000Z`));
  addPoint(johnny, { latitude: 45.22400, longitude: -101.18800, address: "310 Coulee Rd" }, "2026-09-01T09:05:00.000Z");
  addPoint(johnny, { latitude: 45.14100, longitude: -101.29500, address: "412 Section Line Rd" }, "2026-09-01T09:20:00.000Z");
  addPoint(johnny, { latitude: 45.17002, longitude: -101.24004, address: "1409 West Main Street", name: "big green barn" }, "2026-09-01T09:41:00.000Z");

  return { you, johnny, coworker };
}

test("the twenty inherited points do not turn into duplicates", () => {
  const { you, johnny } = weekWithInheritedPoints();
  const inherited = (state) => idsOf(state).filter((id) => id.startsWith("W1XQ8-"));
  assert.equal(inherited(you).length, 20);
  assert.deepEqual(inherited(you), inherited(johnny), "you both hold the same twenty records, under the same ids");

  const yours = handOff(you, { now: "2026-09-01T17:00:00.000Z" });
  const { summary } = receive(johnny, yours, "2026-09-01T17:05:00.000Z");

  assert.equal(summary.added, 5);
  assert.equal(summary.duplicates, 1, "only the driveway you both pinned is flagged");
  assert.equal(johnny.features.length, 28);
  assert.deepEqual(duplicateIds(johnny), [], "no record appears twice");
});

test("a week of swapping leaves both crews with the same map and no losses", () => {
  const { you, johnny } = weekWithInheritedPoints();
  receive(johnny, handOff(you, { now: "2026-09-01T17:00:00.000Z" }), "2026-09-01T17:05:00.000Z");

  const duplicate = johnny.features.find((feature) => feature.properties.label === "1409 West Main Street");
  sync.deletePoint(johnny, duplicate.properties.id, "2026-09-01T17:12:00.000Z");
  receive(you, handOff(johnny, { now: "2026-09-01T17:15:00.000Z" }), "2026-09-01T17:20:00.000Z");

  assert.equal(you.features.length, 27, "20 inherited + your 5 + his 3, less the one duplicate removed");
  assert.deepEqual(idsOf(you), idsOf(johnny));
  assert.deepEqual(duplicateIds(you), []);
  assert.deepEqual(labels(you).filter((label) => /1409/.test(label)), ["1409 W Main St"], "one pin on that driveway, not two");
});

test("pasting the same block again, or a full re-send, changes nothing", () => {
  const { you, johnny, coworker } = weekWithInheritedPoints();
  const yours = handOff(you, { now: "2026-09-01T17:00:00.000Z" });
  receive(johnny, yours, "2026-09-01T17:05:00.000Z");
  const before = johnny.features.length;

  const again = receive(johnny, yours, "2026-09-01T17:06:00.000Z");
  assert.equal(again.summary.changes, 0, "a second paste of the same text is a no-op");
  assert.equal(johnny.features.length, before);

  const everything = sync.encodePacket({
    deviceId: coworker.deviceId,
    records: sync.pendingRecords(coworker, { full: true }),
    generatedUtc: "2026-09-07T08:00:00.000Z",
  });
  const resent = receive(johnny, everything, "2026-09-07T08:05:00.000Z");
  assert.equal(resent.summary.changes, 0, "the coworker re-sending the lot adds nothing");
  assert.equal(johnny.features.length, before);
  assert.deepEqual(duplicateIds(johnny), []);
});

// --- one block, several recipients ------------------------------------------

test("one block can be handed to several people, and stays valid until closed", () => {
  const outgoing = device("AAAAA");
  addPoint(outgoing, { latitude: 45.10, longitude: -101.20, address: "one" }, "2026-09-01T14:00:00.000Z");
  addPoint(outgoing, { latitude: 45.11, longitude: -101.21, address: "two" }, "2026-09-01T14:05:00.000Z");

  // Copying does not close the hand-off, so the same text serves everybody.
  const records = sync.pendingRecords(outgoing);
  const text = sync.encodePacket({ deviceId: outgoing.deviceId, records, generatedUtc: "2026-09-01T15:00:00.000Z" });
  assert.equal(sync.pendingRecords(outgoing).length, 2, "still on offer after being copied");

  const crew = [device("BBBBB"), device("CCCCC"), device("DDDDD")];
  crew.forEach((phone) => receive(phone, text, "2026-09-01T15:05:00.000Z"));
  crew.forEach((phone) => assert.deepEqual(labels(phone), ["one", "two"], `${phone.deviceId} got the lot`));

  // Work collected before it is closed joins the same block, so a late
  // recipient is not left short.
  addPoint(outgoing, { latitude: 45.12, longitude: -101.22, address: "three" }, "2026-09-01T15:30:00.000Z");
  const grown = sync.pendingRecords(outgoing);
  assert.equal(grown.length, 3, "the earlier two are still in it");

  sync.markShared(outgoing, "2026-09-01T16:00:00.000Z");
  assert.equal(sync.pendingRecords(outgoing).length, 0, "closing it starts the next one from here");
});
