// Sound: the journey itself is synthesized; the ground at each place is real
// field recordings (CONFIG.ambience), streamed and looped with a crossfade.
// If a recording can't be loaded, that place falls back to synthesis.
//
//   layers (space, motion, re-entry, cloud, air, ground, writing)
//     → mix → muffle (closes inside clouds) → drive → limiter → master → speakers
//   cues → drive directly, so a whoosh is never muffled
//   every layer also sends into one shared convolution reverb, returned into mix.
//
// No oscillator below ~120 Hz glides or wobbles: every rumble, thump and
// swell down there is filtered noise, so nothing can sound like an engine.

import { CONFIG } from './config.js';

// The mix is balanced and limited at DRIVE; MASTER sets how loud the result
// is (0.45 ≈ −7 dB, about half the original level) and does the muting, so the balance never changes with it.
const DRIVE = 0.85;
const MASTER = 0.45;

// Recordings: each decoded file is scaled toward this RMS before its layer gain.
const BED_RMS = 0.12;
const BED_FADE = 1.5;        // seconds of crossfade at the loop point
const BED_AHEAD = 75;        // seconds of loop scheduled ahead (survives throttled timers)
const LOAD_TIMEOUT = 25;     // seconds before a recording counts as failed

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const clamp01 = (x) => clamp(x, 0, 1);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
const logRand = (lo, hi) => lo * Math.pow(hi / lo, Math.random());
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const chance = (p) => Math.random() < p;
const num = (x, fallback) => (Number.isFinite(x) ? x : fallback);

// 1D value noise for gusts: smooth, never repeating in a way you'd notice.
const VN = Float32Array.from({ length: 256 }, () => Math.random());
function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = VN[i & 255];
  const b = VN[(i + 1) & 255];
  return a + (b - a) * f * f * (3 - 2 * f);
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

// Looping stereo noise. Each channel is generated separately (decorrelated, so
// it sounds wide), the extra tail is crossfaded into the head so the loop has
// no seam, and every colour is normalised to the same RMS.
function makeNoise(ctx, kind, seconds = 5) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.2);
  const buf = ctx.createBuffer(2, n, sr);
  const raw = new Float32Array(n + fade);
  for (let ch = 0; ch < 2; ch++) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') {
        raw[i] = w;
      } else if (kind === 'pink') {
        // Paul Kellet's pink filter.
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        raw[i] = last;
      }
    }
    const out = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] = raw[i];
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      out[i] = raw[i] * Math.sqrt(k) + raw[n + i] * Math.sqrt(1 - k);
    }
    let mean = 0;
    for (let i = 0; i < n; i++) mean += out[i];
    mean /= n;
    let sum = 0;
    for (let i = 0; i < n; i++) { out[i] -= mean; sum += out[i] * out[i]; }
    const k = 0.2 / Math.sqrt(sum / n || 1);
    for (let i = 0; i < n; i++) out[i] = clamp(out[i] * k, -1, 1);
  }
  return buf;
}

// Reverb impulse: decaying stereo noise that darkens as it fades, a short
// pre-delay and a few early reflections.
function makeImpulse(ctx, seconds = 3.6) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const pre = Math.floor(sr * 0.018);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const x = (i - pre) / (n - pre);
      const a = 0.08 + 0.8 * x;
      lp = lp * a + (Math.random() * 2 - 1) * (1 - a);
      d[i] = lp * Math.exp(-x * 5.5) * (1 - x);
    }
    for (let r = 0; r < 6; r++) {
      const at = pre + Math.floor(sr * rand(0.004, 0.07));
      d[at] += (chance(0.5) ? -1 : 1) * rand(0.15, 0.4);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Small helpers around AudioParams and nodes
// ---------------------------------------------------------------------------

// Freeze a param at its current value so a new ramp can start from there.
function hold(param, t) {
  if (param.cancelAndHoldAtTime) {
    try { param.cancelAndHoldAtTime(t); return; } catch (e) { /* fall back below */ }
  }
  const v = param.value;
  param.cancelScheduledValues(t);
  param.setValueAtTime(v, t);
}

const NO_PARAM = {
  value: 0,
  setValueAtTime() {},
  setTargetAtTime() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
  setValueCurveAtTime() {},
  cancelScheduledValues() {},
};

function makePanner(ctx, pan) {
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }
  // Very old browsers: no panning, but the same shape.
  const g = ctx.createGain();
  g.pan = NO_PARAM;
  return g;
}

// Steers one or more AudioParams with setTargetAtTime; skips calls that would
// change nothing so per-frame updates stay cheap.
class Ctl {
  constructor(params, tau, eps = 0.0005, relative = false) {
    this.params = Array.isArray(params) ? params : [params];
    this.tau = tau;
    this.eps = eps;
    this.relative = relative;
    this.last = NaN;
  }

  set(value, t) {
    if (!Number.isFinite(value)) return;
    const limit = this.relative ? Math.abs(value) * this.eps : this.eps;
    if (Math.abs(value - this.last) <= limit) return;
    this.last = value;
    for (const p of this.params) p.setTargetAtTime(value, t, this.tau);
  }
}

// Owns a list of nodes so they can be disconnected together.
class Rack {
  constructor(sc) {
    this.sc = sc;
    this.ctx = sc.ctx;
    this.nodes = [];
    this.lastPan = null;
  }

  keep(node) { this.nodes.push(node); return node; }

  gain(value = 1) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return this.keep(g);
  }

  // For lowpass/highpass Web Audio's Q is a resonance in dB; for bandpass it is a real Q.
  filter(type, freq, q = type === 'bandpass' ? 1 : 0) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return this.keep(f);
  }

  panner(pan = 0) { return this.keep(makePanner(this.ctx, pan)); }

  // input → (distance lowpass) → pan → dry + reverb send. Far things are duller,
  // quieter and wetter. Returns the input gain.
  out(dest, { pan = 0, dist = 0, level = 1, wet } = {}) {
    const input = this.gain(level);
    let node = input;
    if (dist > 0.01) {
      const lp = this.filter('lowpass', 14000 * Math.pow(0.1, dist), 0);
      node.connect(lp);
      node = lp;
    }
    const p = this.panner(pan);
    node.connect(p);
    const dry = this.gain(1 - dist * 0.65);
    p.connect(dry);
    dry.connect(dest.dry);
    const w = wet ?? 0.1 + dist * 0.75;
    if (w > 0) {
      const send = this.gain(w);
      p.connect(send);
      send.connect(dest.wet);
    }
    this.lastPan = p;
    return input;
  }

  disconnectAll() {
    for (const n of this.nodes) {
      try { n.disconnect(); } catch (e) { /* already disconnected */ }
    }
    this.nodes = [];
  }
}

// A one-shot: all of its nodes are disconnected once its sources have ended.
class Voice extends Rack {
  constructor(sc, owner = null) {
    super(sc);
    this.owner = owner;
    this.srcs = [];
    this.live = 0;
    this.done = false;
    if (owner) owner.add(this);
  }

  osc(type, freq, t0, t1, detune = 0) {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type;
    else o.setPeriodicWave(type);
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    this._run(o, t0, t1);
    return o;
  }

  noise(kind, t0, t1, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.sc.noise[kind];
    s.loop = true;
    s.playbackRate.value = rate;
    this._run(s, t0, t1, Math.random() * s.buffer.duration);
    return s;
  }

  sample(buffer, t0, t1) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    this._run(s, t0, t1, 0);
    return s;
  }

  _run(src, t0, t1, offset) {
    this.keep(src);
    this.srcs.push(src);
    this.live++;
    src.onended = () => { if (--this.live <= 0) this.dispose(); };
    if (offset === undefined) src.start(t0);
    else src.start(t0, offset);
    src.stop(Math.max(t0 + 0.02, t1));
  }

  kill() {
    for (const s of this.srcs) {
      try { s.stop(); } catch (e) { /* already stopped */ }
    }
    this.dispose();
  }

  dispose() {
    if (this.done) return;
    this.done = true;
    this.disconnectAll();
    this.srcs = [];
    if (this.owner) this.owner.delete(this);
  }
}

// A long-lived set of nodes (a layer, a place's ambience, an inscription) with
// its own fade, timers and one-shot voices, all torn down by stop().
class Group extends Rack {
  constructor(sc, dryDest, wetDest, level = 1, fadeIn = 0) {
    super(sc);
    const t = this.ctx.currentTime;
    this.dry = this.ctx.createGain();
    this.wet = this.ctx.createGain();
    for (const g of [this.dry, this.wet]) {
      g.gain.setValueAtTime(fadeIn > 0 ? 0 : level, t);
      if (fadeIn > 0) g.gain.setTargetAtTime(level, t, fadeIn / 3);
    }
    this.dry.connect(dryDest);
    this.wet.connect(wetDest);
    this.dest = { dry: this.dry, wet: this.wet };
    this.srcs = [];
    this.voices = new Set();
    this.timers = new Set();
    this.cleanup = [];
    this.alive = true;
    this.gate = null;          // (level) => boolean: may timed events play now?
    this.lv = 1;               // level of timed events (lower under recordings)
  }

  // Looping noise, started at a random point so layers never line up.
  src(kind, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.sc.noise[kind];
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(this.ctx.currentTime, Math.random() * s.buffer.duration);
    this.srcs.push(s);
    return this.keep(s);
  }

  osc(type, freq, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    o.start();
    this.srcs.push(o);
    return this.keep(o);
  }

  // A slow modulator: connect the returned gain to an AudioParam.
  lfo(freq, depth, type = 'sine') {
    const g = this.gain(depth);
    this.osc(type, freq).connect(g);
    return g;
  }

  voice() { return new Voice(this.sc, this.voices); }

  after(sec, fn) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (this.alive) fn();
    }, Math.max(0, sec) * 1000);
    this.timers.add(id);
  }

  // Calls fn(time) at jittered intervals. Gated events that can't play right
  // now (too high up, muted) retry soon instead of waiting a whole interval.
  every(min, max, fn, { first, always = false, level = 0.05 } = {}) {
    const tick = () => {
      if (!always && this.gate && !this.gate(level)) {
        this.after(rand(1, 2.5), tick);
        return;
      }
      try { fn(this.ctx.currentTime + 0.05); } catch (e) { console.warn('[audio]', e); }
      this.after(rand(min, max), tick);
    };
    this.after(first ?? rand(min, max), tick);
  }

  // Random walk of a param. Returns { value } holding the latest target.
  drift(param, lo, hi, minS, maxS, log = false) {
    const next = () => (log ? logRand(lo, hi) : rand(lo, hi));
    const state = { value: next() };
    param.setValueAtTime(state.value, this.ctx.currentTime);
    this.every(minS, maxS, () => {
      state.value = next();
      param.setTargetAtTime(state.value, this.ctx.currentTime, rand(minS, maxS) * 0.3);
    }, { always: true, first: rand(0, minS) });
    return state;
  }

  stop(fade = 0.5) {
    if (!this.alive) return;
    this.alive = false;
    this.gate = null;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    const t = this.ctx.currentTime;
    for (const g of [this.dry, this.wet]) {
      hold(g.gain, t);
      g.gain.setTargetAtTime(0, t, Math.max(0.01, fade / 4));
    }
    setTimeout(() => {
      for (const v of [...this.voices]) v.kill();
      for (const fn of this.cleanup) {
        try { fn(); } catch (e) { /* already gone */ }
      }
      this.cleanup = [];
      for (const s of this.srcs) {
        try { s.stop(); } catch (e) { /* already stopped */ }
      }
      this.srcs = [];
      this.disconnectAll();
      this.dry.disconnect();
      this.wet.disconnect();
    }, fade * 1000 + 200);
  }
}

// ---------------------------------------------------------------------------
// Recorded beds
// ---------------------------------------------------------------------------

// Equal-power fades: a pass fading out under the next one fading in keeps the
// same loudness, so the loop point is heard as nothing at all.
const FADE_IN = Float32Array.from({ length: 128 }, (_, i) => Math.sin((i / 127) * Math.PI / 2));
const FADE_OUT = FADE_IN.slice().reverse();

// A recording looped without a seam: overlapping passes through the buffer,
// each faded in and out, scheduled well ahead. The first pass starts at a
// random point so a place never sounds the same twice.
class Bed {
  constructor(g, buffer, dest) {
    this.g = g;
    this.ctx = g.ctx;
    this.buffer = buffer;
    this.dest = dest;
    this.fade = Math.min(BED_FADE, buffer.duration / 6);
    this.passes = new Set();
    this.next = 0;
    this.first = true;
    g.cleanup.push(() => this.stop());
    this.fill();
  }

  fill() {
    if (!this.g.alive) return;
    const now = this.ctx.currentTime;
    const dur = this.buffer.duration;
    const x = this.fade;
    // Behind schedule (timers were frozen): carry on with a fresh fade-in.
    if (this.next < now + 0.05) this.next = now + 0.05;
    while (this.next < now + BED_AHEAD) {
      const offset = this.first ? rand(0, dur - 3 * x) : 0;
      this.first = false;
      this.pass(this.next, offset, dur - offset);
      this.next += dur - offset - x;
    }
    this.g.after(10, () => this.fill());
  }

  pass(at, offset, len) {
    const x = this.fade;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    const env = this.ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueCurveAtTime(FADE_IN, at, x);
    env.gain.setValueCurveAtTime(FADE_OUT, at + len - x, x);
    s.connect(env);
    env.connect(this.dest);
    const p = { s, env };
    this.passes.add(p);
    s.onended = () => {
      this.passes.delete(p);
      try { s.disconnect(); env.disconnect(); } catch (e) { /* already disconnected */ }
    };
    s.start(at, offset, len);
  }

  stop() {
    for (const { s, env } of this.passes) {
      try { s.stop(); } catch (e) { /* already stopped */ }
      try { s.disconnect(); env.disconnect(); } catch (e) { /* already disconnected */ }
    }
    this.passes.clear();
  }
}

// Typical loudness of a recording: mean power of its 100 ms blocks, leaving out
// the quietest and loudest tenth so a pause or one loud moment doesn't skew it.
function loudness(buffer) {
  const block = Math.max(1, Math.floor(buffer.sampleRate * 0.1));
  const n = Math.max(1, Math.floor(buffer.length / block));
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const powers = new Float64Array(n);
  let peak = 0;
  for (let b = 0; b < n; b++) {
    let sum = 0;
    let count = 0;
    for (const d of chans) {
      const end = Math.min(d.length, (b + 1) * block);
      for (let i = b * block; i < end; i++) {
        const v = d[i];
        sum += v * v;
        if (v > peak) peak = v;
        else if (-v > peak) peak = -v;
        count++;
      }
    }
    powers[b] = count ? sum / count : 0;
  }
  powers.sort();
  const lo = Math.floor(n * 0.1);
  const hi = Math.max(lo + 1, Math.ceil(n * 0.9));
  let p = 0;
  for (let i = lo; i < hi; i++) p += powers[i];
  return { rms: Math.sqrt(p / (hi - lo)), peak };
}

// CONFIG.ambience[scene] is a URL or a list of layers { url, gain, far }.
function bedLayers(name) {
  const spec = CONFIG && CONFIG.ambience && CONFIG.ambience[name];
  const list = Array.isArray(spec) ? spec : spec ? [spec] : [];
  return list
    .map((l) => (typeof l === 'string' ? { url: l } : l))
    .filter((l) => l && typeof l.url === 'string' && l.url)
    .map((l) => ({ url: l.url, gain: clamp(num(l.gain, 1), 0, 4), far: clamp01(num(l.far, 0)) }));
}

// ---------------------------------------------------------------------------
// Building blocks for struck and clicked things
// ---------------------------------------------------------------------------

// A struck bell, chime or glass: one sine per partial, re-excited by every strike.
// partials: [ratio, amplitude, seconds to fade by 60 dB]; strikes: [time, strength], sorted.
function struck(v, dest, f, partials, strikes, t0, end) {
  const nyquist = v.ctx.sampleRate * 0.45;
  for (const [r, a, decay] of partials) {
    const fr = f * r;
    if (fr > nyquist) continue;
    const o = v.osc('sine', fr, t0, end);
    const env = v.gain(0);
    o.connect(env);
    env.connect(dest);
    for (const [at, amp] of strikes) {
      env.gain.setTargetAtTime(a * amp, at, 0.0015);
      env.gain.setTargetAtTime(0, at + 0.008, decay / 6.9);
    }
  }
}

// Short filtered noise clicks (clapper, crackle, strike transient) at each strike.
function ticks(v, dest, strikes, { kind = 'white', type = 'highpass', freq = 3000, q, len = 0.01, level = 0.5 } = {}) {
  if (!strikes.length) return;
  const src = v.noise(kind, strikes[0][0] - 0.01, strikes[strikes.length - 1][0] + len * 6 + 0.05);
  const f = v.filter(type, freq, q);
  const env = v.gain(0);
  src.connect(f);
  f.connect(env);
  env.connect(dest);
  for (const [at, amp] of strikes) {
    env.gain.setValueAtTime(level * amp, at);
    env.gain.setTargetAtTime(0, at + 0.0005, len / 3);
  }
}

function ping(v, dest, t, f, partials, opts) {
  const input = v.out(dest, opts);
  let tail = 0;
  for (const p of partials) tail = Math.max(tail, p[2]);
  struck(v, input, f, partials, [[t, 1]], t, t + tail + 0.05);
}

// ---------------------------------------------------------------------------
// Journey layers
// ---------------------------------------------------------------------------

function buildSpace(g) {
  // A floor of deep filtered noise, breathing very slowly: weight without a pitch.
  const floorSrc = g.src('brown');
  const floorCut = g.filter('lowpass', 90, 0);
  const floor = g.gain(0.35);
  g.lfo(0.037, 0.12).connect(floor.gain);
  floorSrc.connect(floorCut);
  floorCut.connect(floor);
  floor.connect(g.dry);

  // Detuned partials (none below 120 Hz) through a slowly breathing lowpass.
  const lp = g.filter('lowpass', 520, 3);
  g.lfo(0.031, 160).connect(lp.frequency);
  g.lfo(0.013, 90, 'triangle').connect(lp.frequency);
  const breath = g.gain(0.75);
  g.lfo(0.071, 0.25).connect(breath.gain);
  lp.connect(breath);
  breath.connect(g.dry);
  const send = g.gain(0.45);
  breath.connect(send);
  send.connect(g.wet);
  for (const [type, f, detune, pan, level] of [
    ['triangle', 164.81, 4, -0.2, 0.08],
    ['sawtooth', 220, -6, -0.45, 0.03],
    ['sawtooth', 220, 5, 0.45, 0.03],
    ['sine', 329.63, 2, 0.15, 0.035],
    ['sine', 440, -3, -0.1, 0.012],
  ]) {
    const o = g.osc(type, f, detune);
    const a = g.gain(level);
    const p = g.panner(pan);
    o.connect(a);
    a.connect(p);
    p.connect(lp);
  }

  // Cosmic shimmer: thin bands of noise drifting in and out, mostly reverb.
  for (const [f, q, rate, pan] of [[3000, 7, 0.045, -0.35], [4700, 9, 0.061, 0.4]]) {
    const src = g.src('pink');
    const bp = g.filter('bandpass', f, q);
    const amp = g.gain(1);
    g.lfo(rate, 1).connect(amp.gain);
    const p = g.panner(pan);
    src.connect(bp);
    bp.connect(amp);
    amp.connect(p);
    const dry = g.gain(0.5);
    const wet = g.gain(2);
    p.connect(dry);
    dry.connect(g.dry);
    p.connect(wet);
    wet.connect(g.wet);
  }
}

function buildMotion(g) {
  const rushSrc = g.src('brown');
  const rushCut = g.filter('lowpass', 120, 1);
  const rush = g.gain(0);
  rushSrc.connect(rushCut);
  rushCut.connect(rush);
  rush.connect(g.dry);

  const whooshSrc = g.src('pink');
  const whooshBand = g.filter('bandpass', 250, 1.8);
  const whoosh = g.gain(0);
  whooshSrc.connect(whooshBand);
  whooshBand.connect(whoosh);
  whoosh.connect(g.dry);
  const send = g.gain(0.25);
  whoosh.connect(send);
  send.connect(g.wet);
  return { rush, rushCut, whoosh, whooshBand };
}

function buildReentry(g) {
  // Low roar of air being torn apart.
  const rumble = g.src('brown');
  const lp = g.filter('lowpass', 75, 0);
  const rumbleLevel = g.gain(1.3);
  rumble.connect(lp);
  lp.connect(rumbleLevel);
  rumbleLevel.connect(g.dry);

  const roar = g.src('brown');
  const bp = g.filter('bandpass', 220, 0.9);
  g.lfo(0.37, 60).connect(bp.frequency);
  const roarLevel = g.gain(0.9);
  roar.connect(bp);
  bp.connect(roarLevel);
  roarLevel.connect(g.dry);

  // Plasma crackle: its gain is spiked from update().
  const cr = g.src('white');
  const hp = g.filter('highpass', 1800, 0);
  const crackle = g.gain(0);
  const cracklePan = g.panner(0);
  cr.connect(hp);
  hp.connect(crackle);
  crackle.connect(cracklePan);
  cracklePan.connect(g.dry);
  const send = g.gain(0.3);
  cracklePan.connect(send);
  send.connect(g.wet);
  return { crackle, cracklePan };
}

function buildCloud(g) {
  const src = g.src('white');
  const bp = g.filter('bandpass', 900, 0.5);
  g.lfo(0.9, 250).connect(bp.frequency);
  const roar = g.gain(2.4);
  src.connect(bp);
  bp.connect(roar);
  roar.connect(g.dry);

  const body = g.src('brown');
  const lp = g.filter('lowpass', 450, 0);
  const bodyLevel = g.gain(0.45);
  body.connect(lp);
  lp.connect(bodyLevel);
  bodyLevel.connect(g.dry);
}

function buildAir(g) {
  const src = g.src('pink');
  const band = g.filter('bandpass', 500, 1.2);
  const amp = g.gain(1);
  src.connect(band);
  band.connect(amp);
  amp.connect(g.dry);
  const send = g.gain(0.2);
  amp.connect(send);
  send.connect(g.wet);

  // A thin whistle riding on top of the gusts.
  const ws = g.src('pink');
  const whistleBand = g.filter('bandpass', 1200, 8);
  const whistle = g.gain(0);
  ws.connect(whistleBand);
  whistleBand.connect(whistle);
  whistle.connect(g.dry);
  return { amp, band, whistle, whistleBand };
}

// ---------------------------------------------------------------------------
// Ground beds
// ---------------------------------------------------------------------------

// Wind: pink noise through a band that wanders with the gusts.
function windBed(g, { lo = 300, hi = 900, q = 0.8, level = 0.5, pan = 0, wet = 0.1, gust = [0.25, 1], pace = [0.8, 2.6] } = {}) {
  const src = g.src('pink');
  const bp = g.filter('bandpass', lo, q);
  const amp = g.gain(0.5);
  src.connect(bp);
  bp.connect(amp);
  amp.connect(g.out(g.dest, { pan, level, wet }));
  g.drift(bp.frequency, lo, hi, pace[0], pace[1], true);
  return g.drift(amp.gain, gust[0], gust[1], pace[0], pace[1]);
}

// Sand hissing across the ground in gusts, with a fine granular grit.
function sandHiss(g, { level = 0.45 } = {}) {
  const out = g.out(g.dest, { level, wet: 0.06 });
  const src = g.src('white');
  const hp = g.filter('highpass', 3500, 0);
  const amp = g.gain(0.1);
  src.connect(hp);
  hp.connect(amp);
  amp.connect(out);
  const gust = g.drift(amp.gain, 0.01, 0.45, 0.7, 2.4);

  const grit = g.src('white');
  const bp = g.filter('bandpass', 6500, 1);
  const flick = g.gain(0);
  grit.connect(bp);
  bp.connect(flick);
  flick.connect(out);
  g.every(0.05, 0.12, () => {
    flick.gain.setTargetAtTime(Math.random() ** 3 * gust.value * 1.4, g.ctx.currentTime, 0.012);
  });
}

// Far-off people: pink noise through five formant bands whose levels jitter at
// syllable rate (that is what turns noise into murmur). Only used when the
// recordings can't be loaded.
const FORMANTS = [[320, 4, 1], [560, 5, 0.9], [900, 6, 0.75], [1500, 7, 0.5], [2400, 8, 0.3]];

function crowdBed(g, { level = 1, dist = 0.5, pan = 0 } = {}) {
  const out = g.out(g.dest, { level, dist, pan });
  const src = g.src('pink');
  const bands = FORMANTS.map(([f, q, w]) => {
    const bp = g.filter('bandpass', f, q);
    const amp = g.gain(w * 0.5);
    src.connect(bp);
    bp.connect(amp);
    amp.connect(out);
    return { bp, amp, f, w };
  });
  g.every(0.08, 0.2, () => {
    const t = g.ctx.currentTime;
    for (const b of bands) {
      b.amp.gain.setTargetAtTime(b.w * (0.12 + Math.random() ** 1.5 * 0.88), t, rand(0.03, 0.09));
      b.bp.frequency.setTargetAtTime(b.f * rand(0.9, 1.12), t, 0.08);
    }
  });
  g.drift(out.gain, level * 0.55, level * 1.1, 2, 6);
}

// Wind moving through trees, with leaves flickering in the gusts.
function treesBed(g, { level = 0.6, leaves = 0.9 } = {}) {
  const out = g.out(g.dest, { level, wet: 0.12 });
  const src = g.src('pink');
  const hp = g.filter('highpass', 800, 0);
  const lp = g.filter('lowpass', 7000, 0);
  const amp = g.gain(0.5);
  src.connect(hp);
  hp.connect(lp);
  lp.connect(amp);
  amp.connect(out);
  const gust = g.drift(amp.gain, 0.12, 1, 1, 3.2);
  g.drift(hp.frequency, 500, 1400, 1.5, 4, true);

  const rustle = g.src('white');
  const bp = g.filter('bandpass', 3800, 0.8);
  const flick = g.gain(0);
  const leafLevel = g.gain(leaves);
  rustle.connect(bp);
  bp.connect(flick);
  flick.connect(leafLevel);
  leafLevel.connect(out);
  g.every(0.04, 0.11, () => {
    flick.gain.setTargetAtTime(Math.random() ** 2 * (0.15 + gust.value) * 1.2, g.ctx.currentTime, rand(0.015, 0.04));
  });
}

// Cicadas: high bands of noise chopped at 35–50 Hz into a dry buzz that swells and fades.
function cicadas(g, { level = 4 } = {}) {
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.pow(i / 255, 4);
  for (const [f, rate, pan] of [[4300, rand(35, 41), -0.45], [5500, rand(43, 50), 0.5]]) {
    const src = g.src('white');
    const bp = g.filter('bandpass', f, 3.5);
    const chop = g.gain(0);
    const shaper = g.keep(g.ctx.createWaveShaper());
    shaper.curve = curve;
    g.osc('sine', rate).connect(shaper);
    shaper.connect(chop.gain);
    const swell = g.gain(0.5);
    src.connect(bp);
    bp.connect(chop);
    chop.connect(swell);
    swell.connect(g.out(g.dest, { pan, level, dist: 0.2, wet: 0.2 }));
    g.drift(swell.gain, 0.08, 1, 2.5, 7);
  }
}

// ---------------------------------------------------------------------------
// Ground events
// ---------------------------------------------------------------------------

// A thump made of deep noise: body without a pitch (a falling sine down
// there sounds like an engine dying).
function thud(v, dest, t, { cut = 160, attack = 0.006, decay = 0.2, level = 1 } = {}) {
  const src = v.noise('brown', t, t + attack + decay * 7);
  const lp = v.filter('lowpass', cut, 0);
  const env = v.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(level, t + attack);
  env.gain.setTargetAtTime(0, t + attack, decay);
  src.connect(lp);
  lp.connect(env);
  env.connect(dest);
}

// Little bells on camel or horse tack, shaken with each step.
const JINGLE = [[1, 1, 0.35], [1.47, 0.5, 0.25], [2.09, 0.35, 0.18], [2.91, 0.2, 0.1]];

function jingle(g, t) {
  const v = g.voice();
  const input = v.out(g.dest, { pan: rand(-0.8, 0.8), dist: rand(0.5, 0.7), level: 0.035 * g.lv });
  const steps = 4 + Math.floor(Math.random() * 6);
  const pace = rand(0.5, 0.75);
  const strikes = [];
  for (let i = 0; i < steps; i++) {
    let at = t + i * pace + rand(0, 0.06);
    const k = chance(0.3) ? 1 : 2 + Math.floor(Math.random() * 3);
    for (let j = 0; j < k; j++) {
      strikes.push([at, rand(0.3, 1)]);
      at += rand(0.03, 0.07);
    }
  }
  const end = strikes[strikes.length - 1][0] + 0.6;
  for (const f of [rand(2600, 3300), rand(3500, 4400)]) {
    struck(v, input, f, JINGLE, strikes.filter(() => chance(0.7)), t, end);
  }
  ticks(v, input, strikes, { type: 'highpass', freq: 5000, len: 0.006, level: 0.25 });
}

// Sparrow: a few quick chirps with up-down contours.
function sparrow(g, t, { dist = 0.3, level = 0.045 } = {}) {
  const v = g.voice();
  const n = 2 + Math.floor(Math.random() * 5);
  const base = rand(3200, 4600);
  const notes = [];
  let at = t;
  for (let i = 0; i < n; i++) {
    const len = rand(0.05, 0.11);
    notes.push([at, len]);
    at += len + rand(0.06, 0.28);
  }
  const input = v.out(g.dest, { pan: rand(-0.9, 0.9), dist, level: level * g.lv });
  const o = v.osc(g.sc.birdWave, base, t, at);
  const env = v.gain(0);
  o.connect(env);
  env.connect(input);
  for (const [s, len] of notes) {
    const f0 = base * rand(0.85, 1.15);
    o.frequency.setValueAtTime(f0, s);
    o.frequency.exponentialRampToValueAtTime(f0 * rand(1.15, 1.45), s + len * 0.35);
    o.frequency.exponentialRampToValueAtTime(f0 * rand(0.7, 0.9), s + len);
    env.gain.setValueAtTime(0, s);
    env.gain.linearRampToValueAtTime(rand(0.5, 1), s + 0.01);
    env.gain.linearRampToValueAtTime(0, s + len);
  }
}

// Swallows: a burst of buzzy twitter that flies across the stereo field.
function swallows(g, t, { dist = 0.35, level = 0.035 } = {}) {
  const v = g.voice();
  const n = 6 + Math.floor(Math.random() * 10);
  const notes = [];
  let at = t;
  for (let i = 0; i < n; i++) {
    const len = rand(0.03, 0.08);
    notes.push([at, len, rand(3500, 6500)]);
    at += len + rand(0.02, 0.12);
  }
  const input = v.out(g.dest, { dist, level: level * g.lv });
  const p0 = rand(-0.9, 0.9);
  v.lastPan.pan.setValueAtTime(p0, t);
  v.lastPan.pan.linearRampToValueAtTime(clamp(-p0 + rand(-0.2, 0.2), -1, 1), at);
  const o = v.osc(g.sc.birdWave, 4500, t, at + 0.05);
  const fm = v.osc('sine', rand(35, 70), t, at + 0.05);
  const depth = v.gain(rand(150, 400));
  fm.connect(depth);
  depth.connect(o.frequency);
  const env = v.gain(0);
  o.connect(env);
  env.connect(input);
  for (const [s, len, f] of notes) {
    o.frequency.setValueAtTime(f, s);
    o.frequency.linearRampToValueAtTime(f * rand(0.85, 1.2), s + len);
    env.gain.setValueAtTime(0, s);
    env.gain.linearRampToValueAtTime(rand(0.4, 1), s + 0.006);
    env.gain.linearRampToValueAtTime(0, s + len);
  }
}

// Church bell: inharmonic partials (hum, prime, minor-third tierce, quint,
// nominal…) with long decays, tolled 3–5 times from across the city.
const CHURCH = [
  [0.5, 0.45, 9], [1, 0.6, 6.5], [1.183, 0.4, 5], [1.506, 0.22, 4], [2, 0.5, 4.5],
  [2.514, 0.16, 2.8], [2.662, 0.14, 2.4], [3.011, 0.1, 2], [4.166, 0.07, 1.3],
];

function churchBell(g, t) {
  const v = g.voice();
  const input = v.out(g.dest, { pan: rand(-0.6, 0.6), dist: rand(0.6, 0.8), level: 0.05 * g.lv, wet: 0.9 });
  // Hum stays above 120 Hz.
  const f = pick([261.63, 293.66]) * rand(0.99, 1.01);
  const n = 3 + Math.floor(Math.random() * 3);
  const gap = rand(2.3, 2.9);
  const strikes = [];
  for (let i = 0; i < n; i++) strikes.push([t + i * gap + rand(0, 0.06), i === 0 ? 1 : rand(0.85, 1)]);
  const partials = CHURCH.map(([r, a, d]) => [r * rand(0.998, 1.002), a, d]);
  struck(v, input, f, partials, strikes, t, strikes[n - 1][0] + 9.5);
  ticks(v, input, strikes, { type: 'bandpass', freq: 2500, q: 1.2, len: 0.012, level: 0.6 });
}

// Swiss cowbells far across the slopes: short metallic clanks in irregular clusters.
const COWBELL = [[1, 1, 0.9], [1.52, 0.6, 0.6], [2.3, 0.45, 0.45], [2.84, 0.35, 0.35], [3.7, 0.22, 0.25], [4.9, 0.12, 0.15]];

function cowbells(g, t) {
  const cows = chance(0.35) ? 2 : 1;
  for (let c = 0; c < cows; c++) {
    const v = g.voice();
    const input = v.out(g.dest, { pan: rand(-0.9, 0.9), dist: rand(0.75, 0.95), level: 0.045 * g.lv });
    const f = rand(420, 760);
    const n = 2 + Math.floor(Math.random() * 6);
    const strikes = [];
    let at = t + c * rand(0.3, 2);
    for (let i = 0; i < n; i++) {
      strikes.push([at, rand(0.35, 1)]);
      at += rand(0.16, 0.7);
    }
    const partials = COWBELL.map(([r, a, d]) => [r * rand(0.99, 1.01), a, d]);
    struck(v, input, f, partials, strikes, t, at + 1.2);
    ticks(v, input, strikes, { type: 'bandpass', freq: 1400, q: 0.8, len: 0.01, level: 0.5 });
  }
}

// A distant ice crack: a sharp splintering snap and a dull boom off the rock.
function iceCrack(g, t) {
  const v = g.voice();
  const input = v.out(g.dest, { pan: rand(-0.9, 0.9), dist: rand(0.6, 0.9), level: 0.1 * g.lv, wet: 0.95 });
  const grains = [];
  let at = t;
  const n = 3 + Math.floor(Math.random() * 8);
  for (let i = 0; i < n; i++) {
    grains.push([at, i === 0 ? 1 : rand(0.15, 0.6)]);
    at += rand(0.004, 0.05);
  }
  ticks(v, input, grains, { type: 'highpass', freq: 1200, len: 0.006, level: 1 });
  thud(v, input, t, { cut: 170, decay: 0.22, level: 1.6 });
}

// Bonshō: a temple bell with beating pairs of partials, struck by a log.
const BONSHO = [
  [1, 0.8, 12], [1.007, 0.55, 11], [1.98, 0.45, 9], [2.013, 0.4, 8.5],
  [2.71, 0.28, 6.5], [3.32, 0.2, 5], [4.15, 0.14, 3.6], [5.05, 0.09, 2.6], [6.4, 0.05, 1.6],
];

function templeBell(g, t) {
  const v = g.voice();
  const input = v.out(g.dest, { pan: rand(-0.5, 0.5), dist: rand(0.5, 0.7), level: 0.06 * g.lv, wet: 0.9 });
  struck(v, input, rand(128, 138), BONSHO, [[t, 1]], t, t + 13);
  // Soft wooden thud of the shumoku.
  thud(v, input, t, { cut: 260, decay: 0.07, level: 1.2 });
  ticks(v, input, [[t, 1]], { kind: 'pink', type: 'lowpass', freq: 380, len: 0.05, level: 1 });
}

// Fūrin: a glass wind chime, one to three strikes.
function furin(g, t) {
  const v = g.voice();
  const input = v.out(g.dest, { pan: rand(-0.7, 0.7), dist: rand(0.25, 0.45), level: 0.025 * g.lv });
  const n = 1 + Math.floor(Math.random() * 3);
  const strikes = [];
  let at = t;
  for (let i = 0; i < n; i++) {
    strikes.push([at, i === 0 ? 1 : rand(0.35, 0.8)]);
    at += rand(0.12, 0.4);
  }
  struck(v, input, rand(2100, 2900), [[1, 1, 1.3], [1.004, 0.6, 1.1], [2.76, 0.35, 0.6], [5.4, 0.15, 0.25]], strikes, t, at + 1.5);
  ticks(v, input, strikes, { type: 'highpass', freq: 5000, len: 0.004, level: 0.4 });
}

// Uguisu, the Japanese bush warbler: a long "hoo…" then a quick "ho-ke-kyo".
function uguisu(g, t) {
  const v = g.voice();
  const k = rand(0.92, 1.08);
  const t1 = t + rand(0.9, 1.4);
  const t2 = t1 + rand(0.1, 0.18);
  const t3 = t2 + 0.1;
  const t4 = t3 + 0.08;
  const t5 = t4 + rand(0.25, 0.35);
  const input = v.out(g.dest, { pan: rand(-0.8, 0.8), dist: rand(0.35, 0.6), level: 0.05 * g.lv });
  const o = v.osc(g.sc.birdWave, 1100 * k, t, t5 + 0.05);
  const env = v.gain(0);
  o.connect(env);
  env.connect(input);
  const f = o.frequency;
  const a = env.gain;
  // hoo
  f.setValueAtTime(1100 * k, t);
  f.linearRampToValueAtTime(1200 * k, t1 - 0.1);
  f.linearRampToValueAtTime(1300 * k, t1);
  a.setValueAtTime(0, t);
  a.linearRampToValueAtTime(0.5, t + 0.2);
  a.linearRampToValueAtTime(0.85, t1 - 0.08);
  a.linearRampToValueAtTime(0, t1);
  // ho
  f.setValueAtTime(1750 * k, t2);
  f.linearRampToValueAtTime(1900 * k, t2 + 0.07);
  a.setValueAtTime(0, t2);
  a.linearRampToValueAtTime(0.9, t2 + 0.015);
  a.linearRampToValueAtTime(0, t2 + 0.08);
  // ke
  f.setValueAtTime(2500 * k, t3);
  f.exponentialRampToValueAtTime(3300 * k, t3 + 0.05);
  a.setValueAtTime(0, t3);
  a.linearRampToValueAtTime(0.85, t3 + 0.01);
  a.linearRampToValueAtTime(0, t3 + 0.06);
  // kyo
  f.setValueAtTime(3600 * k, t4);
  f.exponentialRampToValueAtTime(2200 * k, t5);
  a.setValueAtTime(0, t4);
  a.linearRampToValueAtTime(1, t4 + 0.02);
  a.linearRampToValueAtTime(0.55, t4 + (t5 - t4) * 0.6);
  a.linearRampToValueAtTime(0, t5);
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

// rec: the field recordings carry the bed, so only a few synthesized events
// play on top, sparser (k) and quieter (g.lv). Without them the beds below
// stand in.

function buildDesert(g, rec) {
  if (!rec) {
    windBed(g, { lo: 260, hi: 850, q: 0.8, level: 0.8, wet: 0.08 });
    sandHiss(g, { level: 0.45 });
    crowdBed(g, { level: 0.5, dist: 0.75, pan: rand(-0.4, 0.4) });
  }
  const k = rec ? 2 : 1;
  g.every(14 * k, 32 * k, (t) => jingle(g, t), { first: rand(6, 14) });
}

function buildRome(g, rec) {
  if (!rec) {
    crowdBed(g, { level: 1, dist: 0.35 });
    windBed(g, { lo: 300, hi: 800, q: 0.9, level: 0.25 });
  }
  const k = rec ? 2 : 1;
  g.every(5 * k, 12 * k, (t) => sparrow(g, t), { first: rand(2, 6) });
  g.every(40 * k, 70 * k, (t) => churchBell(g, t), { first: rand(12, 30), level: 0.6 });
}

function buildAcropolis(g, rec) {
  if (!rec) {
    cicadas(g, { level: 3 });
    crowdBed(g, { level: 0.9, dist: 0.4 });
    windBed(g, { lo: 350, hi: 1000, q: 0.9, level: 0.45 });
  }
  const k = rec ? 2.2 : 1;
  g.every(5 * k, 13 * k, (t) => (chance(0.55) ? swallows(g, t) : sparrow(g, t, { dist: 0.45 })), { first: rand(3, 7) });
}

function buildAlpine(g, rec) {
  if (!rec) {
    // Howling: narrow resonant bands of wind wandering 400–1000 Hz.
    for (const pan of [-0.5, 0.5]) {
      const src = g.src('pink');
      const bp = g.filter('bandpass', 600, rand(8, 12));
      const amp = g.gain(0.5);
      src.connect(bp);
      bp.connect(amp);
      amp.connect(g.out(g.dest, { pan, level: 5, wet: 0.35 }));
      g.drift(bp.frequency, 400, 1000, 1.2, 3.5, true);
      g.drift(amp.gain, 0.1, 1, 1, 3);
    }
    // Low wind rumble.
    const low = g.src('brown');
    const lp = g.filter('lowpass', 160, 0);
    const lowAmp = g.gain(0.5);
    low.connect(lp);
    lp.connect(lowAmp);
    lowAmp.connect(g.out(g.dest, { level: 0.45, wet: 0.05 }));
    g.drift(lowAmp.gain, 0.3, 1, 1.5, 4);
    // Icy hiss.
    const ice = g.src('white');
    const hp = g.filter('highpass', 6500, 0);
    const iceAmp = g.gain(0.4);
    ice.connect(hp);
    hp.connect(iceAmp);
    iceAmp.connect(g.out(g.dest, { level: 0.15, wet: 0.2 }));
    g.drift(iceAmp.gain, 0.1, 0.8, 0.8, 2.5);
  }
  const k = rec ? 2 : 1;
  g.every(12 * k, 30 * k, (t) => cowbells(g, t), { first: rand(4, 10) });
  g.every(25 * k, 55 * k, (t) => iceCrack(g, t), { first: rand(10, 24) });
}

function buildFuji(g, rec) {
  if (!rec) {
    treesBed(g, { level: 0.6, leaves: 0.9 });
    g.every(14, 34, (t) => uguisu(g, t), { first: rand(5, 12) });
  }
  const k = rec ? 2 : 1;
  g.every(45 * k, 80 * k, (t) => templeBell(g, t), { first: rand(10, 22), level: 0.6 });
  g.every(7 * k, 16 * k, (t) => furin(g, t), { first: rand(3, 7) });
}

const SCENES = new Map([
  ['desert', buildDesert],
  ['rome', buildRome],
  ['acropolis', buildAcropolis],
  ['alpine', buildAlpine],
  ['fuji', buildFuji],
]);

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

const GLASS = [[1, 1, 1.4], [2.756, 0.3, 0.55], [5.404, 0.1, 0.22]];

const CUES = {
  // Slow swell of deep air that builds tension, an airy riser on top.
  hover(sc, t) {
    const v = new Voice(sc);
    const input = v.out(sc.cueDest, { level: 1, wet: 0.35 });
    const peak = t + 1.5;
    const end = t + 3.2;
    const body = v.noise('brown', t, end);
    const lp = v.filter('lowpass', 140, 0);
    lp.frequency.setValueAtTime(140, t);
    lp.frequency.exponentialRampToValueAtTime(900, peak);
    lp.frequency.setTargetAtTime(260, peak, 0.4);
    const amp = v.gain(0);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.7, peak);
    amp.gain.setTargetAtTime(0, peak + 0.05, 0.35);
    body.connect(lp);
    lp.connect(amp);
    amp.connect(input);

    const n = v.noise('pink', t, end);
    const hp = v.filter('highpass', 400, 0);
    hp.frequency.setValueAtTime(400, t);
    hp.frequency.exponentialRampToValueAtTime(3500, peak);
    const na = v.gain(0);
    na.gain.setValueAtTime(0.0001, t);
    na.gain.exponentialRampToValueAtTime(0.6, peak);
    na.gain.setTargetAtTime(0, peak + 0.02, 0.25);
    n.connect(hp);
    hp.connect(na);
    na.connect(input);
  },

  // Big sudden whoosh with a deep thump.
  dive(sc, t) {
    const v = new Voice(sc);
    const input = v.out(sc.cueDest, { level: 1, wet: 0.3 });
    const end = t + 2.2;
    const n = v.noise('pink', t, end);
    const bp = v.filter('bandpass', 200, 2.2);
    bp.frequency.setValueAtTime(200, t);
    bp.frequency.exponentialRampToValueAtTime(2000, t + 1.2);
    const na = v.gain(0);
    na.gain.setValueAtTime(0, t);
    na.gain.linearRampToValueAtTime(3.2, t + 0.05);
    na.gain.setTargetAtTime(2, t + 0.05, 0.3);
    na.gain.setTargetAtTime(0, t + 1.2, 0.25);
    n.connect(bp);
    bp.connect(na);
    na.connect(input);

    // Air tearing past.
    const w = v.noise('white', t, end);
    const hp = v.filter('highpass', 1500, 0);
    hp.frequency.setValueAtTime(1500, t);
    hp.frequency.exponentialRampToValueAtTime(5000, t + 1.2);
    const wa = v.gain(0);
    wa.gain.setValueAtTime(0, t);
    wa.gain.linearRampToValueAtTime(0.3, t + 0.03);
    wa.gain.setTargetAtTime(0, t + 0.08, 0.4);
    w.connect(hp);
    hp.connect(wa);
    wa.connect(input);

    const thump = v.out(sc.cueDest, { level: 1, wet: 0.05 });
    thud(v, thump, t, { cut: 150, decay: 0.22, level: 2.2 });
    ticks(v, thump, [[t, 1]], { type: 'lowpass', freq: 1500, len: 0.012, level: 0.5 });
  },

  // Short, wide "fwoomp" as we punch through a cloud.
  cloudPunch(sc, t) {
    const v = new Voice(sc);
    const end = t + 1.3;
    for (const [pan, delay] of [[-0.85, 0], [0.85, rand(0.015, 0.03)]]) {
      const input = v.out(sc.cueDest, { pan, level: 1, wet: 0.25 });
      const st = t + delay;
      const n = v.noise('pink', st, end);
      const lp = v.filter('lowpass', 250, 2);
      lp.frequency.setValueAtTime(250, st);
      lp.frequency.exponentialRampToValueAtTime(2600, st + 0.12);
      lp.frequency.exponentialRampToValueAtTime(280, st + 0.75);
      const a = v.gain(0);
      a.gain.setValueAtTime(0, st);
      a.gain.linearRampToValueAtTime(1, st + 0.06);
      a.gain.setTargetAtTime(0, st + 0.14, 0.17);
      n.connect(lp);
      lp.connect(a);
      a.connect(input);
    }
    const thump = v.out(sc.cueDest, { level: 1, wet: 0.1 });
    thud(v, thump, t, { cut: 180, attack: 0.02, decay: 0.12, level: 1.4 });
  },

  // Arrival: the air settles. A soft swell of breath-like noise that lets go
  // into the reverb, a short release of hiss and a faint high shimmer.
  // Nothing tonal, nothing falling.
  land(sc, t) {
    const v = new Voice(sc);
    const end = t + 4.8;
    for (const [pan, delay] of [[-0.55, 0], [0.55, rand(0.02, 0.05)]]) {
      const input = v.out(sc.cueDest, { pan, level: 1, wet: 0.45 });
      const st = t + delay;
      const n = v.noise('pink', st, end);
      const bp = v.filter('bandpass', 750, 0.6);
      const lp = v.filter('lowpass', 2600, 0);
      const a = v.gain(0);
      a.gain.setValueAtTime(0, st);
      a.gain.linearRampToValueAtTime(0.9, st + 0.4);
      a.gain.setTargetAtTime(0, st + 0.45, 0.8);
      n.connect(bp);
      bp.connect(lp);
      lp.connect(a);
      a.connect(input);
    }

    const rel = v.out(sc.cueDest, { level: 1, wet: 0.3 });
    const w = v.noise('white', t, end);
    const hp = v.filter('highpass', 3500, 0);
    const wa = v.gain(0);
    wa.gain.setValueAtTime(0, t + 0.15);
    wa.gain.linearRampToValueAtTime(0.12, t + 0.5);
    wa.gain.setTargetAtTime(0, t + 0.55, 0.5);
    w.connect(hp);
    hp.connect(wa);
    wa.connect(rel);

    // Shimmer: thin high bands of noise that flicker, mostly reverb.
    for (const [f, pan] of [[7200, -0.4], [9600, 0.4]]) {
      const shim = v.out(sc.cueDest, { pan, level: 1, wet: 1.4 });
      const src = v.noise('white', t, end);
      const band = v.filter('bandpass', f, 4);
      const flick = v.gain(0.5);
      for (let at = t + 0.2; at < t + 3.6; at += rand(0.025, 0.07)) {
        flick.gain.setTargetAtTime(0.25 + 0.75 * Math.random() ** 2, at, 0.012);
      }
      const env = v.gain(0);
      env.gain.setValueAtTime(0, t + 0.2);
      env.gain.linearRampToValueAtTime(0.18, t + 0.9);
      env.gain.setTargetAtTime(0, t + 1.2, 0.9);
      src.connect(band);
      band.connect(flick);
      flick.connect(env);
      env.connect(shim);
    }
  },

  // Rising lift-off whoosh with a sparkle trail.
  ascend(sc, t) {
    const v = new Voice(sc);
    const input = v.out(sc.cueDest, { level: 1, wet: 0.35 });
    const end = t + 3.6;
    const n = v.noise('pink', t, end);
    const bp = v.filter('bandpass', 250, 1.5);
    bp.frequency.setValueAtTime(250, t);
    bp.frequency.exponentialRampToValueAtTime(3500, t + 2.4);
    const a = v.gain(0);
    a.gain.setValueAtTime(0.0001, t);
    a.gain.exponentialRampToValueAtTime(2.6, t + 1.5);
    a.gain.setTargetAtTime(0, t + 1.7, 0.45);
    n.connect(bp);
    bp.connect(a);
    a.connect(input);

    // Deep air lifting away: noise whose band opens with the climb.
    const s = v.noise('brown', t, end);
    const slp = v.filter('lowpass', 90, 0);
    slp.frequency.setValueAtTime(90, t);
    slp.frequency.exponentialRampToValueAtTime(400, t + 2.2);
    const sa = v.gain(0);
    sa.gain.setValueAtTime(0, t);
    sa.gain.linearRampToValueAtTime(0.9, t + 0.8);
    sa.gain.setTargetAtTime(0, t + 1.6, 0.4);
    s.connect(slp);
    slp.connect(sa);
    sa.connect(input);

    const notes = [1046.5, 1174.66, 1318.51, 1567.98, 1760.0];
    notes.forEach((f, i) => {
      ping(v, sc.cueDest, t + 0.4 + i * 0.28 + rand(0, 0.05), f, GLASS, { pan: -0.6 + i * 0.3, level: 0.025, wet: 0.7 });
    });
  },
};

// ---------------------------------------------------------------------------
// Writing the message
// ---------------------------------------------------------------------------

const PINGS = {
  golden: [[1, 1, 1.9], [1.003, 0.45, 1.7], [2, 0.3, 1.1], [3, 0.1, 0.6], [4.02, 0.05, 0.35]],
  glass: GLASS,
  ice: [[1, 1, 0.55], [2.41, 0.45, 0.3], [3.93, 0.22, 0.18], [6.1, 0.09, 0.09]],
};

// Per place: timbre, pentatonic scale, mean gap between notes, levels.
const WRITE = {
  desert: { timbre: 'golden', scale: [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46, 783.99], gap: 0.42, level: 0.05, glow: 0.02, glowRoot: 146.83 },
  rome: { timbre: 'glass', scale: [1046.5, 1174.66, 1318.51, 1567.98, 1760.0, 2093.0], gap: 0.38, level: 0.04, glow: 0.016, glowRoot: 261.63 },
  acropolis: { timbre: 'glass', scale: [880.0, 987.77, 1108.73, 1318.51, 1479.98, 1760.0, 1975.53], gap: 0.38, level: 0.04, glow: 0.016, glowRoot: 220.0 },
  alpine: { timbre: 'ice', scale: [2093.0, 2349.32, 2637.02, 3135.96, 3520.0, 4186.01], gap: 0.3, level: 0.032, glow: 0.012, glowRoot: 349.23 },
  // Miyako-bushi (in) scale for the koto.
  fuji: { timbre: 'brush', scale: [293.66, 311.13, 392.0, 440.0, 466.16, 587.33, 622.25, 783.99], gap: 0.55, level: 0.6, glow: 0.01, glowRoot: 146.83 },
};

function writeNote(g, t, pan, spec, f, first, dirSign) {
  const v = g.voice();
  const level = spec.level * (first ? 1.25 : rand(0.55, 1));
  if (spec.timbre === 'brush') {
    swish(v, g.dest, t, pan, dirSign, level);
    if (first || chance(0.3)) koto(g, t + rand(0, 0.12), pan, f * (chance(0.3) ? 0.5 : 1));
    return;
  }
  ping(v, g.dest, t, f, PINGS[spec.timbre], { pan, level, wet: 0.55 });
  if (spec.timbre === 'ice') {
    const grains = [];
    let at = t + rand(0, 0.03);
    const n = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      grains.push([at, rand(0.2, 1)]);
      at += rand(0.01, 0.06);
    }
    const dest = v.out(g.dest, { pan: pan + rand(-0.1, 0.1), level: level * 1.5, wet: 0.3 });
    ticks(v, dest, grains, { type: 'highpass', freq: 6500, len: 0.004, level: 1 });
  }
}

// A soft brush stroke: band of noise sweeping up, drifting the way the writing goes.
function swish(v, dest, t, pan, dirSign, level) {
  const len = rand(0.25, 0.6);
  const input = v.out(dest, { pan, level, wet: 0.3 });
  v.lastPan.pan.setValueAtTime(clamp(pan, -1, 1), t);
  v.lastPan.pan.linearRampToValueAtTime(clamp(pan + dirSign * 0.18, -1, 1), t + len);
  const src = v.noise('pink', t, t + len + 0.3);
  const bp = v.filter('bandpass', 1200, 1.3);
  bp.frequency.setValueAtTime(rand(800, 1300), t);
  bp.frequency.exponentialRampToValueAtTime(rand(2200, 3400), t + len);
  const env = v.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(1, t + len * 0.3);
  env.gain.setTargetAtTime(0, t + len * 0.45, len * 0.2);
  src.connect(bp);
  bp.connect(env);
  env.connect(input);
}

// Koto pluck: a Karplus-Strong string rendered into a buffer, sometimes bent.
function koto(g, t, pan, f) {
  const v = g.voice();
  const buf = g.sc._pluck(f);
  const input = v.out(g.dest, { pan, level: 0.14, wet: 0.4 });
  const s = v.sample(buf, t, t + buf.duration);
  if (chance(0.35)) {
    // Oshide: pressing the string behind the bridge raises the pitch.
    s.playbackRate.setValueAtTime(1, t + 0.12);
    s.playbackRate.linearRampToValueAtTime(rand(1.03, 1.06), t + 0.4);
  }
  const lp = v.filter('lowpass', 4200, 0);
  s.connect(lp);
  lp.connect(input);
}

// A quiet tremolo glow under the whole inscription.
function glow(g, t, dur, spec) {
  const v = g.voice();
  const end = t + dur + 4.5;
  const input = v.out(g.dest, { level: spec.glow, wet: 0.7 });
  const env = v.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(1, t + Math.min(1.5, dur * 0.4));
  env.gain.setValueAtTime(1, t + dur);
  env.gain.setTargetAtTime(0, t + dur, 0.8);
  const trem = v.gain(0.85);
  const lfo = v.osc('sine', 0.3, t, end);
  const depth = v.gain(0.15);
  lfo.connect(depth);
  depth.connect(trem.gain);
  env.connect(trem);
  trem.connect(input);
  for (const [r, a] of [[1, 1], [1.5, 0.55], [2, 0.35]]) {
    for (const detune of [-6, 6]) {
      const o = v.osc('sine', spec.glowRoot * r, t, end, detune);
      const og = v.gain(a * 0.5);
      o.connect(og);
      og.connect(env);
    }
  }
}

// ---------------------------------------------------------------------------
// The soundscape
// ---------------------------------------------------------------------------

export class SoundScape {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.place = null;
    this.scene = null;
    this.sceneName = null;
    this.writer = null;
    this.groundLevel = 0;
    this._muted = false;
    this._booting = null;
    this._lastCue = {};
    this._crackling = false;
    this._warned = false;
    this._plucks = new Map();
    this._raw = new Map();     // url → Promise<ArrayBuffer>, until decoded
    this._files = new Map();   // url → Promise<{ buffer, norm }>
  }

  // Call from a click handler. Safe to call again (it only resumes).
  async start() {
    if (!this._booting) this._booting = this._boot();
    else if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this._booting;
  }

  get muted() { return this._muted; }

  setMuted(muted) {
    this._muted = !!muted;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    hold(g, t);
    g.setTargetAtTime(this._muted ? 0 : MASTER, t, 0.12);
  }

  setPlace(place) {
    const next = place || null;
    if (next !== this.place) this._cancelWrite();
    this.place = next;
    // Called at departure: the recordings stream in during the flight.
    if (next && SCENES.has(next.sound)) this._prefetch(next.sound);
    if (!this.ready) return;
    try { this._applyPlace(next); } catch (e) { console.warn('[audio] could not set the place', e); }
  }

  update(dt, state) {
    if (!this.ready || this.ctx.state !== 'running') return;
    try {
      this._update(dt, state || {});
    } catch (e) {
      if (!this._warned) { this._warned = true; console.warn('[audio] update failed', e); }
    }
  }

  cue(name, place) {
    if (!this.ready || this._muted || this.ctx.state !== 'running') return;
    if (!Object.prototype.hasOwnProperty.call(CUES, name)) return;
    const now = this.ctx.currentTime;
    if (now - (this._lastCue[name] ?? -1) < 0.25) return;
    this._lastCue[name] = now;
    try { CUES[name](this, now + 0.02, place || this.place); } catch (e) { console.warn(`[audio] cue '${name}' failed`, e); }
  }

  write(place, duration, lines) {
    if (!this.ready || this.ctx.state !== 'running') return;
    try { this._write(place || this.place, duration, lines); } catch (e) { console.warn('[audio] write failed', e); }
  }

  // ---------- Internals ----------

  async _boot() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    let resumed;
    try {
      this.ctx = new AC();
      // resume() must be called inside the user gesture, before any await.
      resumed = Promise.resolve(this.ctx.resume && this.ctx.resume());
    } catch (e) {
      console.warn('[audio] Web Audio is unavailable', e);
      this.ctx = null;
      return;
    }
    try {
      this._build();
    } catch (e) {
      console.warn('[audio] could not build the soundscape', e);
      try { this.ctx.close().catch(() => {}); } catch (err) { /* ignore */ }
      this.ctx = null;
      return;
    }
    this.ready = true;
    if (this.place) this.setPlace(this.place);
    try {
      await Promise.race([resumed, new Promise((r) => setTimeout(r, 1500))]);
    } catch (e) { /* stays suspended until the next gesture */ }
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(this._muted ? 0 : MASTER, t + 2.5);
  }

  _build() {
    const ctx = this.ctx;
    this.noise = { white: makeNoise(ctx, 'white'), pink: makeNoise(ctx, 'pink'), brown: makeNoise(ctx, 'brown') };
    // A sine with a little 2nd and 3rd harmonic: birds sound less like test tones.
    this.birdWave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.14, 0.05]));

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    // After the limiter, so everything (cues, beds, recordings) comes down together.
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    limiter.connect(this.master);
    this.master.connect(ctx.destination);

    this.drive = ctx.createGain();
    this.drive.gain.value = DRIVE;
    this.drive.connect(limiter);

    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 18000;
    this.muffle.Q.value = 0;
    this.muffle.connect(this.drive);

    this.mix = ctx.createGain();
    this.mix.connect(this.muffle);

    this.cueBus = ctx.createGain();
    this.cueBus.connect(this.drive);

    // Shared reverb (lows filtered out of the send so it never gets muddy).
    this.reverbIn = ctx.createGain();
    const verbHp = ctx.createBiquadFilter();
    verbHp.type = 'highpass';
    verbHp.frequency.value = 200;
    verbHp.Q.value = 0;
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.6;
    this.reverbIn.connect(verbHp);
    verbHp.connect(verb);
    verb.connect(verbOut);
    verbOut.connect(this.mix);

    this.cueDest = { dry: this.cueBus, wet: this.reverbIn };

    // Ground bus: place scenes plug in here; its level follows altitude.
    this.groundDry = ctx.createGain();
    this.groundDry.gain.value = 0;
    this.groundDry.connect(this.mix);
    this.groundWet = ctx.createGain();
    this.groundWet.gain.value = 0;
    this.groundWet.connect(this.reverbIn);

    const space = new Group(this, this.mix, this.reverbIn, 1);
    buildSpace(space);
    const motion = new Group(this, this.mix, this.reverbIn, 1);
    this.motion = buildMotion(motion);
    const reentry = new Group(this, this.mix, this.reverbIn, 0);
    this.re = buildReentry(reentry);
    const cloud = new Group(this, this.mix, this.reverbIn, 0);
    buildCloud(cloud);
    const air = new Group(this, this.mix, this.reverbIn, 0);
    this.air = buildAir(air);
    this.layers = [space, motion, reentry, cloud, air];

    this.ctl = {
      space: new Ctl([space.dry.gain, space.wet.gain], 0.6),
      rush: new Ctl(this.motion.rush.gain, 0.06),
      rushCut: new Ctl(this.motion.rushCut.frequency, 0.06, 0.004, true),
      whoosh: new Ctl(this.motion.whoosh.gain, 0.06),
      whooshFreq: new Ctl(this.motion.whooshBand.frequency, 0.06, 0.004, true),
      reentry: new Ctl([reentry.dry.gain, reentry.wet.gain], 0.15),
      cloud: new Ctl([cloud.dry.gain, cloud.wet.gain], 0.05),
      muffle: new Ctl(this.muffle.frequency, 0.05, 0.004, true),
      air: new Ctl([air.dry.gain, air.wet.gain], 0.35),
      airAmp: new Ctl(this.air.amp.gain, 0.25, 0.002),
      airFreq: new Ctl(this.air.band.frequency, 0.3, 0.004, true),
      whistle: new Ctl(this.air.whistle.gain, 0.3, 0.002),
      whistleFreq: new Ctl(this.air.whistleBand.frequency, 0.3, 0.004, true),
      ground: new Ctl([this.groundDry.gain, this.groundWet.gain], 0.5),
    };
  }

  _update(dt, s) {
    const t = this.ctx.currentTime;
    const frame = clamp(num(dt, 0.016), 0.001, 0.05);
    const alt = Math.max(0, num(s.altitude, 2e7));
    const speed = clamp01(num(s.speed, 0));
    const cloud = clamp01(num(s.cloud, 0));
    const reentry = clamp01(num(s.reentry, 0));
    const landed = clamp01(num(s.landed, 0));
    const c = this.ctl;

    // Space: the calm drone above ~1500 km, gone by ~80 km.
    c.space.set(smooth(80e3, 1500e3, alt), t);

    // Motion: rush and whoosh open up with speed (a little softer far out).
    const m = Math.pow(speed, 1.4) * (1 - 0.4 * smooth(300e3, 4e6, alt));
    c.rush.set(m * 0.85, t);
    c.rushCut.set(120 * Math.pow(5000 / 120, speed), t);
    c.whoosh.set(m * 2.4, t);
    c.whooshFreq.set(250 * Math.pow(12, speed), t);

    // Re-entry: rumble and plasma crackle.
    const r = Math.min(1, reentry * Math.min(1, speed * 1.4));
    c.reentry.set(r * 0.8, t);
    this._crackle(r, t, frame);

    // Clouds: a roar, and everything else goes dull.
    c.cloud.set(cloud, t);
    c.muffle.set(18000 * Math.pow(1000 / 18000, cloud), t);

    // Air: rises below ~25 km, strongest a few km up, gentler near the ground.
    const air = (1 - smooth(4e3, 25e3, alt)) * (0.4 + 0.6 * smooth(150, 2500, alt)) * (0.7 + 0.5 * speed) * (1 - 0.6 * landed);
    const gust = clamp01(0.55 * vnoise(t * 0.21) + 0.3 * vnoise(t * 0.57 + 11) + 0.15 * vnoise(t * 1.9 + 37));
    const airFreq = 320 * Math.pow(3, gust) * (1 + 0.5 * speed);
    c.air.set(clamp01(air), t);
    c.airAmp.set((0.45 + 0.9 * gust) * 1.8, t);
    c.airFreq.set(airFreq, t);
    c.whistle.set(gust * gust * (0.25 + speed) * 1.2, t);
    c.whistleFreq.set(airFreq * 2.4, t);

    // Ground ambience: in below ~4 km, full by ~400 m and once landed.
    this.groundLevel = Math.max(1 - smooth(400, 4000, alt), landed);
    c.ground.set(this.groundLevel, t);
  }

  // Random spiky bursts on the plasma noise, a few per frame at most.
  _crackle(r, t, frame) {
    const { crackle, cracklePan } = this.re;
    if (r < 0.01) {
      if (this._crackling) {
        crackle.gain.setTargetAtTime(0, t, 0.05);
        this._crackling = false;
      }
      return;
    }
    this._crackling = true;
    if (chance(0.35 + 0.5 * r)) {
      const at = t + Math.random() * frame;
      crackle.gain.setValueAtTime(0.2 + 0.8 * Math.random() ** 2, at);
      crackle.gain.setTargetAtTime(0.04, at + 0.001, rand(0.003, 0.012));
    }
    cracklePan.pan.setTargetAtTime(rand(-0.7, 0.7), t, 0.01);
  }

  _applyPlace(place) {
    const name = place && SCENES.has(place.sound) ? place.sound : null;
    if (name === this.sceneName) return;
    if (this.scene) this.scene.stop(0.8);
    this.scene = null;
    this.sceneName = name;
    if (name) this.scene = this._buildScene(name);
  }

  _groundAudible(level) {
    return this.ctx.state === 'running' && !this._muted && this.groundLevel > level;
  }

  // Recordings first; the synthesized scene adds its events once they're in
  // (or its beds as well, if none of them could be loaded).
  _buildScene(name) {
    const g = new Group(this, this.groundDry, this.groundWet, 1, 1.5);
    g.gate = (level) => this._groundAudible(level);
    const build = (rec) => {
      g.lv = rec ? 0.55 : 1;
      try { SCENES.get(name)(g, rec); } catch (e) { console.warn(`[audio] scene '${name}' failed`, e); }
    };
    const layers = bedLayers(name);
    if (!layers.length) {
      build(false);
      return g;
    }
    Promise.all(layers.map((layer) => this._loadBuffer(layer.url).then(
      (file) => ({ ...layer, ...file }),
      (e) => { console.warn(`[audio] could not load ${layer.url}`, e); return null; },
    ))).then((loaded) => {
      if (!g.alive) return;
      const ok = loaded.filter(Boolean);
      if (!ok.length) console.warn(`[audio] no recordings for '${name}'; synthesizing it instead`);
      for (const layer of ok) {
        try { this._bed(g, layer); } catch (e) { console.warn(`[audio] could not play ${layer.url}`, e); }
      }
      build(ok.length > 0);
    });
    return g;
  }

  // One recorded layer, gently filtered (no rumble below 100 Hz, no fizz on
  // top). `far` makes it duller, quieter and wetter, like Rack.out's dist.
  _bed(g, { buffer, norm, gain, far }) {
    const input = g.gain(norm);
    const hp = g.filter('highpass', 100, 0);
    const lp = g.filter('lowpass', 11000, 0);
    input.connect(hp);
    hp.connect(lp);
    lp.connect(g.out(g.dest, { level: gain, dist: far, wet: 0.06 + far * 0.4 }));
    return new Bed(g, buffer, input);
  }

  _prefetch(name) {
    for (const { url } of bedLayers(name)) {
      if (!this._files.has(url)) this._fetch(url).catch(() => {});
    }
  }

  // Downloads can start before Web Audio exists; decoding waits for it.
  _fetch(url) {
    if (!this._raw.has(url)) {
      const abort = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => abort && abort.abort(), LOAD_TIMEOUT * 1000);
      const p = fetch(url, { mode: 'cors', credentials: 'omit', signal: abort ? abort.signal : undefined })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .finally(() => clearTimeout(timer));
      p.catch(() => this._raw.delete(url));
      this._raw.set(url, p);
    }
    return this._raw.get(url);
  }

  // Decoded once per URL and measured, so every recording can be brought to
  // the same loudness (norm) before its layer gain.
  _loadBuffer(url) {
    if (!this._files.has(url)) {
      const p = this._fetch(url)
        .then((data) => new Promise((resolve, reject) => {
          const ret = this.ctx.decodeAudioData(data, resolve, reject);
          if (ret && ret.catch) ret.catch(reject);
        }))
        .then((buffer) => {
          if (!buffer || buffer.duration < 3) throw new Error('too short to loop');
          const { rms, peak } = loudness(buffer);
          if (!(rms > 1e-5)) throw new Error('silent');
          const norm = Math.min(clamp(BED_RMS / rms, 0.05, 12), 1 / Math.max(peak, 0.01));
          return { buffer, norm };
        })
        .finally(() => this._raw.delete(url));
      p.catch(() => this._files.delete(url));
      this._files.set(url, p);
    }
    return this._files.get(url);
  }

  _cancelWrite() {
    if (!this.writer) return;
    this.writer.stop(0.25);
    this.writer = null;
  }

  // Pings follow the pen: the pan sweeps across once per line, in the
  // direction the script is written.
  _write(place, duration, lines) {
    this._cancelWrite();
    const ctx = this.ctx;
    const spec = (place && WRITE[place.sound]) || WRITE.rome;
    const dur = clamp(num(duration, 4), 0.5, 120);
    const fallback = place && Array.isArray(place.lines) ? place.lines.length : 1;
    const count = Array.isArray(lines) ? lines.length : num(lines, fallback);
    const nLines = Math.max(1, Math.round(count));
    const lineDur = dur / nLines;
    const from = place && place.dir === 'rtl' ? 0.75 : -0.75;
    const dirSign = from < 0 ? 1 : -1;

    const g = new Group(this, this.mix, this.reverbIn);
    this.writer = g;
    const t0 = ctx.currentTime + 0.03;
    glow(g, t0, dur, spec);

    let idx = Math.floor(spec.scale.length / 2);
    let lastLine = -1;
    const step = () => {
      const el = ctx.currentTime - t0;
      if (el >= dur) return;
      const line = clamp(Math.floor(el / lineDur), 0, nLines - 1);
      const x = clamp01((el - line * lineDur) / lineDur);
      const pan = clamp(from - 2 * from * x + rand(-0.08, 0.08), -1, 1);
      const first = line !== lastLine;
      lastLine = line;
      idx = first
        ? Math.floor(rand(0, 2))
        : clamp(idx + pick([-2, -1, -1, 1, 1, 2]), 0, spec.scale.length - 1);
      if (!this._muted) writeNote(g, ctx.currentTime + 0.02, pan, spec, spec.scale[idx], first, dirSign);
      let wait = spec.gap * rand(0.55, 1.45);
      const nextLine = (line + 1) * lineDur;
      if (line + 1 < nLines && el + wait > nextLine) wait = nextLine - el + 0.01;
      g.after(Math.max(0.02, wait), step);
    };
    g.after(0.03, step);
    g.after(dur + 7, () => {
      g.stop(0.5);
      if (this.writer === g) this.writer = null;
    });
  }

  // Karplus-Strong string, rendered once per pitch and cached.
  _pluck(freq) {
    const key = Math.round(freq * 10);
    const cached = this._plucks.get(key);
    if (cached) return cached;
    const sr = this.ctx.sampleRate;
    const period = Math.max(2, Math.round(sr / freq));
    const len = Math.floor(sr * 2.4);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const ring = new Float32Array(period);
    let s = 0;
    for (let i = 0; i < period; i++) {
      s = s * 0.2 + (Math.random() * 2 - 1) * 0.8;
      ring[i] = s;
    }
    const loss = Math.pow(0.001, 1 / (2.2 * freq));
    let idx = 0;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const a = ring[idx];
      const b = ring[(idx + 1) % period];
      d[i] = a;
      peak = Math.max(peak, Math.abs(a));
      ring[idx] = (a + b) * 0.5 * loss;
      idx = (idx + 1) % period;
    }
    const fade = Math.floor(sr * 0.05);
    for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade;
    const k = 0.8 / (peak || 1);
    for (let i = 0; i < len; i++) d[i] *= k;
    this._plucks.set(key, buf);
    return buf;
  }
}
