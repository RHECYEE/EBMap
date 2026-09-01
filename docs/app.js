"use strict";

const els = {
  searchPanel: document.querySelector(".search-panel"),
  searchInput: document.querySelector("#search-input"),
  clearSearch: document.querySelector("#clear-search"),
  searchResults: document.querySelector("#search-results"),
  dataSummary: document.querySelector("#data-summary"),
  loading: document.querySelector("#loading"),
  toast: document.querySelector("#toast"),
  coordinateCard: document.querySelector("#coordinate-card"),
  coordinateValue: document.querySelector("#coordinate-value"),
  coordinateContext: document.querySelector("#coordinate-context"),
  copyAgain: document.querySelector("#copy-again"),
  shareCoordinates: document.querySelector("#share-coordinates"),
  navigateLink: document.querySelector("#navigate-link"),
  locateButton: document.querySelector("#locate-button"),
  connectionState: document.querySelector("#connection-state"),
  installButton: document.querySelector("#install-button"),
  dataButton: document.querySelector("#data-button"),
  dataDialog: document.querySelector("#data-dialog"),
  closeDataDialog: document.querySelector("#close-data-dialog"),
  dataSourceName: document.querySelector("#data-source-name"),
  dataSourceDetail: document.querySelector("#data-source-detail"),
  dataStatus: document.querySelector("#data-status"),
  importData: document.querySelector("#import-data"),
  shareData: document.querySelector("#share-data"),
  exportData: document.querySelector("#export-data"),
  resetData: document.querySelector("#reset-data"),
  dataFileInput: document.querySelector("#data-file-input"),
  collectButton: document.querySelector("#collect-button"),
  collectHint: document.querySelector("#collect-hint"),
  cancelCollect: document.querySelector("#cancel-collect"),
  pointDialog: document.querySelector("#point-dialog"),
  pointDialogTitle: document.querySelector("#point-dialog-title"),
  closePointDialog: document.querySelector("#close-point-dialog"),
  pointCoordinates: document.querySelector("#point-coordinates"),
  pointForm: document.querySelector("#point-form"),
  pointAddress: document.querySelector("#point-address"),
  pointName: document.querySelector("#point-name"),
  pointStatus: document.querySelector("#point-status"),
  deletePoint: document.querySelector("#delete-point"),
  cancelPoint: document.querySelector("#cancel-point"),
  collectedSummary: document.querySelector("#collected-summary"),
  collectedDetail: document.querySelector("#collected-detail"),
  collectedStatus: document.querySelector("#collected-status"),
  sendCollected: document.querySelector("#send-collected"),
  exportCollected: document.querySelector("#export-collected"),
  clearCollected: document.querySelector("#clear-collected"),
  handoffChips: [...document.querySelectorAll(".handoff-chip")],
  handoffScopeNote: document.querySelector("#handoff-scope-note"),
  handoffText: document.querySelector("#handoff-text"),
  copyHandoff: document.querySelector("#copy-handoff"),
  shareHandoff: document.querySelector("#share-handoff"),
  handoffStatus: document.querySelector("#handoff-status"),
  finishHandoff: document.querySelector("#finish-handoff"),
  mergeText: document.querySelector("#merge-text"),
  mergePreview: document.querySelector("#merge-preview"),
  checkMerge: document.querySelector("#check-merge"),
  applyMerge: document.querySelector("#apply-merge"),
  clearMerge: document.querySelector("#clear-merge"),
  mergeStatus: document.querySelector("#merge-status"),
  filterChips: [...document.querySelectorAll(".filter-chip")],
};

const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 6 });
map.setView([45.17, -101.24], 8);
L.control.zoom({ position: "bottomright" }).addTo(map);
map.createPane("communityPane");
map.getPane("communityPane").style.zIndex = "625";
map.createPane("buildingPane");
map.getPane("buildingPane").style.zIndex = "350";
map.createPane("collectedPane");
map.getPane("collectedPane").style.zIndex = "640";
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: 'Map &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>; buildings &copy; <a href="https://overturemaps.org/">Overture Maps Foundation</a>',
}).addTo(map);

L.DomEvent.disableClickPropagation(els.searchPanel);
L.DomEvent.disableScrollPropagation(els.searchPanel);

const roadLayers = new Map();
const locationLayers = new Map();
const communityLayers = new Map();
const buildingLayers = new Map();
const collectedLayers = new Map();
const searchDocuments = [];
let activeFilter = "all";
let highlightedRoad = null;
let highlightedLocation = null;
let copiedCoordinates = "";
let clickMarker = null;
let toastTimer = null;
let deferredInstallPrompt = null;
let currentBundle = null;
let communityLayerGroup = null;
let buildingLayerGroup = null;
let dataSource = "packaged";
let collectedState = FieldMapSync.emptyCollection("");
let handoffScope = "pending";
let copiedBlock = "";
let pendingPacket = null;
let collectedLayerGroup = null;
let collectMode = false;
let draftLatLng = null;
let editingPointId = null;
let appConfiguration = { allowPackagedData: false, distribution: "hosted-data-free" };

const DATA_SCHEMA_VERSION = 1;
const DATA_DB_NAME = "field-map-local-data";
const DATA_STORE_NAME = "updates";
const ACTIVE_UPDATE_KEY = "active-update";
const COLLECTED_POINTS_KEY = "collected-points";
const COLLECTED_LABEL_MIN_ZOOM = 16;
const COMMUNITY_LABEL_MAX_ZOOM = 13;
const ROAD_LABEL_MIN_ZOOM = 14;
const MILE_LABEL_MIN_ZOOM = 16;
const HOUSE_LABEL_MIN_ZOOM = 18;
const BUILDING_MIN_ZOOM = 16;

const roadStyle = {
  color: "#31594e",
  weight: 2.2,
  opacity: 0.82,
  lineCap: "round",
  lineJoin: "round",
};

const normalize = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function hideLoading() {
  els.loading.hidden = true;
  els.loading.setAttribute("aria-hidden", "true");
  els.loading.style.setProperty("display", "none", "important");
}

function showLoadingFailure(message) {
  els.loading.hidden = false;
  els.loading.removeAttribute("aria-hidden");
  els.loading.style.removeProperty("display");
  els.loading.innerHTML = "";
  els.loading.textContent = message;
}

function openDataDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Local update storage is unavailable in this browser"));
      return;
    }
    const request = indexedDB.open(DATA_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DATA_STORE_NAME)) {
        request.result.createObjectStore(DATA_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local update storage"));
  });
}

async function readImportedBundle() {
  const database = await openDataDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DATA_STORE_NAME, "readonly");
    const request = transaction.objectStore(DATA_STORE_NAME).get(ACTIVE_UPDATE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not read the saved update"));
    transaction.oncomplete = () => database.close();
  });
}

async function saveImportedBundle(bundle) {
  const database = await openDataDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DATA_STORE_NAME, "readwrite");
    transaction.objectStore(DATA_STORE_NAME).put(bundle, ACTIVE_UPDATE_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Could not save the update"));
    };
  });
}

async function deleteImportedBundle() {
  const database = await openDataDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DATA_STORE_NAME, "readwrite");
    transaction.objectStore(DATA_STORE_NAME).delete(ACTIVE_UPDATE_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Could not remove the saved update"));
    };
  });
}

async function readCollectedPoints() {
  const database = await openDataDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DATA_STORE_NAME, "readonly");
    const request = transaction.objectStore(DATA_STORE_NAME).get(COLLECTED_POINTS_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not read the collected points"));
    transaction.oncomplete = () => database.close();
  });
}

async function writeCollectedPoints(state) {
  const database = await openDataDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DATA_STORE_NAME, "readwrite");
    transaction.objectStore(DATA_STORE_NAME).put(state, COLLECTED_POINTS_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Could not save the collected points"));
    };
  });
}

function validateBundle(candidate) {
  if (!candidate || candidate.type !== "field-map-update" || candidate.schemaVersion !== DATA_SCHEMA_VERSION) {
    throw new Error("This is not a supported Field Map update file");
  }
  if (candidate.roads?.type !== "FeatureCollection" || !Array.isArray(candidate.roads.features)) {
    throw new Error("The update is missing its road collection");
  }
  if (candidate.locations?.type !== "FeatureCollection" || !Array.isArray(candidate.locations.features)) {
    throw new Error("The update is missing its location collection");
  }
  const bounds = candidate.meta?.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 2 || bounds.some((corner) => !Array.isArray(corner) || corner.length !== 2 || corner.some((value) => !Number.isFinite(Number(value))))) {
    throw new Error("The update has invalid map bounds");
  }
  if (candidate.roads.features.some((feature) => !feature?.properties?.id || feature.properties.kind !== "road" || !feature.geometry)) {
    throw new Error("The update contains an invalid road record");
  }
  const allowedLocationKinds = new Set(["address", "personal", "mile"]);
  if (candidate.locations.features.some((feature) => !feature?.properties?.id || !allowedLocationKinds.has(feature.properties.kind) || feature.geometry?.type !== "Point")) {
    throw new Error("The update contains an invalid location record");
  }
  const communities = candidate.communities || { type: "FeatureCollection", features: [] };
  if (communities.type !== "FeatureCollection" || !Array.isArray(communities.features)) {
    throw new Error("The update has an invalid community collection");
  }
  if (communities.features.some((feature) => !feature?.properties?.id || feature.properties.kind !== "community" || feature.geometry?.type !== "Point")) {
    throw new Error("The update contains an invalid community record");
  }
  const buildings = candidate.buildings || { type: "FeatureCollection", features: [] };
  if (buildings.type !== "FeatureCollection" || !Array.isArray(buildings.features)) {
    throw new Error("The update has an invalid building collection");
  }
  if (buildings.features.some((feature) => !feature?.properties?.id || feature.properties.kind !== "building" || !["Polygon", "MultiPolygon"].includes(feature.geometry?.type))) {
    throw new Error("The update contains an invalid building record");
  }
  const counts = {
    roads: candidate.roads.features.length,
    addresses: 0,
    personalLocations: 0,
    mileMarkers: 0,
    communities: communities.features.length,
    buildings: buildings.features.length,
  };
  candidate.locations.features.forEach((feature) => {
    if (feature.properties.kind === "address") counts.addresses += 1;
    if (feature.properties.kind === "personal") counts.personalLocations += 1;
    if (feature.properties.kind === "mile") counts.mileMarkers += 1;
  });
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    type: "field-map-update",
    meta: { ...candidate.meta, counts },
    roads: candidate.roads,
    locations: candidate.locations,
    communities,
    buildings,
  };
}

async function loadAppConfiguration() {
  try {
    const response = await fetch("./app-config.json");
    if (!response.ok) throw new Error("App configuration request failed");
    const configuration = await response.json();
    return {
      allowPackagedData: configuration.allowPackagedData === true,
      distribution: String(configuration.distribution || "unknown"),
    };
  } catch (error) {
    console.warn("Using privacy-first app configuration", error);
    return { allowPackagedData: false, distribution: "hosted-data-free" };
  }
}

let dataSummaryBase = "Loading local map data...";

function setDataSummary(text) {
  dataSummaryBase = text;
  refreshDataSummary();
}

function refreshSearchAvailability() {
  const searchable = Boolean(currentBundle) || collectedState.features.length > 0;
  els.searchInput.disabled = !searchable;
  if (searchable) return;
  els.searchInput.value = "";
  els.clearSearch.hidden = true;
  els.searchResults.hidden = true;
  els.searchResults.replaceChildren();
}

function refreshDataSummary() {
  const total = collectedState.features.length;
  els.dataSummary.textContent = total
    ? `${dataSummaryBase} - ${total.toLocaleString()} collected`
    : dataSummaryBase;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2300);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fall through to the selection-based compatibility copy.
    }
  }
  return fallbackCopy(text);
}

async function copyCoordinates(latlng, context = "Map point") {
  const latitude = Number(latlng.lat).toFixed(6);
  const longitude = Number(latlng.lng).toFixed(6);
  copiedCoordinates = `${latitude}, ${longitude}`;
  const copied = await copyText(copiedCoordinates);

  if (clickMarker) clickMarker.setLatLng(latlng);
  else {
    clickMarker = L.circleMarker(latlng, {
      radius: 7,
      color: "#ffffff",
      weight: 3,
      fillColor: "#173f35",
      fillOpacity: 1,
      pane: "markerPane",
    }).addTo(map);
  }

  els.coordinateValue.textContent = copiedCoordinates;
  els.coordinateContext.textContent = context;
  els.navigateLink.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(copiedCoordinates)}`;
  els.coordinateCard.hidden = false;
  showToast(copied ? "Coordinates copied" : "Select and copy the displayed coordinates");
}

async function shareSelectedCoordinates() {
  if (!copiedCoordinates) return;
  const context = els.coordinateContext.textContent || "Field Map location";
  const navigationUrl = els.navigateLink.href;
  if (navigator.share) {
    try {
      await navigator.share({
        title: context,
        text: `${context}\n${copiedCoordinates}`,
        url: navigationUrl,
      });
      showToast("Location shared");
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  const copied = await copyText(`${context}\n${copiedCoordinates}\n${navigationUrl}`);
  showToast(copied ? "Share details copied" : "Use the Navigate link to share this point");
}

function updateFileName() {
  const generated = new Date(currentBundle?.meta?.generatedUtc || Date.now());
  const date = Number.isNaN(generated.getTime()) ? new Date().toISOString().slice(0, 10) : generated.toISOString().slice(0, 10);
  return `field-map-update-${date}.fieldmap.json`;
}

function makeUpdateFile() {
  if (!currentBundle) throw new Error("Map data is still loading");
  return new File([JSON.stringify(currentBundle)], updateFileName(), { type: "application/json" });
}

function downloadUpdateFile(file = makeUpdateFile()) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatGeneratedDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Update date unavailable";
  return `Generated ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function updateDataPanel() {
  if (!currentBundle) {
    els.dataSourceName.textContent = "No map data on this device";
    els.dataSourceDetail.textContent = "Import a private .fieldmap.json update to begin.";
    els.resetData.hidden = true;
    els.shareData.disabled = true;
    els.exportData.disabled = true;
    return;
  }
  els.shareData.disabled = false;
  els.exportData.disabled = false;
  if (dataSource === "imported") {
    els.dataSourceName.textContent = "Imported update in use";
  } else if (dataSource === "invalid") {
    els.dataSourceName.textContent = "Packaged data in use";
  } else {
    els.dataSourceName.textContent = "Packaged map data";
  }
  const suffix = dataSource === "invalid" ? " - saved update could not be read" : "";
  els.dataSourceDetail.textContent = `${formatGeneratedDate(currentBundle.meta.generatedUtc)}${suffix}`;
  els.resetData.hidden = dataSource === "packaged";
}

async function shareCurrentUpdate() {
  try {
    const file = makeUpdateFile();
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({
          title: "Field Map data update",
          text: "Import this file from Field Map's Data panel.",
          files: [file],
        });
        els.dataStatus.textContent = "Update sent to the selected sharing channel.";
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    downloadUpdateFile(file);
    els.dataStatus.textContent = "Update saved. Attach it to email, Teams, Bluetooth, text, or another channel.";
    showToast("Update file saved for sharing");
  } catch (error) {
    els.dataStatus.textContent = error.message;
  }
}

function locationStyle(kind) {
  if (kind === "address") {
    return { radius: 4.4, color: "#ffffff", weight: 1, fillColor: "#256da8", fillOpacity: 0.84 };
  }
  if (kind === "mile") {
    return { radius: 4.2, color: "#ffffff", weight: 1, fillColor: "#7657a8", fillOpacity: 0.88 };
  }
  return { radius: 4.8, color: "#ffffff", weight: 1, fillColor: "#c66b2d", fillOpacity: 0.92 };
}

function navigationUrl(latlng) {
  const coordinates = `${Number(latlng.lat).toFixed(6)}, ${Number(latlng.lng).toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(coordinates)}`;
}

function popupHtml(properties, latlng = null) {
  const kind = properties.kind === "address"
    ? "Official address"
    : properties.kind === "personal"
      ? "My location"
      : properties.kind === "mile"
        ? "Official mile marker"
        : properties.kind === "community"
          ? "Community"
          : properties.kind === "building"
            ? "Mapped building - address not verified"
        : "Road";
  let actions = "";
  if (latlng) {
    const latitude = Number(latlng.lat).toFixed(6);
    const longitude = Number(latlng.lng).toFixed(6);
    actions = `<div class="popup-actions">
      <button type="button" data-copy-lat="${latitude}" data-copy-lng="${longitude}" data-copy-context="${escapeHtml(properties.label)}">Copy coordinates</button>
      <a href="${navigationUrl(latlng)}" target="_blank" rel="noopener">Navigate</a>
    </div>`;
  }
  return `<div class="map-popup"><strong>${escapeHtml(properties.label)}</strong><br><small>${escapeHtml(properties.subtitle || kind)}</small>${actions}</div>`;
}

function setRoadLabelMode(layer, permanent) {
  const mode = permanent ? "permanent" : "hover";
  if (layer._fieldMapLabelMode === mode) return;
  layer.unbindTooltip();
  layer.bindTooltip(escapeHtml(layer.feature.properties.label), permanent
    ? { permanent: true, direction: "center", className: "map-label road-label", opacity: 0.96 }
    : { sticky: true, direction: "top", className: "map-label hover-label" });
  layer._fieldMapLabelMode = mode;
  if (permanent) layer.openTooltip();
}

function setLocationLabelMode(layer, permanent, direction = "right") {
  const mode = permanent ? `permanent-${direction}` : "hover";
  if (layer._fieldMapLabelMode === mode) return;
  const kind = layer.feature.properties.kind;
  const label = layer.feature.properties.mapLabel || layer.feature.properties.label;
  layer.unbindTooltip();
  const offsets = { right: [7, 0], left: [-7, 0], top: [0, -7], bottom: [0, 7] };
  layer.bindTooltip(escapeHtml(label), permanent
    ? {
      permanent: true,
      direction,
      offset: offsets[direction] || offsets.right,
      className: `map-label location-label ${kind}-label`,
      opacity: 0.98,
    }
    : { direction: "top", className: "map-label hover-label" });
  layer._fieldMapLabelMode = mode;
  if (permanent) layer.openTooltip();
}

function proposedLabelRectangle(point, label, direction) {
  const width = Math.min(190, Math.max(46, 15 + String(label).length * 6.1));
  const height = 22;
  if (direction === "left") return { left: point.x - 9 - width, right: point.x - 9, top: point.y - height / 2, bottom: point.y + height / 2 };
  if (direction === "top") return { left: point.x - width / 2, right: point.x + width / 2, top: point.y - 9 - height, bottom: point.y - 9 };
  if (direction === "bottom") return { left: point.x - width / 2, right: point.x + width / 2, top: point.y + 9, bottom: point.y + 9 + height };
  return { left: point.x + 9, right: point.x + 9 + width, top: point.y - height / 2, bottom: point.y + height / 2 };
}

function rectanglesOverlap(left, right) {
  const gap = 3;
  return !(left.right + gap < right.left || left.left - gap > right.right || left.bottom + gap < right.top || left.top - gap > right.bottom);
}

function buildingStyle(feature) {
  const status = feature?.properties?.addressStatus;
  if (status === "official") return { pane: "buildingPane", color: "#256da8", weight: 0.8, fillColor: "#5fa3d5", fillOpacity: 0.3 };
  if (status === "local") return { pane: "buildingPane", color: "#b55c27", weight: 0.8, fillColor: "#dc985c", fillOpacity: 0.3 };
  if (status === "missing") return { pane: "buildingPane", color: "#a44c35", weight: 1, fillColor: "#e18a65", fillOpacity: 0.34 };
  return { pane: "buildingPane", color: "#79644e", weight: 0.65, fillColor: "#b59a78", fillOpacity: 0.2 };
}

function updateRenderedLabels() {
  const zoom = map.getZoom();
  const visibleBounds = map.getBounds().pad(0.12);

  if (buildingLayerGroup) {
    const shouldShowBuildings = zoom >= BUILDING_MIN_ZOOM;
    if (shouldShowBuildings && !map.hasLayer(buildingLayerGroup)) buildingLayerGroup.addTo(map);
    if (!shouldShowBuildings && map.hasLayer(buildingLayerGroup)) map.removeLayer(buildingLayerGroup);
  }

  if (communityLayerGroup) {
    const shouldShowCommunities = zoom <= COMMUNITY_LABEL_MAX_ZOOM;
    if (shouldShowCommunities && !map.hasLayer(communityLayerGroup)) communityLayerGroup.addTo(map);
    if (!shouldShowCommunities && map.hasLayer(communityLayerGroup)) map.removeLayer(communityLayerGroup);
    if (shouldShowCommunities) {
      communityLayers.forEach((layer) => {
        const communityType = normalize(layer.feature.properties.communityType);
        const minimumZoom = ["town", "village", "city"].includes(communityType)
          ? 6
          : communityType === "hamlet"
            ? 10
            : communityType === "locality"
              ? 11
              : 13;
        if (zoom >= minimumZoom && !communityLayerGroup.hasLayer(layer)) communityLayerGroup.addLayer(layer);
        if (zoom < minimumZoom && communityLayerGroup.hasLayer(layer)) communityLayerGroup.removeLayer(layer);
      });
    }
  }

  roadLayers.forEach((layer) => {
    const named = layer.feature.properties.label !== "Unnamed road";
    const visible = layer.getBounds().intersects(visibleBounds);
    setRoadLabelMode(layer, named && visible && zoom >= ROAD_LABEL_MIN_ZOOM);
  });

  const candidates = [];
  collectedLayers.forEach((layer) => {
    const visible = visibleBounds.contains(layer.getLatLng());
    if (visible && zoom >= COLLECTED_LABEL_MIN_ZOOM) candidates.push(layer);
    else setLocationLabelMode(layer, false);
  });
  locationLayers.forEach((layer) => {
    const kind = layer.feature.properties.kind;
    const threshold = kind === "mile" ? MILE_LABEL_MIN_ZOOM : HOUSE_LABEL_MIN_ZOOM;
    const visible = visibleBounds.contains(layer.getLatLng());
    const label = layer.feature.properties.mapLabel || layer.feature.properties.label;
    const usefulLabel = !normalize(label).startsWith("unlabeled");
    if (visible && usefulLabel && zoom >= threshold) candidates.push(layer);
    else setLocationLabelMode(layer, false);
  });

  const occupied = [];
  const mapSize = map.getSize();
  candidates
    .sort((left, right) => {
      if (left === highlightedLocation) return -1;
      if (right === highlightedLocation) return 1;
      const priorities = { collected: -1, personal: 0, address: 1, mile: 2 };
      return priorities[left.feature.properties.kind] - priorities[right.feature.properties.kind]
        || left.getLatLng().lat - right.getLatLng().lat;
    })
    .forEach((layer) => {
      const label = layer.feature.properties.mapLabel || layer.feature.properties.label;
      const point = map.latLngToContainerPoint(layer.getLatLng());
      const directions = ["right", "left", "top", "bottom"];
      const direction = directions.find((candidateDirection) => {
        const rectangle = proposedLabelRectangle(point, label, candidateDirection);
        const insideMap = rectangle.left >= 2 && rectangle.top >= 2
          && rectangle.right <= mapSize.x - 2 && rectangle.bottom <= mapSize.y - 2;
        return insideMap && !occupied.some((existing) => rectanglesOverlap(rectangle, existing));
      });
      if (!direction) {
        setLocationLabelMode(layer, false);
        return;
      }
      occupied.push(proposedLabelRectangle(point, label, direction));
      setLocationLabelMode(layer, true, direction);
    });
}

function indexDocument(properties) {
  const text = [properties.label, properties.subtitle, properties.searchText, properties.aliases]
    .filter(Boolean)
    .join(" ");
  searchDocuments.push({
    id: properties.id,
    kind: properties.kind,
    label: properties.label,
    subtitle: properties.subtitle || "",
    normalizedLabel: normalize(properties.label),
    normalizedText: normalize(text),
  });
}

function scoreDocument(document, query, tokens) {
  if (!tokens.every((token) => document.normalizedText.includes(token))) return null;
  if (document.normalizedLabel === query) return 0;
  if (document.normalizedLabel.startsWith(query)) return 10;
  if (document.normalizedLabel.split(" ").some((word) => word.startsWith(query))) return 20;
  if (document.normalizedLabel.includes(query)) return 30;
  const firstPosition = Math.min(...tokens.map((token) => document.normalizedText.indexOf(token)));
  return 50 + Math.max(0, firstPosition) + document.normalizedLabel.length / 100;
}

function runSearch() {
  const query = normalize(els.searchInput.value);
  els.clearSearch.hidden = !query;
  if (!query) {
    els.searchResults.hidden = true;
    els.searchResults.replaceChildren();
    return;
  }

  const tokens = query.split(" ").filter(Boolean);
  const results = searchDocuments
    .filter((document) => activeFilter === "all" || document.kind === activeFilter)
    .map((document) => ({ document, score: scoreDocument(document, query, tokens) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.document.label.localeCompare(right.document.label))
    .slice(0, 30);

  els.searchResults.hidden = false;
  if (!results.length) {
    els.searchResults.innerHTML = '<p class="empty-results">No matching roads or locations.</p>';
    return;
  }

  const label = results.length === 30 ? "Top 30 matches" : `${results.length} match${results.length === 1 ? "" : "es"}`;
  els.searchResults.innerHTML = `<div class="result-count">${label}</div>${results
    .map(({ document }) => `
      <button class="result-item" type="button" role="option" data-id="${escapeHtml(document.id)}" data-kind="${document.kind}">
        <span class="result-dot" aria-hidden="true"></span>
        <span class="result-copy">
          <span class="result-label">${escapeHtml(document.label)}</span>
          <span class="result-subtitle">${escapeHtml(document.subtitle || (document.kind === "road" ? "Road" : "Location"))}</span>
        </span>
      </button>`)
    .join("")}`;
}

function resetHighlights() {
  if (highlightedRoad) {
    highlightedRoad.setStyle(roadStyle);
    highlightedRoad = null;
  }
  if (highlightedLocation) {
    const kind = highlightedLocation.feature.properties.kind;
    highlightedLocation.setStyle(locationStyle(kind));
    highlightedLocation = null;
  }
}

function selectResult(kind, id) {
  resetHighlights();
  if (kind === "collected") {
    const layer = collectedLayers.get(id);
    if (!layer) return;
    map.flyTo(layer.getLatLng(), 18, { duration: 0.5 });
    layer.openPopup();
    copyCoordinates(layer.getLatLng(), layer.feature.properties.label);
  } else if (kind === "community") {
    const layer = communityLayers.get(id);
    if (!layer) return;
    map.flyTo(layer.getLatLng(), 13, { duration: 0.5 });
    layer.openPopup();
    copyCoordinates(layer.getLatLng(), layer.feature.properties.label);
  } else if (kind === "road") {
    const layer = roadLayers.get(id);
    if (!layer) return;
    highlightedRoad = layer;
    layer.setStyle({ color: "#e05d35", weight: 5, opacity: 1 });
    layer.bringToFront();
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [45, 45], maxZoom: 15 });
    layer.bindPopup(popupHtml(layer.feature.properties, bounds.getCenter())).openPopup(bounds.getCenter());
  } else if (kind === "building") {
    const layer = buildingLayers.get(id);
    if (!layer) return;
    if (buildingLayerGroup && !map.hasLayer(buildingLayerGroup)) buildingLayerGroup.addTo(map);
    const bounds = layer.getBounds();
    const center = bounds.getCenter();
    map.flyTo(center, 18, { duration: 0.5 });
    layer.openPopup(center);
    copyCoordinates(center, layer.feature.properties.label);
  } else {
    const layer = locationLayers.get(id);
    if (!layer) return;
    highlightedLocation = layer;
    const style = locationStyle(kind);
    layer.setStyle({ ...style, radius: 8, weight: 3, fillOpacity: 1 });
    map.flyTo(layer.getLatLng(), kind === "mile" ? 16 : 18, { duration: 0.5 });
    layer.openPopup();
    copyCoordinates(layer.getLatLng(), layer.feature.properties.label);
  }
  els.searchResults.hidden = true;
  els.searchInput.blur();
}

els.searchInput.addEventListener("input", runSearch);
els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const first = els.searchResults.querySelector(".result-item");
    if (first) {
      event.preventDefault();
      selectResult(first.dataset.kind, first.dataset.id);
    }
  }
  if (event.key === "ArrowDown") {
    const first = els.searchResults.querySelector(".result-item");
    if (first) {
      event.preventDefault();
      first.focus();
    }
  }
});

els.clearSearch.addEventListener("click", () => {
  els.searchInput.value = "";
  runSearch();
  resetHighlights();
  els.searchInput.focus();
});

els.searchResults.addEventListener("click", (event) => {
  const result = event.target.closest(".result-item");
  if (result) selectResult(result.dataset.kind, result.dataset.id);
});

els.filterChips.forEach((chip) => chip.addEventListener("click", () => {
  activeFilter = chip.dataset.filter;
  els.filterChips.forEach((item) => item.classList.toggle("active", item === chip));
  runSearch();
}));

map.on("click", (event) => {
  if (collectMode) {
    openPointForm(event.latlng);
    return;
  }
  copyCoordinates(event.latlng);
});
map.on("zoomend moveend", updateRenderedLabels);
map.on("popupopen", (event) => {
  const popupElement = event.popup.getElement();
  if (!popupElement) return;
  const copyButton = popupElement.querySelector("[data-copy-lat]");
  if (copyButton) {
    L.DomEvent.disableClickPropagation(copyButton);
    copyButton.addEventListener("click", () => {
      copyCoordinates(
        L.latLng(Number(copyButton.dataset.copyLat), Number(copyButton.dataset.copyLng)),
        copyButton.dataset.copyContext || "Map location",
      );
    });
  }
  const editButton = popupElement.querySelector("[data-edit-point]");
  if (editButton) {
    L.DomEvent.disableClickPropagation(editButton);
    editButton.addEventListener("click", () => {
      const layer = collectedLayers.get(editButton.dataset.editPoint);
      if (layer) openPointForm(layer.getLatLng(), editButton.dataset.editPoint);
    });
  }
  const deleteButton = popupElement.querySelector("[data-delete-point]");
  if (deleteButton) {
    L.DomEvent.disableClickPropagation(deleteButton);
    deleteButton.addEventListener("click", () => deleteCollectedPoint(deleteButton.dataset.deletePoint));
  }
});
els.copyAgain.addEventListener("click", async () => {
  if (!copiedCoordinates) return;
  const copied = await copyText(copiedCoordinates);
  showToast(copied ? "Coordinates copied again" : "Copy is unavailable in this browser");
});
els.shareCoordinates.addEventListener("click", shareSelectedCoordinates);

els.dataButton.addEventListener("click", () => {
  els.dataStatus.textContent = "";
  updateDataPanel();
  if (typeof els.dataDialog.showModal === "function") els.dataDialog.showModal();
  else els.dataDialog.setAttribute("open", "");
});
els.closeDataDialog.addEventListener("click", () => els.dataDialog.close());
els.importData.addEventListener("click", () => els.dataFileInput.click());
els.exportData.addEventListener("click", () => {
  try {
    downloadUpdateFile();
    els.dataStatus.textContent = "Update file saved to this device.";
    showToast("Update file saved");
  } catch (error) {
    els.dataStatus.textContent = error.message;
  }
});
els.shareData.addEventListener("click", shareCurrentUpdate);
els.dataFileInput.addEventListener("change", async () => {
  const file = els.dataFileInput.files?.[0];
  if (!file) return;
  els.dataStatus.textContent = `Checking ${file.name}...`;
  try {
    const bundle = validateBundle(JSON.parse(await file.text()));
    await saveImportedBundle(bundle);
    els.dataStatus.textContent = "Update imported. Reloading the map...";
    showToast("Data update imported");
    setTimeout(() => window.location.reload(), 350);
  } catch (error) {
    els.dataStatus.textContent = `Import failed: ${error.message}`;
    showToast("Could not import that update");
  } finally {
    els.dataFileInput.value = "";
  }
});
els.resetData.addEventListener("click", async () => {
  const message = appConfiguration.allowPackagedData
    ? "Remove the imported update and return to the data packaged with this app?"
    : "Remove the imported update? This app will contain no map data until another update is imported.";
  if (!window.confirm(message)) return;
  try {
    await deleteImportedBundle();
    els.dataStatus.textContent = "Imported update removed. Reloading the map...";
    setTimeout(() => window.location.reload(), 250);
  } catch (error) {
    els.dataStatus.textContent = error.message;
  }
});

els.locateButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("Location is unavailable on this device");
    return;
  }
  showToast("Finding your location...");
  map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true, timeout: 10000 });
});
map.on("locationfound", (event) => copyCoordinates(event.latlng, "Current device location"));
map.on("locationerror", () => showToast("Could not access your current location"));

function updateConnectionState() {
  const online = navigator.onLine;
  els.connectionState.textContent = online ? "Online map" : "No connection";
  els.connectionState.classList.toggle("offline", !online);
}
window.addEventListener("online", updateConnectionState);
window.addEventListener("offline", updateConnectionState);
updateConnectionState();

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  els.installButton.hidden = false;
});
els.installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  els.installButton.hidden = true;
});
window.addEventListener("appinstalled", () => showToast("Field Map installed"));

// --- Field collection -------------------------------------------------------
// Points collected on this device live in their own IndexedDB key, separate
// from the imported update, so importing or removing an update never touches
// field work. The rules for exchanging them with other crews live in sync.js.

function collectedStyle() {
  return { pane: "collectedPane", radius: 6, color: "#ffffff", weight: 2, fillColor: "#0f8a7a", fillOpacity: 1 };
}

function coordinateLabel(latlng) {
  return FieldMapSync.coordinateLabel(latlng.lat, latlng.lng);
}

function collectedFeatureLatLng(feature) {
  return L.latLng(FieldMapSync.featureLatitude(feature), FieldMapSync.featureLongitude(feature));
}

function pendingHandoffCount() {
  return FieldMapSync.pendingRecords(collectedState).length;
}

function plural(count, singular, many) {
  return `${count.toLocaleString()} ${count === 1 ? singular : many}`;
}

function shortTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function collectedPopupHtml(properties, latlng) {
  const latitude = Number(latlng.lat).toFixed(6);
  const longitude = Number(latlng.lng).toFixed(6);
  const detail = properties.address && properties.name
    ? `${escapeHtml(properties.name)}`
    : escapeHtml(properties.subtitle || "Collected point");
  return `<div class="map-popup"><strong>${escapeHtml(properties.label)}</strong><br><small>${detail}</small>
    <div class="popup-actions">
      <button type="button" data-copy-lat="${latitude}" data-copy-lng="${longitude}" data-copy-context="${escapeHtml(properties.label)}">Copy coordinates</button>
      <a href="${navigationUrl(latlng)}" target="_blank" rel="noopener">Navigate</a>
      <button type="button" data-edit-point="${escapeHtml(properties.id)}">Edit</button>
      <button type="button" class="popup-danger" data-delete-point="${escapeHtml(properties.id)}">Delete</button>
    </div></div>`;
}

function removeIndexedDocument(id) {
  const index = searchDocuments.findIndex((document) => document.id === id);
  if (index >= 0) searchDocuments.splice(index, 1);
}

function removeCollectedLayer(id) {
  const layer = collectedLayers.get(id);
  if (!layer) return;
  if (collectedLayerGroup) collectedLayerGroup.removeLayer(layer);
  collectedLayers.delete(id);
  removeIndexedDocument(id);
}

function renderCollectedPoint(feature) {
  removeCollectedLayer(feature.properties.id);
  const latlng = collectedFeatureLatLng(feature);
  const layer = L.circleMarker(latlng, collectedStyle());
  layer.feature = feature;
  layer.bindPopup(collectedPopupHtml(feature.properties, latlng));
  layer.on("click", (event) => {
    if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
  });
  collectedLayerGroup.addLayer(layer);
  collectedLayers.set(feature.properties.id, layer);
  indexDocument(feature.properties);
  setLocationLabelMode(layer, false);
}

// A merge can add, change, and remove points all at once, so the whole layer is
// rebuilt rather than tracked change by change.
function renderAllCollectedPoints() {
  [...collectedLayers.keys()].forEach(removeCollectedLayer);
  collectedState.features.forEach(renderCollectedPoint);
}

function updateCollectedPanel() {
  const total = collectedState.features.length;
  const pending = pendingHandoffCount();
  els.collectedSummary.textContent = total === 0
    ? "No collected points yet"
    : plural(total, "collected point", "collected points");

  if (total === 0 && pending === 0) {
    els.collectedDetail.textContent = "Tap the pin button on the map to add one.";
  } else if (!collectedState.lastSharedUtc) {
    els.collectedDetail.textContent = `${plural(pending, "change", "changes")} to hand off - none handed off yet`;
  } else if (pending === 0) {
    els.collectedDetail.textContent = `Nothing new since the hand-off on ${shortTime(collectedState.lastSharedUtc)}`;
  } else {
    els.collectedDetail.textContent = `${plural(pending, "change", "changes")} since the hand-off on ${shortTime(collectedState.lastSharedUtc)}`;
  }

  els.sendCollected.disabled = total === 0;
  els.exportCollected.disabled = total === 0;
  els.clearCollected.disabled = total === 0;
  refreshHandoffText();
  refreshDataSummary();
  refreshSearchAvailability();
}

async function persistCollectedPoints() {
  await writeCollectedPoints(collectedState);
  updateCollectedPanel();
}

/**
 * Changes the collection, and puts it back the way it was if the save fails.
 *
 * Storage can refuse a write - a full device, private browsing, a locked
 * profile. Without the rollback the map would show a point that is not on the
 * phone, which is the one thing a crew must be able to trust.
 */
async function commitCollectedChange(mutate) {
  const snapshot = JSON.parse(JSON.stringify(collectedState));
  const result = mutate();
  try {
    await persistCollectedPoints();
    return { ok: true, result };
  } catch (error) {
    collectedState = snapshot;
    updateCollectedPanel();
    return { ok: false, error };
  }
}

function setCollectMode(active) {
  collectMode = active;
  document.body.classList.toggle("collect-mode", active);
  els.collectButton.setAttribute("aria-pressed", active ? "true" : "false");
  els.collectHint.hidden = !active;
  if (active) showToast("Tap the map to place a point");
}

function openPointDialog() {
  if (typeof els.pointDialog.showModal === "function") els.pointDialog.showModal();
  else els.pointDialog.setAttribute("open", "");
}

function closePointDialog() {
  if (typeof els.pointDialog.close === "function") els.pointDialog.close();
  else els.pointDialog.removeAttribute("open");
  draftLatLng = null;
  editingPointId = null;
}

function openPointForm(latlng, existingId = null) {
  draftLatLng = latlng;
  editingPointId = existingId;
  const feature = existingId ? collectedState.features.find((entry) => entry.properties.id === existingId) : null;
  els.pointDialogTitle.textContent = feature ? "Edit point" : "New point";
  els.pointCoordinates.textContent = coordinateLabel(latlng);
  els.pointAddress.value = feature?.properties.address || "";
  els.pointName.value = feature?.properties.name || "";
  els.pointStatus.textContent = "";
  els.deletePoint.hidden = !feature;
  openPointDialog();
  window.setTimeout(() => els.pointAddress.focus(), 60);
}

async function savePointForm() {
  const address = els.pointAddress.value.trim();
  const name = els.pointName.value.trim();
  if (!address && !name) {
    els.pointStatus.textContent = "Enter an address or a name before saving.";
    els.pointAddress.focus();
    return;
  }
  if (!draftLatLng) {
    els.pointStatus.textContent = "This point has no location. Close this and tap the map again.";
    return;
  }

  const editing = Boolean(editingPointId);
  const outcome = await commitCollectedChange(() => FieldMapSync.upsertPoint(collectedState, {
    id: editingPointId || undefined,
    latitude: draftLatLng.lat,
    longitude: draftLatLng.lng,
    address,
    name,
  }));
  if (!outcome.ok) {
    els.pointStatus.textContent = outcome.error.message;
    return;
  }

  renderCollectedPoint(outcome.result);
  updateRenderedLabels();
  closePointDialog();
  setCollectMode(false);
  showToast(editing ? "Point updated" : "Point saved to this device");
}

async function deleteCollectedPoint(id) {
  const feature = collectedState.features.find((entry) => entry.properties.id === id);
  if (!feature) return;
  const message = `Delete "${feature.properties.label}"?\n\nIt goes from this device now, and from the crews you hand off to next.`;
  if (!window.confirm(message)) return;

  const outcome = await commitCollectedChange(() => FieldMapSync.deletePoint(collectedState, id));
  if (!outcome.ok) {
    showToast(outcome.error.message);
    return;
  }
  removeCollectedLayer(id);
  map.closePopup();
  if (editingPointId === id) closePointDialog();
  showToast("Point deleted");
}

// --- handing off by text ----------------------------------------------------

// The stamp a still-open hand-off keeps, so copying it again for the next
// person produces the identical block.
let handoffStamp = null;
let handoffStampFor = "";

function openedHandoffUtc(records) {
  const shape = records.map((record) => `${record.op}${record.id}${record.updatedUtc}`).join("|");
  if (shape !== handoffStampFor) {
    handoffStampFor = shape;
    handoffStamp = new Date().toISOString();
  }
  return handoffStamp;
}

function refreshHandoffText() {
  if (!els.handoffText) return;
  const full = handoffScope === "full";
  const records = FieldMapSync.pendingRecords(collectedState, { full });
  const empty = records.length === 0;

  els.handoffScopeNote.textContent = full
    ? "Every point on this phone. Use this for a phone joining the rotation, or when a hand-off never arrived."
    : "Only what you have changed since you last handed off.";

  els.handoffText.classList.toggle("empty", empty);
  const block = empty ? "" : FieldMapSync.encodePacket({
    deviceId: collectedState.deviceId,
    records,
    // Hold the time still while a hand-off is open, so re-copying it for the
    // next person gives the same block rather than a new one.
    generatedUtc: openedHandoffUtc(records),
  });
  els.handoffText.value = empty
    ? (full
      ? "There is nothing on this device to hand off yet."
      : "Nothing new since your last hand-off was closed.")
    : block;

  els.copyHandoff.disabled = empty;
  els.shareHandoff.disabled = empty;

  // A block stays on screen after it is copied, because a crew rarely hands to
  // one person. Both people going off shift send to whoever is coming on, and
  // that person passes the same block to their partner and to the crew after
  // them. Clearing it at the first copy would leave the second and third
  // recipient with nothing but the whole map to re-send.
  const sent = Boolean(copiedBlock) && copiedBlock === els.handoffText.value;
  els.finishHandoff.hidden = empty || !sent;
}

/**
 * Closes the current hand-off, so the next one starts from here.
 *
 * Deliberately a separate tap rather than something Copy does. The app cannot
 * tell whether the block reached one person or four, and guessing wrong the
 * unsafe way means work that was never delivered stops being offered.
 */
async function finishHandoff() {
  const counted = pendingHandoffCount();
  const outcome = await commitCollectedChange(() => FieldMapSync.markShared(collectedState));
  if (!outcome.ok) {
    els.handoffStatus.textContent = outcome.error.message;
    return;
  }
  copiedBlock = "";
  els.handoffStatus.textContent = `Hand-off closed - ${plural(counted, "change", "changes")}. The next one starts from here.`;
  showToast("Hand-off closed");
}

function afterHandoffCopy(text, note) {
  copiedBlock = text;
  const counted = FieldMapSync.pendingRecords(collectedState, { full: handoffScope === "full" }).length;
  els.handoffStatus.textContent = `${plural(counted, "change", "changes")} ${note} The same block works for everyone taking over - send it to all of them.`;
  refreshHandoffText();
}

async function copyHandoffText() {
  if (els.copyHandoff.disabled) return;
  const text = els.handoffText.value;
  if (!(await copyText(text))) {
    els.handoffStatus.textContent = "Copy is unavailable in this browser. Select the text above and copy it by hand.";
    return;
  }
  afterHandoffCopy(text, "copied.");
  showToast("Hand-off text copied");
}

async function shareHandoffText() {
  if (els.shareHandoff.disabled) return;
  const text = els.handoffText.value;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Field Map hand-off", text });
      afterHandoffCopy(text, "sent.");
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  if (!(await copyText(text))) {
    els.handoffStatus.textContent = "Sharing is unavailable here. Select the text above and copy it by hand.";
    return;
  }
  afterHandoffCopy(text, "copied, because sharing is unavailable here.");
  showToast("Hand-off text copied");
}

function setHandoffScope(scope) {
  handoffScope = scope;
  els.handoffChips.forEach((chip) => chip.classList.toggle("active", chip.dataset.scope === scope));
  els.handoffStatus.textContent = "";
  refreshHandoffText();
}

// --- taking a hand-off ------------------------------------------------------

function resetMergePreview() {
  pendingPacket = null;
  els.mergePreview.hidden = true;
  els.mergePreview.replaceChildren();
  els.applyMerge.disabled = true;
  els.clearMerge.hidden = true;
}

function mergeRow(count, singular, many, quiet = false) {
  if (!count) return "";
  return `<li${quiet ? ' class="quiet"' : ""}><span class="merge-count">${count.toLocaleString()}</span><span>${count === 1 ? singular : many}</span></li>`;
}

function renderMergePreview(packet, plan) {
  const summary = FieldMapSync.summarizePlan(plan);
  const from = packet.origin ? `From ${escapeHtml(packet.origin)}` : "From another device";
  const when = packet.generatedUtc ? ` - ${escapeHtml(shortTime(packet.generatedUtc))}` : "";

  const rows = [
    mergeRow(summary.added, "new point", "new points"),
    mergeRow(summary.updated, "point updated", "points updated"),
    mergeRow(summary.removed, "point removed", "points removed"),
    mergeRow(summary.unchanged, "you already have", "you already have", true),
    mergeRow(summary.stale, "older than yours, ignored", "older than yours, ignored", true),
  ].filter(Boolean).join("");

  const flags = [];
  if (summary.duplicates) {
    const examples = plan.duplicates.slice(0, 3)
      .map((entry) => escapeHtml(entry.existing))
      .join(", ");
    flags.push(`${plural(summary.duplicates, "new point lands", "new points land")} within ${FieldMapSync.DUPLICATE_RADIUS_METRES} m of one you already have (${examples}${summary.duplicates > 3 ? ", and more" : ""}). They will be added; check them on the map and delete whichever is wrong.`);
  }
  packet.warnings.forEach((warning) => flags.push(escapeHtml(warning)));

  // A hand-off that changes nothing is the normal result of two crews who are
  // already in step. Say so, rather than leaving a greyed-out button to explain
  // itself.
  const nothingNew = summary.changes === 0
    ? '<p class="merge-nothing">Nothing in this hand-off is new to you. Your map is already up to date.</p>'
    : "";

  els.mergePreview.innerHTML = `<span class="merge-from">${from}${when}</span>
    ${nothingNew}
    ${rows ? `<ul>${rows}</ul>` : ""}
    ${flags.map((flag) => `<p class="merge-flag">${flag}</p>`).join("")}`;
  els.mergePreview.hidden = false;
}

function checkMergeText() {
  els.mergeStatus.textContent = "";
  const packet = FieldMapSync.decodePacket(els.mergeText.value);
  if (!packet.ok) {
    resetMergePreview();
    els.mergeStatus.textContent = packet.error;
    return;
  }
  const plan = FieldMapSync.planMerge(collectedState, packet);
  pendingPacket = packet;
  renderMergePreview(packet, plan);
  els.applyMerge.disabled = FieldMapSync.summarizePlan(plan).changes === 0;
  els.clearMerge.hidden = false;
}

async function applyPendingMerge() {
  if (!pendingPacket) {
    checkMergeText();
    return;
  }
  const packet = pendingPacket;
  const outcome = await commitCollectedChange(() => FieldMapSync.applyMerge(collectedState, packet));
  if (!outcome.ok) {
    els.mergeStatus.textContent = outcome.error.message;
    return;
  }

  renderAllCollectedPoints();
  updateRenderedLabels();
  const summary = outcome.result.summary;
  const parts = [];
  if (summary.added) parts.push(plural(summary.added, "point added", "points added"));
  if (summary.updated) parts.push(plural(summary.updated, "point updated", "points updated"));
  if (summary.removed) parts.push(plural(summary.removed, "point removed", "points removed"));

  els.mergeText.value = "";
  resetMergePreview();
  els.mergeStatus.textContent = parts.length
    ? `Merged: ${parts.join(", ")}. These travel on in your next hand-off.`
    : "Merged. Nothing in it was new to you.";
  showToast(parts.length ? "Hand-off merged" : "Nothing new in that hand-off");
}

// --- files, for the office --------------------------------------------------

function collectedFileName() {
  return `field-map-collected-${new Date().toISOString().slice(0, 10)}.geojson`;
}

function makeCollectedFile() {
  if (!collectedState.features.length) throw new Error("There are no collected points to send yet");
  const payload = {
    type: "FeatureCollection",
    features: collectedState.features,
    fieldMap: {
      type: FieldMapSync.COLLECTION_TYPE,
      schemaVersion: FieldMapSync.COLLECTION_SCHEMA_VERSION,
      device: collectedState.deviceId,
      generatedUtc: new Date().toISOString(),
      count: collectedState.features.length,
    },
  };
  return new File([JSON.stringify(payload)], collectedFileName(), { type: "application/geo+json" });
}

async function sendCollectedPoints() {
  try {
    const file = makeCollectedFile();
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({
          title: "Field Map collected points",
          text: "Collected points from the field.",
          files: [file],
        });
        els.collectedStatus.textContent = "Collected points sent. They stay on this device too.";
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    downloadUpdateFile(file);
    els.collectedStatus.textContent = "Collected points saved. Attach the file to a text, email, or Teams message.";
    showToast("Collected points file saved");
  } catch (error) {
    els.collectedStatus.textContent = error.message;
  }
}

async function saveCollectedFile() {
  try {
    downloadUpdateFile(makeCollectedFile());
    els.collectedStatus.textContent = "Collected points saved to this device.";
    showToast("Collected points file saved");
  } catch (error) {
    els.collectedStatus.textContent = error.message;
  }
}

/**
 * Wipes this device's collection.
 *
 * Deliberately not the same thing as deleting the points one by one: this
 * leaves no removals behind, so it clears this phone without reaching into
 * anybody else's. Taking a hand-off afterwards fills it back up.
 */
async function clearCollectedPoints() {
  const pending = pendingHandoffCount();
  const warning = pending > 0
    ? `${plural(pending, "change has", "changes have")} not been handed off yet and will be lost. `
    : "";
  if (!window.confirm(`${warning}Remove every collected point from this device? Other crews keep theirs - this does not delete anything for them.`)) return;

  const outcome = await commitCollectedChange(() => {
    collectedState = FieldMapSync.emptyCollection(collectedState.deviceId);
  });
  if (!outcome.ok) {
    els.collectedStatus.textContent = outcome.error.message;
    return;
  }
  renderAllCollectedPoints();
  resetMergePreview();
  els.collectedStatus.textContent = "Collected points removed from this device.";
  showToast("Collected points cleared");
}

async function loadCollectedPoints() {
  collectedLayerGroup = L.layerGroup().addTo(map);
  let stored = null;
  try {
    stored = await readCollectedPoints();
  } catch (error) {
    console.warn("Collected points could not be read", error);
  }

  collectedState = FieldMapSync.normalizeCollection(stored);
  // First run on this phone, or points carried over from an older version:
  // write the upgraded shape back before anything else touches it.
  if (JSON.stringify(collectedState) !== JSON.stringify(stored)) {
    try {
      await writeCollectedPoints(collectedState);
    } catch (error) {
      console.warn("Collected points could not be saved", error);
    }
  }

  renderAllCollectedPoints();
  updateCollectedPanel();
  updateRenderedLabels();
}

els.collectButton.addEventListener("click", () => setCollectMode(!collectMode));
els.cancelCollect.addEventListener("click", () => setCollectMode(false));
els.closePointDialog.addEventListener("click", () => {
  closePointDialog();
  setCollectMode(false);
});
els.cancelPoint.addEventListener("click", () => {
  closePointDialog();
  setCollectMode(false);
});
els.pointDialog.addEventListener("close", () => {
  draftLatLng = null;
  editingPointId = null;
  setCollectMode(false);
});
els.pointForm.addEventListener("submit", (event) => {
  event.preventDefault();
  savePointForm();
});
els.deletePoint.addEventListener("click", () => {
  if (editingPointId) deleteCollectedPoint(editingPointId);
});
els.sendCollected.addEventListener("click", sendCollectedPoints);
els.exportCollected.addEventListener("click", saveCollectedFile);
els.clearCollected.addEventListener("click", clearCollectedPoints);

els.handoffChips.forEach((chip) => chip.addEventListener("click", () => setHandoffScope(chip.dataset.scope)));
els.copyHandoff.addEventListener("click", copyHandoffText);
els.shareHandoff.addEventListener("click", shareHandoffText);
els.finishHandoff.addEventListener("click", finishHandoff);
els.handoffText.addEventListener("focus", () => els.handoffText.select());
els.checkMerge.addEventListener("click", checkMergeText);
els.applyMerge.addEventListener("click", applyPendingMerge);
els.clearMerge.addEventListener("click", () => {
  els.mergeText.value = "";
  els.mergeStatus.textContent = "";
  resetMergePreview();
});
els.mergeText.addEventListener("input", () => {
  if (pendingPacket) resetMergePreview();
  els.mergeStatus.textContent = "";
});

async function loadMapData() {
  try {
    appConfiguration = await loadAppConfiguration();
    let bundle = null;
    try {
      const imported = await readImportedBundle();
      if (imported) {
        try {
          bundle = validateBundle(imported);
          dataSource = "imported";
        } catch (error) {
          console.warn("Saved Field Map update is invalid", error);
          dataSource = "invalid";
          showToast(appConfiguration.allowPackagedData ? "Saved update is invalid; using packaged data" : "Saved update is invalid; import another update");
        }
      }
    } catch (error) {
      console.warn("Local update storage is unavailable", error);
    }

    if (!bundle && appConfiguration.allowPackagedData) {
      const [metadataResponse, roadsResponse, locationsResponse, communitiesResponse, buildingsResponse] = await Promise.all([
        fetch("./data/meta.json"),
        fetch("./data/roads.geojson"),
        fetch("./data/locations.geojson"),
        fetch("./data/communities.geojson"),
        fetch("./data/buildings.geojson"),
      ]);
      if (!metadataResponse.ok || !roadsResponse.ok || !locationsResponse.ok || !communitiesResponse.ok || !buildingsResponse.ok) throw new Error("Map data request failed");
      const [metadata, roads, locations, communities, buildings] = await Promise.all([
        metadataResponse.json(),
        roadsResponse.json(),
        locationsResponse.json(),
        communitiesResponse.json(),
        buildingsResponse.json(),
      ]);
      bundle = validateBundle({
        schemaVersion: DATA_SCHEMA_VERSION,
        type: "field-map-update",
        meta: metadata,
        roads,
        locations,
        communities,
        buildings,
      });
    }

    if (!bundle) {
      if (dataSource !== "invalid") dataSource = "empty";
      currentBundle = null;
      setDataSummary("No local data - select Data to import an update");
      refreshSearchAvailability();
      hideLoading();
      updateDataPanel();
      showToast("Import a private Field Map update to begin");
      return;
    }

    currentBundle = bundle;
    const metadata = bundle.meta;
    const roads = bundle.roads;
    const locations = bundle.locations;
    const communities = bundle.communities;
    const buildings = bundle.buildings;

    communityLayerGroup = L.geoJSON(communities, {
      pointToLayer(feature, latlng) {
        return L.marker(latlng, {
          pane: "communityPane",
          icon: L.divIcon({
            className: "community-marker",
            html: `<span>${escapeHtml(feature.properties.label)}</span>`,
            iconSize: [170, 38],
            iconAnchor: [85, 19],
          }),
        });
      },
      onEachFeature(feature, layer) {
        communityLayers.set(feature.properties.id, layer);
        indexDocument(feature.properties);
        layer.bindPopup(popupHtml(feature.properties, layer.getLatLng()));
        layer.on("click", (event) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          copyCoordinates(event.latlng, feature.properties.label);
        });
      },
    }).addTo(map);

    buildingLayerGroup = L.geoJSON(buildings, {
      pane: "buildingPane",
      style: buildingStyle,
      onEachFeature(feature, layer) {
        buildingLayers.set(feature.properties.id, layer);
        if (feature.properties.addressStatus === "missing") indexDocument(feature.properties);
        const center = layer.getBounds().getCenter();
        layer.bindPopup(popupHtml(feature.properties, center));
        layer.on("click", (event) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          copyCoordinates(event.latlng, feature.properties.label);
        });
      },
    });

    const roadsLayer = L.geoJSON(roads, {
      style: roadStyle,
      onEachFeature(feature, layer) {
        roadLayers.set(feature.properties.id, layer);
        indexDocument(feature.properties);
        setRoadLabelMode(layer, false);
        layer.on("click", (event) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          resetHighlights();
          highlightedRoad = layer;
          layer.setStyle({ color: "#e05d35", weight: 5, opacity: 1 });
          layer.bindPopup(popupHtml(feature.properties, event.latlng)).openPopup(event.latlng);
          copyCoordinates(event.latlng, feature.properties.label);
        });
      },
    }).addTo(map);
    roadsLayer.bringToBack();

    L.geoJSON(locations, {
      pointToLayer(feature, latlng) {
        return L.circleMarker(latlng, locationStyle(feature.properties.kind));
      },
      onEachFeature(feature, layer) {
        locationLayers.set(feature.properties.id, layer);
        indexDocument(feature.properties);
        layer.bindPopup(popupHtml(feature.properties, layer.getLatLng()));
        setLocationLabelMode(layer, false);
        layer.on("click", (event) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          copyCoordinates(event.latlng, feature.properties.label);
        });
      },
    }).addTo(map);

    map.fitBounds(metadata.bounds, { padding: [20, 20] });
    const counts = metadata.counts;
    setDataSummary(`${counts.communities.toLocaleString()} communities - ${counts.roads.toLocaleString()} roads - ${counts.buildings.toLocaleString()} buildings - ${counts.addresses.toLocaleString()} addresses - ${counts.personalLocations.toLocaleString()} saved - ${counts.mileMarkers.toLocaleString()} markers`);
    updateDataPanel();
    refreshSearchAvailability();
    hideLoading();
    updateRenderedLabels();
  } catch (error) {
    console.error(error);
    showLoadingFailure("Map data could not be loaded. Start the app from its local web server.");
    showToast("Map data failed to load");
  }
}

async function disableOfflineMode() {
  const appScope = new URL("./", window.location.href).href;
  if ("serviceWorker" in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations
        .filter((registration) => registration.scope === appScope)
        .map((registration) => registration.unregister()));
    } catch (error) {
      console.warn("Could not remove the old Field Map service worker", error);
    }
  }
  if ("caches" in window) {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames
        .filter((name) => name.startsWith("field-map-"))
        .map((name) => caches.delete(name)));
    } catch (error) {
      console.warn("Could not remove the old Field Map cache", error);
    }
  }
}

window.addEventListener("load", disableOfflineMode);

loadCollectedPoints();
loadMapData();
