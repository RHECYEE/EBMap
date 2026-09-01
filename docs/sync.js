"use strict";

// Hand-off sync for collected points.
//
// Crews swap work by pasting a block of text into a message or an email. No
// computer, no server, no account. This file holds everything that has to be
// exactly right for that to work - the text format, and the rules for merging
// someone else's block into your own points - and nothing that touches the
// page, so it can be tested on its own.
//
// Three ideas carry the whole design:
//
//   * Every point is owned by the device that made it, and carries the time it
//     was last changed. When two devices disagree about a point, the later
//     change wins. That is the only conflict rule, and it needs no server.
//   * A deleted point leaves a tombstone behind. Without one, the next hand-off
//     from anybody still holding the point would quietly bring it back, and
//     the duplicate a crew just cleaned up would reappear at the next swap.
//   * Each device counts its own changes. A hand-off carries what changed since
//     that device last handed off, which is why the hundredth swap is as small
//     as the first, and why a point that arrived from someone else still
//     travels onward to the next crew.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FieldMapSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PACKET_TAG = "EBMAP1";
  const PACKET_END = "END";
  const COLLECTION_SCHEMA_VERSION = 2;
  const COLLECTION_TYPE = "field-map-collection";

  // Read aloud over a radio if it comes to that, so no letters that sound or
  // look like digits.
  const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const DEVICE_ID_LENGTH = 5;

  // Two points this close are worth a second look at a hand-off. Rural
  // driveways sit much further apart than this, so anything inside it is
  // usually the same place collected twice.
  const DUPLICATE_RADIUS_METRES = 25;

  // A delete has to outlive every copy of the point still in circulation. A
  // year is far longer than any hand-off chain, and a tombstone is two dozen
  // bytes, so this only exists to stop indefinite growth.
  const TOMBSTONE_RETENTION_DAYS = 365;

  // --- small helpers ---------------------------------------------------------

  function pad(value, width = 2) {
    return String(value).padStart(width, "0");
  }

  function makeDeviceId(random = Math.random) {
    let id = "";
    for (let index = 0; index < DEVICE_ID_LENGTH; index += 1) {
      id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
    }
    return id;
  }

  /**
   * Packs a time as YYMMDDHHMM in UTC.
   *
   * Ten characters, sorts as text, and readable enough that someone can see at
   * a glance whether a pasted block is from today. Seconds are dropped: they
   * cost a fifth of the stamp and only matter if two crews edit the same point
   * in the same minute, which the device tie-break already settles.
   */
  function encodeStamp(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return null;
    return [
      pad(date.getUTCFullYear() % 100),
      pad(date.getUTCMonth() + 1),
      pad(date.getUTCDate()),
      pad(date.getUTCHours()),
      pad(date.getUTCMinutes()),
    ].join("");
  }

  function decodeStamp(text) {
    if (!/^\d{10}$/.test(String(text || ""))) return null;
    const year = 2000 + Number(text.slice(0, 2));
    const month = Number(text.slice(2, 4));
    const day = Number(text.slice(4, 6));
    const hour = Number(text.slice(6, 8));
    const minute = Number(text.slice(8, 10));
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (Number.isNaN(date.getTime()) || date.getUTCDate() !== day) return null;
    return date.toISOString();
  }

  /**
   * Rounds a time down to the minute the text format carries.
   *
   * Stored times have to sit on the same grid as sent ones. Keep a local edit
   * at full precision and the same clash resolves differently on each phone --
   * whoever holds the untruncated copy always looks later than the copy that
   * has been through the text - and the two devices quietly disagree forever.
   */
  function truncateToMinute(value) {
    const stamp = encodeStamp(value);
    return stamp ? decodeStamp(stamp) : new Date().toISOString();
  }

  /**
   * A time for a change that must land after an earlier one.
   *
   * Deleting a point a few seconds after editing it, or re-adding one right
   * after a delete, would otherwise produce two changes stamped the same minute
   * and every other device would have to guess which came first. Nudging the
   * later one forward keeps the order the crew actually worked in.
   */
  function timeAfter(now, previous) {
    const candidate = truncateToMinute(now);
    if (!previous) return candidate;
    const floor = truncateToMinute(previous);
    if (candidate > floor) return candidate;
    return new Date(new Date(floor).getTime() + 60000).toISOString();
  }

  function coordinateText(value) {
    // Five places is about a metre. More would only pad every hand-off.
    return Number(value).toFixed(5);
  }

  function escapeField(value) {
    return String(value == null ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/[\r\n\t]+/g, " ")
      .trim();
  }

  function unescapeField(value) {
    let out = "";
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === "\\" && index + 1 < value.length) {
        out += value[index + 1];
        index += 1;
      } else {
        out += character;
      }
    }
    return out.trim();
  }

  /** Splits on the first unescaped separator, so an address may contain one. */
  function splitEscaped(text, separator) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\\") {
        index += 1;
        continue;
      }
      if (text[index] === separator) {
        return [text.slice(0, index), text.slice(index + 1)];
      }
    }
    return [text, null];
  }

  /**
   * A short check value over the body of a packet.
   *
   * This is here to catch a paste that lost half of itself on the way through a
   * message app, not to catch tampering. Four base-36 characters, so a mangled
   * block gets flagged rather than silently merged as if it were whole.
   */
  function checksum(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash % 1679616).toString(36).toUpperCase().padStart(4, "0");
  }

  function distanceMetres(first, second) {
    const radius = 6371000;
    const toRadians = (degrees) => (degrees * Math.PI) / 180;
    const deltaLatitude = toRadians(second.latitude - first.latitude);
    const deltaLongitude = toRadians(second.longitude - first.longitude);
    const firstLatitude = toRadians(first.latitude);
    const secondLatitude = toRadians(second.latitude);
    const haversine = Math.sin(deltaLatitude / 2) ** 2
      + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(deltaLongitude / 2) ** 2;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(haversine)));
  }

  /**
   * Decides which of two versions of a point is the live one.
   *
   * Later time wins. When two devices changed a point in the same minute the
   * device name breaks the tie, so every device in the chain reaches the same
   * answer without talking to any of the others.
   */
  function isNewer(candidateUtc, candidateOrigin, existingUtc, existingOrigin) {
    const candidate = String(candidateUtc || "");
    const existing = String(existingUtc || "");
    if (candidate !== existing) return candidate > existing;
    return String(candidateOrigin || "") > String(existingOrigin || "");
  }

  // --- points ----------------------------------------------------------------

  function coordinateLabel(latitude, longitude) {
    return `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`;
  }

  function pointLabel(address, name, latitude, longitude) {
    return address || name || coordinateLabel(latitude, longitude);
  }

  function pointSubtitle(properties, localDeviceId) {
    const collected = new Date(properties.collectedUtc || "");
    const when = Number.isNaN(collected.getTime())
      ? ""
      : ` ${collected.toLocaleDateString([], { dateStyle: "medium" })}`;
    const named = properties.address && properties.name ? ` - ${properties.name}` : "";
    const origin = properties.origin && properties.origin !== localDeviceId
      ? ` - from ${properties.origin}`
      : "";
    return `Collected${when}${named}${origin}`;
  }

  /** Builds the stored GeoJSON feature for a point, however it arrived. */
  function buildFeature(input, localDeviceId) {
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    const address = String(input.address || "").trim();
    const name = String(input.name || "").trim();
    const properties = {
      id: input.id,
      kind: "collected",
      address,
      name,
      origin: input.origin || localDeviceId,
      collectedUtc: input.collectedUtc || input.updatedUtc,
      updatedUtc: input.updatedUtc,
      seq: Number(input.seq) || 0,
      label: pointLabel(address, name, latitude, longitude),
    };
    if (input.legacyId) properties.legacyId = input.legacyId;
    properties.subtitle = pointSubtitle(properties, localDeviceId);
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties,
    };
  }

  function featureLatitude(feature) {
    return Number(feature.geometry.coordinates[1]);
  }

  function featureLongitude(feature) {
    return Number(feature.geometry.coordinates[0]);
  }

  function featurePosition(feature) {
    return { latitude: featureLatitude(feature), longitude: featureLongitude(feature) };
  }

  // --- stored state ----------------------------------------------------------

  function emptyCollection(deviceId) {
    return {
      schemaVersion: COLLECTION_SCHEMA_VERSION,
      type: COLLECTION_TYPE,
      deviceId,
      seq: 0,
      sharedSeq: 0,
      lastSharedUtc: null,
      lastMergedUtc: null,
      features: [],
      tombstones: [],
    };
  }

  function hasUsablePoint(feature) {
    const coordinates = feature?.geometry?.coordinates;
    return Boolean(feature?.properties?.id)
      && feature.geometry?.type === "Point"
      && Array.isArray(coordinates)
      && coordinates.length >= 2
      && coordinates.slice(0, 2).every((value) => Number.isFinite(Number(value)));
  }

  /**
   * Reads whatever is in storage and returns state this file can work with.
   *
   * Version 1 knew only a flat list of points and the date of the last file
   * export. Those points are renamed onto the compact scheme here, because a
   * hand-off carries every id and the old ones were four times longer than they
   * needed to be. The original is kept on the point so a file already sent to
   * the office can still be matched up by hand.
   *
   * The migration deliberately leaves the hand-off mark at zero, so the first
   * text hand-off after an upgrade carries everything. Nobody on the other end
   * has these points in this form yet, and sending too much once is the
   * cheaper mistake.
   */
  function normalizeCollection(candidate, options = {}) {
    const newDeviceId = options.makeDeviceId || makeDeviceId;
    const deviceId = (candidate && typeof candidate.deviceId === "string" && candidate.deviceId)
      || newDeviceId();
    const state = emptyCollection(deviceId);
    if (!candidate || !Array.isArray(candidate.features)) return state;

    const migrating = Number(candidate.schemaVersion) < COLLECTION_SCHEMA_VERSION
      || !Array.isArray(candidate.tombstones);
    let seq = 0;
    let counter = 0;

    state.features = candidate.features.filter(hasUsablePoint).map((feature) => {
      const properties = feature.properties;
      seq += 1;
      counter += 1;
      const id = migrating && !/^[0-9A-Z]{5}-/.test(String(properties.id))
        ? `${deviceId}-${counter.toString(36).toUpperCase()}`
        : properties.id;
      return buildFeature({
        id,
        legacyId: id === properties.id ? properties.legacyId : properties.id,
        latitude: featureLatitude(feature),
        longitude: featureLongitude(feature),
        address: properties.address,
        name: properties.name,
        origin: properties.origin || deviceId,
        collectedUtc: properties.collectedUtc,
        updatedUtc: properties.updatedUtc || properties.collectedUtc,
        seq: migrating ? seq : (Number(properties.seq) || seq),
      }, deviceId);
    });

    state.tombstones = (Array.isArray(candidate.tombstones) ? candidate.tombstones : [])
      .filter((entry) => entry && entry.id && entry.deletedUtc)
      .map((entry) => ({
        id: String(entry.id),
        deletedUtc: String(entry.deletedUtc),
        origin: String(entry.origin || deviceId),
        seq: Number(entry.seq) || 0,
      }));

    state.seq = migrating
      ? Math.max(seq, ...state.tombstones.map((entry) => entry.seq), 0)
      : Math.max(Number(candidate.seq) || 0, seq, ...state.tombstones.map((entry) => entry.seq), 0);
    state.sharedSeq = migrating ? 0 : Math.min(Number(candidate.sharedSeq) || 0, state.seq);
    state.lastSharedUtc = migrating ? null : (candidate.lastSharedUtc || null);
    state.lastMergedUtc = candidate.lastMergedUtc || null;
    return state;
  }

  /** Drops tombstones old enough that no hand-off could still be carrying the point. */
  function pruneTombstones(state, now = new Date().toISOString()) {
    const cutoff = new Date(now).getTime() - TOMBSTONE_RETENTION_DAYS * 86400000;
    state.tombstones = state.tombstones.filter((entry) => {
      const deleted = new Date(entry.deletedUtc).getTime();
      return Number.isNaN(deleted) || deleted >= cutoff;
    });
    return state;
  }

  function nextId(state) {
    return `${state.deviceId}-${(state.seq + 1).toString(36).toUpperCase()}`;
  }

  /** Records a point, new or edited, and marks it as this device's latest change. */
  function upsertPoint(state, input, now = new Date().toISOString()) {
    state.seq += 1;
    const existing = state.features.find((feature) => feature.properties.id === input.id);
    // Putting back a point that was deleted has to beat the delete everywhere,
    // not just here, so it is stamped after the tombstone it clears.
    const tombstone = state.tombstones.find((entry) => entry.id === input.id);
    const feature = buildFeature({
      id: input.id || nextId(state),
      latitude: input.latitude,
      longitude: input.longitude,
      address: input.address,
      name: input.name,
      origin: state.deviceId,
      collectedUtc: existing ? existing.properties.collectedUtc : now,
      updatedUtc: tombstone ? timeAfter(now, tombstone.deletedUtc) : truncateToMinute(now),
      seq: state.seq,
      legacyId: existing ? existing.properties.legacyId : undefined,
    }, state.deviceId);
    if (tombstone) state.tombstones = state.tombstones.filter((entry) => entry.id !== feature.properties.id);
    if (existing) state.features = state.features.map((entry) => (entry === existing ? feature : entry));
    else state.features.push(feature);
    return feature;
  }

  /** Deletes a point and leaves the tombstone that keeps it deleted everywhere. */
  function deletePoint(state, id, now = new Date().toISOString()) {
    const existing = state.features.find((feature) => feature.properties.id === id);
    if (!existing) return null;
    state.seq += 1;
    state.features = state.features.filter((feature) => feature.properties.id !== id);
    state.tombstones = state.tombstones
      .filter((entry) => entry.id !== id)
      .concat({
        id,
        deletedUtc: timeAfter(now, existing.properties.updatedUtc),
        origin: state.deviceId,
        seq: state.seq,
      });
    return existing;
  }

  // --- what to send ----------------------------------------------------------

  function upsertRecord(feature) {
    return {
      op: "upsert",
      id: feature.properties.id,
      latitude: featureLatitude(feature),
      longitude: featureLongitude(feature),
      updatedUtc: feature.properties.updatedUtc,
      origin: feature.properties.origin,
      address: feature.properties.address || "",
      name: feature.properties.name || "",
    };
  }

  /**
   * The changes a hand-off should carry.
   *
   * By default that is everything this device has touched since its last
   * hand-off - including points that arrived from somebody else, because the
   * crew taking over needs those too, and because that is what lets a point
   * travel down a chain of swaps without anyone having to think about it.
   *
   * The full list is there for a phone joining the rotation, or for when a
   * message never arrived and the last hand-off has to be redone.
   */
  function pendingRecords(state, options = {}) {
    const floor = options.full === true ? -1 : state.sharedSeq;
    const records = [];
    state.features.forEach((feature) => {
      if (Number(feature.properties.seq) > floor) records.push(upsertRecord(feature));
    });
    state.tombstones.forEach((entry) => {
      if (Number(entry.seq) > floor) {
        records.push({ op: "delete", id: entry.id, updatedUtc: entry.deletedUtc, origin: entry.origin });
      }
    });
    records.sort((left, right) => String(left.updatedUtc).localeCompare(String(right.updatedUtc))
      || String(left.id).localeCompare(String(right.id)));
    return records;
  }

  function markShared(state, now = new Date().toISOString()) {
    state.sharedSeq = state.seq;
    state.lastSharedUtc = now;
    return state;
  }

  // --- the text format -------------------------------------------------------
  //
  //   EBMAP1 K7Q2M 2609011422 3 4H1P     header: tag, device, time, count, check
  //   + K7Q2M-7 45.17123 -101.23890 2609011401 1409 W Main St|Smith barn
  //   + A3F1Q-2 45.18001 -101.24100 2608302315 1412 W Main St
  //   - A3F1Q-9 2609011410
  //   END
  //
  // One line per point, and the free text last. That ordering is the reason a
  // mail client wrapping the block at eighty columns cannot corrupt a position:
  // a wrap can only ever land in the address.

  /**
   * Names the crew whose change this is, when that is not the crew sending it.
   *
   * Passing a point on must not make it look like a fresh change by whoever
   * passed it. Get this wrong and a point relayed through three crews arrives
   * looking newer than the copy it came from, which sets off an edit that
   * bounces between phones and never settles.
   */
  function authorMark(record, senderId) {
    const origin = String(record.origin || "");
    return origin && origin !== senderId ? `@${origin} ` : "";
  }

  function recordLine(record, senderId) {
    const stamp = encodeStamp(record.updatedUtc);
    if (!stamp) return null;
    if (record.op === "delete") {
      return `- ${record.id} ${stamp} ${authorMark(record, senderId)}`.trimEnd();
    }
    const address = escapeField(record.address);
    const name = escapeField(record.name);
    const text = name ? `${address}|${name}` : address;
    return `+ ${record.id} ${coordinateText(record.latitude)} ${coordinateText(record.longitude)} ${stamp} ${authorMark(record, senderId)}${text}`.trimEnd();
  }

  function encodePacket(input) {
    const generatedUtc = input.generatedUtc || new Date().toISOString();
    const lines = (input.records || [])
      .map((record) => recordLine(record, input.deviceId))
      .filter(Boolean);
    const body = lines.join("\n");
    const header = [
      PACKET_TAG,
      input.deviceId,
      encodeStamp(generatedUtc),
      String(lines.length),
      checksum(body),
    ].join(" ");
    return [header, ...lines, PACKET_END].join("\n");
  }

  /** Strips what a message app or a quoted reply adds in front of a line. */
  function stripQuoting(line) {
    return String(line).replace(/^[\s>]+/, "").replace(/\s+$/, "");
  }

  function startsRecord(line) {
    return /^[+-]\s/.test(line);
  }

  /** Reads an @NAME author mark, or nothing if this token is not one. */
  function readAuthor(token) {
    return /^@[0-9A-Z]{5}$/.test(String(token || "")) ? token.slice(1) : "";
  }

  /**
   * Reads a pasted block back into records.
   *
   * Written on the assumption that the block arrives damaged. People paste the
   * whole email around it, replies arrive with every line quoted, and long
   * addresses get wrapped. So: anything before the header and after END is
   * ignored, quote markers are stripped, and a line that does not begin a
   * record is treated as the tail of the one above it.
   *
   * A block that fails its own check value still returns every record that
   * parsed. Half a hand-off is worth having, as long as the crew is told that
   * is what they are looking at.
   */
  function decodePacket(text) {
    const lines = String(text || "").split(/\r?\n/).map(stripQuoting);
    const headerIndex = lines.findIndex((line) => line.toUpperCase().startsWith(`${PACKET_TAG} `));
    if (headerIndex < 0) {
      return { ok: false, error: "No hand-off text found. Copy the whole block, including the EBMAP1 line." };
    }

    const header = lines[headerIndex].split(/\s+/);
    const origin = header[1] || "";
    const generatedUtc = decodeStamp(header[2]);
    const declaredCount = Number(header[3]);
    const declaredChecksum = String(header[4] || "").toUpperCase();

    const body = [];
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      if (line.toUpperCase() === PACKET_END) break;
      if (line.toUpperCase().startsWith(`${PACKET_TAG} `)) break;
      if (startsRecord(line) || !body.length) body.push(line);
      else body[body.length - 1] = `${body[body.length - 1]} ${line}`;
    }

    const warnings = [];
    const records = [];
    body.forEach((line) => {
      if (!startsRecord(line)) {
        warnings.push(`Skipped a line that is not a point: "${line.slice(0, 40)}"`);
        return;
      }
      const operation = line[0];
      const rest = line.slice(1).trim();
      if (operation === "-") {
        const [id, stamp, mark] = rest.split(/\s+/);
        const deletedUtc = decodeStamp(stamp);
        if (!id || !deletedUtc) {
          warnings.push(`Skipped an unreadable removal: "${line.slice(0, 40)}"`);
          return;
        }
        records.push({ op: "delete", id, updatedUtc: deletedUtc, origin: readAuthor(mark) || origin });
        return;
      }
      const parts = rest.split(/\s+/);
      const [id, latitudeText, longitudeText, stamp] = parts;
      const latitude = Number(latitudeText);
      const longitude = Number(longitudeText);
      const updatedUtc = decodeStamp(stamp);
      if (!id || !updatedUtc || !Number.isFinite(latitude) || !Number.isFinite(longitude)
        || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        warnings.push(`Skipped an unreadable point: "${line.slice(0, 40)}"`);
        return;
      }
      const author = readAuthor(parts[4]);
      const tail = parts.slice(author ? 5 : 4).join(" ");
      const [addressText, nameText] = splitEscaped(tail, "|");
      records.push({
        op: "upsert",
        id,
        latitude,
        longitude,
        updatedUtc,
        origin: author || origin,
        address: unescapeField(addressText),
        name: nameText === null ? "" : unescapeField(nameText),
      });
    });

    const bodyChecksum = checksum(body.map((line) => line.trim()).join("\n"));
    const checksumOk = !declaredChecksum || declaredChecksum === bodyChecksum;
    if (!checksumOk) {
      warnings.push("The text does not match its own check value, so some of it changed on the way. Ask for it again if anything looks wrong.");
    }
    if (Number.isFinite(declaredCount) && declaredCount !== records.length) {
      warnings.push(`The text says ${declaredCount} change${declaredCount === 1 ? "" : "s"} but ${records.length} could be read. Some of it did not arrive.`);
    }
    if (!records.length) {
      return { ok: false, error: "That text has no points in it.", warnings, origin, generatedUtc };
    }

    return { ok: true, origin, generatedUtc, declaredCount, checksumOk, warnings, records };
  }

  // --- merging ---------------------------------------------------------------

  /**
   * Works out what a packet would do, without doing any of it.
   *
   * The panel shows this before anything is written, because a crew about to
   * take a hand-off should be able to see that it removes four points before it
   * removes them.
   */
  function planMerge(state, packet) {
    const liveById = new Map(state.features.map((feature) => [feature.properties.id, feature]));
    const tombstoneById = new Map(state.tombstones.map((entry) => [entry.id, entry]));
    const plan = { added: [], updated: [], removed: [], noted: [], unchanged: [], stale: [], duplicates: [] };

    packet.records.forEach((record) => {
      const origin = record.origin || packet.origin || "";
      const live = liveById.get(record.id);
      const tombstone = tombstoneById.get(record.id);

      if (record.op === "delete") {
        // Somebody deleted it, but we changed it after they did. An edit that
        // came later is the more recent decision about the point, so it stands.
        if (live && isNewer(live.properties.updatedUtc, live.properties.origin, record.updatedUtc, origin)) {
          plan.stale.push(record);
          return;
        }
        if (live) plan.removed.push(record);
        else if (tombstone) plan.unchanged.push(record);
        else plan.noted.push(record);
        return;
      }

      // The point was deleted, and this copy is no newer than the delete, so
      // the delete still holds. A genuinely later edit resurrects it: that is
      // somebody deliberately putting the point back.
      if (tombstone && !isNewer(record.updatedUtc, origin, tombstone.deletedUtc, tombstone.origin)) {
        plan.stale.push(record);
        return;
      }

      if (!live) {
        plan.added.push(record);
        const near = state.features
          .concat(plan.added.slice(0, -1).map((entry) => buildFeature(entry, state.deviceId)))
          .find((feature) => distanceMetres(featurePosition(feature), record) <= DUPLICATE_RADIUS_METRES);
        if (near) plan.duplicates.push({ record, existing: near.properties.label });
        return;
      }

      if (isNewer(record.updatedUtc, origin, live.properties.updatedUtc, live.properties.origin)) {
        plan.updated.push(record);
      } else if (record.updatedUtc === live.properties.updatedUtc && origin === live.properties.origin) {
        plan.unchanged.push(record);
      } else {
        // Same point, but our copy was changed later. Theirs is out of date.
        plan.stale.push(record);
      }
    });

    return plan;
  }

  function summarizePlan(plan) {
    return {
      added: plan.added.length,
      updated: plan.updated.length,
      removed: plan.removed.length,
      noted: plan.noted.length,
      unchanged: plan.unchanged.length,
      stale: plan.stale.length,
      duplicates: plan.duplicates.length,
      changes: plan.added.length + plan.updated.length + plan.removed.length + plan.noted.length,
    };
  }

  /**
   * Applies a packet and reports what it did.
   *
   * Everything that actually changes gets this device's next sequence number,
   * so a point that arrived here goes out again in this device's next hand-off.
   * That is what carries a point down a chain of crews without anyone
   * forwarding anything by hand.
   */
  function applyMerge(state, packet, now = new Date().toISOString()) {
    const plan = planMerge(state, packet);
    const byId = new Map(state.features.map((feature) => [feature.properties.id, feature]));
    const tombstoneById = new Map(state.tombstones.map((entry) => [entry.id, entry]));

    plan.added.concat(plan.updated).forEach((record) => {
      state.seq += 1;
      const existing = byId.get(record.id);
      byId.set(record.id, buildFeature({
        id: record.id,
        latitude: record.latitude,
        longitude: record.longitude,
        address: record.address,
        name: record.name,
        origin: record.origin || packet.origin || "",
        collectedUtc: existing ? existing.properties.collectedUtc : record.updatedUtc,
        updatedUtc: record.updatedUtc,
        seq: state.seq,
      }, state.deviceId));
      tombstoneById.delete(record.id);
    });

    plan.removed.concat(plan.noted).forEach((record) => {
      state.seq += 1;
      byId.delete(record.id);
      tombstoneById.set(record.id, {
        id: record.id,
        deletedUtc: record.updatedUtc,
        origin: record.origin || packet.origin || "",
        seq: state.seq,
      });
    });

    state.features = [...byId.values()];
    state.tombstones = [...tombstoneById.values()];
    state.lastMergedUtc = now;
    pruneTombstones(state, now);
    return { state, plan, summary: summarizePlan(plan) };
  }

  return {
    PACKET_TAG,
    PACKET_END,
    COLLECTION_SCHEMA_VERSION,
    COLLECTION_TYPE,
    DUPLICATE_RADIUS_METRES,
    TOMBSTONE_RETENTION_DAYS,
    makeDeviceId,
    encodeStamp,
    decodeStamp,
    truncateToMinute,
    timeAfter,
    checksum,
    readAuthor,
    distanceMetres,
    isNewer,
    coordinateLabel,
    pointLabel,
    pointSubtitle,
    buildFeature,
    featureLatitude,
    featureLongitude,
    featurePosition,
    emptyCollection,
    normalizeCollection,
    pruneTombstones,
    nextId,
    upsertPoint,
    deletePoint,
    upsertRecord,
    pendingRecords,
    markShared,
    encodePacket,
    decodePacket,
    planMerge,
    summarizePlan,
    applyMerge,
  };
});
