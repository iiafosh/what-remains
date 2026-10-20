// Procedural Giza pyramids.
//
// Google's photogrammetry melts the pyramids into soft blobs: the scan cannot
// resolve two hundred courses of stepped masonry. Here the scanned pyramids are
// cut out of the tileset with clipping polygons and replaced by real geometry.
// Every course is a ring of vertical risers with a horizontal tread on top, set
// back so the faces keep their true slope, with broken arrises, Khufu's summit
// platform and mast, Khafre's surviving casing cap and Menkaure's granite skirt.
// A flat apron of sand, pavement and rubble covers the clipped hole at the foot.
//
// Stone detail (running-bond joints, weathering, dust on the treads) is drawn in
// the shader in real metres and fades with distance. Lighting is done in the
// shader too, because the photogrammetry around it is unlit with baked sun.

const C = window.Cesium;
const D2R = Math.PI / 180;

// Real dimensions. `base` is [east-west, north-south] side length (m), `height`
// today's height, `slope` the face angle. Heights inside a pyramid are metres
// above its base; `along` on a face is metres from the face's centre, positive
// to the right as seen from outside looking at it. Edit freely before calling
// createGiza(): everything is rebuilt from these.
export const GIZA = {
  khufu: {
    lat: 29.979200,
    lon: 31.134110,
    baseHeight: 73.4,           // WGS84 ellipsoid height of the base, if not measured
    heading: 0,                 // degrees clockwise, to fine-tune the alignment
    base: [230.3, 230.3],
    height: 138.5,              // original apex 146.6
    slope: 51.84,
    courses: 203,
    courseHeight: [1.4, 0.55],  // bottom, top
    coreInset: 0.8,             // the stripped core sits inside the lost casing plane
    erosion: 1.0,               // size of the bites taken out of the arrises
    topInset: 1.0,              // extra loss on the top courses: a ~10 m platform
    blockLength: 1.6,
    mast: 9,                    // survey mast marking the original apex (m)
    baseCasing: [{ face: 'N', along: [-15, 7], height: 1.5 }],  // casing blocks still in place
    marks: [
      { face: 'N', along: [-10.5, -4], z: [15.5, 23] },        // original entrance and its gable stones
      { face: 'N', along: [-1.2, 2.2], z: [5.5, 9] },          // al-Ma'mun's tunnel
    ],
    rubble: 110,
    pavement: 7,
    clipMargin: 4,              // scan removed this far beyond the base
    apron: 12,                  // ground cover reaches this far beyond the clip, fading out
    seed: 11,
    colors: {
      stone: ['#b9a07a', '#d2bb92'],
      dust: '#d9c39d',
      joint: '#6e5a40',
      casing: '#ddd0b0',
      granite: '#8a5a52',
      sand: ['#c8aa82', '#dcc59f'],
    },
  },
  khafre: {
    lat: 29.976110,
    lon: 31.130830,
    baseHeight: 83,
    heading: 0,
    base: [215.3, 215.3],
    height: 136.4,              // original apex 143.5
    slope: 53.13,
    courses: 196,
    courseHeight: [1.2, 0.55],
    coreInset: 1.5,
    erosion: 0.9,
    topInset: 0,
    blockLength: 1.5,
    casing: { from: 106.5, full: 112, course: 0.62 },  // ragged lower edge between from and full
    marks: [],
    rubble: 130,
    pavement: 0,
    clipMargin: 4,
    apron: 12,
    seed: 23,
    colors: {
      stone: ['#b39a76', '#cdb68f'],
      dust: '#d6c09a',
      joint: '#6e5a40',
      casing: '#ddd0b0',
      granite: '#8a5a52',
      sand: ['#c8aa82', '#dcc59f'],
    },
  },
  menkaure: {
    lat: 29.972500,
    lon: 31.128330,
    baseHeight: 80,
    heading: 0,
    base: [102.2, 104.6],       // swap if the tiles say the long side runs east-west
    height: 61,                 // original apex 65.5
    slope: 51.34,
    courses: 74,
    courseHeight: [1.25, 0.6],
    courseDecay: 12,
    coreInset: 0.5,
    granite: 16,                // lowest courses partly cased in Aswan granite
    erosion: 0.8,
    topInset: 0.6,
    blockLength: 1.7,
    marks: [
      { face: 'N', along: [-5.5, 5.5], z: [12, 44], heap: 45 },  // the breach of 1196
      { face: 'N', along: [-1, 1], z: [3, 4.6] },                 // entrance
    ],
    rubble: 150,
    pavement: 0,
    clipMargin: 4,
    apron: 12,
    seed: 37,
    colors: {
      stone: ['#bfa27a', '#d4b98f'],
      dust: '#d9c39d',
      joint: '#6e5a40',
      casing: '#ddd0b0',
      granite: '#8a5a52',
      sand: ['#c8aa82', '#dcc59f'],
    },
  },
};

// Surface kinds understood by the shader, packed with the face index (kind + 8·face).
const RISER = 0, TREAD = 1, UNDER = 2, CASING = 3, BROKEN = 4, LOOSE = 5, TIMBER = 6;
const FACES = { E: 0, N: 1, W: 2, S: 3 };
const UP = [0, 0, 1];
const DOWN = [0, 0, -1];
const APRON_LIFT = 0.12;

// A scan is only cut out once Google's tiles over its footprint are fine.
// Coarse tiles can sit metres off the real ground, and the cut then shows the
// black sky through the hole beside the apron. Their geometric error halves
// per level (… 32, 16, 8 m); the scan comes back if they coarsen again.
const CUT_ERROR = 17;
const UNCUT_ERROR = 33;
// The cuts follow the tiles a frame late (and climbing away, the tiles coarsen
// faster than that), so a sand floor far below the plateau fills any hole that
// opens for a moment instead of the black sky.
const FLOOR_DEPTH = 80;      // below the lowest base (m)
const FLOOR_MARGIN = 1000;   // beyond the pyramids (m): a grazing look through a hole lands this far on

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function createGiza(viewer, tileset, { baseHeights, offsets } = {}) {
  const scene = viewer.scene;
  const primitives = [];
  const sites = [];
  let triangles = 0;
  let lowest = Infinity;

  for (const [name, spec] of Object.entries(GIZA)) {
    const h = Number.isFinite(baseHeights?.[name]) ? baseHeights[name] : spec.baseHeight;
    lowest = Math.min(lowest, h);
    const nudge = offsets?.[name] || {};
    const matrix = pyramidFrame(spec, h, nudge.east || 0, nudge.north || 0);
    const mesh = buildPyramid(spec);
    triangles += mesh.idx.length / 3 + 2;
    const pyramid = scene.primitives.add(new C.Primitive({
      geometryInstances: new C.GeometryInstance({ geometry: mesh.toGeometry(), modelMatrix: matrix, id: `giza-${name}` }),
      appearance: pyramidAppearance(spec, matrix),
      asynchronous: false,
      compressVertices: false,   // st carries metres, compression assumes 0..1
    }));
    const apron = scene.primitives.add(apronPrimitive(spec, matrix));
    apron.show = false;          // it only covers the cut, so it comes with it
    primitives.push(pyramid, apron);
    const hx = spec.base[0] / 2 + spec.clipMargin;
    const hy = spec.base[1] / 2 + spec.clipMargin;
    sites.push({
      pyramid,
      apron,
      polygon: new C.ClippingPolygon({ positions: footprint(matrix, hx, hy) }),
      center: C.Matrix4.getTranslation(matrix, new C.Cartesian3()),
      reach: Math.hypot(hx, hy),
      cut: false,
      error: -1,                 // coarsest tile drawn over the footprint this frame, -1 if none
    });
  }
  const floor = scene.primitives.add(floorPrimitive(Object.values(GIZA), lowest));
  floor.show = false;
  primitives.push(floor);

  // Cut the scanned pyramids out of the photogrammetry. If the tileset already
  // clips something we join its collection, otherwise it gets one of its own.
  const previous = tileset ? tileset.clippingPolygons : undefined;
  let clips = null;
  let owned = false;
  if (tileset && C.ClippingPolygonCollection.isSupported(scene)) {
    if (!previous) {
      clips = new C.ClippingPolygonCollection();
      tileset.clippingPolygons = clips;
      owned = true;
    } else if (!previous.inverse) {
      clips = previous;
    } else {
      console.warn('[giza] tileset already uses inverse clipping; scanned pyramids left in place');
    }
  } else if (tileset) {
    console.warn('[giza] clipping polygons need WebGL 2; scanned pyramids left in place');
  }

  let visible = true;
  let destroyed = false;
  const alive = () => tileset && !(tileset.isDestroyed && tileset.isDestroyed());

  const setCut = (site, cut) => {
    if (cut === site.cut) return;
    site.cut = cut;
    site.apron.show = cut;
    floor.show = sites.some((s) => s.cut);
    if (!alive()) return;
    if (cut) clips.add(site.polygon);
    else clips.remove(site.polygon);
  };

  // While a frame renders, note the coarsest tile drawn over each footprint;
  // after it, cut the scans whose ground is fine, once their model is drawn.
  const unwatch = clips ? [
    tileset.tileVisible.addEventListener((tile) => {
      for (const site of sites) {
        if (tile.geometricError > site.error && overlaps(tile, site)) site.error = tile.geometricError;
      }
    }),
    scene.postRender.addEventListener(() => {
      for (const site of sites) {
        if (site.error >= 0) {
          const fine = site.error <= CUT_ERROR || (site.cut && site.error <= UNCUT_ERROR);
          setCut(site, visible && fine && site.pyramid.ready);
        }
        site.error = -1;
      }
    }),
  ] : [];

  return {
    primitives,
    triangles,
    setVisible(v) {
      v = !!v;
      if (destroyed || v === visible) return;
      visible = v;
      for (const site of sites) {
        site.pyramid.show = v;
        if (!v) setCut(site, false);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of unwatch) off();
      // Uncut first: tiles keep a reference to the collection after it is detached.
      for (const site of sites) setCut(site, false);
      for (const p of primitives) {
        if (!p.isDestroyed()) scene.primitives.remove(p);
      }
      primitives.length = 0;
      if (owned && alive() && tileset.clippingPolygons === clips) tileset.clippingPolygons = previous;
    },
  };
}

// The sand floor under the whole group (see FLOOR_DEPTH).
function floorPrimitive(specs, lowest) {
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const spec of specs) {
    const r = Math.max(...spec.base) / 2 + FLOOR_MARGIN;
    const dLat = r / 110574;
    const dLon = r / (111320 * Math.cos(spec.lat * D2R));
    w = Math.min(w, spec.lon - dLon);
    e = Math.max(e, spec.lon + dLon);
    s = Math.min(s, spec.lat - dLat);
    n = Math.max(n, spec.lat + dLat);
  }
  return new C.Primitive({
    geometryInstances: new C.GeometryInstance({
      geometry: new C.RectangleGeometry({
        rectangle: C.Rectangle.fromDegrees(w, s, e, n),
        height: lowest - FLOOR_DEPTH,
        vertexFormat: C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
      }),
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color(specs[0].colors.sand[0])) },
    }),
    appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: false }),
    asynchronous: false,
  });
}

// Whether a tile's volume reaches a footprint: its bounding sphere first, then
// the tighter oriented box Google's tiles carry.
function overlaps(tile, site) {
  const sphere = tile.boundingSphere;
  if (C.Cartesian3.distance(sphere.center, site.center) > sphere.radius + site.reach) return false;
  const box = tile.boundingVolume?.boundingVolume;
  return !(box instanceof C.OrientedBoundingBox)
    || C.OrientedBoundingBox.distanceSquaredTo(box, site.center) <= site.reach * site.reach;
}

// East-north-up frame at the base centre, nudged and turned as asked.
function pyramidFrame(spec, height, east, north) {
  let enu = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(spec.lon, spec.lat, height));
  if (east || north) {
    const moved = C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(east, north, 0), new C.Cartesian3());
    enu = C.Transforms.eastNorthUpToFixedFrame(moved);
  }
  const turn = C.Matrix4.fromRotationTranslation(C.Matrix3.fromRotationZ(-(spec.heading || 0) * D2R));
  return C.Matrix4.multiplyTransformation(enu, turn, new C.Matrix4());
}

function footprint(matrix, hx, hy) {
  return [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]].map(([x, y]) =>
    C.Matrix4.multiplyByPoint(matrix, new C.Cartesian3(x, y, 0), new C.Cartesian3()));
}

// Unit local axis i (0 east, 1 north, 2 up) of a frame, in world coordinates.
function axis(matrix, i) {
  return C.Cartesian3.normalize(new C.Cartesian3(matrix[i * 4], matrix[i * 4 + 1], matrix[i * 4 + 2]), new C.Cartesian3());
}

const color = (css) => C.Color.fromCssColorString(css);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  return next;
}

// Flat-shaded triangles with per-vertex st (metres) and course data.
class Mesh {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.st = [];
    this.info = [];
    this.idx = [];
    this.count = 0;
  }

  // A convex planar polygon. Winding is set from the intended outward normal.
  face(pts, n, st, course, kindFace, ds, w) {
    const base = this.count;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.st.push(st[i][0], st[i][1]);
      this.info.push(course, kindFace, ds[i], w);
    }
    this.count += pts.length;
    const [a, b, c] = pts;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const flip = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] < 0;
    for (let i = 1; i < pts.length - 1; i++) {
      if (flip) this.idx.push(base, base + i + 1, base + i);
      else this.idx.push(base, base + i, base + i + 1);
    }
  }

  toGeometry() {
    const positions = new Float64Array(this.pos);
    return new C.Geometry({
      attributes: {
        position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
        normal: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(this.nrm) }),
        st: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array(this.st) }),
        info: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 4, values: new Float32Array(this.info) }),
      },
      indices: C.IndexDatatype.createTypedArray(this.count, this.idx),
      primitiveType: C.PrimitiveType.TRIANGLES,
      boundingSphere: C.BoundingSphere.fromVertices(positions),
    });
  }
}

// Corners counter-clockwise from above. Each is reached along one side and left
// along the next (sides: 0 east, 1 north, 2 west, 3 south).
const CORNERS = [
  { x: 1, y: -1, arrive: 3, leave: 0, din: [1, 0], dout: [0, 1] },    // SE
  { x: 1, y: 1, arrive: 0, leave: 1, din: [0, 1], dout: [-1, 0] },    // NE
  { x: -1, y: 1, arrive: 1, leave: 2, din: [-1, 0], dout: [0, -1] },  // NW
  { x: -1, y: -1, arrive: 2, leave: 3, din: [0, -1], dout: [1, 0] },  // SW
];
const SIDE_OUT = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const SIDE_ALONG = [[0, 1], [-1, 0], [0, -1], [1, 0]];

// Coordinate along face f (left to right seen from outside), offset per face so
// the faces get different block patterns.
function faceU(f, x, y) {
  return (f === 0 ? y : f === 1 ? -x : f === 2 ? -y : x) + f * 300;
}

function faceOf(x, y) {
  if (Math.abs(x) >= Math.abs(y) - 1e-6) return x > 0 ? 0 : 2;
  return y > 0 ? 1 : 3;
}

// (outward distance, along) on side k → local x, y.
function sideXY(k, n, t) {
  return [SIDE_OUT[k][0] * n + SIDE_ALONG[k][0] * t, SIDE_OUT[k][1] * n + SIDE_ALONG[k][1] * t];
}

const halfSides = (spec) => [spec.base[0] / 2, spec.base[1] / 2, spec.base[0] / 2, spec.base[1] / 2];
const sideLength = (a, k) => (k % 2 === 0 ? a[1] + a[3] : a[0] + a[2]);

// Course heights: thick at the bottom, thinning upward, with the recurring
// sudden thick courses real cores show, scaled to add up to the true height.
function courseHeights(spec, rnd) {
  const n = spec.courses;
  const [hb, ht] = spec.courseHeight;
  const tau = spec.courseDecay || n * 0.07;
  const raw = [];
  let left = 0, span = 1, bump = 0;
  for (let i = 0; i < n; i++) {
    if (left <= 0) {
      span = Math.round(rnd.range(7, 26));
      left = span;
      bump = rnd.range(0.08, 0.35);
    }
    raw.push(ht + (hb - ht) * Math.exp(-i / tau) + bump * (left / span) + rnd.range(-0.04, 0.04));
    left--;
  }
  const floor = ht * 0.8;
  const excess = raw.reduce((s, h) => s + h - floor, 0);
  const k = Math.min(3, Math.max(0.3, (spec.height - floor * n) / excess));
  const hs = raw.map((h) => floor + (h - floor) * k);
  const sum = hs.reduce((s, h) => s + h, 0);
  return hs.map((h) => h * spec.height / sum);
}

// Half-extent of every course on each side: on the slope, minus the core inset,
// with per-course jitter and a slow wander of each face.
function coreExtents(spec, rnd, zs, count, tanS) {
  const half = halfSides(spec);
  const drift = [0, 0, 0, 0];
  const total = zs.length - 1;
  const ext = [];
  for (let i = 0; i < count; i++) {
    const fromTop = total - 1 - i;
    const loss = fromTop < 3 ? (spec.topInset || 0) * (3 - fromTop) / 3 : 0;
    const inset = i < (spec.granite || 0) ? 0 : spec.coreInset;
    const a = [];
    for (let k = 0; k < 4; k++) {
      drift[k] = Math.max(-0.25, Math.min(0.25, drift[k] + rnd.range(-0.05, 0.05)));
      let v = half[k] - inset - zs[i] / tanS + drift[k] + rnd.range(-0.15, 0.15) - loss;
      if (i > 0) v = Math.min(v, ext[i - 1][k] - 0.12);
      a.push(Math.max(v, 0.8));
    }
    ext.push(a);
  }
  return ext;
}

// Broken arrises: at every course each corner loses a sliver, a chamfer or a
// whole block (a rectangular notch). A course is never left hanging over the
// hole in the one below, so missing blocks run up the ridge in ragged runs.
function cutCorners(spec, rnd, ext) {
  const n = ext.length;
  const cuts = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const scale = spec.erosion * (0.75 + 0.6 * t) * (i >= n - 3 ? 1.6 : 1);
    const row = [];
    for (let k = 0; k < 4; k++) {
      const { arrive: A, leave: B } = CORNERS[k];
      const roll = rnd();
      let e;
      if (roll < 0.22) {
        e = { type: 'chamfer', la: rnd.range(0.08, 0.3), lb: rnd.range(0.08, 0.3), r: 0 };
      } else if (roll < 0.62) {
        const l = rnd.range(0.4, 1.7) * scale;
        e = { type: 'chamfer', la: l * rnd.range(0.6, 1.5), lb: l * rnd.range(0.6, 1.5), r: rnd() < 0.5 ? rnd.range(0.2, 0.45) : 0 };
      } else {
        const big = rnd() < 0.1 ? 1.7 : 1;
        e = { type: 'notch', la: rnd.range(0.7, 2.4) * scale * big, lb: rnd.range(0.7, 2.4) * scale * big, r: 0 };
      }
      if (i > 0) {
        const p = cuts[i - 1][k];
        const sA = ext[i - 1][A] - ext[i][A];
        const sB = ext[i - 1][B] - ext[i][B];
        const needA = p.type === 'notch' ? p.la - sB : p.la - sB - sA * p.la / p.lb;
        const needB = p.type === 'notch' ? p.lb - sA : p.lb - sA - sB * p.lb / p.la;
        if (needA > 0 && needB > 0) {
          if (p.type === 'notch') e.type = 'notch';
          e.la = Math.max(e.la, needA + rnd.range(0.03, 0.3));
          e.lb = Math.max(e.lb, needB + rnd.range(0.03, 0.3));
          e.r = 0;
        }
      }
      e.la = Math.min(e.la, 0.4 * sideLength(ext[i], A));
      e.lb = Math.min(e.lb, 0.4 * sideLength(ext[i], B));
      row.push(e);
    }
    cuts.push(row);
  }
  return cuts;
}

// Plan outline of one course, counter-clockwise from above, corners cut.
function outline(a, cuts) {
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const c = CORNERS[k];
    const cx = c.x > 0 ? a[0] : -a[2];
    const cy = c.y > 0 ? a[1] : -a[3];
    const e = cuts[k];
    const p1 = [cx - c.din[0] * e.la, cy - c.din[1] * e.la];
    const p3 = [cx + c.dout[0] * e.lb, cy + c.dout[1] * e.lb];
    if (e.type === 'notch') {
      pts.push(p1, [p1[0] + c.dout[0] * e.lb, p1[1] + c.dout[1] * e.lb], p3);
    } else if (e.r > 0) {
      const mx = (p1[0] + p3[0]) / 2, my = (p1[1] + p3[1]) / 2;
      pts.push(p1, [mx + (cx - mx) * e.r, my + (cy - my) * e.r], p3);
    } else {
      pts.push(p1, p3);
    }
  }
  return pts;
}

// Side walls between a bottom and a top outline (same vertex count, parallel
// edges): vertical risers, or sloped casing when the top is set back.
function ring(mesh, bottom, top, z0, z1, course, kind) {
  const h = z1 - z0;
  const m = bottom.length;
  for (let j = 0; j < m; j++) {
    const P = bottom[j], Q = bottom[(j + 1) % m];
    const Pt = top[j], Qt = top[(j + 1) % m];
    const ex = Q[0] - P[0], ey = Q[1] - P[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-3) continue;
    const ox = ey / len, oy = -ex / len;
    const back = -((Pt[0] - P[0]) * ox + (Pt[1] - P[1]) * oy);
    const nl = Math.hypot(h, back);
    const f = faceOf(ox, oy);
    mesh.face(
      [[P[0], P[1], z0], [Q[0], Q[1], z0], [Qt[0], Qt[1], z1], [Pt[0], Pt[1], z1]],
      [ox * h / nl, oy * h / nl, back / nl],
      [[faceU(f, P[0], P[1]), z0], [faceU(f, Q[0], Q[1]), z0], [faceU(f, Qt[0], Qt[1]), z1], [faceU(f, Pt[0], Pt[1]), z1]],
      course, kind + 8 * f, [0, 0, h, h], h,
    );
  }
}

// Horizontal cap, fanned from the middle (outlines are star-shaped about it).
// For treads, d is the distance in from the lip and w the depth to the next riser.
function cap(mesh, poly, z, course, kind, setback, up) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const m = poly.length;
  for (let j = 0; j < m; j++) {
    const P = poly[j], Q = poly[(j + 1) % m];
    const ex = Q[0] - P[0], ey = Q[1] - P[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-3) continue;
    const f = faceOf(ey, -ex);
    const dc = Math.abs(ex * (cy - P[1]) - ey * (cx - P[0])) / len;
    mesh.face(
      [[cx, cy, z], [P[0], P[1], z], [Q[0], Q[1], z]],
      up ? UP : DOWN,
      [[faceU(f, cx, cy), z], [faceU(f, P[0], P[1]), z], [faceU(f, Q[0], Q[1]), z]],
      course, kind + 8 * f, [dc, 0, 0], setback ? setback[f] : 1,
    );
  }
}

// A stretch of dressed casing on side k: sloped outer face, broken top and
// ends, underside. Its back is buried in the core, so it has no inner wall.
function slab(mesh, k, t0, t1, z0, z1, a0, inset, depth, course) {
  const h = z1 - z0;
  const ai = a0 - depth;
  const at = a0 - inset;
  const P = (n, t, z) => { const [x, y] = sideXY(k, n, t); return [x, y, z]; };
  const o = SIDE_OUT[k], al = SIDE_ALONG[k];
  const nl = Math.hypot(h, inset);
  const u0 = t0 + k * 300, u1 = t1 + k * 300;
  const s = k * 300 + 150;
  mesh.face([P(a0, t0, z0), P(a0, t1, z0), P(at, t1, z1), P(at, t0, z1)],
    [o[0] * h / nl, o[1] * h / nl, inset / nl],
    [[u0, z0], [u1, z0], [u1, z1], [u0, z1]], course, CASING + 8 * k, [0, 0, h, h], h);
  mesh.face([P(at, t0, z1), P(at, t1, z1), P(ai, t1, z1), P(ai, t0, z1)], UP,
    [[u0, z1], [u1, z1], [u1, z1 + depth - inset], [u0, z1 + depth - inset]], course, BROKEN + 8 * k,
    [0, 0, depth - inset, depth - inset], depth);
  mesh.face([P(a0, t0, z0), P(ai, t0, z0), P(ai, t1, z0), P(a0, t1, z0)], DOWN,
    [[u0, z0], [u0, z0 + depth], [u1, z0 + depth], [u1, z0]], course, UNDER + 8 * k, [0, 0, 0, 0], 1);
  for (const [t, sign] of [[t0, -1], [t1, 1]]) {
    mesh.face([P(a0, t, z0), P(at, t, z1), P(ai, t, z1), P(ai, t, z0)],
      [al[0] * sign, al[1] * sign, 0],
      [[s, z0], [s + inset, z1], [s + depth, z1], [s + depth, z0]], course, BROKEN + 8 * k, [0, 0, 0, 0], depth);
  }
}

// A box with arbitrary orientation (fallen blocks, the summit mast).
function box(mesh, c, axes, half, seed, kind) {
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, l = (i + 2) % 3;
    // st axes per face: x-faces (y, z), y-faces (x, z), z-faces (x, y)
    const sa = i === 0 ? 1 : 0, sb = i === 2 ? 1 : 2;
    for (const s of [-1, 1]) {
      const n = axes[i].map((v) => v * s);
      const pts = [], st = [];
      for (const [p, q] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const loc = [0, 0, 0];
        loc[i] = s * half[i];
        loc[j] = p * half[j];
        loc[l] = q * half[l];
        pts.push([0, 1, 2].map((d) => c[d] + axes[0][d] * loc[0] + axes[1][d] * loc[1] + axes[2][d] * loc[2]));
        st.push([loc[sa] + seed * 0.37, loc[sb]]);
      }
      mesh.face(pts, n, st, seed, kind, [0, 0, 0, 0], 1);
    }
  }
}

// Rodrigues rotation of v about unit axis k.
function rotate(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2];
  const x = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => v[i] * c + x[i] * s + k[i] * d * (1 - c));
}

function block(mesh, rnd, c, size, seed, tilt = 0.18) {
  const a = rnd() * Math.PI;
  let ax = [Math.cos(a), Math.sin(a), 0];
  let ay = [-Math.sin(a), Math.cos(a), 0];
  let az = [0, 0, 1];
  const tx = rnd.range(-tilt, tilt), ty = rnd.range(-tilt, tilt);
  ay = rotate(ay, ax, tx);
  az = rotate(az, ax, tx);
  ax = rotate(ax, ay, ty);
  az = rotate(az, ay, ty);
  box(mesh, c, [ax, ay, az], size.map((v) => v / 2), seed, LOOSE);
}

function blockSize(rnd) {
  const s = Math.pow(rnd(), 1.5);
  return [rnd.range(0.4, 1.0) + s * 1.1, rnd.range(0.35, 0.8) + s * 0.8, rnd.range(0.25, 0.6) + s * 0.6];
}

// Fallen blocks and chips around the foot, a heap under each breach.
function addRubble(mesh, spec, rnd, base) {
  const reach = spec.clipMargin + spec.apron * 0.6;
  let seed = 1;
  for (let i = 0; i < spec.rubble; i++) {
    const k = Math.floor(rnd() * 4);
    const out = 0.4 + Math.pow(rnd(), 1.8) * reach;
    const hw = sideLength(base, k) / 2;
    const t = rnd.range(-1, 1) * (hw + out * 0.7);
    const size = blockSize(rnd);
    const [x, y] = sideXY(k, base[k] + out + size[0] * 0.3, t);
    block(mesh, rnd, [x, y, size[2] * rnd.range(0.2, 0.42)], size, seed++);
  }
  for (const mk of spec.marks || []) {
    if (!mk.heap) continue;
    const k = FACES[mk.face];
    for (let i = 0; i < mk.heap; i++) {
      const out = rnd.range(-1.5, 9);
      const t = rnd.range(mk.along[0] - 4, mk.along[1] + 4);
      const size = blockSize(rnd);
      const pile = Math.max(0, 4.5 - Math.max(out, 0) * 0.5) * rnd();
      const [x, y] = sideXY(k, base[k] + out, t);
      block(mesh, rnd, [x, y, pile + size[2] * 0.35], size, seed++, 0.35);
    }
  }
}

// Khufu's summit: a slim timber mast where the apex was, a few loose blocks.
function addSummit(mesh, spec, rnd, top, z) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of top) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const room = Math.min(x1 - x0, y1 - y0) / 2 - 1;
  for (let i = 0; i < 7 && room > 1; i++) {
    const size = blockSize(rnd).map((v) => v * 0.8);
    block(mesh, rnd, [cx + rnd.range(-room, room), cy + rnd.range(-room, room), z + size[2] * 0.4], size, 500 + i);
  }
  const H = spec.mast;
  if (!H) return;
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  box(mesh, [cx, cy, z + H / 2], I, [0.11, 0.11, H / 2], 900, TIMBER);
  const strut = (a, b, r, seed) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    const az = d.map((v) => v / len);
    let ax = [az[1], -az[0], 0];
    const al = Math.hypot(...ax);
    ax = al > 1e-3 ? ax.map((v) => v / al) : [1, 0, 0];
    const ay = [az[1] * ax[2] - az[2] * ax[1], az[2] * ax[0] - az[0] * ax[2], az[0] * ax[1] - az[1] * ax[0]];
    box(mesh, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [ax, ay, az], [r, r, len / 2], seed, TIMBER);
  };
  for (let i = 0; i < 3; i++) {
    const a = i * 2.094 + 0.4;
    strut([cx + Math.cos(a) * 1.9, cy + Math.sin(a) * 1.9, z], [cx, cy, z + H * 0.42], 0.06, 901 + i);
  }
  strut([cx - 0.7, cy, z + H * 0.82], [cx + 0.7, cy, z + H * 0.82], 0.04, 905);
  strut([cx, cy - 0.5, z + H * 0.62], [cx, cy + 0.5, z + H * 0.62], 0.04, 906);
}

// Keep casing course boundaries off the core's, so coplanar faces never fight.
function avoid(z, zs) {
  for (const c of zs) if (Math.abs(z - c) < 0.06) return c + 0.08;
  return z;
}

// Khafre's cap: rings of smooth casing from `full` to the top, and below that a
// ragged edge where the casing survives only on parts of each face.
function buildCasing(mesh, spec, rnd, tanS, coreZs) {
  const cas = spec.casing;
  const half = halfSides(spec);
  const top = spec.height;
  const zc = [cas.from];
  while (zc[zc.length - 1] < top) {
    let z = zc[zc.length - 1] + cas.course * rnd.range(0.85, 1.15);
    z = top - z < 0.3 ? top : avoid(z, coreZs);
    zc.push(Math.min(z, top));
  }
  const plane = (k, z) => half[k] - z / tanS;
  const across = (k, z) => (k % 2 === 0 ? Math.min(plane(1, z), plane(3, z)) : Math.min(plane(0, z), plane(2, z)));
  const depth = spec.coreInset + 2;   // deep enough to stay buried in the stepped core
  let rings = 0;
  for (let j = 0; j < zc.length - 1; j++) {
    const z0 = zc[j], z1 = zc[j + 1];
    if (z1 - z0 < 0.05) continue;
    if (z0 >= cas.full) {
      const a0 = half.map((_, k) => plane(k, z0));
      const a1 = half.map((_, k) => plane(k, z1));
      const rough = 1 + 2.2 * Math.max(0, 1 - rings / 6) + (z1 > top - 2 ? 1 : 0);
      rings++;
      const cuts = CORNERS.map(({ arrive, leave }) => {
        const l = rnd.range(0.12, 0.5) * rough;
        return {
          type: rnd() < 0.35 ? 'notch' : 'chamfer',
          la: Math.min(l * rnd.range(0.6, 1.6), 0.4 * sideLength(a1, arrive)),
          lb: Math.min(l * rnd.range(0.6, 1.6), 0.4 * sideLength(a1, leave)),
          r: 0,
        };
      });
      const B = outline(a0, cuts);
      const T = outline(a1, cuts);
      ring(mesh, B, T, z0, z1, j, CASING);
      cap(mesh, T, z1, j, BROKEN, null, true);
      cap(mesh, B, z0, j, UNDER, null, false);
    } else {
      const p = (z0 - cas.from) / (cas.full - cas.from);
      for (let k = 0; k < 4; k++) {
        const lim = across(k, z1) - depth - 0.3;
        if (lim < 2) continue;
        const f = Math.min(1, Math.max(0.1, 0.25 + 0.7 * p + rnd.range(-0.2, 0.2)));
        const L = f * lim;
        const c = rnd.range(-1, 1) * (lim - L);
        let segs = [[c - L, c + L]];
        if (L > 5 && rnd() < 0.4) {
          const g = rnd.range(c - L * 0.6, c + L * 0.6);
          const gw = rnd.range(1.2, 4);
          segs = [[c - L, g - gw / 2], [g + gw / 2, c + L]];
        }
        for (const [t0, t1] of segs) {
          if (t1 - t0 > 0.8) slab(mesh, k, t0, t1, z0, z1, plane(k, z0), (z1 - z0) / tanS, depth, j);
        }
      }
    }
  }
}

function buildPyramid(spec) {
  const rnd = rng(spec.seed);
  const mesh = new Mesh();
  const tanS = Math.tan(spec.slope * D2R);
  const hs = courseHeights(spec, rnd);
  const zs = [0];
  for (const h of hs) zs.push(zs[zs.length - 1] + h);

  // Under a casing cap the core is hidden, so it stops just above the cap's edge.
  let count = hs.length;
  if (spec.casing) {
    const i = zs.findIndex((z) => z > spec.casing.full + 1.5);
    if (i > 0) count = i;
  }
  const ext = coreExtents(spec, rnd, zs, count, tanS);
  const cuts = cutCorners(spec, rnd, ext);
  const shapes = ext.map((a, i) => outline(a, cuts[i]));

  for (let i = 0; i < count; i++) {
    const next = ext[i + 1];
    const setback = next ? ext[i].map((v, k) => v - next[k]) : [99, 99, 99, 99];
    ring(mesh, shapes[i], shapes[i], zs[i], zs[i + 1], i, RISER);
    cap(mesh, shapes[i], zs[i + 1], i, TREAD, setback, true);
    cap(mesh, shapes[i], zs[i], i, UNDER, null, false);
  }

  if (spec.casing) buildCasing(mesh, spec, rnd, tanS, zs);
  const half = halfSides(spec);
  for (const bc of spec.baseCasing || []) {
    const k = FACES[bc.face];
    const h = avoid(bc.height, zs);
    slab(mesh, k, bc.along[0], bc.along[1], 0, h, half[k], h / tanS, spec.coreInset + 2, 0);
  }
  addRubble(mesh, spec, rnd, ext[0]);
  if (!spec.casing) addSummit(mesh, spec, rnd, shapes[count - 1], zs[count]);
  return mesh;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------
const COMMON_GLSL = /* glsl */ `
  float gz_hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float gz_noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 w = f * f * (3.0 - 2.0 * f);
    return mix(mix(gz_hash(i), gz_hash(i + vec2(1.0, 0.0)), w.x),
               mix(gz_hash(i + vec2(0.0, 1.0)), gz_hash(i + vec2(1.0, 1.0)), w.x), w.y);
  }

  float gz_fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      s += a * gz_noise(p);
      p = p * 2.07 + vec2(13.1, 7.7);
      a *= 0.5;
    }
    return s * 1.0667;
  }

  // Warm sun plus a cool sky that favours up-facing surfaces, tuned to sit next
  // to sunlit desert photogrammetry (a shaded wall still gets ~0.6 of full light).
  vec3 gz_light(vec3 n, vec3 L, vec3 up, float ao) {
    float sunH = dot(L, up);
    float sunVis = smoothstep(-0.05, 0.08, sunH);
    vec3 sunCol = mix(vec3(1.0, 0.72, 0.5), vec3(1.0, 0.95, 0.87), smoothstep(0.0, 0.45, sunH));
    float ndl = clamp((dot(n, L) + 0.08) / 1.08, 0.0, 1.0);
    float sky = dot(n, up) * 0.5 + 0.5;
    vec3 amb = mix(vec3(0.56, 0.53, 0.48), vec3(0.68, 0.70, 0.72), sky);
    return amb * ao + sunCol * (ndl * 0.55 * sunVis * mix(1.0, ao, 0.5));
  }
`;

const PYRAMID_GLSL = /* glsl */ `
  // x: block index along the course, y: distance to the nearest vertical joint
  // (m). Joints wander by a third of a block so lengths vary.
  vec2 gz_bond(float u, float row, float len) {
    float x = u / len + gz_hash(vec2(row, 5.3)) * 4.0;
    float k = floor(x);
    float j0 = k + (gz_hash(vec2(k, row)) - 0.5) * 0.64;
    float j1 = k + 1.0 + (gz_hash(vec2(k + 1.0, row)) - 0.5) * 0.64;
    if (x < j0) {
      j1 = j0;
      k -= 1.0;
      j0 = k + (gz_hash(vec2(k, row)) - 0.5) * 0.64;
    } else if (x > j1) {
      j0 = j1;
      k += 1.0;
      j1 = k + 1.0 + (gz_hash(vec2(k + 1.0, row)) - 0.5) * 0.64;
    }
    return vec2(k, min(x - j0, j1 - x) * len);
  }

  // Soft, ragged rectangle on one face: entrances, Menkaure's breach.
  float gz_mark(vec4 r, float markFace, float face, float along, float z, float wobble) {
    if (markFace < -0.5 || abs(markFace - face) > 0.5) return 0.0;
    float a = along + wobble * 1.6;
    float h = z + wobble * 1.2;
    return smoothstep(r.x - 0.5, r.x + 0.5, a) * (1.0 - smoothstep(r.y - 0.5, r.y + 0.5, a))
         * smoothstep(r.z - 0.5, r.z + 0.5, h) * (1.0 - smoothstep(r.w - 0.5, r.w + 0.5, h));
  }

  czm_material czm_getMaterial(czm_materialInput materialInput) {
    czm_material m = czm_getDefaultMaterial(materialInput);

    // Course data rides in str/s (see the fragment shader); st is in metres.
    float course = floor(materialInput.str.x + 0.5);
    float kf = floor(materialInput.str.y + 0.5);
    float face = floor((kf + 0.5) / 8.0);
    float kind = kf - face * 8.0;
    float d = materialInput.str.z;
    float w = max(materialInput.s, 0.05);
    float u = materialInput.st.x;
    float z = materialInput.st.y;
    float along = u - face * 300.0;

    bool riser = kind < 0.5;
    bool tread = kind > 0.5 && kind < 1.5;
    bool under = kind > 1.5 && kind < 2.5;
    bool casing = kind > 2.5 && kind < 3.5;
    bool broken = kind > 3.5 && kind < 4.5;
    bool loose = kind > 4.5 && kind < 5.5;
    bool timber = kind > 5.5;
    bool stepped = riser || tread;

    // Detail fades with distance so nothing shimmers.
    float dist = length(materialInput.positionToEyeEC);
    float fFine = 1.0 - smoothstep(110.0, 170.0, dist);
    float fJoint = 1.0 - smoothstep(420.0, 650.0, dist);
    float fBlock = 1.0 - smoothstep(650.0, 1200.0, dist);
    float macro = smoothstep(120.0, 600.0, dist) * 0.85;

    vec2 tc = tread ? vec2(u, d + course * 3.17)
      : ((loose || timber) ? materialInput.st + vec2(course * 7.31, course * 3.7) : vec2(u, z));
    float px = max(max(fwidth(tc.x), fwidth(tc.y)), 1.0e-4);

    // ---- Blocks: a running bond along every course ----
    bool graniteRow = u_granite > 0.0 && stepped && course < u_granite;
    float row = casing ? course + 400.0 : course;
    float len = casing ? 1.45 : u_blockLength * (graniteRow ? 1.35 : 1.0);
    vec2 bond = gz_bond(u, row, len);
    float hb = gz_hash(vec2(bond.x, row + 0.37));
    float hb2 = gz_hash(vec2(bond.x * 1.31 + 7.0, row));
    float hb3 = gz_hash(vec2(bond.x + 3.3, row * 1.7 + 1.0));
    bool granite = graniteRow && hb3 < mix(0.9, 0.45, course / max(u_granite, 1.0));

    // ---- Colour: per block, then large weathered patches across the face ----
    vec3 stone = mix(u_stoneA.rgb, u_stoneB.rgb, mix(0.5, hb, fBlock));
    vec3 tint = hb2 > 0.84 ? vec3(0.92, 0.94, 0.97) : (hb2 < 0.08 ? vec3(1.05, 0.94, 0.88) : vec3(1.0));
    stone *= mix(vec3(1.0), tint, fBlock);
    stone *= 0.88 + 0.24 * gz_fbm(vec2(u, z) * 0.03 + face * 5.1);
    if (granite) {
      float g = gz_fbm(tc * 0.9 + 11.0);
      stone = mix(u_graniteColor.rgb, vec3(0.47, 0.44, 0.42), 0.2 + 0.5 * g) * (0.88 + 0.24 * hb);
    }
    if (casing || broken) {
      vec3 cas = u_casingColor.rgb * (0.95 + 0.1 * hb);
      float stain = gz_fbm(vec2(u * 0.25, z * 0.1) + 3.0);
      cas = mix(cas, cas * vec3(0.86, 0.8, 0.7), smoothstep(0.45, 0.8, stain) * 0.8);
      stone = broken ? mix(cas, stone, 0.55) : cas;
    }
    if (loose) {
      stone = mix(u_stoneA.rgb, u_stoneB.rgb, gz_hash(vec2(course, 1.0))) * (0.88 + 0.18 * gz_hash(vec2(course, 2.0)));
    }
    if (timber) {
      stone = vec3(0.34, 0.28, 0.22) * (0.85 + 0.3 * gz_noise(tc * vec2(1.0, 0.15)));
    }

    // ---- Weathering: pitting up close, mottling and streaks further out ----
    float fine = 0.5;
    if (fFine > 0.0) {
      fine = gz_fbm(tc * 3.3);
      float grit = gz_noise(tc * 13.0);
      stone *= 1.0 + ((fine - 0.5) * 0.26 + (grit - 0.5) * (granite ? 0.3 : 0.14)) * fFine;
    }
    stone *= 1.0 + (gz_noise(tc * 0.8 + 5.0) - 0.5) * 0.16 * fBlock;
    if (riser || casing) {
      float streak = gz_noise(vec2(u * 1.6, z * 0.04));
      stone *= 1.0 - 0.09 * smoothstep(0.55, 0.9, streak) * fBlock;
    }

    // ---- Dust: sand settles on the treads, deepest against the next riser ----
    vec3 dustCol = u_dust.rgb * (0.94 + 0.12 * fine);
    float dust = 0.0;
    if (tread) dust = clamp(0.2 + 0.65 * clamp(d / w, 0.0, 1.0) + (gz_fbm(tc * 0.9 + 2.0) - 0.5) * 0.9, 0.0, 1.0);
    if (riser) dust = 0.4 * (1.0 - smoothstep(0.0, 0.3, d)) * (0.6 + 0.8 * fine);
    if (broken) dust = 0.3;
    vec3 col = mix(stone, dustCol, dust * 0.75);
    if (tread) col *= 1.06;

    // ---- Entrances and breaches ----
    float wobble = gz_noise(vec2(along, z) * 0.35) - 0.5;
    float rec = (stepped || casing)
      ? max(gz_mark(u_markA, u_markFaces.x, face, along, z, wobble), gz_mark(u_markB, u_markFaces.y, face, along, z, wobble))
      : 0.0;
    vec3 recCol = stone * vec3(0.6, 0.56, 0.52);
    col = mix(col, recCol, rec * 0.85);

    // ---- Joints: dark eroded gaps; ones thinner than a pixel fade out ----
    float joint = 0.0;
    float edge = 0.0;
    if (stepped || casing) {
      float jd = bond.y;
      if (riser) jd = min(jd, d);
      if (casing) jd = min(jd, min(d, w - d));
      float jw = casing ? 0.012 : (0.035 + 0.05 * gz_noise(tc * 1.7 + 9.0)) * (granite ? 0.6 : 1.0);
      float cov = clamp(jw / px, 0.0, 1.0);
      joint = (1.0 - smoothstep(jw - px * 0.5, jw + px * 0.5, jd)) * cov * fJoint;
      edge = (1.0 - smoothstep(0.0, casing ? 0.05 : 0.22, jd)) * fJoint;
    }
    col = mix(col, u_joint.rgb * (0.85 + 0.3 * fine), joint * (casing ? 0.45 : 0.85));
    if (riser) col *= 1.0 + 0.07 * smoothstep(w - 0.12, w, d) * fJoint;
    // Sun-bleached and dusty: a little paler than the raw stone colours.
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.85);

    // ---- Fake ambient occlusion ----
    float ao = 1.0;
    if (riser) ao = 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.45 * w, d));
    if (tread) ao = 1.0 - 0.3 * smoothstep(w - 0.35, w, d);
    if (under) ao = 0.6;
    ao *= 1.0 - 0.16 * edge * (casing ? 0.3 : 1.0);
    ao *= 1.0 - 0.35 * joint;
    ao *= 1.0 - 0.35 * rec;

    // ---- Light ----
    vec3 upEC = normalize(czm_viewRotation * u_axisZ);
    vec3 xEC = normalize(czm_viewRotation * u_axisX);
    vec3 yEC = normalize(czm_viewRotation * u_axisY);
    vec3 outEC = face < 0.5 ? xEC : (face < 1.5 ? yEC : (face < 2.5 ? -xEC : -yEC));
    vec3 L = normalize(czm_lightDirectionEC);
    vec3 n = normalize(materialInput.normalEC);
    // Weathered block faces are rounded and lean back (~25°), not sheer.
    vec3 outLit = normalize(outEC + upEC * 0.47);
    if (riser) n = normalize(n + upEC * 0.47);
    vec3 lit = col * gz_light(n, L, upEC, ao);

    // From afar a course is smaller than a pixel: shade what a camera would
    // average, risers and treads weighted by how much of each is in view.
    if (stepped && macro > 0.0) {
      vec3 V = normalize(materialInput.positionToEyeEC);
      float wR = max(dot(outEC, V), 0.0);
      float wT = max(dot(upEC, V), 0.0) * u_slope.y / u_slope.x;
      float sum = max(wR + wT, 1.0e-3);
      vec3 avgLight = (wR * gz_light(outLit, L, upEC, 0.86) + wT * gz_light(upEC, L, upEC, 0.9)) / sum;
      vec3 avgCol = mix(stone, dustCol, 0.42 * wT / sum);
      avgCol = mix(vec3(dot(avgCol, vec3(0.299, 0.587, 0.114))), avgCol, 0.85);
      avgCol = mix(avgCol, recCol, rec * 0.85);
      lit = mix(lit, avgCol * avgLight * (1.0 - 0.3 * rec), macro);
    }

    m.diffuse = czm_gammaCorrect(lit * u_brightness);
    m.alpha = 1.0;
    return m;
  }
`;

// Primitive's own position handling (RTE, model matrix) needs these exact
// declarations; the extra `info` attribute carries the course data.
const PYRAMID_VS = /* glsl */ `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec2 st;
in vec4 info;
in float batchId;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec2 v_st;
out vec4 v_info;

void main()
{
    vec4 p = czm_computePosition();
    v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
    v_normalEC = czm_normal * normal;
    v_st = st;
    v_info = info;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

const PYRAMID_FS = /* glsl */ `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
in vec4 v_info;

void main()
{
    czm_materialInput materialInput;
    materialInput.normalEC = normalize(v_normalEC);
    materialInput.positionToEyeEC = -v_positionEC;
    materialInput.st = v_st;
    // course index, kind + 8·face, distance within course/tread, course height/tread depth
    materialInput.str = v_info.xyz;
    materialInput.s = v_info.w;
    czm_material material = czm_getMaterial(materialInput);
    out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
}
`;

const APRON_GLSL = /* glsl */ `
  czm_material czm_getMaterial(czm_materialInput materialInput) {
    czm_material m = czm_getDefaultMaterial(materialInput);
    vec2 p = materialInput.st;                  // metres east/north of the centre
    vec2 q = abs(p) - u_half;
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);   // distance out from the base

    float dist = length(materialInput.positionToEyeEC);
    float fFine = 1.0 - smoothstep(90.0, 170.0, dist);
    float fMid = 1.0 - smoothstep(350.0, 800.0, dist);
    float px = max(max(fwidth(p.x), fwidth(p.y)), 1.0e-4);

    float big = gz_fbm(p * 0.045 + u_seed);
    float n1 = gz_fbm(p * 0.6 + u_seed * 1.7);
    vec3 col = mix(u_sandA.rgb, u_sandB.rgb, big);
    col *= 1.0 + (n1 - 0.5) * 0.16 * fMid;
    float rip = sin(dot(p, vec2(0.8, 0.6)) * 8.0 + n1 * 7.0) * 0.5 + 0.5;
    col *= 1.0 + (rip - 0.5) * 0.06 * fFine;

    // Worn limestone pavement along the foot, half buried in sand.
    if (u_pave > 0.0) {
      float band = 1.0 - smoothstep(u_pave - 1.5, u_pave + 1.5, sd + (n1 - 0.5) * 4.0);
      float bare = smoothstep(0.38, 0.62, gz_fbm(p * 0.12 + 4.0));
      vec2 g = p / vec2(1.7, 1.15);
      g.x += floor(g.y) * 0.5;
      vec2 gi = floor(g);
      vec2 gf = fract(g);
      float jd = min(min(gf.x, 1.0 - gf.x) * 1.7, min(gf.y, 1.0 - gf.y) * 1.15);
      float jm = (1.0 - smoothstep(0.03 - px * 0.5, 0.03 + px * 0.5, jd)) * clamp(0.03 / px, 0.0, 1.0) * fMid;
      vec3 slab = mix(u_stoneA.rgb, u_stoneB.rgb, gz_hash(gi + u_seed)) * (1.02 + (n1 - 0.5) * 0.2);
      slab = mix(slab, u_joint.rgb, jm * 0.7);
      col = mix(col, slab, band * bare);
    }

    // Chips and fallen stones, denser near the base, each with a contact shadow.
    float shade = 0.0;
    if (fMid > 0.0) {
      float dens = mix(0.45, 0.06, smoothstep(0.0, u_clip + u_reach, sd));
      vec2 cp = p / 1.25;
      vec2 ci = floor(cp);
      vec2 cf = fract(cp);
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 o = vec2(float(i), float(j));
          vec2 id = ci + o;
          if (gz_hash(id + u_seed * 0.37) > dens) continue;
          vec2 c = (o + vec2(gz_hash(id + 1.7), gz_hash(id + 4.3)) - cf) * 1.25;
          float r = mix(0.06, 0.3, gz_hash(id + 8.9));
          float dm = length(c * vec2(1.0, 1.0 + 0.5 * gz_hash(id + 2.2)));
          float rock = (1.0 - smoothstep(r - px, r + px, dm)) * fMid;
          shade = max(shade, (1.0 - smoothstep(r, r * 1.9, dm)) * (1.0 - rock) * fMid);
          vec3 rc = mix(u_stoneA.rgb, u_stoneB.rgb, gz_hash(id + 6.1)) * (0.85 + 0.25 * gz_hash(id + 3.9));
          col = mix(col, rc, rock);
        }
      }
    }

    vec3 up = normalize(materialInput.normalEC);
    vec3 L = normalize(czm_lightDirectionEC);
    float ao = (1.0 - 0.3 * shade) * (1.0 - 0.18 * (1.0 - smoothstep(-1.0, 2.5, sd)));
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.8);
    m.diffuse = czm_gammaCorrect(col * gz_light(up, L, up, ao) * 0.85 * u_brightness);

    // Opaque over the clipped hole, then a ragged fade into the tiles.
    float sq = max(q.x, q.y);
    float fade = u_clip + 1.0;
    // Opaque cut-out with a ragged, dithered edge (soft translucency rendered black
    // through order-independent translucency on some views).
    float a = 1.0 - smoothstep(fade, fade + (u_reach - 1.0) * (0.55 + 0.45 * big), sq);
    if (a < gz_hash(floor(gl_FragCoord.xy)) * 0.9 + 0.05) discard;
    m.alpha = 1.0;
    return m;
  }
`;

function pyramidAppearance(spec, matrix) {
  const col = spec.colors;
  const marks = (spec.marks || []).slice(0, 2);
  const mark = (mk) => (mk ? new C.Cartesian4(mk.along[0], mk.along[1], mk.z[0], mk.z[1]) : new C.Cartesian4(0, 0, 0, 0));
  const material = new C.Material({
    translucent: false,
    fabric: {
      uniforms: {
        u_axisX: axis(matrix, 0),
        u_axisY: axis(matrix, 1),
        u_axisZ: axis(matrix, 2),
        u_slope: new C.Cartesian2(Math.sin(spec.slope * D2R), Math.cos(spec.slope * D2R)),
        u_stoneA: color(col.stone[0]),
        u_stoneB: color(col.stone[1]),
        u_dust: color(col.dust),
        u_joint: color(col.joint),
        u_casingColor: color(col.casing),
        u_graniteColor: color(col.granite),
        u_granite: spec.granite || 0,
        u_blockLength: spec.blockLength,
        u_markA: mark(marks[0]),
        u_markB: mark(marks[1]),
        u_markFaces: new C.Cartesian2(marks[0] ? FACES[marks[0].face] : -1, marks[1] ? FACES[marks[1].face] : -1),
        u_brightness: 1,
      },
      source: COMMON_GLSL + PYRAMID_GLSL,
    },
  });
  return new C.MaterialAppearance({
    material,
    flat: true,
    translucent: false,
    closed: true,
    faceForward: false,
    materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED,
    vertexShaderSource: PYRAMID_VS,
    fragmentShaderSource: PYRAMID_FS,
  });
}

// Ground cover over the clipped hole, fading out into the scanned ground.
function apronPrimitive(spec, matrix) {
  const hx = spec.base[0] / 2 + spec.clipMargin + spec.apron;
  const hy = spec.base[1] / 2 + spec.clipMargin + spec.apron;
  const z = APRON_LIFT;
  const positions = new Float64Array([-hx, -hy, z, hx, -hy, z, hx, hy, z, -hx, hy, z]);
  const geometry = new C.Geometry({
    attributes: {
      position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
      normal: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) }),
      st: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array([-hx, -hy, hx, -hy, hx, hy, -hx, hy]) }),
    },
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    primitiveType: C.PrimitiveType.TRIANGLES,
    boundingSphere: C.BoundingSphere.fromVertices(positions),
  });
  const col = spec.colors;
  const material = new C.Material({
    translucent: false,
    fabric: {
      uniforms: {
        u_half: new C.Cartesian2(spec.base[0] / 2, spec.base[1] / 2),
        u_clip: spec.clipMargin,
        u_reach: spec.apron,
        u_pave: spec.pavement || 0,
        u_seed: (spec.seed % 97) * 1.37,
        u_sandA: color(col.sand[0]),
        u_sandB: color(col.sand[1]),
        u_stoneA: color(col.stone[0]),
        u_stoneB: color(col.stone[1]),
        u_joint: color(col.joint),
        u_brightness: 1,
      },
      source: COMMON_GLSL + APRON_GLSL,
    },
  });
  return new C.Primitive({
    geometryInstances: new C.GeometryInstance({ geometry, modelMatrix: matrix }),
    appearance: new C.MaterialAppearance({
      material,
      flat: true,
      translucent: false,
      closed: false,
      faceForward: false,
      materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED,
    }),
    asynchronous: false,
    compressVertices: false,
  });
}
