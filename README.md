# DM Teleport Map

An interactive GTA V map of the locations in the DM teleport Google Sheet. Click a pin to see the location's picture, notes and links, then hit **Copy** to grab its coordinates.

## Running it

- **Double-click `start.bat`.** It serves the folder on <http://localhost:8765> and opens your browser. In this mode the map reads the **live Google Sheet**, so new rows show up on reload (or press the ↻ button in the bottom-left).
- **Or open `index.html` directly.** Everything still works, but it shows the **saved snapshot** in `data/`, because browsers block a page opened from disk from reading Google Sheets.

`start.bat` needs Python, or Node.js as a fallback.

## Using it

- **Click a pin** (or a directory entry) to open its card: the image, category, DLC, notes, a "Confirmed on NoPixel" badge, and video or proof links. Nothing is copied until you press a coordinate's **Copy** button.
- **Videos:** a YouTube or Twitch VOD in the **Video link** column becomes the card's first slide. The player only loads when you press play, starts at the link's timestamp if it has one, and stops when you change slides or close the card. Videos don't embed when the page is opened from disk, so they stay link buttons there.
- **Click the image** to view it full screen. Use the arrow keys when a row has more than one image.
- **Rows with several locations** (e.g. the four office towers) get one pin each. The card lists every location with its own **Copy** button. Clicking another location's coordinates jumps to that pin.
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

The map reads the original sheet straight from its share link. The sheet ID and tab (`SHEET_ID`, `GID`) are at the top of `js/sheet-parser.js`. The only requirement is that the sheet stays shared as **"Anyone with the link can view"**. It doesn't need to be published to the web.

The parser reads the sheet's read-only HTML view rather than its CSV, because CSV drops the in-cell images and the URLs behind the "link" cells. It handles:

- **Name** is the card and directory title. Rows without a name fall back to the first line of **Notes**, and Notes shows as the description.
- **Image, Image 2 … Image 5** make up the photo slideshow, in that order, with empty cells skipped. Images placed *over* one of those columns join it too. Images placed over other columns (e.g. Notes) show inline under the notes. **Image link** is shown as an "Image source" link, not a slide.
- Note rows above the table. The header row is found by its column names (DLC, Category, Coordinates…), so rows above it are skipped, including merged cells. More can be added later.
- Coordinates as `x, y, z`, `X: … Y: … Z: …`, one coordinate set per line, `or` between alternatives, and text around the numbers (which becomes that location's label).
- Rows without coordinates (e.g. "the red circles"). These are listed in the directory and open as a card without a pin.
- Rows with only X/Y. These are pinned, and the card warns that there's no Z.

Category colours come from the first part of the **Category** column (`House/…`, `Garage/…`, etc.). They're set in `GROUPS` at the top of `js/app.js`.

## Hosting

It's a static site, so any host works. Hosted copies read the live sheet the same way `start.bat` does.

### Netlify

`netlify.toml` holds all the settings: no build step, publish the repo root, cache headers for tiles and fonts, a Content Security Policy, and 404s for repo-only files (`scripts/`, `claude.md`).

1. In Netlify, choose **Add new site → Import an existing project → GitHub**, then pick `RYJASM/gta-dm-locations`.
2. Leave the build settings as Netlify fills them in from `netlify.toml`, and click **Deploy**.
3. Every `git push` to `main` redeploys automatically. Rename the site under **Site configuration → Change site name**.

If a sheet row links an image from a new host, it loads fine, because the policy allows any `https:` image. If the page ever needs to fetch from a domain other than Google, add that domain to `connect-src` in `netlify.toml`.

## Credits

- Map tiles and the game→map coordinate calibration come from [gtaservers.org/nopixel](https://gtaservers.org/nopixel) (saved locally in `tiles/`).
- [Leaflet](https://leafletjs.com) (BSD-2-Clause) and [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) (MIT) are in `vendor/`.
- [Geist](https://vercel.com/font) and [Google Sans Code](https://fonts.google.com/specimen/Google+Sans+Code) fonts (SIL OFL), self-hosted in `assets/fonts/`.
- Location data and images come from the DM teleport Google Sheet.
