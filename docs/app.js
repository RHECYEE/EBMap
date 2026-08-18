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
  layersButton: document.querySelector("#layers-button"),
  layersDialog: document.querySelector("#layers-dialog"),
  closeLayersDialog: document.querySelector("#close-layers-dialog"),
  layersStatus: document.querySelector("#layers-status"),
  baseOptions: [...document.querySelectorAll("[data-base]")],
  contourOptions: [...document.querySelectorAll("[data-contour]")],
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
  filterChips: [...document.querySelectorAll(".filter-chip")],
};

const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 6 });
map.setView([45.17, -101.24], 8);
L.control.zoom({ position: "bottomright" }).addTo(map);
map.createPane("communityPane");
map.getPane("communityPane").style.zIndex = "625";
map.createPane("buildingPane");
map.getPane("buildingPane").style.zIndex = "350";
map.createPane("contourPane");
map.getPane("contourPane").style.zIndex = "250";
map.getPane("contourPane").style.pointerEvents = "none";
map.createPane("collectedPane");
map.getPane("collectedPane").style.zIndex = "640";
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
let collectedState = { schemaVersion: 1, type: "field-map-collection", lastExportedUtc: null, features: [] };
let collectedLayerGroup = null;
let activeBaseMap = "street";
let activeContour = "off";
let contourLayer = null;
let collectMode = false;
let draftLatLng = null;
let editingPointId = null;
let appConfiguration = { allowPackagedData: false, distribution: "hosted-data-free" };

const DATA_SCHEMA_VERSION = 1;
const DATA_DB_NAME = "field-map-local-data";
const DATA_STORE_NAME = "updates";
const ACTIVE_UPDATE_KEY = "active-update";
const COLLECTED_POINTS_KEY = "collected-points";
const COLLECTION_SCHEMA_VERSION = 1;
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

// --- Base maps and contours -------------------------------------------------
// Contours come from the USGS 3DEP elevation service, which renders them on
// demand for a requested bounding box, so any interval can be asked for. Below
// CONTOUR_MIN_ZOOM the lines crowd into a solid mass, so the layer stays off.

const CONTOUR_SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";
const CONTOUR_MIN_ZOOM = 13;
const BASE_MAP_STORAGE_KEY = "field-map-base-layer";
const CONTOUR_STORAGE_KEY = "field-map-contour-interval";

const ContourTileLayer = L.TileLayer.extend({
  options: {
    minZoom: CONTOUR_MIN_ZOOM,
    maxZoom: 19,
    interval: 10,
    opacity: 0.75,
    attribution: 'Contours &copy; <a href="https://www.usgs.gov/3d-elevation-program">USGS 3DEP</a>',
  },
  getTileUrl(coords) {
    const size = this.getTileSize();
    const topLeft = this._map.unproject(coords.scaleBy(size), coords.z);
    const bottomRight = this._map.unproject(coords.add([1, 1]).scaleBy(size), coords.z);
    const northWest = L.Projection.SphericalMercator.project(topLeft);
    const southEast = L.Projection.SphericalMercator.project(bottomRight);
    const renderingRule = {
      rasterFunction: "Contour",
      rasterFunctionArguments: {
        ContourType: 0,
        ContourInterval: this.options.interval,
        ZBase: 0,
        NumberOfContours: 0,
        ZFactor: 1,
      },
      variableName: "Raster",
    };
    const parameters = new URLSearchParams({
      bbox: `${northWest.x},${southEast.y},${southEast.x},${northWest.y}`,
      bboxSR: "3857",
      imageSR: "3857",
      size: `${size.x},${size.y}`,
      format: "png32",
      transparent: "true",
      f: "image",
      renderingRule: JSON.stringify(renderingRule),
    });
    return `${CONTOUR_SERVICE}?${parameters.toString()}`;
  },
});

const baseMaps = {
  street: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: 'Map &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>; buildings &copy; <a href="https://overturemaps.org/">Overture Maps Foundation</a>',
  }),
  satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    maxNativeZoom: 19,
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS user community",
  }),
  topographic: L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
    // The USGS topo cache stops at zoom 16 over this area; Leaflet upscales
    // beyond that instead of leaving the map blank.
    maxZoom: 19,
    maxNativeZoom: 16,
    attribution: 'Topographic map &copy; <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>',
  }),
};

const darkBaseMaps = new Set(["satellite"]);

function readStoredPreference(key, fallback) {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch (_) {
    return fallback;
  }
}

function storePreference(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (_) {
    // Private browsing can refuse storage; the choice simply will not persist.
  }
}

function applyRoadContrast() {
  // Dark green hairlines disappear over aerial imagery, so roads switch to a
  // warm high-contrast stroke whenever the base map is dark.
  const dark = darkBaseMaps.has(activeBaseMap);
  roadStyle.color = dark ? "#ffd24a" : "#31594e";
  roadStyle.opacity = dark ? 0.95 : 0.82;
  roadStyle.weight = dark ? 2.6 : 2.2;
  roadLayers.forEach((layer) => {
    if (layer !== highlightedRoad) layer.setStyle(roadStyle);
  });
  document.body.classList.toggle("dark-base", dark);
}

function setBaseMap(name) {
  const next = baseMaps[name] ? name : "street";
  Object.entries(baseMaps).forEach(([key, layer]) => {
    if (key === next) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  });
  baseMaps[next].bringToBack();
  activeBaseMap = next;
  storePreference(BASE_MAP_STORAGE_KEY, next);
  els.baseOptions.forEach((button) => button.setAttribute("aria-checked", button.dataset.base === next ? "true" : "false"));
  applyRoadContrast();
  updateLayersStatus();
}

function setContourInterval(value) {
  const next = ["5", "10"].includes(String(value)) ? String(value) : "off";
  if (contourLayer) {
    map.removeLayer(contourLayer);
    contourLayer = null;
  }
  if (next !== "off") {
    contourLayer = new ContourTileLayer(null, { interval: Number(next), pane: "contourPane" });
    contourLayer.addTo(map);
  }
  activeContour = next;
  storePreference(CONTOUR_STORAGE_KEY, next);
  els.contourOptions.forEach((button) => button.setAttribute("aria-checked", button.dataset.contour === next ? "true" : "false"));
  updateLayersStatus();
}

function updateLayersStatus() {
  if (activeContour === "off") {
    els.layersStatus.textContent = activeBaseMap === "topographic"
      ? "USGS topo sheets are sharpest up to zoom 16, then soften as you zoom further."
      : "";
    return;
  }
  els.layersStatus.textContent = map.getZoom() < CONTOUR_MIN_ZOOM
    ? `${activeContour} m contours draw once you zoom in closer.`
    : `${activeContour} m contours are drawn live from USGS elevation data.`;
}

function restoreLayerPreferences() {
  setBaseMap(readStoredPreference(BASE_MAP_STORAGE_KEY, "street"));
  setContourInterval(readStoredPreference(CONTOUR_STORAGE_KEY, "off"));
}

els.layersButton.addEventListener("click", () => {
  updateLayersStatus();
  if (typeof els.layersDialog.showModal === "function") els.layersDialog.showModal();
  else els.layersDialog.setAttribute("open", "");
});
els.closeLayersDialog.addEventListener("click", () => els.layersDialog.close());
els.baseOptions.forEach((button) => button.addEventListener("click", () => setBaseMap(button.dataset.base)));
els.contourOptions.forEach((button) => button.addEventListener("click", () => setContourInterval(button.dataset.contour)));
map.on("zoomend", updateLayersStatus);

// --- Field collection -------------------------------------------------------
// Points collected on this device live in their own IndexedDB key, separate
// from the imported update, so importing or removing an update never touches
// unsent field work.

function collectedStyle() {
  return { pane: "collectedPane", radius: 6, color: "#ffffff", weight: 2, fillColor: "#0f8a7a", fillOpacity: 1 };
}

function coordinateLabel(latlng) {
  return `${Number(latlng.lat).toFixed(6)}, ${Number(latlng.lng).toFixed(6)}`;
}

function collectedPointLabel(address, name, latlng) {
  return address || name || coordinateLabel(latlng);
}

function collectedPointSubtitle(feature) {
  const collected = new Date(feature.properties.collectedUtc || "");
  const when = Number.isNaN(collected.getTime()) ? "" : ` ${collected.toLocaleDateString([], { dateStyle: "medium" })}`;
  const name = feature.properties.name;
  const address = feature.properties.address;
  const extra = address && name ? ` - ${name}` : "";
  return `Collected${when}${extra}`;
}

function normalizeCollectedState(candidate) {
  const empty = { schemaVersion: COLLECTION_SCHEMA_VERSION, type: "field-map-collection", lastExportedUtc: null, features: [] };
  if (!candidate || !Array.isArray(candidate.features)) return empty;
  const features = candidate.features.filter((feature) => {
    const coordinates = feature?.geometry?.coordinates;
    return feature?.properties?.id
      && feature.geometry?.type === "Point"
      && Array.isArray(coordinates)
      && coordinates.length >= 2
      && coordinates.every((value) => Number.isFinite(Number(value)));
  });
  return { ...empty, lastExportedUtc: candidate.lastExportedUtc || null, features };
}

function collectedFeatureLatLng(feature) {
  const [longitude, latitude] = feature.geometry.coordinates;
  return L.latLng(Number(latitude), Number(longitude));
}

function unsentCollectedCount() {
  return collectedState.features.filter((feature) => !feature.properties.exportedUtc).length;
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

function updateCollectedPanel() {
  const total = collectedState.features.length;
  const unsent = unsentCollectedCount();
  els.collectedSummary.textContent = total === 0
    ? "No collected points yet"
    : `${total.toLocaleString()} collected point${total === 1 ? "" : "s"}`;

  if (total === 0) {
    els.collectedDetail.textContent = "Tap the pin button on the map to add one.";
  } else if (!collectedState.lastExportedUtc) {
    els.collectedDetail.textContent = `${unsent.toLocaleString()} not sent yet`;
  } else {
    const sentNote = `last sent ${new Date(collectedState.lastExportedUtc).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    els.collectedDetail.textContent = unsent === 0
      ? `All points sent - ${sentNote}`
      : `${unsent.toLocaleString()} not yet sent - ${sentNote}`;
  }

  els.sendCollected.disabled = total === 0;
  els.exportCollected.disabled = total === 0;
  els.clearCollected.disabled = total === 0;
  refreshDataSummary();
  refreshSearchAvailability();
}

async function persistCollectedPoints() {
  await writeCollectedPoints(collectedState);
  updateCollectedPanel();
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

  const now = new Date().toISOString();
  const existing = editingPointId
    ? collectedState.features.find((entry) => entry.properties.id === editingPointId)
    : null;
  const feature = existing || {
    type: "Feature",
    geometry: { type: "Point", coordinates: [Number(draftLatLng.lng), Number(draftLatLng.lat)] },
    properties: {
      id: `collected-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "collected",
      collectedUtc: now,
      exportedUtc: null,
    },
  };

  feature.properties.address = address;
  feature.properties.name = name;
  feature.properties.label = collectedPointLabel(address, name, draftLatLng);
  feature.properties.updatedUtc = now;
  feature.properties.subtitle = collectedPointSubtitle(feature);
  if (existing) feature.properties.exportedUtc = null;
  else collectedState.features.push(feature);

  try {
    await persistCollectedPoints();
  } catch (error) {
    els.pointStatus.textContent = error.message;
    return;
  }

  renderCollectedPoint(feature);
  updateRenderedLabels();
  closePointDialog();
  setCollectMode(false);
  showToast(existing ? "Point updated" : "Point saved to this device");
}

async function deleteCollectedPoint(id) {
  const feature = collectedState.features.find((entry) => entry.properties.id === id);
  if (!feature) return;
  if (!window.confirm(`Delete "${feature.properties.label}" from this device?`)) return;
  collectedState.features = collectedState.features.filter((entry) => entry.properties.id !== id);
  try {
    await persistCollectedPoints();
  } catch (error) {
    showToast(error.message);
    return;
  }
  removeCollectedLayer(id);
  map.closePopup();
  if (editingPointId === id) closePointDialog();
  showToast("Point deleted");
}

function collectedFileName() {
  return `field-map-collected-${new Date().toISOString().slice(0, 10)}.geojson`;
}

function makeCollectedFile() {
  if (!collectedState.features.length) throw new Error("There are no collected points to send yet");
  const payload = {
    type: "FeatureCollection",
    features: collectedState.features,
    fieldMap: {
      type: "field-map-collection",
      schemaVersion: COLLECTION_SCHEMA_VERSION,
      generatedUtc: new Date().toISOString(),
      count: collectedState.features.length,
    },
  };
  return new File([JSON.stringify(payload)], collectedFileName(), { type: "application/geo+json" });
}

async function markCollectedExported() {
  const now = new Date().toISOString();
  collectedState.features.forEach((feature) => {
    feature.properties.exportedUtc = feature.properties.exportedUtc || now;
  });
  collectedState.lastExportedUtc = now;
  await persistCollectedPoints();
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
        await markCollectedExported();
        els.collectedStatus.textContent = "Collected points sent. They stay on this device too.";
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    downloadUpdateFile(file);
    await markCollectedExported();
    els.collectedStatus.textContent = "Collected points saved. Attach the file to a text, email, or Teams message.";
    showToast("Collected points file saved");
  } catch (error) {
    els.collectedStatus.textContent = error.message;
  }
}

async function saveCollectedFile() {
  try {
    downloadUpdateFile(makeCollectedFile());
    await markCollectedExported();
    els.collectedStatus.textContent = "Collected points saved to this device.";
    showToast("Collected points file saved");
  } catch (error) {
    els.collectedStatus.textContent = error.message;
  }
}

async function clearCollectedPoints() {
  const unsent = unsentCollectedCount();
  const message = unsent > 0
    ? `${unsent} collected point${unsent === 1 ? " has" : "s have"} not been sent yet. Delete every collected point from this device anyway?`
    : "Delete every collected point from this device?";
  if (!window.confirm(message)) return;
  collectedState.features = [];
  collectedState.lastExportedUtc = null;
  try {
    await persistCollectedPoints();
  } catch (error) {
    els.collectedStatus.textContent = error.message;
    return;
  }
  [...collectedLayers.keys()].forEach(removeCollectedLayer);
  els.collectedStatus.textContent = "Collected points removed from this device.";
  showToast("Collected points cleared");
}

async function loadCollectedPoints() {
  collectedLayerGroup = L.layerGroup().addTo(map);
  try {
    collectedState = normalizeCollectedState(await readCollectedPoints());
  } catch (error) {
    console.warn("Collected points could not be read", error);
    collectedState = normalizeCollectedState(null);
  }
  collectedState.features.forEach(renderCollectedPoint);
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

restoreLayerPreferences();
loadCollectedPoints();
loadMapData();
