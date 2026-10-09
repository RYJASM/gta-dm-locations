(function () {
  'use strict';

  /* ================= Map projection =================
   * Same linear game -> map transform gtaservers.org/nopixel uses for these
   * tiles, so pins line up exactly with the atlas.  Leaflet CRS.Simple maps
   * latLng(lat, lng) to pixel (lng, -lat) at zoom 0.
   */
  const SCALE = 0.0070668;
  const ORIGIN_X = 125.425;
  const ORIGIN_Y = 155.823;
  const toLatLng = (x, y) => L.latLng(y * SCALE - ORIGIN_Y, x * SCALE + ORIGIN_X);
  const toGame = (ll) => ({ x: (ll.lng - ORIGIN_X) / SCALE, y: (ll.lat + ORIGIN_Y) / SCALE });
  const TILE_BOUNDS = L.latLngBounds([-185, 96], [-96, 160]);
  const TILE_MAX_ZOOM = window.TILE_MAX_ZOOM || 8;

  /* ================= Categories ================= */
  const GROUPS = [
    { key: 'home', label: 'Homes & Hotels', color: '#22c55e', match: /house|home|apartment|hotel|motel/i },
    { key: 'garage', label: 'Garages & Mechanics', color: '#3b82f6', match: /garage|loading|mechanic/i },
    { key: 'business', label: 'Business & Office', color: '#a855f7', match: /business|office|government/i },
    { key: 'club', label: 'Clubs & Casino', color: '#ef4444', match: /club|casino/i },
    { key: 'drugs', label: 'Drug Labs', color: '#ec4899', match: /drug/i },
    { key: 'warehouse', label: 'Warehouses', color: '#f97316', match: /warehouse/i },
    { key: 'utility', label: 'Utility & Tunnels', color: '#14b8a6', match: /utility|utillity|tunnel|security|vault/i },
    { key: 'vehicle', label: 'Air, Sea & Islands', color: '#eab308', match: /aviation|plane|aquatic|sea|island/i },
    { key: 'other', label: 'Other', color: '#94a3b8', match: /$^/ },
  ];
  const OTHER = GROUPS[GROUPS.length - 1];

  function groupOf(category) {
    const first = category.split('/')[0] || '';
    return GROUPS.find((g) => g.match.test(first)) || GROUPS.find((g) => g.match.test(category)) || OTHER;
  }

  const STATUS = {
    yes: 'Confirmed on NoPixel',
    partial: 'Partly confirmed / assumed',
    no: 'Assumed not on NoPixel',
  };

  /* ================= Copy formats ================= */
  const axes = (p) => (p.z == null ? [p.x, p.y] : [p.x, p.y, p.z]);
  // `short` is the dropdown text (kept short so the sidebar row fits); `label` is shown in hints
  const FORMATS = {
    comma: { label: 'x, y, z', fmt: (p) => axes(p).join(', ') },
    space: { label: 'x y z', fmt: (p) => axes(p).join(' ') },
    vector: { label: 'vector3(x, y, z)', short: 'vector3', fmt: (p) => `vector${axes(p).length}(${axes(p).join(', ')})` },
    json: { label: '{"x":…,"y":…,"z":…}', short: 'JSON', fmt: (p) => JSON.stringify(p.z == null ? { x: p.x, y: p.y } : { x: p.x, y: p.y, z: p.z }) },
  };

  /* ================= State ================= */
  // localStorage can throw (private windows, blocked storage); it only holds the copy format
  const store = {
    get(k) {
      try { return localStorage.getItem(`dmmap.${k}`); } catch { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(`dmmap.${k}`, v); } catch { /* storage unavailable */ }
    },
  };

  const state = {
    entries: [],
    byId: new Map(),
    mode: 'loading',
    savedAt: null,
    loadedAt: null,
    error: null,
    query: '',
    groups: new Set(),
    confirmedOnly: false,
    format: store.get('format') in FORMATS ? store.get('format') : 'comma',
    markers: new Map(), // "rowN:i" -> marker
    active: null, // { id, i }
    opening: null, // { id, i } while the map is still flying to a pin
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    search: $('search'),
    chips: $('chips'),
    confirmedOnly: $('confirmedOnly'),
    format: $('format'),
    list: $('list'),
    resultsMeta: $('resultsMeta'),
    source: $('source'),
    toast: $('toast'),
    modal: $('modal'),
    lightbox: $('lightbox'),
    lightboxImg: $('lightboxImg'),
    lightboxCaption: $('lightboxCaption'),
    cursor: $('cursorCoords'),
    sidebar: $('sidebar'),
  };

  /* ================= Map setup ================= */
  const map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: 2,
    maxZoom: TILE_MAX_ZOOM + 2,
    zoomSnap: 0.5,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    zoomControl: false,
    attributionControl: false,
    maxBoundsViscosity: 0.8,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const tileBits = window.TILE_BITMAP
    ? Uint8Array.from(atob(window.TILE_BITMAP), (c) => c.charCodeAt(0))
    : null;

  // Skip requests for tiles that don't exist (open ocean) using the bitmap
  const GtaTiles = L.TileLayer.extend({
    _isValidTile(c) {
      if (!tileBits) return L.TileLayer.prototype._isValidTile.call(this, c);
      const s = 2 ** c.z;
      if (c.z < 0 || c.z > TILE_MAX_ZOOM || c.x < 0 || c.y < 0 || c.x >= s || c.y >= s) return false;
      const o = (4 ** c.z - 1) / 3 + c.y * s + c.x;
      return (tileBits[o >> 3] & (128 >> (o & 7))) !== 0;
    },
  });

  new GtaTiles('tiles/{z}/{x}/{y}.webp', {
    tileSize: 256,
    minZoom: 0,
    maxNativeZoom: TILE_MAX_ZOOM,
    maxZoom: TILE_MAX_ZOOM + 2,
    noWrap: true,
    bounds: TILE_BOUNDS,
    keepBuffer: 4,
  }).addTo(map);

  map.fitBounds(TILE_BOUNDS, { padding: [10, 10] });
  // Panning is limited to the map plus one screen's worth of margin at the current
  // zoom. A fixed margin was too tight when zoomed out: a popup on a pin near the
  // top edge couldn't auto-pan into view and stayed stuck off screen.
  let contentBounds = TILE_BOUNDS;
  function updateMaxBounds() {
    const size = map.getSize();
    const unitsPerPx = 1 / 2 ** map.getZoom(); // CRS.Simple: 1 map unit = 2^zoom px
    const padLat = size.y * unitsPerPx;
    const padLng = size.x * 0.5 * unitsPerPx;
    const sw = contentBounds.getSouthWest();
    const ne = contentBounds.getNorthEast();
    map.setMaxBounds(L.latLngBounds([sw.lat - padLat, sw.lng - padLng], [ne.lat + padLat, ne.lng + padLng]));
  }
  updateMaxBounds();
  map.on('zoomend resize', updateMaxBounds);

  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    spiderfyDistanceMultiplier: 1.6,
    maxClusterRadius: (z) => (z >= 7 ? 22 : 44),
    iconCreateFunction(c) {
      const markers = c.getAllChildMarkers();
      const counts = new Map();
      for (const m of markers) counts.set(m.options.group.color, (counts.get(m.options.group.color) || 0) + 1);
      let acc = 0;
      const stops = [...counts].map(([color, n]) => {
        const from = (acc / markers.length) * 360;
        acc += n;
        return `${color} ${from}deg ${(acc / markers.length) * 360}deg`;
      });
      const size = markers.length >= 20 ? 46 : markers.length >= 8 ? 40 : 34;
      return L.divIcon({
        html: `<span class="cluster" style="--ring:conic-gradient(${stops.join(',')})"><span>${markers.length}</span></span>`,
        className: 'cluster-wrap',
        iconSize: [size, size],
      });
    },
  }).addTo(map);

  // Hover readout of game coordinates; right-click anywhere copies X, Y
  map.on('mousemove', (e) => {
    const g = toGame(e.latlng);
    els.cursor.textContent = `X ${g.x.toFixed(1)}   Y ${g.y.toFixed(1)}`;
    els.cursor.classList.add('is-visible');
  });
  map.on('mouseout', () => els.cursor.classList.remove('is-visible'));
  map.on('contextmenu', (e) => {
    const g = toGame(e.latlng);
    copyText(`${g.x.toFixed(2)}, ${g.y.toFixed(2)}`, 'Copied map position (X, Y — no Z)');
  });

  /* ================= Markers ================= */
  function pinIcon(group) {
    return L.divIcon({
      className: 'pin-wrap',
      html: `<span class="pin" style="--c:${group.color}"><span class="pin-dot"></span></span>`,
      iconSize: [26, 32],
      iconAnchor: [13, 31],
      popupAnchor: [0, -30],
    });
  }

  function buildMarkers() {
    state.markers.clear();
    for (const entry of state.entries) {
      entry.points.forEach((p, i) => {
        const marker = L.marker(toLatLng(p.x, p.y), {
          icon: pinIcon(entry.group),
          group: entry.group,
          title: entry.points.length > 1 ? `${entry.title} (${i + 1}/${entry.points.length})` : entry.title,
          riseOnHover: true,
        });
        marker.bindPopup(() => buildCard(entry, i, 'popup'), {
          className: 'loc-popup',
          maxWidth: 380,
          minWidth: 200,
          autoPanPaddingTopLeft: [16, 16],
          autoPanPaddingBottomRight: [16, 16],
        });
        marker.on('click', () => setActive(entry.id, i));
        marker.on('popupclose', () => {
          if (state.active && state.active.id === entry.id && state.active.i === i) setActive(null);
        });
        state.markers.set(`${entry.id}:${i}`, marker);
      });
    }
  }

  function renderMarkers(visible) {
    cluster.clearLayers();
    const layers = [];
    for (const entry of visible) entry.points.forEach((_, i) => layers.push(state.markers.get(`${entry.id}:${i}`)));
    cluster.addLayers(layers);
  }

  function setActive(id, i) {
    for (const el of document.querySelectorAll('.pin.is-active')) el.classList.remove('is-active');
    for (const el of document.querySelectorAll('.item.is-active')) el.classList.remove('is-active');
    state.active = id ? { id, i } : null;
    if (!id) {
      history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    const marker = state.markers.get(`${id}:${i}`);
    marker?.getElement()?.querySelector('.pin')?.classList.add('is-active');
    marker?.setZIndexOffset(1000);
    const item = els.list.querySelector(`[data-id="${id}"]`);
    if (item) {
      item.classList.add('is-active');
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    history.replaceState(null, '', `#${id}${i ? `-${i + 1}` : ''}`);
  }

  // Re-apply the active class when a pin re-enters the DOM after (un)clustering
  cluster.on('animationend spiderfied', () => state.active && setActive(state.active.id, state.active.i));
  map.on('zoomend', () => state.active && setActive(state.active.id, state.active.i));

  // Zoom to the level where this marker leaves its cluster (markercluster's own
  // zoomToShowLayer misbehaves with half-step zoom), then run `done`. Pins that
  // share an exact spot never un-cluster, so those get spiderfied at max zoom.
  function revealMarker(marker, minZoom, done) {
    const ll = marker.getLatLng();
    const maxZoom = map.getMaxZoom();
    const parent = marker.__parent;
    const unclusterZoom = parent ? parent._zoom + 1 : 0;
    const target = Math.min(maxZoom, Math.max(unclusterZoom, minZoom, Math.ceil(map.getZoom())));
    const settle = (fn) => () => (cluster._inZoomAnimation ? cluster.once('animationend', fn) : fn());

    const finish = settle(() => {
      if (marker._map) return done();
      const vp = cluster.getVisibleParent(marker);
      if (vp && vp !== marker && vp.spiderfy) {
        cluster.once('spiderfied', () => done());
        vp.spiderfy();
      } else done();
    });

    const alreadyThere = marker._icon && map.getZoom() >= target - 0.01 && map.getBounds().pad(-0.1).contains(ll);
    if (alreadyThere) return finish();
    map.once('moveend', finish);
    const far = Math.abs(map.getZoom() - target) > 2 || !map.getBounds().contains(ll);
    if (far) map.flyTo(ll, target, { duration: 0.8 });
    else map.setView(ll, target, { animate: true });
  }

  function openPoint(entry, i, { fly = false } = {}) {
    const key = `${entry.id}:${i}`;
    const marker = state.markers.get(key);
    if (!marker) return;
    state.opening = { id: entry.id, i };
    revealMarker(marker, fly ? 6 : 0, () => {
      // Something else was opened while the map was moving
      if (state.opening?.id !== entry.id || state.opening.i !== i) return;
      // The live sheet replaced the snapshot mid-flight (e.g. a #row3 link on page
      // load), so this pin is gone: open the same location's new pin instead.
      if (state.markers.get(key) !== marker) {
        const fresh = state.byId.get(entry.id);
        if (fresh) openPoint(fresh, Math.min(i, fresh.points.length - 1));
        else state.opening = null;
        return;
      }
      state.opening = null;
      marker.openPopup();
      setActive(entry.id, i);
    });
  }

  /* ================= Detail card (popup + modal) ================= */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  const ICONS = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3zM12 10v4M12 17.5v.01"/></svg>',
  };
  const icon = (name) => {
    const span = document.createElement('span');
    span.className = 'ico';
    span.innerHTML = ICONS[name];
    return span;
  };

  // Text with clickable http(s) links, safely built from DOM nodes
  function linkify(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    // A URL ends where whitespace or another "http(s)://" starts (links pasted back to back)
    for (const m of text.matchAll(/https?:\/\/(?:(?!https?:\/\/)[^\s<>"])+/g)) {
      frag.append(text.slice(last, m.index));
      const url = m[0].replace(/[).,]+$/, '');
      frag.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, prettyUrl(url)));
      last = m.index + url.length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  function prettyUrl(url) {
    try {
      const u = new URL(url);
      if (/twitch\.tv$/.test(u.hostname)) return `Twitch VOD${u.searchParams.get('t') ? ` @ ${u.searchParams.get('t')}` : ''}`;
      if (/youtu\.?be/.test(u.hostname)) return 'YouTube video';
      return u.hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function linkKind(url) {
    if (/twitch\.tv/.test(url)) return { label: prettyUrl(url), ico: 'play' };
    if (/youtu\.?be/.test(url)) return { label: 'YouTube video', ico: 'play' };
    return { label: prettyUrl(url), ico: 'link' };
  }

  // Google serves sheet images with Cross-Origin-Resource-Policy: same-site, which
  // blocks plain <img> embeds; a CORS-mode request (crossorigin) is allowed through.
  const needsCors = (src) => /^https:\/\/(docs\.google\.com|[\w-]+\.googleusercontent\.com)\//.test(src);
  function image(im, attrs) {
    const el = h('img', { crossorigin: needsCors(im.thumb) ? 'anonymous' : null, src: im.thumb, ...attrs });
    if (im.local) el.addEventListener('error', () => useLocal(el, im.local), { once: true });
    return el;
  }
  function useLocal(el, src) {
    el.removeAttribute('crossorigin');
    el.src = src;
  }

  function formatPoint(p) {
    return axes(p).join(', ');
  }

  /* ---------- Video embeds ---------- */
  // "90", "1m30s" or "06h53m06s" -> seconds
  function parseTime(t) {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    return m ? (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) : 0;
  }

  // Turns a YouTube or Twitch VOD link into an embeddable player, or null.
  // Both players refuse to run inside a page opened from disk (file://).
  function videoEmbed(url) {
    if (!/^https?:$/.test(location.protocol)) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const id = host === 'youtu.be'
        ? u.pathname.slice(1).split('/')[0]
        : u.searchParams.get('v') || u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1];
      if (!/^[\w-]{11}$/.test(id || '')) return null;
      const start = parseTime(u.searchParams.get('t') || u.searchParams.get('start'));
      return {
        kind: 'YouTube',
        thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ''}`,
      };
    }
    if (host === 'twitch.tv') {
      const id = u.pathname.match(/^\/videos\/(\d+)/)?.[1];
      if (!id) return null;
      const t = u.searchParams.get('t');
      return {
        kind: 'Twitch',
        thumb: null, // Twitch has no public thumbnail URL; the location's photo stands in
        src: `https://player.twitch.tv/?video=v${id}&parent=${location.hostname}&autoplay=true${t ? `&time=${encodeURIComponent(t)}` : ''}`,
      };
    }
    return null;
  }

  /* ---------- Slideshow: videos first, then photos ---------- */
  function buildMedia(entry) {
    const slides = [
      ...entry.videoLinks.map(videoEmbed).filter(Boolean).map((video) => ({ video })),
      ...entry.images.map((im, i) => ({ im, i })),
    ];
    if (!slides.length) return h('div', { class: 'media media-empty' }, icon('image'), h('span', null, 'No image in the sheet yet'));

    let at = 0;
    const stage = h('div', { class: 'media-stage' });
    const counter = h('span', { class: 'media-count' });
    const media = h('div', { class: 'media' }, stage);

    const photo = ({ im, i }) => {
      const img = image(im, { alt: entry.title, decoding: 'async' });
      img.addEventListener('error', () => {
        if (im.local && !img.src.endsWith(im.local)) useLocal(img, im.local);
        else media.classList.add('is-broken');
      });
      img.addEventListener('load', () => media.classList.remove('is-broken'));
      return h('button', { class: 'media-open', type: 'button', 'aria-label': 'View image full size', onclick: () => openLightbox(entry, i) },
        img,
        h('span', { class: 'media-zoom' }, icon('expand'))
      );
    };

    // A thumbnail + play button; the player itself only loads on click, so opening
    // a card stays fast and nothing from YouTube/Twitch loads until asked for
    const videoPoster = ({ video }) => {
      const poster = video.thumb || entry.images[0]?.thumb;
      return h('button', {
        class: `media-play media-play--${video.kind.toLowerCase()}`,
        type: 'button',
        'aria-label': `Play ${video.kind} video`,
        onclick: (e) => {
          // This button is replaced mid-click; without this Leaflet sees a click on
          // a detached element, treats it as a map click and closes the popup
          e.stopPropagation();
          media.classList.add('is-playing');
          stage.replaceChildren(h('iframe', {
            class: 'media-frame',
            src: video.src,
            title: `${entry.title} — ${video.kind} video`,
            allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
            allowfullscreen: true,
            referrerpolicy: 'strict-origin-when-cross-origin',
          }));
        },
      },
        poster ? image({ thumb: poster }, { alt: '', decoding: 'async' }) : null,
        h('span', { class: 'media-play-btn' }, icon('play')),
        h('span', { class: 'media-play-label' }, icon('play'), video.kind)
      );
    };

    // Re-rendering the slide also removes any playing video, which stops it
    const show = () => {
      const s = slides[at];
      media.classList.remove('is-playing', 'is-broken');
      stage.replaceChildren(s.video ? videoPoster(s) : photo(s));
      counter.textContent = `${at + 1} / ${slides.length}`;
    };
    const step = (d) => (e) => {
      e.stopPropagation();
      at = (at + d + slides.length) % slides.length;
      show();
    };
    if (slides.length > 1) {
      media.append(
        h('button', { class: 'media-nav prev', type: 'button', 'aria-label': 'Previous slide', onclick: step(-1) }, icon('prev')),
        h('button', { class: 'media-nav next', type: 'button', 'aria-label': 'Next slide', onclick: step(1) }, icon('next')),
        counter
      );
    }
    show();
    return media;
  }

  function buildCard(entry, activeIndex, where) {
    const g = entry.group;
    const media = buildMedia(entry);

    const coords = entry.points.length
      ? h(
          'div',
          { class: 'coords' },
          entry.points.map((p, i) => {
            // In a popup, the other locations of a multi-location row jump to that pin (no copy)
            const canJump = where === 'popup' && i !== activeIndex;
            const text = [
              entry.points.length > 1 || p.label
                ? h('span', { class: 'coord-label' },
                    entry.points.length > 1 ? `Location ${i + 1} of ${entry.points.length}` : '',
                    entry.points.length > 1 && p.label ? ' · ' : '',
                    p.label || '')
                : null,
              h('code', null, formatPoint(p)),
              p.z == null ? h('span', { class: 'coord-warn' }, 'No Z in the sheet — you may need to adjust height') : null,
            ];
            const row = h(
              'div',
              { class: `coord${i === activeIndex ? ' is-active' : ''}` },
              canJump
                ? h('button', {
                    class: 'coord-text coord-go',
                    type: 'button',
                    title: 'Show this location on the map',
                    onclick: () => {
                      map.closePopup();
                      openPoint(entry, i);
                    },
                  }, text)
                : h('span', { class: 'coord-text' }, text),
              h('button', {
                class: 'coord-copy',
                type: 'button',
                title: `Copy as ${FORMATS[state.format].label}`,
                'aria-label': `Copy coordinates ${formatPoint(p)}`,
                onclick: () => {
                  copyPoint(entry, i);
                  flashCopied(row);
                },
              }, h('span', { class: 'coord-copy-icons' }, icon('copy'), icon('check')), h('span', { class: 'coord-copy-label' }, 'Copy'))
            );
            return row;
          })
        )
      : h('p', { class: 'coord-missing' }, 'No exact coordinates in the sheet for this one.');

    const showNotes = entry.notes && entry.notes.replace(/\s+/g, ' ').trim().toLowerCase() !== entry.title.toLowerCase();
    const confirmedExtra = entry.confirmed.text && !/^(yes|assumed( so| not)?|no)$/i.test(entry.confirmed.text.trim());

    const links = [
      ...entry.videoLinks.map((u) => ({ url: u, ...linkKind(u), label: /twitch|youtu/.test(u) ? linkKind(u).label : 'Video' })),
      ...entry.imageLinks.map((u, i, all) => ({ url: u, label: all.length > 1 ? `Image source ${i + 1}` : 'Image source', ico: 'image' })),
      ...entry.confirmed.links.map((u) => ({ url: u, ...linkKind(u), label: `Proof · ${linkKind(u).label}` })),
    ];
    const seen = new Set();
    const linkRow = links.filter((l) => !seen.has(l.url) && seen.add(l.url));

    return h(
      'article',
      { class: `card card--${where}`, style: `--c:${g.color}` },
      media,
      h(
        'div',
        { class: 'card-body' },
        h(
          'div',
          { class: 'card-tags' },
          h('span', { class: 'tag' }, h('span', { class: 'tag-dot' }), entry.category || g.label),
          entry.confirmed.status && h('span', { class: `status status--${entry.confirmed.status}` }, STATUS[entry.confirmed.status])
        ),
        h('h2', { class: 'card-title' }, entry.title),
        h('p', { class: 'card-dlc' }, entry.dlc || 'Base game / story mode', entry.release ? h('span', null, ` · ${entry.release}`) : null),
        coords,
        entry.points.length ? h('p', { class: 'card-hint' }, copyHint()) : null,
        showNotes && h('p', { class: 'card-notes' }, linkify(entry.notes)),
        noteImages(entry),
        entry.coordsNote && h('p', { class: 'card-subnote' }, linkify(entry.coordsNote)),
        confirmedExtra && h('p', { class: 'card-subnote' }, h('strong', null, 'NoPixel: '), linkify(entry.confirmed.text)),
        linkRow.length > 0 &&
          h('div', { class: 'card-links' },
            linkRow.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, icon(l.ico), l.label))
          ),
        h('p', { class: 'card-row' }, `Sheet row ${entry.row}`)
      )
    );
  }

  // Images floating over the notes in the sheet, shown right under the notes text.
  // The sheet's own width/height reserve the space up front so the card doesn't
  // jump (and the popup doesn't drift off screen) as they load.
  function noteImages(entry) {
    const list = entry.noteImages || [];
    if (!list.length) return null;
    return h(
      'div',
      { class: 'note-images' },
      list.map((im, i) =>
        h('button', {
          class: 'note-image',
          type: 'button',
          'aria-label': 'View image from the notes full size',
          style: im.width && im.height ? `aspect-ratio:${im.width} / ${im.height};max-width:${im.width}px` : null,
          onclick: () => openLightbox(entry, i, list),
        }, image(im, { alt: 'Image from the notes', loading: 'lazy', decoding: 'async' }))
      )
    );
  }

  function copyHint() {
    return `Copies as ${FORMATS[state.format].label} · change format under "Copy as"`;
  }

  function flashCopied(row) {
    const label = row.querySelector('.coord-copy-label');
    row.classList.add('is-copied');
    if (label) label.textContent = 'Copied';
    clearTimeout(row._copiedTimer);
    row._copiedTimer = setTimeout(() => {
      row.classList.remove('is-copied');
      if (label) label.textContent = 'Copy';
    }, 1400);
  }

  /* ================= Modal (entries without coordinates) ================= */
  function openModal(entry) {
    state.opening = null; // don't let a pin that's still being flown to pop up over this
    els.modal.replaceChildren(
      h('button', { class: 'lb-btn modal-close', type: 'button', 'aria-label': 'Close', onclick: () => els.modal.close() }, icon('close')),
      buildCard(entry, -1, 'modal')
    );
    els.modal.showModal();
    setActive(null);
    els.list.querySelector(`[data-id="${entry.id}"]`)?.classList.add('is-active');
    history.replaceState(null, '', `#${entry.id}`);
  }
  els.modal.addEventListener('click', (e) => e.target === els.modal && els.modal.close());
  els.modal.addEventListener('close', () => {
    for (const el of els.list.querySelectorAll('.item.is-active')) el.classList.remove('is-active');
  });

  /* ================= Lightbox ================= */
  // `images` is either the entry's photos or the images shown inline in its notes
  const lb = { entry: null, images: [], index: 0 };
  function openLightbox(entry, index, images = entry.images) {
    lb.entry = entry;
    lb.images = images;
    lb.index = index;
    showLightboxImage();
    if (!els.lightbox.open) els.lightbox.showModal();
  }
  function showLightboxImage() {
    const { entry, images, index } = lb;
    const im = images[index];
    els.lightbox.classList.toggle('is-single', images.length < 2);
    els.lightbox.classList.add('is-loading');
    els.lightboxImg.onload = () => els.lightbox.classList.remove('is-loading');
    els.lightboxImg.onerror = () => {
      if (im.local && !els.lightboxImg.src.endsWith(im.local)) useLocal(els.lightboxImg, im.local);
      else els.lightbox.classList.remove('is-loading');
    };
    if (needsCors(im.full)) els.lightboxImg.crossOrigin = 'anonymous';
    else els.lightboxImg.removeAttribute('crossorigin');
    els.lightboxImg.src = im.full;
    els.lightboxImg.alt = entry.title;
    els.lightboxCaption.textContent = `${entry.title}${images.length > 1 ? ` — ${index + 1} / ${images.length}` : ''}`;
  }
  function stepLightbox(d) {
    if (lb.images.length < 2) return;
    lb.index = (lb.index + d + lb.images.length) % lb.images.length;
    showLightboxImage();
  }
  els.lightbox.addEventListener('click', (e) => {
    const action = e.target.closest('[data-lb]')?.dataset.lb;
    if (action === 'close' || e.target === els.lightbox || e.target.tagName === 'FIGURE') els.lightbox.close();
    else if (action === 'prev') stepLightbox(-1);
    else if (action === 'next') stepLightbox(1);
  });

  /* ================= Clipboard + toast ================= */
  async function copyText(text, message) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0;pointer-events:none' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    toast(ok ? message : 'Copy failed — select the coordinates and copy manually', ok ? text : null, !ok);
    return ok;
  }

  function copyPoint(entry, i) {
    const p = entry.points[i];
    const label = entry.points.length > 1 ? `${entry.title} (${i + 1}/${entry.points.length})` : entry.title;
    return copyText(FORMATS[state.format].fmt(p), `Copied · ${label}`);
  }

  let toastTimer;
  function toast(message, detail, isError) {
    els.toast.replaceChildren(
      h('span', { class: 'toast-icon' }, icon(isError ? 'warn' : 'check')),
      h('span', { class: 'toast-text' }, h('span', null, message), detail ? h('code', null, detail) : null)
    );
    els.toast.classList.toggle('is-error', !!isError);
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 2600);
  }

  /* ================= Filtering + directory ================= */
  function matches(entry) {
    if (state.groups.size && !state.groups.has(entry.group.key)) return false;
    if (state.confirmedOnly && entry.confirmed.status !== 'yes') return false;
    if (!state.query) return true;
    return state.query.split(/\s+/).every((t) => entry.haystack.includes(t));
  }

  function render() {
    const visible = state.entries.filter(matches);
    renderMarkers(visible);
    renderList(visible);
    renderChips();
    const pins = visible.reduce((n, e) => n + e.points.length, 0);
    els.resultsMeta.textContent = state.entries.length
      ? `${visible.length} of ${state.entries.length} locations · ${pins} pins on map`
      : '';
  }

  function renderChips() {
    const counts = new Map();
    for (const e of state.entries) counts.set(e.group.key, (counts.get(e.group.key) || 0) + 1);
    const chips = [
      h('button', {
        class: `chip${state.groups.size ? '' : ' is-on'}`,
        type: 'button',
        'aria-pressed': String(!state.groups.size),
        onclick: () => { state.groups.clear(); render(); },
      }, 'All'),
      ...GROUPS.filter((g) => counts.get(g.key)).map((g) =>
        h('button', {
          class: `chip${state.groups.has(g.key) ? ' is-on' : ''}`,
          type: 'button',
          style: `--c:${g.color}`,
          'aria-pressed': String(state.groups.has(g.key)),
          onclick: () => {
            state.groups.has(g.key) ? state.groups.delete(g.key) : state.groups.add(g.key);
            render();
          },
        }, h('span', { class: 'chip-dot' }), g.label, h('span', { class: 'chip-n' }, counts.get(g.key)))
      ),
    ];
    els.chips.replaceChildren(...chips);
  }

  function renderList(visible) {
    if (!state.entries.length) {
      els.list.replaceChildren(h('div', { class: 'empty' }, state.mode === 'loading' ? 'Loading locations…' : 'No locations found in the sheet.'));
      return;
    }
    if (!visible.length) {
      els.list.replaceChildren(
        h('div', { class: 'empty' },
          h('p', null, 'No locations match your filters.'),
          h('button', { class: 'btn', type: 'button', onclick: clearFilters }, 'Clear filters'))
      );
      return;
    }
    const sections = [];
    let current = null;
    for (const e of visible) {
      const key = e.dlc || '';
      if (!current || current.key !== key) {
        current = { key, release: e.release, items: [] };
        sections.push(current);
      }
      current.items.push(e);
    }
    els.list.replaceChildren(
      ...sections.map((s) =>
        h('section', { class: 'dlc' },
          h('h3', { class: 'dlc-head' }, h('span', null, s.key || 'Base game & story mode'), s.release ? h('span', { class: 'dlc-date' }, s.release) : null),
          s.items.map((e) =>
            h('button', {
              class: `item${state.active?.id === e.id ? ' is-active' : ''}`,
              type: 'button',
              'data-id': e.id,
              style: `--c:${e.group.color}`,
              onclick: () => selectEntry(e),
              onmouseenter: () => hoverPins(e, true),
              onmouseleave: () => hoverPins(e, false),
            },
              h('span', { class: 'item-dot' }),
              h('span', { class: 'item-main' },
                h('span', { class: 'item-title' }, e.title),
                h('span', { class: 'item-sub' },
                  e.category || e.group.label,
                  e.confirmed.status === 'yes' ? h('span', { class: 'item-ok', title: STATUS.yes }, ' · ✓ NoPixel') : null),
                h('span', { class: 'item-coords' },
                  e.points.length === 0 ? 'No coordinates' : e.points.length === 1 ? formatPoint(e.points[0]) : `${e.points.length} locations`)
              ),
              e.images.length ? image(e.images[0], { class: 'item-thumb', alt: '', loading: 'lazy', decoding: 'async' }) : null
            )
          )
        )
      )
    );
  }

  function hoverPins(entry, on) {
    entry.points.forEach((_, i) => state.markers.get(`${entry.id}:${i}`)?.getElement()?.querySelector('.pin')?.classList.toggle('is-hover', on));
  }

  function selectEntry(entry) {
    if (window.matchMedia('(max-width: 760px)').matches) document.body.classList.remove('drawer-open');
    if (entry.points.length) openPoint(entry, 0, { fly: true });
    else openModal(entry);
  }

  function clearFilters() {
    state.query = '';
    els.search.value = '';
    state.groups.clear();
    state.confirmedOnly = false;
    els.confirmedOnly.checked = false;
    render();
  }

  /* ================= Data source footer ================= */
  function renderSource() {
    const time = (d) => d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const msg = {
      loading: 'Loading the live Google Sheet…',
      live: `Live from Google Sheet · ${state.loadedAt ? time(state.loadedAt) : ''}`,
      'live-csv': 'Live from Google Sheet (CSV — images from snapshot)',
      snapshot: `Offline snapshot · saved ${state.savedAt ? time(new Date(state.savedAt)) : ''}`,
      error: 'Could not load the sheet',
    }[state.mode];
    const detail =
      state.error && state.mode === 'snapshot'
        ? location.protocol === 'file:'
          ? 'Opened from disk — run start.bat for live data'
          : 'Live sheet unreachable — showing saved copy'
        : null;
    els.source.replaceChildren(
      h('span', { class: `src-dot src-dot--${state.mode}` }),
      h('span', { class: 'src-text' }, h('span', null, msg), detail ? h('small', null, detail) : null),
      h('button', {
        class: `icon-btn${state.mode === 'loading' ? ' is-spinning' : ''}`,
        type: 'button',
        title: 'Reload from Google Sheet',
        'aria-label': 'Reload from Google Sheet',
        onclick: loadLive,
      }, icon('refresh')),
      h('a', { class: 'icon-btn', href: SheetParser.URLS.view, target: '_blank', rel: 'noopener noreferrer', title: 'Open the Google Sheet', 'aria-label': 'Open the Google Sheet' }, icon('link'))
    );
  }

  /* ================= Loading ================= */
  function prepare(entries) {
    for (const e of entries) {
      e.group = groupOf(e.category);
      e.haystack = [e.title, e.notes, e.dlc, e.release, e.category, e.group.label, e.coordsText, e.confirmed.text, e.confirmed.status === 'yes' ? 'confirmed nopixel' : '']
        .join(' ')
        .toLowerCase();
    }
    return entries;
  }

  function setEntries(entries) {
    const reopen = state.active;
    state.entries = prepare(entries);
    state.byId = new Map(entries.map((e) => [e.id, e]));
    map.closePopup();
    buildMarkers();
    // Let the map pan out far enough to reach far-flung pins (e.g. Cayo Perico)
    const all = entries.flatMap((e) => e.points.map((p) => toLatLng(p.x, p.y)));
    contentBounds = all.length ? L.latLngBounds(TILE_BOUNDS.getSouthWest(), TILE_BOUNDS.getNorthEast()).extend(L.latLngBounds(all)) : TILE_BOUNDS;
    updateMaxBounds();
    render();
    if (reopen && state.byId.has(reopen.id)) openPoint(state.byId.get(reopen.id), reopen.i);
  }

  function snapshotKey(e) {
    return `${e.dlc}|${e.notes}|${e.coordsText}`;
  }
  function snapshotIndex() {
    return new Map((window.SNAPSHOT?.entries || []).map((e) => [snapshotKey(e), e]));
  }

  async function fetchLive() {
    try {
      const res = await fetch(SheetParser.URLS.html, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entries = SheetParser.fromHtml(await res.text());
      if (!entries.length) throw new Error('No rows');
      // Remember the saved copy of each image in case Google's copy fails to load
      const snap = snapshotIndex();
      for (const e of entries) {
        const s = snap.get(snapshotKey(e));
        if (s && s.images.length === e.images.length) e.images.forEach((im, i) => (im.local = s.images[i].full));
        const sn = s?.noteImages || [];
        if (sn.length === (e.noteImages || []).length) e.noteImages.forEach((im, i) => (im.local = sn[i].full));
      }
      return { entries, mode: 'live' };
    } catch (htmlErr) {
      // CSV has no images or hidden links; borrow them from the snapshot where rows match
      const res = await fetch(SheetParser.URLS.csv, { cache: 'no-store' });
      if (!res.ok) throw htmlErr;
      const entries = SheetParser.fromCsv(await res.text());
      const snap = snapshotIndex();
      for (const e of entries) {
        const s = snap.get(snapshotKey(e));
        if (s) Object.assign(e, { images: s.images, noteImages: s.noteImages || [], imageLinks: s.imageLinks, videoLinks: s.videoLinks });
      }
      return { entries, mode: 'live-csv' };
    }
  }

  let loading = false;
  async function loadLive() {
    if (loading) return;
    loading = true;
    const previous = state.mode;
    state.mode = 'loading';
    renderSource();
    try {
      const { entries, mode } = await fetchLive();
      state.mode = mode;
      state.loadedAt = new Date();
      state.error = null;
      setEntries(entries);
    } catch (err) {
      console.warn('Live sheet unavailable:', err);
      state.error = err;
      state.mode = window.SNAPSHOT ? 'snapshot' : 'error';
      if (previous === 'loading' || previous === 'error') render();
      if (!window.SNAPSHOT) toast('Could not load the Google Sheet', null, true);
    } finally {
      loading = false;
      renderSource();
    }
  }

  function openFromHash() {
    const m = location.hash.match(/^#(row\d+)(?:-(\d+))?$/);
    const entry = m && state.byId.get(m[1]);
    if (!entry) return;
    const i = Math.min(Number(m[2] || 1) - 1, Math.max(entry.points.length - 1, 0));
    entry.points.length ? openPoint(entry, i, { fly: true }) : openModal(entry);
  }

  /* ================= Controls ================= */
  for (const [key, f] of Object.entries(FORMATS)) els.format.append(h('option', { value: key, title: f.label }, f.short || f.label));
  els.format.value = state.format;
  els.format.addEventListener('change', () => {
    state.format = els.format.value;
    store.set('format', state.format);
    for (const el of document.querySelectorAll('.card-hint')) el.textContent = copyHint();
    for (const el of document.querySelectorAll('.coord-copy')) el.title = `Copy as ${FORMATS[state.format].label}`;
  });

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.search.value.trim().toLowerCase();
      render();
    }, 120);
  });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = els.list.querySelector('.item');
      if (first) state.byId.get(first.dataset.id) && selectEntry(state.byId.get(first.dataset.id));
    }
    if (e.key === 'Escape' && els.search.value) {
      e.stopPropagation();
      els.search.value = '';
      state.query = '';
      render();
    }
  });
  els.confirmedOnly.addEventListener('change', () => {
    state.confirmedOnly = els.confirmedOnly.checked;
    render();
  });

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      document.body.classList.add('drawer-open');
      els.search.focus();
      els.search.select();
    } else if (els.lightbox.open && e.key === 'ArrowLeft') stepLightbox(-1);
    else if (els.lightbox.open && e.key === 'ArrowRight') stepLightbox(1);
    else if (e.key === 'Escape' && !els.lightbox.open && !els.modal.open) map.closePopup();
  });

  $('drawerOpen').addEventListener('click', () => document.body.classList.add('drawer-open'));
  $('drawerClose').addEventListener('click', () => document.body.classList.remove('drawer-open'));
  map.on('click', () => document.body.classList.remove('drawer-open'));

  /* ================= Boot ================= */
  if (window.SNAPSHOT?.entries?.length) {
    state.mode = 'snapshot';
    state.savedAt = window.SNAPSHOT.savedAt;
    setEntries(window.SNAPSHOT.entries);
    openFromHash();
  } else render();
  renderSource();

  const hadEntries = state.entries.length > 0;
  loadLive().then(() => {
    if (!hadEntries) openFromHash();
  });
  window.addEventListener('hashchange', openFromHash);
})();
