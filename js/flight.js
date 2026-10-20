// Camera choreography. The camera always orbits a target point described by
// lon/lat/height + heading/pitch/range, which makes the whole trip — turning the
// globe, the plunge, the landing and the slow sway afterwards — one continuous
// set of numbers we can ease.

const C = window.Cesium;
const D2R = Math.PI / 180;
const R_EARTH = 6378137;

export const SPACE_SUN_OFFSET = 62; // sun sits east of the view centre → a night crescent on the left

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const clamp01 = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeInQuad = (t) => t * t;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

// Heading during the plunge: the camera turns `spin` degrees, more than the
// `dh` it needs, and lets the extra go as it gets low (w → 1), so the last
// seconds already face the landed view and touchdown doesn't snap round.
const diveHeading = (h0, dh, spin, u, w) => h0 + (dh + (spin - dh) * (1 - w)) * easeInOutSine(u);

// Seconds before touchdown that the rig emits 'approach'.
const APPROACH_LEAD = 4;

// Dive progress: a hard (but not instant) kick, then a long deceleration.
// Built by integrating a speed curve so it is smooth everywhere.
const DIVE_CURVE = (() => {
  const n = 400;
  const v = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const kick = smooth(0, 0.07, t);
    v.push(kick * Math.pow(1 - t, 2.6) + 0.002);
  }
  const acc = [0];
  for (let i = 1; i <= n; i++) acc.push(acc[i - 1] + (v[i] + v[i - 1]) / 2);
  const total = acc[n];
  return (t) => {
    const x = clamp01(t) * n;
    const i = Math.min(n - 1, Math.floor(x));
    return lerp(acc[i], acc[i + 1], x - i) / total;
  };
})();

// Great-circle interpolation between two lon/lat pairs (degrees).
function slerpLonLat(a, b, t) {
  const toV = (p) => {
    const la = p.lat * D2R, lo = p.lon * D2R;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const va = toV(a), vb = toV(b);
  const dot = clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1);
  const om = Math.acos(dot);
  if (om < 1e-6) return { lon: b.lon, lat: b.lat };
  const s = Math.sin(om);
  const ka = Math.sin((1 - t) * om) / s, kb = Math.sin(t * om) / s;
  const v = [ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]];
  return { lon: Math.atan2(v[1], v[0]) / D2R, lat: Math.asin(clamp(v[2], -1, 1)) / D2R };
}
function angularDistance(a, b) {
  const la1 = a.lat * D2R, la2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
  return Math.acos(clamp(Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dl), -1, 1)) / D2R;
}

// Smooth pseudo-random noise for camera shake.
function noise1(t, seed) {
  return Math.sin(t * 13.1 + seed) * 0.5 + Math.sin(t * 27.7 + seed * 2.3) * 0.3 + Math.sin(t * 51.3 + seed * 4.1) * 0.2;
}

export class CameraRig {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.camera = viewer.camera;
    this.s = { lon: 22, lat: 24, h: 0, heading: 0, pitch: -90, range: 20e6 };
    this.mode = 'space';            // space | flying | landed
    this.place = null;
    this.time = 0;
    this.seq = 0;
    this.anim = null;
    this.shake = 0;
    this.freeze = false;
    this.pan = 0;
    this.sunOffset = SPACE_SUN_OFFSET;
    this.datumOffset = 0;
    this.datumOffsetTarget = 0;
    this.landedAt = 0;
    this.user = { heading: 0, pitch: 0, zoom: 1, zoomTarget: 1, vHeading: 0, vPitch: 0, vLon: 0, vLat: 0, dragging: false };
    this.idleSpin = 1.1;            // deg/s while floating in space
    this.handlers = {};
    this.baseFov = this.camera.frustum.fov;
    this._target = new C.Cartesian3();
    this._hpr = new C.HeadingPitchRange();
    this._landTarget = new C.Cartesian3();
    this._landHpr = new C.HeadingPitchRange();
    this.s.range = this.spaceRange();
  }

  on(name, fn) { (this.handlers[name] ||= []).push(fn); }
  emit(name, ...args) { (this.handlers[name] || []).forEach((fn) => fn(...args)); }

  // Distance at which the whole Earth fills ~80% of the shorter screen side.
  spaceRange(fill = 0.8) {
    const canvas = this.scene.canvas;
    // A canvas that hasn't been laid out yet (0×0) would give NaN.
    if (!canvas.clientWidth || !canvas.clientHeight) return this._lastSpaceRange || 2e7;
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const fov = this.baseFov;
    const fovy = aspect >= 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspect) : fov;
    const fovx = aspect >= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const half = Math.min(fovx, fovy) / 2;
    const dist = R_EARTH / Math.sin(half * fill);
    this._lastSpaceRange = dist - R_EARTH;
    return this._lastSpaceRange;
  }

  datumHeight(place = this.place) { return place ? place.datum.h + this.datumOffset : 0; }
  targetHeight(place = this.place) { return this.datumHeight(place) + place.target.h; }

  // ---------- animation plumbing ----------
  _run(duration, step) {
    return new Promise((resolve) => {
      const id = this.seq;
      let t = 0;
      this.anim = {
        step: (dt) => {
          if (id !== this.seq) { resolve(false); return true; }
          t += dt;
          const k = clamp01(t / duration);
          step(k, t);
          if (k >= 1) { resolve(true); return true; }
          return false;
        },
        cancel: () => resolve(false),
      };
    });
  }

  _cancel() {
    this.seq++;
    if (this.anim) { this.anim.cancel(); this.anim = null; }
  }

  // Fold the user's drag/zoom offsets into the pose so animations start from what is on screen.
  _bakeUser() {
    const u = this.user;
    if (this.mode === 'landed' || this.mode === 'flying') {
      this.s.heading += u.heading;
      this.s.pitch += u.pitch;
      this.s.range *= u.zoom;
    } else {
      this.s.range *= u.zoom;
    }
    u.heading = u.pitch = 0;
    u.zoom = u.zoomTarget = 1;
    u.vHeading = u.vPitch = u.vLon = u.vLat = 0;
  }

  // ---------- journeys ----------
  async goTo(place) {
    this._cancel();
    this._bakeUser();
    const id = this.seq;
    const prev = this.place;
    this.place = place;
    this.mode = 'flying';
    this.datumOffset = this.datumOffsetTarget = 0;
    this.emit('depart', place, prev);
    const R = this.spaceRange();

    if (this.s.range < R * 0.45) {
      if (!(await this._ascend(R * 0.8, place, 0.55)) || id !== this.seq) return false;
    }
    if (!(await this._align(place, R)) || id !== this.seq) return false;
    this.emit('hover', place);
    if (!(await this._hover(R)) || id !== this.seq) return false;
    this.emit('dive', place);
    if (!(await this._dive(place)) || id !== this.seq) return false;

    this.mode = 'landed';
    this.landedAt = this.time;
    this.emit('arrive', place);
    return true;
  }

  async returnToSpace() {
    this._cancel();
    this._bakeUser();
    const id = this.seq;
    this.mode = 'flying';
    this.emit('ascend', this.place);
    const R = this.spaceRange();
    const ok = await this._ascend(R, null, 0);
    if (!ok || id !== this.seq) return false;
    this.place = null;
    this.mode = 'space';
    this.emit('space');
    return true;
  }

  _ascend(rangeTo, toward, fraction) {
    const s0 = { ...this.s };
    const sun0 = this.sunOffset;
    const dh = wrap180(0 - s0.heading);
    const lnA = Math.log(s0.range), lnB = Math.log(rangeTo);
    return this._run(4.6, (k) => {
      const e = easeInOutCubic(k);
      this.s.range = Math.exp(lerp(lnA, lnB, e));
      const kp = smooth(0, 0.5, k);
      this.s.pitch = lerp(s0.pitch, -90, kp);
      this.s.heading = s0.heading + dh * kp;
      this.s.h = lerp(s0.h, 0, smooth(0, 0.6, k));
      this.sunOffset = lerp(sun0, SPACE_SUN_OFFSET, smooth(0.2, 0.9, k));
      if (toward) {
        const p = slerpLonLat(s0, toward.target, fraction * smooth(0.3, 1, k));
        this.s.lon = p.lon;
        this.s.lat = p.lat;
      }
    });
  }

  _align(place, R) {
    const s0 = { ...this.s };
    const dist = angularDistance(s0, place.target);
    const duration = 1.4 + 2.8 * Math.pow(dist / 180, 0.6);
    const lnA = Math.log(s0.range), lnB = Math.log(R * 0.84);
    const dh = wrap180(0 - s0.heading);
    return this._run(duration, (k) => {
      const e = easeInOutSine(k);
      const p = slerpLonLat(s0, place.target, e);
      this.s.lon = p.lon;
      this.s.lat = p.lat;
      this.s.range = Math.exp(lerp(lnA, lnB, e));
      this.s.heading = s0.heading + dh * e;
      this.s.pitch = lerp(s0.pitch, -90, e);
      this.s.h = 0;
    });
  }

  _hover(R) {
    const r0 = this.s.range;
    return this._run(1.5, (k) => {
      this.s.range = lerp(r0, R * 0.7, easeInQuad(k));
    });
  }

  // Pitch and heading as a function of how far along the plunge we are.
  _divePose(place, u, r, r0) {
    const rf = place.view.range;
    const lnTop = Math.log(Math.min(r0, 80e3));
    const q = smooth(0, 1, (lnTop - Math.log(r)) / (lnTop - Math.log(rf)));
    const pitch = -90 + (place.view.pitch + 90) * q;
    return { pitch, q };
  }

  _dive(place) {
    const s0 = { ...this.s };
    const sun0 = this.sunOffset;
    const rf = place.view.range;
    const lnA = Math.log(s0.range), lnB = Math.log(rf);
    const dh = wrap180(place.view.heading - s0.heading);
    const spin = dh + (dh >= 0 ? 50 : -50);
    this._diveInfo = { place, s0, lnA, lnB, spin };
    const duration = 9.0;
    let approaching = false;
    return this._run(duration, (k, t) => {
      const u = DIVE_CURVE(k);
      const r = Math.exp(lerp(lnA, lnB, u));
      this.s.range = r;
      this.s.lon = place.target.lon;
      this.s.lat = place.target.lat;
      const { pitch } = this._divePose(place, u, r, s0.range);
      this.s.pitch = pitch;
      const w = smooth(0, 1, (Math.log(40e3) - Math.log(r)) / (Math.log(40e3) - Math.log(rf)));
      this.s.heading = diveHeading(s0.heading, dh, spin, u, w);
      this.s.h = this.targetHeight(place) * w;
      this.sunOffset = lerp(sun0, place.sunOffset, smooth(Math.log(4000e3), Math.log(150e3), Math.log(r)));
      if (!approaching && t >= duration - APPROACH_LEAD) {
        approaching = true;
        this.emit('approach', place);
      }
    });
  }

  // World positions the camera will pass through at the given heights above the
  // destination's datum (used to put a cloud exactly in the way).
  predictDivePoints(place, heights) {
    const R = this.spaceRange();
    const r0 = R * 0.7;
    const lnA = Math.log(r0), lnB = Math.log(place.view.range);
    const s0h = 0;
    const dh = wrap180(place.view.heading - s0h);
    const spin = dh + (dh >= 0 ? 50 : -50);
    const datum = place.datum.h;
    const out = [];
    const target = C.Cartesian3.fromDegrees(place.target.lon, place.target.lat, datum + place.target.h);
    const enu = C.Transforms.eastNorthUpToFixedFrame(target);
    let prevAlt = null;
    let hi = 0;
    const want = [...heights].sort((a, b) => b - a);
    for (let i = 0; i <= 600 && hi < want.length; i++) {
      const u = i / 600;
      const r = Math.exp(lerp(lnA, lnB, u));
      if (r > 60e3) continue;
      const { pitch } = this._divePose(place, u, r, r0);
      const w = smooth(0, 1, (Math.log(40e3) - Math.log(r)) / (Math.log(40e3) - Math.log(place.view.range)));
      const heading = diveHeading(s0h, dh, spin, u, w);
      const th = place.target.h * w;
      const p = pitch * D2R, hd = heading * D2R;
      // Camera sits opposite the view direction.
      const horiz = r * Math.cos(p);
      const east = -Math.sin(hd) * horiz, north = -Math.cos(hd) * horiz;
      const up = -r * Math.sin(p) + th - place.target.h;
      const alt = up + place.target.h;
      if (prevAlt !== null && prevAlt >= want[hi] && alt < want[hi]) {
        out.push(C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(east, north, up), new C.Cartesian3()));
        hi++;
      }
      prevAlt = alt;
    }
    return out;
  }

  // Where the camera will be when it lands (for keeping clouds out of the shot).
  finalCameraPosition(place) {
    const target = C.Cartesian3.fromDegrees(place.target.lon, place.target.lat, place.datum.h + place.target.h);
    const enu = C.Transforms.eastNorthUpToFixedFrame(target);
    const p = place.view.pitch * D2R, hd = place.view.heading * D2R, r = place.view.range;
    const horiz = r * Math.cos(p);
    const local = new C.Cartesian3(-Math.sin(hd) * horiz, -Math.cos(hd) * horiz, -r * Math.sin(p));
    return C.Matrix4.multiplyByPoint(enu, local, new C.Cartesian3());
  }

  // Put another camera where this one will be just after touchdown, lens
  // included (for loading the landed view ahead of time).
  landedPose(camera, place) {
    const v = place.view;
    const target = C.Cartesian3.fromDegrees(place.target.lon, place.target.lat,
      place.datum.h + this.datumOffsetTarget + place.target.h, C.Ellipsoid.WGS84, this._landTarget);
    this._landHpr.heading = v.heading * D2R;
    this._landHpr.pitch = v.pitch * D2R;
    this._landHpr.range = v.range;
    camera.lookAt(target, this._landHpr);
    camera.lookAtTransform(C.Matrix4.IDENTITY);
    camera.frustum.fov = place.fov ? place.fov * D2R : this.baseFov;
  }

  // ---------- user input ----------
  drag(dx, dy) {
    // Inverted on purpose: swipe right turns the view the other way, swipe up looks down.
    dx = -dx;
    dy = -dy;
    const u = this.user;
    if (this.mode === 'space') {
      const k = 0.11 * (this.s.range / this.spaceRange()) * u.zoom;
      u.vLon = -dx * k * 60;
      u.vLat = dy * k * 60;
      this.s.lon -= dx * k;
      this.s.lat = clamp(this.s.lat + dy * k, -75, 75);
    } else if (this.mode === 'landed') {
      const dH = -dx * 0.12, dP = dy * 0.08;
      u.vHeading = dH * 60;
      u.vPitch = dP * 60;
      u.heading += dH;
      u.pitch = clamp(u.pitch + dP, -60 - this.place.view.pitch, 25 - this.place.view.pitch);
    }
  }

  zoomBy(f) {
    if (this.mode === 'flying') return;
    const u = this.user;
    const [lo, hi] = this.mode === 'space' ? [0.45, 1.5] : [0.4, 3.0];
    u.zoomTarget = clamp(u.zoomTarget * f, lo, hi);
  }

  resetView() {
    const u = this.user;
    u.zoomTarget = 1;
    this._resetting = true;
  }

  // ---------- per frame ----------
  update(dt) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const u = this.user;

    if (this.anim) {
      if (this.anim.step(dt)) this.anim = null;
    } else if (this.mode === 'space') {
      if (!u.dragging) {
        this.s.lon += (this.idleSpin + u.vLon) * dt;
        this.s.lat = clamp(this.s.lat + u.vLat * dt, -75, 75);
        u.vLon *= Math.exp(-dt * 2.2);
        u.vLat *= Math.exp(-dt * 2.2);
        // Drift back toward a pleasant latitude.
        this.s.lat += (22 - this.s.lat) * dt * 0.05;
      }
      this.s.range = this.spaceRange();
    } else if (this.mode === 'landed' && !this.freeze) {
      const p = this.place;
      const tl = this.time - this.landedAt;
      const amp = smooth(0, 8, tl);
      this.s.lon = p.target.lon;
      this.s.lat = p.target.lat;
      this.s.h = this.targetHeight(p);
      // Close subjects get a slow orbit (parallax). Far ones (a mountain km away)
      // would make the camera race sideways, so there it stands still and pans.
      const orbit = Math.min(1, 600 / p.view.range);
      const swing = Math.sin((tl * 2 * Math.PI) / 48);
      this.s.heading = p.view.heading + amp * 6.5 * swing * orbit;
      this.s.pitch = p.view.pitch + amp * 0.8 * Math.sin((tl * 2 * Math.PI) / 61) * orbit;
      this.s.range = p.view.range * (1 + amp * 0.03 * Math.sin((tl * 2 * Math.PI) / 53) * orbit);
      this.pan = amp * 1.6 * swing * (1 - orbit);
      if (!u.dragging) {
        u.heading += u.vHeading * dt;
        u.pitch = clamp(u.pitch + u.vPitch * dt, -60 - p.view.pitch, 25 - p.view.pitch);
        u.vHeading *= Math.exp(-dt * 3);
        u.vPitch *= Math.exp(-dt * 3);
        if (this._resetting) {
          const f = 1 - Math.exp(-dt * 2.5);
          u.heading += (wrap180(-u.heading)) * f;
          u.pitch += -u.pitch * f;
          if (Math.abs(u.heading) < 0.05 && Math.abs(u.pitch) < 0.05) this._resetting = false;
        }
      }
    }

    u.zoom += (u.zoomTarget - u.zoom) * (1 - Math.exp(-dt * 4));
    this.datumOffset += (this.datumOffsetTarget - this.datumOffset) * (1 - Math.exp(-dt * 2));
    this._apply();
  }

  // Heading the user actually sees (for the compass).
  get viewHeading() { return this.s.heading + this.user.heading; }

  _apply() {
    const s = this.s, u = this.user;
    const sh = this.shake;
    const t = this.time;
    const heading = s.heading + u.heading + sh * 0.9 * noise1(t, 1.7);
    const pitch = clamp(s.pitch + u.pitch + sh * 0.7 * noise1(t, 5.3), -90, 30);
    const range = s.range * u.zoom;
    // Never hand Cesium a NaN camera: it stops rendering for good.
    if (![heading, pitch, range, s.lon, s.lat, s.h].every(Number.isFinite)) return;
    C.Cartesian3.fromDegrees(s.lon, s.lat, s.h, C.Ellipsoid.WGS84, this._target);
    this._hpr.heading = heading * D2R;
    this._hpr.pitch = pitch * D2R;
    this._hpr.range = range;
    this.camera.lookAt(this._target, this._hpr);
    this.camera.lookAtTransform(C.Matrix4.IDENTITY);
    if (this.pan && this.mode === 'landed') {
      const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(this.camera.positionWC, new C.Cartesian3());
      this.camera.look(up, -this.pan * D2R);
    }
    this.camera.frustum.fov = this._lensFov();
  }

  // Each place can use a longer lens; telephoto compression is what makes
  // real mountain photos look enormous. Blends in over the last part of the fall.
  _lensFov() {
    const p = this.place;
    if (!p || !p.fov) return this.baseFov;
    const w = smooth(0, 1, (Math.log(30e3) - Math.log(this.s.range)) / (Math.log(30e3) - Math.log(p.view.range)));
    return lerp(this.baseFov, p.fov * D2R, w);
  }
}
