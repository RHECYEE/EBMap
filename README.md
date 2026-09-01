# EB Field Map

An installable, data-free field mapping shell for iPhone, iPad, and Android.

The hosted application contains no roads, addresses, personal locations, mile markers, GeoJSON, or Field Map update files. Authorized users receive a separate `.fieldmap.json` update through their approved sharing channel and import it from **Data → Import update**. Imported data is validated and stored only in that browser's IndexedDB storage.

## Install

- iPhone or iPad: open the GitHub Pages site in Safari, use **Share**, then **Add to Home Screen**.
- Android: open the site in Chrome and choose **Install app** or **Add to Home screen**.

## Collecting points in the field

Tap the pin button in the top right, then tap the map where the point belongs. Enter an address, and
a name if it helps (either one is enough), then save. Collected points appear in their own teal
layer, are searchable under the **Collected** filter, and can be edited or deleted by tapping them.

Collected points are stored separately from the imported update, so importing a new `.fieldmap.json`
or removing the current one never deletes them. They are never uploaded anywhere.

## Handing off to the next crew

Crews keep each other's maps up to date by pasting a block of text into a message. No computer, no
server, no account.

**To hand over**, open **Data → Hand off to the next crew**, tap **Copy**, and paste the block into a
text or an email. **Send** offers the phone's own share sheet instead.

The block stays on screen after you copy it, because a hand-off is rarely to one person. Both crews
going off shift send to whoever is coming on, and that person passes the same text to their partner
and to the pair after them. Send it to as many people as you need - it is the same block every time.
When the whole crew has it, tap **Everyone has it - start a new hand-off**; until you do, anything
else you collect joins the same block, so nobody who gets it late is left short.

**To take one**, paste what you were sent into **Take a hand-off** and tap **Check**. The panel says
what the block would do - how many points are new, changed, or removed - before anything on the phone
changes. Tap **Merge** to apply it.

A few things worth knowing:

- **Only what is new goes out.** The block carries what you have changed since you last closed a
  hand-off, so the hundredth swap is as small as the first. Switch to **Everything** for a phone
  joining the rotation, or when a message never arrived.
- **Points are never duplicated by being sent twice.** A point keeps the same identity wherever it
  travels, so pasting the same block again, or taking the same points from two different people,
  changes nothing and adds nothing to the search. Only two crews independently pinning the same place
  makes two points, and the merge panel flags that so somebody can delete one.
- **Points travel down a chain.** A point you took from one crew goes out in your next hand-off, so
  it reaches the crew after them without anyone forwarding anything by hand. It only travels once:
  after that it is settled and stops appearing.
- **Deletions travel too.** Deleting a point removes it from this device and from the crews you hand
  off to next, so a duplicate cleaned up once stays cleaned up. **Clear collected points** is
  different - it wipes this phone only and touches nobody else's.
- **Two crews changing the same point** settle on whichever change was made later, and every phone
  reaches the same answer without talking to any other.
- **Two pins on one driveway** are two separate points, because each crew created their own. The
  merge panel flags anything landing within 25 m of a point you already hold, so somebody can delete
  the extra - and that deletion then travels.

The block survives the trip. Quoted replies, an email wrapped around it, and lines the mail client
has wrapped are all read back correctly, and a block that arrives cut in half says so instead of
merging half a map in silence.

**For the office**, **Data → Send a collected points file** still sends a `.geojson` of the collected
points only - never the imported update.

## Privacy

Deleting the imported update from the app returns the hosted shell to an empty state. Clearing site data or removing the installed PWA also removes the device-local imported dataset.

Collected points and the hand-off blocks stay on the devices that hold them. Nothing about them is
uploaded, and the app has no server to upload them to.

## The hand-off format

A block is plain text, one line per change, so a crew can read it and a damaged one can be repaired
by hand.

```
EBMAP1 R4T9K 2609011000 3 7465
+ R4T9K-2 45.17020 -101.24010 2609010810 1409 W Main St|green barn
+ J8M2P-9 45.22400 -101.18800 2609010905 @J8M2P 310 Coulee Rd
- J8M2P-4 2609011012 @J8M2P
END
```

- The header is the tag, the sending phone's name, the time (`YYMMDDHHMM`, UTC), the number of
  changes, and a check value over the lines that follow.
- `+` adds or updates a point: its id, latitude, longitude, the time it was last changed, and then
  the address, optionally followed by `|` and a name.
- `-` removes one.
- `@NAME` marks a change made by a different crew and passed on by the sender. Without it, relaying a
  point would look like a fresh edit by whoever relayed it.
- The free text is last on the line, so a mail client wrapping the block can never damage a position.

## Tests

`docs/sync.js` holds the hand-off rules and nothing that touches the page, so it runs under Node:

```
node --test tests/sync.test.js
```

Two longer checks drive the real app in a browser. They need a local server and Playwright, so they
are separate from the suite above:

```
npx http-server docs -p 8099 -s &
node tests/handoff.browser.js     # two phones collecting and handing off by text
node tests/fanout.browser.js      # one block handed to a partner and the next crew
node tests/duplicates.browser.js  # repeated merges must not fill up the search
node tests/upgrade.browser.js     # a phone that already has points opening this version
```
