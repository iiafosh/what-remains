// The DOM side of the experience: search with live breadcrumbs, destination
// dock, compass and zoom, status bar, altimeter, place card, pin, toasts, keys.
// update() runs every frame, so it only writes to the DOM when a value changes.

import { PLACES, byId } from './places.js';

const MODES = ['intro', 'space', 'flying', 'landed'];

// Altitudes (m) below which place.crumbs[0..4] appear.
const CRUMB_ALTITUDES = [8000e3, 2500e3, 200e3, 20e3, 3e3];

// Altimeter label bands: [lowest altitude in metres, label]. Below the last
// one it is 'Final approach', and 'Touchdown' once the fall has nearly stopped.
const ALT_BANDS = [
  [10000e3, 'Deep space'],
  [2000e3, 'High orbit'],
  [160e3, 'Low Earth orbit'],
  [120e3, 'Thermosphere'],
  [90e3, 'Kármán line'],
  [50e3, 'Mesosphere'],
  [12e3, 'Stratosphere'],
  [3e3, 'Troposphere'],
];

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(handlers = {}) {
    this.h = handlers;
    this.mode = MODES.find((m) => document.body.classList.contains(`is-${m}`)) || 'intro';
    this.current = null;      // place highlighted in the dock
    this.framePlace = null;   // place reported by the last frame
    this.cardPlace = null;    // place shown in the place card
    this.matches = [];        // places listed in the suggestions
    this.sel = -1;            // highlighted suggestion
    this.last = {};           // last value written to the DOM, by key
    this.crumbKey = '';
    this.crumbList = [];
    this.fitQueued = false;
    this.needleAngle = null;  // unwrapped, so 359° → 1° doesn't spin the needle all the way round
    this.lastHeading = 0;
    this.streamSeenAt = -Infinity;
    this.loading = false;
    this.toastTimer = 0;

    const begin = $('begin');
    const pin = $('pin');
    this.el = {
      brand: $('brand'),
      input: $('search'),
      searchBox: $('search').closest('.search'),
      crumbs: $('crumbs'),
      dice: $('dice'),
      list: $('suggestions'),
      sound: $('btn-sound'),
      full: $('btn-full'),
      altNum: $('alt-num'),
      altUnit: $('alt-unit'),
      altLabel: $('alt-label'),
      altSpeed: $('alt-speed'),
      card: $('placecard'),
      pcFlag: $('pc-flag'),
      pcTitle: $('pc-title'),
      pcSub: $('pc-sub'),
      pcLang: $('pc-lang'),
      pcOriginal: $('pc-original'),
      pcTranslation: $('pc-translation'),
      pcFacts: $('pc-facts'),
      pcCoords: $('pc-coords'),
      pcReplay: $('pc-replay'),
      pcShare: $('pc-share'),
      pcNext: $('pc-next'),
      pcClose: $('pc-close'),
      compass: $('compass'),
      needle: $('needle'),
      zoomIn: $('zoom-in'),
      zoomOut: $('zoom-out'),
      space: $('btn-space'),
      dock: $('dock'),
      stream: $('st-stream'),
      scale: $('st-scale'),
      scaleBar: $('st-scale-bar'),
      scaleLabel: $('st-scale-label'),
      coords: $('st-coords'),
      alt: $('st-alt'),
      loadbar: $('loadbar'),
      toast: $('toast'),
      begin,
      beginLabel: begin.querySelector('.begin-label'),
      pin,
      pinLabel: pin.querySelector('.pin-label'),
    };

    // The "N" rides on the needle, so it turns with it.
    const north = $('compass-n');
    if (north) this.el.needle.append(north);

    this._buildDock();
    this._buildSuggestions();
    this._wireSearch();
    this._wireControls();
    this._wirePlaceCard();
    addEventListener('keydown', (e) => this._onKey(e));
  }

  // ---------- Public API ----------
  setMode(mode) {
    if (!MODES.includes(mode)) return;
    const classes = document.body.classList;
    for (const m of MODES) classes.toggle(`is-${m}`, m === mode);
    this.mode = mode;
    if (mode === 'intro' || mode === 'flying') {
      this._closeSuggestions();
      if (document.activeElement === this.el.input) this.el.input.blur();
    }
  }

  setBeginReady(ready, label) {
    this.el.begin.disabled = !ready;
    if (label != null && this.el.beginLabel) this.el.beginLabel.textContent = label;
  }

  setCurrent(place) {
    this.current = place || null;
    const id = place ? place.id : null;
    for (const card of this.cards) {
      if (card.dataset.id === id) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    }
  }

  update(frame) {
    if (!frame) return;
    const alt = Number.isFinite(frame.altitude) ? Math.max(0, frame.altitude) : 0;
    this.framePlace = frame.place || null;

    this._updatePin(frame.pin);
    this._updateLoad(frame.loadProgress);
    if (this.mode === 'intro') return; // everything else is hidden behind the intro

    if (this.mode === 'flying') this._updateAltimeter(alt, frame.speedKmh);
    this._updateCrumbs(this.framePlace, alt);
    this._updateCompass(frame.heading);
    this._updateStatus(frame, alt);
  }

  showPlaceCard(place) {
    if (!place) return;
    const e = this.el;
    this.cardPlace = place;
    e.pcFlag.textContent = place.flag;
    e.pcTitle.textContent = place.landmark;
    e.pcSub.replaceChildren(native(place.landmarkNative, place), ` · ${place.country}`);
    e.pcLang.textContent = place.languageName;
    e.pcLang.lang = place.lang;
    e.pcLang.dir = place.dir;
    e.pcOriginal.textContent = place.lines.join(' ');
    e.pcOriginal.lang = place.lang;
    e.pcOriginal.dir = place.dir;
    e.pcTranslation.textContent = `“${place.translation}”`;
    const facts = document.createDocumentFragment();
    for (const [label, value] of place.facts || []) facts.append(make('dt', null, label), make('dd', null, value));
    e.pcFacts.replaceChildren(facts);
    e.pcCoords.textContent = formatLatLon(place.target.lat, place.target.lon);
    e.card.hidden = false;
  }

  hidePlaceCard() {
    this.el.card.hidden = true;
  }

  setSoundState(muted) {
    this.el.sound.setAttribute('aria-pressed', String(!muted));
  }

  toast(text, ms = 2200) {
    const t = this.el.toast;
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- Building ----------
  _buildDock() {
    const frag = document.createDocumentFragment();
    this.cards = PLACES.map((place, i) => {
      const key = String(i + 1);
      const card = make('button', 'card');
      card.type = 'button';
      card.dataset.id = place.id;
      card.title = `${place.landmark}, ${place.country} (${key})`;
      card.setAttribute('aria-keyshortcuts', key);
      const flag = make('span', 'c-flag', place.flag);
      const hint = make('span', 'c-key', key);
      flag.setAttribute('aria-hidden', 'true');
      hint.setAttribute('aria-hidden', 'true');
      card.append(flag, make('span', 'c-country', place.country), make('span', 'c-landmark', place.landmark), hint);
      card.addEventListener('click', () => this.h.onSelect?.(place));
      frag.append(card);
      return card;
    });
    this.el.dock.replaceChildren(frag);
  }

  _buildSuggestions() {
    this.index = PLACES.map((place) => ({
      place,
      fields: [
        place.country, place.landmark, place.countryNative, place.landmarkNative,
        place.languageName, ...(place.crumbs || []),
      ].map(fold),
    }));

    // One <li> per place, built once and reordered as the query changes.
    this.items = new Map();
    PLACES.forEach((place, i) => {
      const li = make('li');
      li.id = `sg-${place.id}`;
      li.dataset.id = place.id;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const main = make('span', 'sg-main', place.country);
      const small = make('small', null, `${place.landmark} · `);
      small.append(native(place.countryNative, place));
      main.append(small);
      li.append(make('span', 'sg-flag', place.flag), main, make('span', 'sg-key', String(i + 1)));
      this.items.set(place.id, li);
    });

    this.emptyItem = make('li');
    this.emptyItem.setAttribute('role', 'option');
    this.emptyItem.setAttribute('aria-disabled', 'true');
    this.emptyMain = make('span', 'sg-main');
    this.emptyItem.append(make('span', 'sg-flag'), this.emptyMain);
  }

  // ---------- Search ----------
  _wireSearch() {
    const { input, list, crumbs, dice, searchBox } = this.el;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');

    input.addEventListener('focus', () => this._showSuggestions());
    input.addEventListener('input', () => this._showSuggestions());
    input.addEventListener('blur', () => {
      this._closeSuggestions();
      this._queueCrumbFit(); // the crumbs reappear and lost their scroll position
    });
    input.addEventListener('keydown', (e) => this._onSearchKey(e));

    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-id]');
      if (li) this._choose(byId(li.dataset.id));
    });
    list.addEventListener('pointermove', (e) => {
      const li = e.target.closest('li[data-id]');
      const i = li ? this.matches.findIndex((p) => p.id === li.dataset.id) : -1;
      if (i >= 0 && i !== this.sel) {
        this.sel = i;
        this._markSelected();
      }
    });

    crumbs.addEventListener('click', () => {
      input.value = '';
      this._focusSearch();
    });
    dice.addEventListener('click', () => this._choose(this._randomPlace()));

    document.addEventListener('pointerdown', (e) => {
      if (searchBox.contains(e.target)) return;
      this._closeSuggestions();
      if (document.activeElement === input) input.blur();
    }, true);
    addEventListener('resize', () => this._queueCrumbFit());
  }

  _onSearchKey(e) {
    if (e.isComposing || e.keyCode === 229) return; // IME (e.g. Japanese) still composing
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (this.el.list.hidden) {
          this._showSuggestions();
          return;
        }
        const n = this.matches.length;
        if (!n) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        this.sel = this.sel < 0 ? (step > 0 ? 0 : n - 1) : (this.sel + step + n) % n;
        this._markSelected();
        break;
      }
      case 'Enter': {
        e.preventDefault();
        if (this.el.list.hidden) this._showSuggestions();
        const raw = this.el.input.value.trim();
        const pick = this.matches[this.sel] || (raw && this.matches[0]);
        if (pick) this._choose(pick);
        else if (raw) this.toast(`No match for “${raw}”`);
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this._closeSuggestions();
        this.el.input.blur();
        break;
    }
  }

  _showSuggestions() {
    const raw = this.el.input.value.trim();
    const q = fold(raw);
    this.matches = this._filter(q);
    this.sel = q && this.matches.length ? 0 : -1;

    const list = this.el.list;
    if (this.matches.length) {
      list.replaceChildren(...this.matches.map((p) => this.items.get(p.id)));
    } else {
      this.emptyMain.replaceChildren(`No match for “${raw}”`, make('small', null, 'Try a country, a landmark or a language'));
      list.replaceChildren(this.emptyItem);
    }
    this._markSelected();

    if (list.hidden) {
      list.hidden = false;
      this.el.input.setAttribute('aria-expanded', 'true');
    }
  }

  _closeSuggestions() {
    const { list, input } = this.el;
    if (list.hidden) return;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    this.sel = -1;
  }

  _markSelected() {
    this.matches.forEach((p, i) => this.items.get(p.id).setAttribute('aria-selected', String(i === this.sel)));
    const active = this.matches[this.sel];
    if (active) this.el.input.setAttribute('aria-activedescendant', `sg-${active.id}`);
    else this.el.input.removeAttribute('aria-activedescendant');
  }

  // Prefix matches first, then word starts, then anywhere; ties keep dock order.
  _filter(q) {
    if (!q) return PLACES.slice();
    const scored = [];
    this.index.forEach(({ place, fields }, i) => {
      let best = 3;
      for (const f of fields) {
        const at = f.indexOf(q);
        if (at < 0) continue;
        const score = at === 0 ? 0 : /[\p{L}\p{N}]/u.test(f[at - 1]) ? 2 : 1;
        if (score < best) best = score;
      }
      if (best < 3) scored.push({ place, rank: best * 100 + i });
    });
    return scored.sort((a, b) => a.rank - b.rank).map((s) => s.place);
  }

  _choose(place) {
    if (!place) return;
    this._closeSuggestions();
    this.el.input.value = '';
    this.el.input.blur();
    this.h.onSelect?.(place);
  }

  _focusSearch() {
    const input = this.el.input;
    input.focus({ preventScroll: true });
    input.select();
    if (this.el.list.hidden) this._showSuggestions();
  }

  _randomPlace() {
    const cur = (this.current || this.framePlace)?.id;
    const pool = PLACES.filter((p) => p.id !== cur);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---------- Controls ----------
  _wireControls() {
    const { brand, compass, zoomIn, zoomOut, space, sound, full, begin } = this.el;
    brand.addEventListener('click', (e) => {
      e.preventDefault();
      this.h.onSpace?.();
    });
    space.addEventListener('click', () => this.h.onSpace?.());
    compass.addEventListener('click', () => this.h.onResetView?.());
    zoomIn.addEventListener('click', () => this.h.onZoom?.(0.8));
    zoomOut.addEventListener('click', () => this.h.onZoom?.(1.25));
    sound.addEventListener('click', () => this._toggleSound());
    full.addEventListener('click', () => this._toggleFullscreen());
    begin.addEventListener('click', () => {
      if (!begin.disabled) this.h.onBegin?.();
    });

    const syncFull = () => full.setAttribute('aria-pressed', String(!!fullscreenElement()));
    document.addEventListener('fullscreenchange', syncFull);
    document.addEventListener('webkitfullscreenchange', syncFull);
  }

  _wirePlaceCard() {
    const e = this.el;
    e.pcReplay.addEventListener('click', () => this.h.onRewrite?.());
    e.pcNext.addEventListener('click', () => this.h.onNext?.());
    e.pcShare.addEventListener('click', () => this._share());
    e.pcClose.addEventListener('click', () => this.hidePlaceCard());
  }

  _toggleSound() {
    const muted = this.h.onToggleSound?.();
    if (typeof muted === 'boolean') this.setSoundState(muted);
    else if (muted && typeof muted.then === 'function') {
      muted.then((m) => { if (typeof m === 'boolean') this.setSoundState(m); }, () => {});
    }
  }

  _toggleFullscreen() {
    const doc = document;
    const root = doc.documentElement;
    const fail = () => this.toast('Fullscreen is not available here');
    try {
      const result = fullscreenElement()
        ? (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc)
        : (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      if (result && typeof result.catch === 'function') result.catch(fail);
    } catch {
      fail();
    }
  }

  async _share() {
    const place = this.cardPlace;
    if (!place) return;
    const url = `${location.origin}${location.pathname}#${place.id}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      ok = copyWithInput(url);
    }
    if (ok) this.toast('Link copied');
    else this.toast(url, 6000);
  }

  _onKey(e) {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.mode === 'intro' || isTyping(e.target)) return; // the search input handles its own keys
    const key = e.key;

    if (key === 'Escape') {
      if (!this.el.list.hidden) this._closeSuggestions();
      else this.h.onSpace?.();
      return;
    }
    if (e.repeat) return;

    if (key.length === 1 && key >= '1' && key <= '9') {
      const place = PLACES[key - 1];
      if (place) {
        e.preventDefault();
        this.h.onSelect?.(place);
      }
      return;
    }
    switch (key.toLowerCase()) {
      case 'm':
        this._toggleSound();
        break;
      case 'f':
        this._toggleFullscreen();
        break;
      case '/':
        e.preventDefault();
        this._focusSearch();
        break;
    }
  }

  // ---------- Per-frame pieces ----------
  _text(key, el, text) {
    if (this.last[key] === text) return;
    this.last[key] = text;
    el.textContent = text;
  }

  _hidden(key, el, hidden) {
    if (this.last[key] === hidden) return;
    this.last[key] = hidden;
    el.hidden = hidden;
  }

  _style(key, el, prop, value) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    el.style[prop] = value;
  }

  _updatePin(pin) {
    const show = !!pin && Number.isFinite(pin.x) && Number.isFinite(pin.y);
    if (show !== this.last.pinShow) {
      this.last.pinShow = show;
      this.el.pin.classList.toggle('show', show);
    }
    if (!show) return; // keep the last position so it fades out in place
    this._style('pinTf', this.el.pin, 'transform', `translate3d(${pin.x.toFixed(1)}px, ${pin.y.toFixed(1)}px, 0)`);
    if (pin.label != null) this._text('pinLabel', this.el.pinLabel, String(pin.label));
  }

  _updateLoad(progress) {
    if (!Number.isFinite(progress)) return;
    const p = Math.min(1, Math.max(0, progress));
    const bar = this.el.loadbar;
    if (!this.loading) {
      if (p >= 0.98) return;
      // A new burst of loading: snap the bar back to the start instead of sliding it there.
      this.loading = true;
      bar.style.transition = 'none';
      bar.style.opacity = '1';
      requestAnimationFrame(() => { bar.style.transition = ''; });
    }
    const done = p >= 0.999;
    this._style('loadW', bar, 'width', done ? '100%' : `${(p * 100).toFixed(1)}%`);
    if (done) {
      this.loading = false;
      bar.style.opacity = '0';
    }
  }

  _updateAltimeter(alt, speedKmh) {
    const e = this.el;
    let num;
    let unit = 'km';
    if (alt >= 100e3) num = nf0.format(alt / 1000);
    else if (alt >= 10e3) num = nf1.format(alt / 1000);
    else {
      num = nf0.format(alt);
      unit = 'm';
    }
    const speed = Number.isFinite(speedKmh) ? Math.abs(speedKmh) : 0;
    this._text('altNum', e.altNum, num);
    this._text('altUnit', e.altUnit, unit);
    this._text('altLabel', e.altLabel, altitudeLabel(alt, speed));
    this._text('altSpeed', e.altSpeed, nf0.format(speed));
  }

  _updateCrumbs(place, alt) {
    let count = 0;
    if (place) while (count < CRUMB_ALTITUDES.length && alt < CRUMB_ALTITUDES[count]) count++;
    const key = place ? `${place.id}:${count}` : '';
    if (key === this.crumbKey) return;
    this.crumbKey = key;

    this.el.searchBox.classList.toggle('has-crumbs', !!place);
    const list = !place ? [] : count ? (place.crumbs || []).slice(0, count) : ['Earth'];

    // Keep the spans both lists share, so only the new crumbs animate in.
    const el = this.el.crumbs;
    let keep = 0;
    while (keep < list.length && keep < this.crumbList.length && list[keep] === this.crumbList[keep]) keep++;
    while (el.childElementCount > keep) el.lastElementChild.remove();
    for (let i = keep; i < list.length; i++) el.append(make('span', null, list[i]));
    this.crumbList = list;
    this._queueCrumbFit();
  }

  // Scroll the crumbs to their end so the newest stays visible when they
  // overflow. Reads layout, so it runs at most once a frame and only when the
  // crumbs (or the window) change.
  _queueCrumbFit() {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      const el = this.el.crumbs;
      el.scrollLeft = el.scrollWidth;
      const clipped = el.scrollLeft > 0;
      if (clipped !== this.last.crumbsClipped) {
        this.last.crumbsClipped = clipped;
        el.classList.toggle('clipped', clipped);
      }
    });
  }

  _updateCompass(heading) {
    if (!Number.isFinite(heading)) return;
    if (this.needleAngle === null) this.needleAngle = heading;
    else this.needleAngle += ((((heading - this.lastHeading) % 360) + 540) % 360) - 180;
    this.lastHeading = heading;
    this._style('needle', this.el.needle, 'transform', `rotate(${(-this.needleAngle).toFixed(1)}deg)`);
  }

  _updateStatus(frame, alt) {
    const e = this.el;
    const { lon, lat, metersPerPixel: mpp } = frame;
    this._text('coords', e.coords, Number.isFinite(lon) && Number.isFinite(lat) ? formatLatLon(lat, lon) : '—');
    this._text('eyeAlt', e.alt, alt >= 10e3 ? `Eye alt ${nf0.format(alt / 1000)} km` : `Eye alt ${nf0.format(alt)} m`);

    const meters = scaleMeters(mpp);
    this._hidden('scale', e.scale, !meters);
    if (meters) {
      this._style('scaleW', e.scaleBar, 'width', `${Math.round(meters / mpp)}px`);
      this._text('scaleLabel', e.scaleLabel, formatDistance(meters));
    }

    // Held for a moment so the spinner doesn't flicker between tile batches.
    const now = performance.now();
    if (frame.streaming > 0) this.streamSeenAt = now;
    this._hidden('stream', e.stream, now - this.streamSeenAt > 400);
  }
}

// ---------- Helpers ----------
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Native-script text, tagged so the browser picks the right font and direction.
function native(text, place) {
  const span = make('span', null, text);
  span.lang = place.lang;
  span.dir = place.dir;
  return span;
}

// Case- and diacritic-insensitive form for search ("Ελλάδα" → "ελλαδα", "Kármán" → "karman").
function fold(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isTyping(t) {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function altitudeLabel(alt, speedKmh) {
  if (alt < 3e3 && speedKmh < 5) return 'Touchdown';
  for (const [min, label] of ALT_BANDS) if (alt >= min) return label;
  return 'Final approach';
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;

function dms(value, pos, neg) {
  const total = Math.round(Math.abs(value) * 3600);
  const d = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return `${d}°${pad2(m)}'${pad2(s)}"${value < 0 && total > 0 ? neg : pos}`;
}

// Google Earth style: 29°58'45"N  31°08'03"E
function formatLatLon(lat, lon) {
  const wrapped = ((((lon % 360) + 540) % 360)) - 180;
  return `${dms(lat, 'N', 'S')}  ${dms(wrapped, 'E', 'W')}`;
}

// Largest 1-2-5 distance whose bar fits in 110 px (that always leaves it at
// least 44 px, usually 50+). 0 hides the scale bar.
function scaleMeters(mpp) {
  if (!Number.isFinite(mpp) || mpp <= 0) return 0;
  const max = mpp * 110;
  const base = 10 ** Math.floor(Math.log10(max));
  const r = max / base;
  const meters = (r >= 5 ? 5 : r >= 2 ? 2 : 1) * base;
  return meters > 2000e3 ? 0 : meters;
}

function formatDistance(m) {
  if (m >= 1000) return `${nf0.format(m / 1000)} km`;
  if (m >= 1) return `${Math.round(m)} m`;
  return `${Math.round(m * 100)} cm`;
}

// Clipboard fallback for insecure contexts and older browsers.
function copyWithInput(text) {
  const prev = document.activeElement;
  const input = document.createElement('input');
  input.value = text;
  input.readOnly = true;
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(input);
  input.select();
  input.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  input.remove();
  if (prev && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
  return ok;
}
