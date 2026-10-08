# DM Teleport Map

An interactive GTA V map of the locations in the DM teleport Google Sheet. Click a pin to copy its coordinates and see the location's picture, notes and links.

## Running it

- **Double-click `start.bat`.** It serves the folder on <http://localhost:8765> and opens your browser. In this mode the map reads the **live Google Sheet**, so new rows show up on reload (or press the ↻ button in the bottom-left).
- **Or open `index.html` directly.** Everything still works, but it shows the **saved snapshot** in `data/`, because browsers block a page opened from disk from reading Google Sheets.

`start.bat` needs Python, or Node.js as a fallback.

## Using it

- **Click a pin** to copy its coordinates and open its card: the image, category, DLC, notes, a "Confirmed on NoPixel" badge, and video or proof links.
- **Click the image** to view it full screen. Use the arrow keys when a row has more than one image.
- **Rows with several locations** (e.g. the four office towers) get one pin each. The card lists every location, and clicking one copies it and jumps there.
- **Directory:** press `/` to search by name, DLC, category, notes or coordinates. You can also filter by category chip or show only locations confirmed on NoPixel. Press Enter to open the first result.
- **Copy as:** choose `x, y, z`, `x y z`, `vector3(x, y, z)` or JSON. Your choice is remembered.
- **Hover the map** to see the game X/Y under your cursor. **Right-click** to copy that X/Y. There's no Z, so you'll need to adjust height in-game.
- **Share a location:** the address bar updates to e.g. `#row103`, and opening that link opens the same pin.
- On phones, the directory is a slide-up drawer opened from the **Directory** button.

## Updating the offline copy

```sh
node scripts/update-snapshot.mjs   # re-saves sheet data + images (data/, assets/locations/)
node scripts/download-tiles.mjs    # re-downloads map tiles (only missing ones; --force for all)
```

You only need the snapshot for opening from disk or when Google is unreachable. The live mode always reads the current sheet.

## Sheet format notes

The parser (`js/sheet-parser.js`) reads the sheet's published HTML instead of the CSV, because CSV drops the in-cell images and the URLs behind the "link" cells. It handles:

- Coordinates as `x, y, z`, `X: … Y: … Z: …`, one coordinate set per line, `or` between alternatives, and text around the numbers (which becomes that location's label).
- Rows without coordinates (e.g. "the red circles"). These are listed in the directory and open as a card without a pin.
- Rows with only X/Y. These are pinned, and the card warns that there's no Z.

Category colours come from the first part of the **Category** column (`House/…`, `Garage/…`, etc.). They're set in `GROUPS` at the top of `js/app.js`.

## Hosting

It's a static site. Push the folder to GitHub Pages, Netlify or any web host, and it will load the live sheet the same way `start.bat` does.

## Credits

- Map tiles and the game→map coordinate calibration come from [gtaservers.org/nopixel](https://gtaservers.org/nopixel) (saved locally in `tiles/`).
- [Leaflet](https://leafletjs.com) (BSD-2-Clause) and [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) (MIT) are in `vendor/`.
- [Geist](https://vercel.com/font) and [Google Sans Code](https://fonts.google.com/specimen/Google+Sans+Code) fonts (SIL OFL), self-hosted in `assets/fonts/`.
- Location data and images come from the DM teleport Google Sheet.
