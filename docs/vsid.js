"use strict";

// VSID: voluntary self-identified addresses.
//
// Residents report where they live through a form, and the office sends the
// form's responses out as a .csv. These points are the residents' own word -
// nobody has checked them - so the map keeps them apart from the imported
// update and from collected points, draws them differently, labels them, and
// ranks them after everything else in search. They are a last resort.
//
// This file reads the .csv and nothing that touches the page, so it can be
// tested on its own. A list is always replaced whole: the form's response
// sheet is cumulative, so each export is the complete list, and a row deleted
// from the sheet disappears from every phone at the next import.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FieldMapVsid = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const VSID_TYPE = "field-map-vsid";
  const VSID_SCHEMA_VERSION = 1;

  // How far past the imported map's bounds a VSID point may sit and still be
  // drawn. Half a degree is roughly 55 km north-south and 40 km east-west at
  // this latitude: room for anyone living just off the edge of the map, while a
  // response placed in another state is held back and listed for cleanup.
  const AREA_MARGIN_DEGREES = 0.5;

  // Matched against the lower-cased header text. The first matching column
  // wins and no column is used twice, so "Latitude" is never also read as an
  // address. Order matters: coordinates are claimed first.
  const COLUMN_PATTERNS = [
    ["latitude", /\blat(itude)?\b/],
    ["longitude", /\b(lon|lng|long|longitude)\b/],
    ["timestamp", /timestamp|submitted/],
    ["phone", /phone|cell|mobile/],
    ["address", /address/],
  ];

  const NO_ADDRESS_LABEL = "No address given";

  /**
   * Splits CSV text into rows of cells (RFC 4180).
   *
   * Handles quoted cells holding commas, line breaks and doubled quotes, any
   * line ending, and a leading byte-order mark. A quote that is still open at
   * the end means the file was cut short, so that throws rather than quietly
   * folding the rest of the file into one cell.
   */
  function parseCsv(text) {
    const source = String(text || "").replace(/^﻿/, "");
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    let cellStarted = false;

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (character === '"') {
          if (source[index + 1] === '"') {
            cell += '"';
            index += 1;
          } else {
            quoted = false;
          }
        } else {
          cell += character;
        }
        continue;
      }
      if (character === '"' && !cellStarted) {
        quoted = true;
        cellStarted = true;
      } else if (character === ",") {
        row.push(cell);
        cell = "";
        cellStarted = false;
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
        cellStarted = false;
      } else {
        cell += character;
        cellStarted = true;
      }
    }
    if (quoted) throw new Error("The .csv ends in the middle of a quoted value - the file looks cut off");
    if (cellStarted || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }

  function findColumns(header) {
    const names = header.map((cell) => String(cell || "").trim().toLowerCase());
    const taken = new Set();
    const columns = {};
    COLUMN_PATTERNS.forEach(([key, pattern]) => {
      const index = names.findIndex((name, position) => !taken.has(position) && pattern.test(name));
      columns[key] = index;
      if (index >= 0) taken.add(index);
    });
    return columns;
  }

  /** Returns { value } for a usable coordinate, or { problem } saying why not. */
  function readCoordinate(raw, name, limit) {
    const text = String(raw ?? "").trim();
    if (!text) return { problem: `no ${name}` };
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return { problem: `${name} "${text}" is not a number` };
    const value = Number(text);
    if (!Number.isFinite(value) || Math.abs(value) > limit) return { problem: `${name} ${text} is out of range` };
    return { value };
  }

  function phoneDigits(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  }

  /** (605) 218-0660 for a US number; anything else is shown as it was typed. */
  function formatPhone(raw) {
    const digits = phoneDigits(raw);
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    return String(raw || "").trim();
  }

  /** A tel: link, or "" when there is nothing that could be dialled. */
  function phoneHref(raw) {
    const digits = phoneDigits(raw);
    if (digits.length === 10) return `tel:+1${digits}`;
    const dialable = String(raw || "").replace(/[^\d+]/g, "");
    return dialable.replace(/\D/g, "").length >= 7 ? `tel:${dialable}` : "";
  }

  /**
   * The date part of the form's timestamp, exactly as the form wrote it.
   *
   * Google Forms writes the timestamp in the sheet owner's locale, so
   * 11/12/2026 could be either day-first or month-first. Showing it as written
   * is the only reading that cannot be wrong.
   */
  function submittedDate(raw) {
    return String(raw || "").trim().split(/\s+/)[0] || "";
  }

  function rowLabel(address, latitude, longitude) {
    if (address) return address;
    if (latitude || longitude) return `${latitude || "?"}, ${longitude || "?"}`;
    return "(blank)";
  }

  /**
   * Reads the form responses .csv.
   *
   * Returns the points to draw and, separately, every row that was left out
   * and why, so whoever keeps the sheet can fix it. Row numbers are the sheet's
   * own: the header is row 1. Throws only when the file is not a VSID list at
   * all.
   */
  function parseVsidCsv(text) {
    const rows = parseCsv(text);
    const headerIndex = rows.findIndex((cells) => cells.some((cell) => String(cell).trim()));
    if (headerIndex < 0) throw new Error("The .csv is empty");
    const columns = findColumns(rows[headerIndex]);
    if (columns.latitude < 0 || columns.longitude < 0) {
      throw new Error("The .csv has no Latitude and Longitude columns - is it the VSID form responses?");
    }

    const cellAt = (cells, key) => (columns[key] >= 0 ? String(cells[columns[key]] ?? "").trim() : "");
    const points = [];
    const problems = [];
    const seen = new Map();

    rows.slice(headerIndex + 1).forEach((cells, offset) => {
      if (!cells.some((cell) => String(cell).trim())) return;
      const row = headerIndex + offset + 2;
      const address = cellAt(cells, "address").replace(/\s+/g, " ");
      const latitudeText = cellAt(cells, "latitude");
      const longitudeText = cellAt(cells, "longitude");
      const label = rowLabel(address, latitudeText, longitudeText);

      const latitude = readCoordinate(latitudeText, "latitude", 90);
      const longitude = readCoordinate(longitudeText, "longitude", 180);
      const coordinateProblems = [latitude.problem, longitude.problem].filter(Boolean);
      if (coordinateProblems.length) {
        problems.push({ row, label, reason: coordinateProblems.join(", ") });
        return;
      }

      const phone = cellAt(cells, "phone");
      const key = [address.toLowerCase(), latitude.value.toFixed(6), longitude.value.toFixed(6), phoneDigits(phone)].join("|");
      if (seen.has(key)) {
        problems.push({ row, label, reason: `same as row ${seen.get(key)}` });
        return;
      }
      seen.set(key, row);

      points.push({
        id: `vsid-${row}`,
        row,
        address,
        latitude: latitude.value,
        longitude: longitude.value,
        phone,
        submitted: submittedDate(cellAt(cells, "timestamp")),
      });
    });

    return { points, problems };
  }

  /**
   * True when a point sits well outside the imported map.
   *
   * `bounds` is the update's [[lat, lng], [lat, lng]], corners in either order.
   */
  function outsideArea(point, bounds, margin = AREA_MARGIN_DEGREES) {
    if (!Array.isArray(bounds) || bounds.length !== 2) return false;
    const latitudes = bounds.map((corner) => Number(corner[0]));
    const longitudes = bounds.map((corner) => Number(corner[1]));
    if ([...latitudes, ...longitudes].some((value) => !Number.isFinite(value))) return false;
    return point.latitude < Math.min(...latitudes) - margin
      || point.latitude > Math.max(...latitudes) + margin
      || point.longitude < Math.min(...longitudes) - margin
      || point.longitude > Math.max(...longitudes) + margin;
  }

  /** The map, search and popup fields for one point. */
  function pointProperties(point) {
    const label = point.address || NO_ADDRESS_LABEL;
    const phone = formatPhone(point.phone);
    return {
      id: point.id,
      kind: "vsid",
      label,
      mapLabel: `VSID: ${label}`,
      subtitle: "VSID - last resort, not verified",
      searchText: ["vsid", "self identified", phone, phoneDigits(point.phone)].filter(Boolean).join(" "),
      phone,
      phoneHref: phoneHref(point.phone),
      submitted: point.submitted,
      row: point.row,
    };
  }

  /**
   * What goes into storage: the file itself, not the parsed rows.
   *
   * Parsing again on every load means a fix to the reading rules reaches lists
   * that were imported before the fix, and "Send VSID list" passes on exactly
   * the file that was received.
   */
  function makeVsidRecord({ text, fileName, importedUtc }) {
    return {
      type: VSID_TYPE,
      schemaVersion: VSID_SCHEMA_VERSION,
      importedUtc,
      fileName: String(fileName || ""),
      text: String(text || ""),
    };
  }

  /** The stored record read back, or null if there is none or it is unusable. */
  function loadVsidRecord(record) {
    if (!record || record.type !== VSID_TYPE || typeof record.text !== "string") return null;
    try {
      return { ...record, ...parseVsidCsv(record.text) };
    } catch (_) {
      return null;
    }
  }

  return {
    VSID_TYPE,
    VSID_SCHEMA_VERSION,
    AREA_MARGIN_DEGREES,
    NO_ADDRESS_LABEL,
    parseCsv,
    parseVsidCsv,
    outsideArea,
    pointProperties,
    formatPhone,
    phoneHref,
    submittedDate,
    makeVsidRecord,
    loadVsidRecord,
  };
});
