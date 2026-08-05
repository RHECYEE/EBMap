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
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

L.DomEvent.disableClickPropagation(els.searchPanel);
L.DomEvent.disableScrollPropagation(els.searchPanel);

const roadLayers = new Map();
const locationLayers = new Map();
const searchDocuments = [];
let activeFilter = "all";
let highlightedRoad = null;
let highlightedLocation = null;
let copiedCoordinates = "";
let clickMarker = null;
let toastTimer = null;
let deferredInstallPrompt = null;
let currentBundle = null;
let dataSource = "packaged";
let appConfiguration = { allowPackagedData: false, distribution: "hosted-data-free" };

const DATA_SCHEMA_VERSION = 1;
const DATA_DB_NAME = "field-map-local-data";
const DATA_STORE_NAME = "updates";
const ACTIVE_UPDATE_KEY = "active-update";

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
  const counts = { roads: candidate.roads.features.length, addresses: 0, personalLocations: 0, mileMarkers: 0 };
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
    return { radius: 3.2, color: "#ffffff", weight: 0.7, fillColor: "#256da8", fillOpacity: 0.78 };
  }
  if (kind === "mile") {
    return { radius: 3.2, color: "#ffffff", weight: 0.7, fillColor: "#7657a8", fillOpacity: 0.86 };
  }
  return { radius: 3.8, color: "#ffffff", weight: 0.8, fillColor: "#c66b2d", fillOpacity: 0.9 };
}

function popupHtml(properties) {
  const kind = properties.kind === "address"
    ? "Official address"
    : properties.kind === "personal"
      ? "My location"
      : properties.kind === "mile"
        ? "Official mile marker"
        : "Road";
  return `<div class="map-popup"><strong>${escapeHtml(properties.label)}</strong><br><small>${escapeHtml(properties.subtitle || kind)}</small></div>`;
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
  if (kind === "road") {
    const layer = roadLayers.get(id);
    if (!layer) return;
    highlightedRoad = layer;
    layer.setStyle({ color: "#e05d35", weight: 5, opacity: 1 });
    layer.bringToFront();
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [45, 45], maxZoom: 15 });
    layer.bindPopup(popupHtml(layer.feature.properties)).openPopup(bounds.getCenter());
  } else {
    const layer = locationLayers.get(id);
    if (!layer) return;
    highlightedLocation = layer;
    const style = locationStyle(kind);
    layer.setStyle({ ...style, radius: 8, weight: 3, fillOpacity: 1 });
    map.flyTo(layer.getLatLng(), 16, { duration: 0.5 });
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
  els.connectionState.textContent = online ? "Online map" : "Offline data";
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
      const [metadataResponse, roadsResponse, locationsResponse] = await Promise.all([
        fetch("./data/meta.json"),
        fetch("./data/roads.geojson"),
        fetch("./data/locations.geojson"),
      ]);
      if (!metadataResponse.ok || !roadsResponse.ok || !locationsResponse.ok) throw new Error("Map data request failed");
      const [metadata, roads, locations] = await Promise.all([
        metadataResponse.json(),
        roadsResponse.json(),
        locationsResponse.json(),
      ]);
      bundle = validateBundle({
        schemaVersion: DATA_SCHEMA_VERSION,
        type: "field-map-update",
        meta: metadata,
        roads,
        locations,
      });
    }

    if (!bundle) {
      if (dataSource !== "invalid") dataSource = "empty";
      currentBundle = null;
      els.dataSummary.textContent = "No local data - select Data to import an update";
      els.searchInput.disabled = true;
      els.loading.hidden = true;
      updateDataPanel();
      showToast("Import a private Field Map update to begin");
      return;
    }

    currentBundle = bundle;
    const metadata = bundle.meta;
    const roads = bundle.roads;
    const locations = bundle.locations;

    const roadsLayer = L.geoJSON(roads, {
      style: roadStyle,
      onEachFeature(feature, layer) {
        roadLayers.set(feature.properties.id, layer);
        indexDocument(feature.properties);
        layer.bindTooltip(feature.properties.label, { sticky: true, direction: "top" });
        layer.on("click", (event) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          resetHighlights();
          highlightedRoad = layer;
          layer.setStyle({ color: "#e05d35", weight: 5, opacity: 1 });
          layer.bindPopup(popupHtml(feature.properties)).openPopup(event.latlng);
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
        layer.bindPopup(popupHtml(feature.properties));
        layer.on("click", (event) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          copyCoordinates(event.latlng, feature.properties.label);
        });
      },
    }).addTo(map);

    map.fitBounds(metadata.bounds, { padding: [20, 20] });
    const counts = metadata.counts;
    els.dataSummary.textContent = `${counts.roads.toLocaleString()} roads - ${counts.addresses.toLocaleString()} addresses - ${counts.personalLocations.toLocaleString()} saved - ${counts.mileMarkers.toLocaleString()} markers`;
    updateDataPanel();
    els.searchInput.disabled = false;
    els.loading.hidden = true;
  } catch (error) {
    console.error(error);
    els.loading.innerHTML = "Map data could not be loaded. Start the app from its local web server.";
    showToast("Map data failed to load");
  }
}

if ("serviceWorker" in navigator) {
  let refreshingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshingForUpdate) return;
    refreshingForUpdate = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker registration failed", error));
  });
}

loadMapData();
