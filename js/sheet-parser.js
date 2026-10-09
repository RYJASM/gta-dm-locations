/*
 * Parses the DM teleport Google Sheet into location entries.
 *
 * Works in the browser (window.SheetParser) and in Node (require), so the page
 * and scripts/update-snapshot.mjs share exactly the same parsing rules.
 *
 * Reads the sheet's read-only HTML view rather than CSV because CSV drops the
 * hyperlinks behind the "link" cells and the images embedded in cells. That
 * view only needs the sheet shared as "anyone with the link can view" — it
 * doesn't have to be published to the web.
 *
 * The table doesn't have to start on row 1: the header row is found by its
 * column names, so note rows (merged cells and all) above it are skipped.
 */
(function (root) {
  'use strict';

  const SHEET_ID = '1JBfP-mzsiPdxtAHSDMXLXI05YuIvA-MgtvTHcMQP62k';
  const GID = '0'; // which tab
  const SHEET_BASE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;
  const URLS = {
    html: `${SHEET_BASE}/htmlview/sheet?headers=false&gid=${GID}`,
    csv: `${SHEET_BASE}/export?format=csv&gid=${GID}`,
    view: `${SHEET_BASE}/edit?gid=${GID}#gid=${GID}`,
  };

  // Header text (lowercased, partial match) -> field name
  const COLUMNS = [
    ['confirmed', 'confirmed'],
    ['image link', 'imageLink'],
    ['video', 'videoLink'],
    ['image', 'image'], // also matches "Image 2" … "Image 5"
    ['name', 'name'],
    ['dlc', 'dlc'],
    ['release', 'release'],
    ['category', 'category'],
    ['note', 'notes'],
    ['coord', 'coords'],
  ];

  /* ---------- HTML helpers ---------- */

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  function stripTags(html) {
    return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
      .replace(/ /g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  // Google wraps every sheet link in https://www.google.com/url?q=<real url>
  function unwrapGoogleUrl(url) {
    const m = url.match(/^https?:\/\/www\.google\.com\/url\?q=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : url;
  }

  // A link pasted twice into one hyperlink ("…?t=08h37m48shttps://…") becomes
  // two URLs; duplicates are then dropped by unique().
  function splitGluedUrls(url) {
    return url.split(/(?=https?:\/\/)/).filter(Boolean);
  }

  function parseCell(html) {
    const images = [...html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
    const links = [...html.matchAll(/<a\b[^>]*?\shref="([^"]+)"/gi)].flatMap((m) =>
      splitGluedUrls(unwrapGoogleUrl(decodeEntities(m[1])))
    );
    return { text: stripTags(html), links: unique(links), images };
  }

  const emptyCell = () => ({ text: '', links: [], images: [] });

  // Returns one array of cells per sheet row, with merged cells expanded so every
  // row lines up column-for-column. Each row carries its real sheet row number.
  function parseSheetHtml(html) {
    const rows = [];
    const carry = []; // column -> { cell, left } for cells merged downwards (rowspan)
    for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const id = tr[1].match(/<th\b[^>]*\bid="\d+R(\d+)"/); // 0-based row index
      if (!id) continue; // header/frozen-divider rows aren't sheet rows
      const cells = [];
      let col = 0;
      const fillCarried = () => {
        while (carry[col]?.left > 0) {
          cells[col] = carry[col].cell;
          carry[col].left--;
          col++;
        }
      };
      for (const m of tr[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
        if (/freezebar-cell/.test(m[1])) continue;
        fillCarried();
        const colspan = Number(m[1].match(/colspan="(\d+)"/)?.[1] || 1);
        const rowspan = Number(m[1].match(/rowspan="(\d+)"/)?.[1] || 1);
        const cell = parseCell(m[2]);
        for (let k = 0; k < colspan; k++) {
          cells[col + k] = k === 0 ? cell : emptyCell();
          if (rowspan > 1) carry[col + k] = { cell: cells[col + k], left: rowspan - 1 };
        }
        col += colspan;
      }
      fillCarried();
      const row = Array.from(cells, (c) => c || emptyCell());
      row.num = Number(id[1]) + 1;
      rows.push(row);
    }
    attachFloatingImages(html, rows);
    return rows;
  }

  // Images placed *over* cells (Insert → Image → over cells) aren't inside any
  // <td>. Google renders them after the table and positions them with
  // posObj(sheet, id, row, col, x, y); attach each one to the row it sits on.
  function attachFloatingImages(html, rows) {
    const objects = new Map();
    const overlay = /<div\s+id=['"](embed_\d+)['"][^>]*waffle-embedded-object-overlay[^>]*>\s*<img\b([^>]*)>/gi;
    for (const m of html.matchAll(overlay)) {
      const attr = (name) => m[2].match(new RegExp(`\\b${name}=['"]([^'"]+)['"]`))?.[1];
      const src = attr('src');
      if (src) objects.set(m[1], { src: decodeEntities(src), width: Number(attr('width')) || null, height: Number(attr('height')) || null });
    }
    for (const m of html.matchAll(/posObj\(\s*['"][^'"]*['"]\s*,\s*['"](embed_\d+)['"]\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      const obj = objects.get(m[1]);
      const row = rows.find((r) => r.num === Number(m[2]) + 1);
      if (obj && row) (row.floating ||= []).push({ ...obj, col: Number(m[3]) });
    }
  }

  /* ---------- CSV (fallback: no images, no hidden links) ---------- */

  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.map((r, i) => {
      const cells = r.map((t) => ({ text: t.trim(), links: unique((t.match(/https?:\/\/\S+/g) || []).flatMap(splitGluedUrls)), images: [] }));
      cells.num = i + 1; // quoted line breaks stay inside a field, so CSV rows = sheet rows
      return cells;
    });
  }

  /* ---------- Field interpretation ---------- */

  const NUM = /-\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  // Only commas, spaces and axis labels like "Y:" may sit between the numbers of one coordinate
  const NUM_GAP = /^[\s,]*(?:[xyz]\s*:)?\s*$/i;

  function cleanNumber(s) {
    const n = Number(s.replace(/\s+/g, ''));
    return Number(n.toFixed(3));
  }

  function parseCoordinates(text) {
    const points = [];
    const notes = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const nums = [...line.matchAll(NUM)];
      const groups = [];
      let group = [];
      nums.forEach((m, i) => {
        if (group.length) {
          const prev = nums[i - 1];
          const gap = line.slice(prev.index + prev[0].length, m.index);
          if (group.length === 3 || !NUM_GAP.test(gap)) { groups.push(group); group = []; }
        }
        group.push(m);
      });
      if (group.length) groups.push(group);

      const coordGroups = groups.filter((g) => g.length >= 2);
      if (!coordGroups.length) {
        if (!/^or$/i.test(line)) notes.push(line);
        continue;
      }
      // Whatever text surrounds the numbers becomes the point's label
      let label = line;
      for (const g of coordGroups) {
        const start = g[0].index, end = g[g.length - 1].index + g[g.length - 1][0].length;
        label = label.replace(line.slice(start, end), ' ');
      }
      label = label.replace(/[xyz]\s*:/gi, ' ').replace(/^[\s:,;-]+|[\s:,;-]+$/g, '').replace(/\s+/g, ' ');
      for (const g of coordGroups) {
        const [x, y, z] = g.map((m) => cleanNumber(m[0]));
        if (Math.abs(x) > 20000 || Math.abs(y) > 20000) continue;
        points.push({ x, y, z: z === undefined ? null : z, label });
      }
    }
    return { points, note: notes.join('\n') };
  }

  function confirmedStatus(text) {
    const t = text.toLowerCase();
    if (!t) return '';
    if (/\bnot\b/.test(t)) return 'no';
    if (/assum|kinda|technically|\bbut\b/.test(t)) return 'partial';
    if (/\byes/.test(t)) return 'yes';
    return 'partial';
  }

  function deriveTitle(notes, category) {
    let t = (notes.split('\n').find((l) => l.trim()) || '').replace(/https?:\/\/\S+/g, '');
    t = t.split(/\.\s/)[0];
    t = t.replace(/\s*\b(according to|as seen|confirmed|james|burn)\b.*$/i, '');
    t = t.replace(/[\s:.,(]+$/, '').trim();
    if (!t) t = category || 'Location';
    if (t.length > 70) t = t.slice(0, 67).replace(/\s+\S*$/, '') + '…';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function imageFromUrl(url) {
    // Sheet-embedded images accept a size/format suffix: =w671-h401, =w640-rj-l80
    // (-rj = JPEG, -l80 = quality), which is ~7x smaller than the default PNG
    if (/googleusercontent\.com|sheets-images-rt/.test(url)) {
      const base = url.replace(/=[swh][\w-]*$/, '');
      return { thumb: `${base}=w720-rj-l80`, full: `${base}=w1920-rj-l88` };
    }
    return { thumb: url, full: url };
  }

  function unique(arr) {
    return [...new Set(arr)];
  }

  /* ---------- Rows -> entries ---------- */

  // Which field a header cell names, if any. Header cells are short labels, so
  // long note text that happens to mention "coordinates" doesn't count.
  function headerField(text) {
    const t = text.trim().toLowerCase();
    if (!t || t.length > 40) return null;
    return COLUMNS.find(([needle]) => t.includes(needle))?.[1] || null;
  }

  // The header is the row (among the first 50) naming the most known columns.
  function findHeaderRow(rows) {
    let best = -1;
    let bestScore = 2; // need at least 3 recognised column names
    rows.slice(0, 50).forEach((row, i) => {
      const score = new Set(row.map((c) => headerField(c.text)).filter(Boolean)).size;
      if (score > bestScore) { best = i; bestScore = score; }
    });
    return best;
  }

  function rowsToEntries(rows) {
    const headerIndex = findHeaderRow(rows);
    if (headerIndex < 0) throw new Error('Could not find the header row (DLC, Category, Coordinates…) in the sheet');
    const col = {};
    const imageCols = []; // "Image", "Image 2" … "Image 5" — all feed the slideshow, in order
    rows[headerIndex].forEach((c, i) => {
      const field = headerField(c.text);
      if (field === 'image') imageCols.push(i);
      if (field && !(field in col)) col[field] = i;
    });
    if (!('coords' in col)) throw new Error('The sheet has no Coordinates column');

    const entries = [];
    const usedIds = new Set();
    rows.slice(headerIndex + 1).forEach((row, i) => {
      const rowNum = row.num || headerIndex + i + 2;
      const get = (field) => row[col[field]] || { text: '', links: [], images: [] };
      if (!row.some((c) => c.text || c.images.length)) return;

      const notes = get('notes');
      const coords = get('coords');
      const imageLinks = get('imageLink').links;
      const parsed = parseCoordinates(coords.text);

      // Slideshow photos come only from the Image columns; "Image link" holds where a
      // photo came from, so it stays a link in the card rather than a slide.
      const images = imageCols.flatMap((c) => (row[c]?.images || []).map(imageFromUrl));

      // Floating images over an Image column join the photos; anywhere else they
      // illustrate the notes (e.g. "…press this button:") and are shown inline there.
      const floating = row.floating || [];
      const sized = (f) => ({ ...imageFromUrl(f.src), width: f.width, height: f.height });
      for (const f of floating) if (imageCols.includes(f.col)) images.push(imageFromUrl(f.src));
      const noteImages = floating.filter((f) => !imageCols.includes(f.col)).map(sized);

      // Several categories are comma-separated ("Business, Club"); "/" stays part of a
      // single category's name ("House/Apartment")
      const categories = get('category').text.split(',').map((c) => c.trim()).filter(Boolean);
      const category = categories.join(', ');
      entries.push({
        id: uniqueId(slugify(get('name').text) || `row${rowNum}`, usedIds),
        row: rowNum,
        dlc: get('dlc').text,
        release: get('release').text,
        category,
        categories,
        // The Name column is the title; rows not yet named fall back to the notes' first line
        title: get('name').text.replace(/\s+/g, ' ') || deriveTitle(notes.text, category),
        notes: notes.text,
        links: unique([...notes.links, ...coords.links]),
        coordsText: coords.text,
        coordsNote: parsed.note,
        points: parsed.points,
        images: uniqueBy(images, (im) => im.full),
        noteImages: uniqueBy(noteImages, (im) => im.full),
        imageLinks,
        videoLinks: get('videoLink').links,
        confirmed: {
          status: confirmedStatus(get('confirmed').text),
          text: get('confirmed').text,
          links: get('confirmed').links,
        },
      });
    });
    return entries;
  }

  // "Kortz Center Heist Room" -> "kortz-center-heist-room". Used for the entry's id,
  // which is also its shareable link (#kortz-center-heist-room) and the snapshot
  // image file names, so both survive rows being reordered in the sheet.
  function slugify(text) {
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  // Repeated names get -2, -3 … in sheet order
  function uniqueId(base, used) {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  }

  function uniqueBy(arr, key) {
    const seen = new Set();
    return arr.filter((x) => (seen.has(key(x)) ? false : seen.add(key(x))));
  }

  const SheetParser = {
    URLS,
    parseSheetHtml,
    parseCsv,
    parseCoordinates,
    rowsToEntries,
    fromHtml: (html) => rowsToEntries(parseSheetHtml(html)),
    fromCsv: (csv) => rowsToEntries(parseCsv(csv)),
  };

  root.SheetParser = SheetParser;
  if (typeof module !== 'undefined' && module.exports) module.exports = SheetParser;
})(typeof globalThis !== 'undefined' ? globalThis : this);
