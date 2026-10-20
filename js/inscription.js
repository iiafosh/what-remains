// Writes the message onto the monument itself.
//
// After landing we look at the real 3D surface through the depth buffer: a grid
// of picks around the anchor gives points on the wall/face/slope, a plane is
// fitted through them, and a textured quad is laid on that plane. The message
// is then "written" by a shader sweep, line by line, in the language's own
// direction (right-to-left for Arabic).

const C = window.Cesium;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// ---------------------------------------------------------------------------
// Text → canvas
// ---------------------------------------------------------------------------
export async function renderMessage(place) {
  const { family, weight, style, scale } = place.font;
  const text = place.lines.join(' ');
  try {
    await document.fonts.load(`${style} ${weight} 120px "${family}"`, text);
  } catch { /* fall back to whatever is available */ }

  const W = 2048;
  const padX = 120;
  const probe = document.createElement('canvas').getContext('2d');
  let px = 230 * scale;
  const fontFor = (size) => `${style} ${weight} ${size}px "${family}", "Noto Sans Arabic", "Noto Sans JP", serif`;
  for (let i = 0; i < 40; i++) {
    probe.font = fontFor(px);
    const widest = Math.max(...place.lines.map((l) => probe.measureText(l).width));
    if (widest <= W - padX * 2) break;
    px *= 0.94;
  }
  const lineH = px * 1.3;
  const marginY = px * 0.55;
  const H = Math.ceil(lineH * place.lines.length + marginY * 2);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.font = fontFor(px);
  ctx.direction = place.dir;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const ys = place.lines.map((_, i) => marginY + lineH * (i + 0.5));

  // 1. Soft light spill around the letters.
  ctx.save();
  ctx.shadowColor = place.ink.glow;
  ctx.shadowBlur = px * 0.45;
  ctx.fillStyle = withAlpha(place.ink.glow, 0.55);
  place.lines.forEach((l, i) => ctx.fillText(l, W / 2, ys[i]));
  ctx.shadowBlur = px * 0.18;
  place.lines.forEach((l, i) => ctx.fillText(l, W / 2, ys[i]));
  ctx.restore();

  // 2. Dark edge so it reads on bright stone or snow.
  ctx.save();
  ctx.strokeStyle = place.ink.edge;
  ctx.lineWidth = px * 0.075;
  place.lines.forEach((l, i) => ctx.strokeText(l, W / 2, ys[i]));
  ctx.restore();

  // 3. The letters.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, place.ink.fill);
  grad.addColorStop(1, mixHex(place.ink.fill, place.ink.glow, 0.28));
  ctx.fillStyle = grad;
  place.lines.forEach((l, i) => ctx.fillText(l, W / 2, ys[i]));

  return {
    canvas,
    aspect: W / H,
    lines: place.lines.length,
    marginT: marginY / H,
    bandH: (lineH * place.lines.length) / H,
  };
}

function withAlpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
}

// ---------------------------------------------------------------------------
// Surface fitting + the quad on the monument
// ---------------------------------------------------------------------------
export class Inscription {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.primitive = null;
    this.material = null;
    this.frame = null;     // { center, normal }
    this.progress = 0;
    this.visible = 0;
    this.writing = null;
  }

  clear() {
    if (this.primitive) this.scene.primitives.remove(this.primitive);
    this.primitive = null;
    this.material = null;
    this.frame = null;
    this.writing = null;
    this.progress = 0;
  }

  nextFrame() {
    return new Promise((resolve) => {
      const remove = this.scene.postRender.addEventListener(() => { remove(); resolve(); });
    });
  }

  // Must be called right after a render with the camera held still.
  fitSurface(place, datumHeight) {
    const scene = this.scene;
    const camera = scene.camera;
    const anchor = C.Cartesian3.fromDegrees(place.anchor.lon, place.anchor.lat, datumHeight + place.anchor.h);
    const camPos = C.Cartesian3.clone(camera.positionWC);
    const R = C.Cartesian3.clone(camera.rightWC);
    const U = C.Cartesian3.clone(camera.upWC);
    const D = C.Cartesian3.clone(camera.directionWC);

    const sp = C.SceneTransforms.worldToWindowCoordinates(scene, anchor);
    const canvas = scene.canvas;
    const cx = sp ? sp.x : canvas.clientWidth / 2;
    const cy = sp ? sp.y : canvas.clientHeight / 2;

    // How many pixels the message will span, to size the sampling grid.
    const dist = C.Cartesian3.distance(camPos, anchor);
    const fov = camera.frustum.fov;
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const fovx = aspect >= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const pxPerM = canvas.clientWidth / (2 * dist * Math.tan(fovx / 2));
    const halfW = Math.max(30, Math.min(canvas.clientWidth * 0.4, place.width * 0.5 * pxPerM * 0.75));
    const halfH = Math.max(18, halfW * 0.32);

    const pts = [];
    const nx = 11, ny = 7;
    const scratch = new C.Cartesian3();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = cx + (i / (nx - 1) * 2 - 1) * halfW;
        const y = cy + (j / (ny - 1) * 2 - 1) * halfH;
        if (x < 1 || y < 1 || x > canvas.clientWidth - 1 || y > canvas.clientHeight - 1) continue;
        let p;
        try { p = scene.pickPosition(new C.Cartesian2(x, y), scratch); } catch { p = undefined; }
        if (!p) continue;
        const d = C.Cartesian3.subtract(p, camPos, new C.Cartesian3());
        const w = C.Cartesian3.dot(d, D);
        if (!(w > 1) || w > dist * 3) continue;
        pts.push({ u: C.Cartesian3.dot(d, R), v: C.Cartesian3.dot(d, U), w });
      }
    }

    // Fit depth w = a·u + b·v + c in camera space, then drop outliers and refit.
    let fit = pts.length >= 8 ? fitPlane(pts) : null;
    if (fit) {
      for (let pass = 0; pass < 2; pass++) {
        const res = pts.map((p) => Math.abs(p.w - (fit.a * p.u + fit.b * p.v + fit.c)));
        const sorted = [...res].sort((x, y) => x - y);
        const med = sorted[Math.floor(sorted.length / 2)];
        const keep = pts.filter((_, k) => res[k] <= Math.max(med * 2.5, dist * 0.004));
        if (keep.length < 8) break;
        fit = fitPlane(keep) || fit;
      }
    }

    // Normal toward the camera.
    let normal;
    if (fit) {
      normal = new C.Cartesian3();
      C.Cartesian3.add(C.Cartesian3.multiplyByScalar(R, fit.a, new C.Cartesian3()),
        C.Cartesian3.multiplyByScalar(U, fit.b, new C.Cartesian3()), normal);
      C.Cartesian3.subtract(normal, D, normal);
      C.Cartesian3.normalize(normal, normal);
    } else {
      normal = C.Cartesian3.negate(D, new C.Cartesian3());
    }
    // Rough natural surfaces (a mountain face) read better when the text leans
    // partly toward the viewer, the way a projector would be aimed.
    if (place.facing) {
      C.Cartesian3.lerp(normal, C.Cartesian3.negate(D, new C.Cartesian3()), place.facing, normal);
      C.Cartesian3.normalize(normal, normal);
    }
    // Avoid grazing angles that would smear the text.
    const facing = -C.Cartesian3.dot(normal, D);
    if (facing < 0.3) {
      const t = (0.3 - facing) / 0.3;
      C.Cartesian3.lerp(normal, C.Cartesian3.negate(D, new C.Cartesian3()), clamp01(t), normal);
      C.Cartesian3.normalize(normal, normal);
    }

    // Centre: where the ray through the anchor's pixel meets the plane.
    const ray = camera.getPickRay(new C.Cartesian2(cx, cy));
    let center;
    if (fit) {
      const du = C.Cartesian3.dot(ray.direction, R), dv = C.Cartesian3.dot(ray.direction, U), dw = C.Cartesian3.dot(ray.direction, D);
      const t = fit.c / (dw - fit.a * du - fit.b * dv);
      center = (t > 0 && t < dist * 4)
        ? C.Cartesian3.add(camPos, C.Cartesian3.multiplyByScalar(ray.direction, t, new C.Cartesian3()), new C.Cartesian3())
        : anchor;
    } else {
      center = anchor;
    }

    return { center, normal, samples: pts.length, ok: !!fit };
  }

  build(place, msg, frame) {
    this.clear();
    const { center, normal } = frame;
    const camera = this.scene.camera;
    const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(center, new C.Cartesian3());

    // In-plane axes: right is horizontal; up climbs the surface.
    let right = C.Cartesian3.cross(up, normal, new C.Cartesian3());
    if (C.Cartesian3.magnitude(right) < 0.15) {
      // Nearly flat surface: use the camera's right, projected onto the plane.
      right = C.Cartesian3.clone(camera.rightWC);
      const k = C.Cartesian3.dot(right, normal);
      C.Cartesian3.subtract(right, C.Cartesian3.multiplyByScalar(normal, k, new C.Cartesian3()), right);
    }
    C.Cartesian3.normalize(right, right);
    if (C.Cartesian3.dot(right, camera.rightWC) < 0) C.Cartesian3.negate(right, right);
    const textUp = C.Cartesian3.normalize(C.Cartesian3.cross(normal, right, new C.Cartesian3()), new C.Cartesian3());

    const w = place.width;
    const h = w / msg.aspect;
    const corner = (sx, sy) => {
      const p = C.Cartesian3.clone(center);
      C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(right, sx * w / 2, new C.Cartesian3()), p);
      C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(textUp, sy * h / 2, new C.Cartesian3()), p);
      return p;
    };
    const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const positions = new Float64Array(12);
    corners.forEach((c, i) => { positions[i * 3] = c.x; positions[i * 3 + 1] = c.y; positions[i * 3 + 2] = c.z; });
    const normals = new Float32Array([0, 1, 2, 3].flatMap(() => [normal.x, normal.y, normal.z]));

    const geometry = new C.Geometry({
      attributes: {
        position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
        normal: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: normals }),
        st: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) }),
      },
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      primitiveType: C.PrimitiveType.TRIANGLES,
      boundingSphere: C.BoundingSphere.fromVertices(positions),
    });

    const glow = C.Color.fromCssColorString(place.ink.glow);
    this.material = new C.Material({
      translucent: true,
      fabric: {
        uniforms: {
          image: msg.canvas,
          progress: 0,
          rtl: place.dir === 'rtl' ? 1 : 0,
          lines: msg.lines,
          marginT: msg.marginT,
          bandH: msg.bandH,
          glowColor: glow,
          opacity: 1,
          time: 0,
        },
        source: /* glsl */ `
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material m = czm_getDefaultMaterial(materialInput);
            vec2 st = materialInput.st;
            vec4 tex = texture(image, st);

            // Which line is this pixel on? (line 0 is the top one)
            float yFromTop = 1.0 - st.y;
            float band = clamp((yFromTop - marginT) / bandH, 0.0, 0.9999);
            float lineIdx = floor(band * lines);
            float local = clamp(progress * lines - lineIdx, 0.0, 1.0);

            float x = rtl > 0.5 ? 1.0 - st.x : st.x;
            float front = mix(0.04, 1.02, local);
            float written = 1.0 - smoothstep(front - 0.035, front + 0.005, x);
            float tip = exp(-pow((x - front) * 30.0, 2.0)) * step(0.001, local) * step(local, 0.999);

            float shimmer = 0.93 + 0.07 * sin(time * 1.3 + st.x * 7.0 + st.y * 3.0);
            vec3 col = tex.rgb * shimmer;
            col += glowColor.rgb * tip * 1.4;
            col += vec3(1.0) * tip * tex.a * 0.6;

            float a = tex.a * written + tip * smoothstep(0.02, 0.4, tex.a) * 0.9;
            m.diffuse = col;
            m.alpha = clamp(a, 0.0, 1.0) * opacity;
            return m;
          }
        `,
      },
    });

    this.primitive = this.scene.primitives.add(new C.Primitive({
      geometryInstances: new C.GeometryInstance({ geometry }),
      appearance: new C.MaterialAppearance({
        material: this.material,
        flat: true,
        translucent: true,
        closed: false,
        faceForward: true,
        renderState: {
          depthTest: { enabled: false },
          depthMask: false,
          cull: { enabled: false },
          blending: C.BlendingState.ALPHA_BLEND,
        },
      }),
      asynchronous: false,
    }));
    this.frame = { center, normal };
  }

  write(duration) {
    this.writing = { t: 0, duration };
    this.progress = 0;
  }

  showAll() {
    this.writing = null;
    this.progress = 1;
  }

  update(dt, time) {
    if (!this.material) return;
    if (this.writing) {
      this.writing.t += dt;
      this.progress = clamp01(this.writing.t / this.writing.duration);
      if (this.progress >= 1) this.writing = null;
    }
    // Fade out when looking at the face edge-on or from behind.
    const cam = this.scene.camera.positionWC;
    const toCam = C.Cartesian3.normalize(C.Cartesian3.subtract(cam, this.frame.center, new C.Cartesian3()), new C.Cartesian3());
    const facing = C.Cartesian3.dot(toCam, this.frame.normal);
    const target = clamp01((facing - 0.08) / 0.25);
    this.visible += (target - this.visible) * Math.min(1, dt * 4);
    const u = this.material.uniforms;
    u.progress = this.progress;
    u.time = time;
    u.opacity = this.visible;
  }
}

function fitPlane(pts) {
  // Least squares for w = a·u + b·v + c
  let su = 0, sv = 0, sw = 0, suu = 0, svv = 0, suv = 0, suw = 0, svw = 0;
  const n = pts.length;
  for (const p of pts) {
    su += p.u; sv += p.v; sw += p.w;
    suu += p.u * p.u; svv += p.v * p.v; suv += p.u * p.v;
    suw += p.u * p.w; svw += p.v * p.w;
  }
  const M = [[suu, suv, su], [suv, svv, sv], [su, sv, n]];
  const rhs = [suw, svw, sw];
  const det = det3(M);
  if (Math.abs(det) < 1e-9) return null;
  const solve = (col) => {
    const m = M.map((row, r) => row.map((v, c) => (c === col ? rhs[r] : v)));
    return det3(m) / det;
  };
  return { a: solve(0), b: solve(1), c: solve(2) };
}
function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
