# EB Field Map

An installable, data-free field mapping shell for iPhone, iPad, and Android.

The hosted application contains no roads, addresses, personal locations, mile markers, GeoJSON, or Field Map update files. Authorized users receive a separate `.fieldmap.json` update through their approved sharing channel and import it from **Data → Import update**. Imported data is validated and stored only in that browser's IndexedDB storage.

## Install

- iPhone or iPad: open the GitHub Pages site in Safari, use **Share**, then **Add to Home Screen**.
- Android: open the site in Chrome and choose **Install app** or **Add to Home screen**.

## Map layers

The layers button on the map switches the background between **Street** (OpenStreetMap),
**Satellite** (Esri World Imagery, detailed to zoom 19), and **Topographic** (USGS topo quads, which
are sharp to zoom 16 and soften beyond it).

Contour lines can be overlaid on any of those at **5 m** or **10 m** intervals. They are drawn on
demand from the USGS 3DEP elevation service and appear from zoom 13 in, below which the lines crowd
together into a solid mass. Roads switch to a high-contrast stroke over satellite imagery.

The chosen background and contour interval are remembered on the device.

## Collecting points in the field

Tap the pin button in the top right, then tap the map where the point belongs. Enter an address, and
a name if it helps (either one is enough), then save. Collected points appear in their own teal
layer, are searchable under the **Collected** filter, and can be edited or deleted by tapping them.

Collected points are stored separately from the imported update, so importing a new `.fieldmap.json`
or removing the current one never deletes them. They are never uploaded anywhere.

To hand them in, open **Data → Send collected points**. That sends a `.geojson` file containing the
collected points only - never the imported update - through text, email, or another app. Points stay
on the device after sending, and the panel tracks how many are new since the last send.

## Privacy

Deleting the imported update from the app returns the hosted shell to an empty state. Clearing site data or removing the installed PWA also removes the device-local imported dataset.
