/*
 * Parses the published Google Sheet into location entries.
 *
 * Works in the browser (window.SheetParser) and in Node (require), so the page
 * and scripts/update-snapshot.mjs share exactly the same parsing rules.
 *
 * The sheet's "pubhtml" view is preferred over CSV because CSV drops the
 * hyperlinks behind the "link" cells and the images embedded in cells.
 */
(function (root) {
  'use strict';

  const SHEET_KEY = '2PACX-1vS40YANfEtEm4z79xG7nDhNu0bGJqj0_kCebK6mf5Lu37gN54vXmvr857T45WP_ppvJfWUl_h0MKXaQ';
  const SHEET_BASE = `https://docs.google.com/spreadsheets/d/e/${SHEET_KEY}`;
  const URLS = {
    html: `${SHEET_BASE}/pubhtml/sheet?headers=false&gid=0`,
    csv: `${SHEET_BASE}/pub?output=csv`,
    view: `${SHEET_BASE}/pubhtml`,
  };

  // Header text (lowercased, partial match) -> field name
  const COLUMNS = [
    ['confirmed', 'confirmed'],
    ['image link', 'imageLink'],
    ['video', 'videoLink'],
    ['image', 'image'],
    ['dlc', 'dlc'],
    ['release', 'release'],
    ['category', 'category'],
    ['note', 'notes'],
    ['coord', 'coords'],
  ];

  const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;

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

  function parseCell(html) {
    const images = [...html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
    const links = [...html.matchAll(/<a\b[^>]*?\shref="([^"]+)"/gi)].map((m) =>
      unwrapGoogleUrl(decodeEntities(m[1]))
    );
    return { text: stripTags(html), links: unique(links), images };
  }

  function parseSheetHtml(html) {
    const rows = [];
    for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
        .filter((m) => !/freezebar-cell/.test(m[1]))
        .map((m) => parseCell(m[2]));
      if (cells.length) rows.push(cells);
    }
    return rows;
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
    return rows.map((r) =>
      r.map((t) => ({ text: t.trim(), links: unique(t.match(/https?:\/\/\S+/g) || []), images: [] }))
    );
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

  function rowsToEntries(rows) {
    const headerIndex = rows.findIndex((r) => r.some((c) => /coord/i.test(c.text)));
    if (headerIndex < 0) throw new Error('Could not find the header row in the sheet');
    const header = rows[headerIndex].map((c) => c.text.toLowerCase());
    const col = {};
    header.forEach((h, i) => {
      const hit = COLUMNS.find(([needle, field]) => h.includes(needle) && !(field in col));
      if (hit) col[hit[1]] = i;
    });

    const entries = [];
    rows.slice(headerIndex + 1).forEach((row, i) => {
      const get = (field) => row[col[field]] || { text: '', links: [], images: [] };
      if (!row.some((c) => c.text || c.images.length)) return;

      const notes = get('notes');
      const coords = get('coords');
      const imageLinks = get('imageLink').links;
      const parsed = parseCoordinates(coords.text);

      const images = get('image').images.map(imageFromUrl);
      for (const url of imageLinks) if (IMAGE_EXT.test(url)) images.push(imageFromUrl(url));

      const category = get('category').text;
      entries.push({
        id: `row${headerIndex + i + 2}`,
        row: headerIndex + i + 2,
        dlc: get('dlc').text,
        release: get('release').text,
        category,
        title: deriveTitle(notes.text, category),
        notes: notes.text,
        links: unique([...notes.links, ...coords.links]),
        coordsText: coords.text,
        coordsNote: parsed.note,
        points: parsed.points,
        images: uniqueBy(images, (im) => im.full),
        imageLinks: imageLinks.filter((u) => !IMAGE_EXT.test(u)),
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
