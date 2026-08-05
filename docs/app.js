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
  filterChips: [...document.querySelectorAll(".filter-chip")],
};

const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 6 });
map.setView([45.17, -101.24], 8);
L.control.zoom({ position: "bottomright" }).addTo(map);
map.createPane("communityPane");
map.getPane("communityPane").style.zIndex = "625";
map.createPane("buildingPane");
map.getPane("buildingPane").style.zIndex = "350";
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
let appConfiguration = { allowPackagedData: false, distribution: "hosted-data-free" };

const DATA_SCHEMA_VERSION = 1;
const DATA_DB_NAME = "field-map-local-data";
const DATA_STORE_NAME = "updates";
const ACTIVE_UPDATE_KEY = "active-update";
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
      const priorities = { personal: 0, address: 1, mile: 2 };
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
  if (kind === "community") {
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

map.on("click", (event) => copyCoordinates(event.latlng));
map.on("zoomend moveend", updateRenderedLabels);
map.on("popupopen", (event) => {
  const popupElement = event.popup.getElement();
  const copyButton = popupElement?.querySelector("[data-copy-lat]");
  if (!copyButton) return;
  L.DomEvent.disableClickPropagation(copyButton);
  copyButton.addEventListener("click", () => {
    copyCoordinates(
      L.latLng(Number(copyButton.dataset.copyLat), Number(copyButton.dataset.copyLng)),
      copyButton.dataset.copyContext || "Map location",
    );
  });
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
      els.dataSummary.textContent = "No local data - select Data to import an update";
      els.searchInput.disabled = true;
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
    els.dataSummary.textContent = `${counts.communities.toLocaleString()} communities - ${counts.roads.toLocaleString()} roads - ${counts.buildings.toLocaleString()} buildings - ${counts.addresses.toLocaleString()} addresses - ${counts.personalLocations.toLocaleString()} saved - ${counts.mileMarkers.toLocaleString()} markers`;
    updateDataPanel();
    els.searchInput.disabled = false;
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

loadMapData();
