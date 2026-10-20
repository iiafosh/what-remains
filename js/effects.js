// Visual atmosphere: clouds seen from orbit, the night side, cloud layers you
// fall through, motion blur, colour grading and screen-space weather.

const C = window.Cesium;

const CLOUD_TEXTURE = 'https://cdn.jsdelivr.net/npm/three-globe@2.45.2/example/clouds/clouds.png';

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);

export class Effects {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.night = 1;          // 0..1 strength of night-side shading
    this.blur = 0;           // 0..1 radial motion blur
    this.gradeAmount = 0;    // 0..1 per-place colour grade
    this.grade = { tint: [1, 1, 1], saturation: 1, contrast: 1, brightness: 1, vignette: 0.3 };
    this.cloudShellOpacity = 1;
    this.layerClouds = null;
    this.veil = document.getElementById('veil');
    this._buildCloudShell();
    this._buildPostStages();
  }

  // ---------- Clouds seen from space: a lit shell 12 km above the surface ----------
  _buildCloudShell() {
    const a = 6378137 + 12000;
    const b = 6356752.3142 + 12000;
    const geometry = new C.EllipsoidGeometry({
      radii: new C.Cartesian3(a, a, b),
      stackPartitions: 96,
      slicePartitions: 128,
      vertexFormat: C.VertexFormat.POSITION_NORMAL_AND_ST,
    });
    this.shellMaterial = new C.Material({
      translucent: true,
      fabric: {
        uniforms: { image: CLOUD_TEXTURE, opacity: 1.0, spin: 0.0 },
        source: /* glsl */ `
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material m = czm_getDefaultMaterial(materialInput);
            vec3 posEC = -materialInput.positionToEyeEC;
            vec3 dirWC = normalize((czm_inverseView * vec4(posEC, 1.0)).xyz);
            float lon = atan(dirWC.y, dirWC.x) - spin;
            float lat = asin(clamp(dirWC.z, -1.0, 1.0));
            vec2 uv = vec2(fract(lon / czm_twoPi + 0.5), lat / czm_pi + 0.5);
            vec4 c = texture(image, uv);
            float sun = dot(dirWC, czm_sunDirectionWC);
            float lit = smoothstep(-0.18, 0.25, sun);
            // A little warmth along the terminator, like real dawn light on cloud tops.
            vec3 dawn = vec3(1.0, 0.72, 0.5) * (1.0 - smoothstep(0.0, 0.35, abs(sun - 0.02))) * 0.35;
            m.diffuse = (vec3(0.97, 0.98, 1.0) * (0.06 + 0.94 * lit) + dawn * lit);
            m.alpha = c.a * opacity * (0.55 + 0.45 * lit) * 0.92;
            return m;
          }
        `,
      },
    });
    this.cloudShell = this.scene.primitives.add(new C.Primitive({
      geometryInstances: new C.GeometryInstance({ geometry }),
      appearance: new C.MaterialAppearance({
        material: this.shellMaterial,
        flat: true,
        translucent: true,
        closed: true,
        faceForward: false,
        renderState: { depthMask: false, cull: { enabled: true, face: C.CullFace.BACK } },
      }),
      asynchronous: true,
    }));
  }

  // ---------- Post-processing ----------
  _buildPostStages() {
    const stages = this.scene.postProcessStages;
    stages.fxaa.enabled = true;

    // Night side: darken whatever is turned away from the sun.
    this.nightStage = stages.add(new C.PostProcessStage({
      name: 'wr_night',
      fragmentShader: /* glsl */ `
        uniform sampler2D colorTexture;
        uniform sampler2D depthTexture;
        uniform float strength;
        in vec2 v_textureCoordinates;
        void main() {
          vec4 color = texture(colorTexture, v_textureCoordinates);
          float logDepth = texture(depthTexture, v_textureCoordinates).r;
          if (strength <= 0.001 || logDepth >= 1.0) { out_FragColor = color; return; }
          vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord.xy, logDepth);
          eye /= eye.w;
          vec3 world = (czm_inverseView * vec4(eye.xyz, 1.0)).xyz;
          vec3 n = normalize(world);
          float l = dot(n, czm_sunDirectionWC);
          float day = smoothstep(-0.10, 0.22, l);
          vec3 night = color.rgb * vec3(0.03, 0.045, 0.09);
          vec3 lit = mix(night, color.rgb, day);
          // Warm the band right at the terminator.
          lit *= mix(vec3(1.0), vec3(1.12, 0.92, 0.8), (1.0 - smoothstep(0.0, 0.3, abs(l - 0.05))) * day);
          out_FragColor = vec4(mix(color.rgb, lit, strength), color.a);
        }
      `,
      uniforms: { strength: () => this.night },
    }));

    // Radial blur: speed lines toward the centre during the dive.
    this.blurStage = stages.add(new C.PostProcessStage({
      name: 'wr_blur',
      fragmentShader: /* glsl */ `
        uniform sampler2D colorTexture;
        uniform float amount;
        in vec2 v_textureCoordinates;
        void main() {
          vec2 uv = v_textureCoordinates;
          if (amount <= 0.002) { out_FragColor = texture(colorTexture, uv); return; }
          vec2 dir = uv - vec2(0.5);
          float falloff = smoothstep(0.05, 0.6, length(dir));
          vec4 sum = vec4(0.0);
          for (int i = 0; i < 14; i++) {
            float t = float(i) / 13.0;
            sum += texture(colorTexture, uv - dir * amount * falloff * t * 0.22);
          }
          out_FragColor = sum / 14.0;
        }
      `,
      uniforms: { amount: () => this.blur },
    }));

    // Colour grade + vignette for each place's mood.
    this.gradeStage = stages.add(new C.PostProcessStage({
      name: 'wr_grade',
      fragmentShader: /* glsl */ `
        uniform sampler2D colorTexture;
        uniform float amount;
        uniform vec3 tint;
        uniform float saturation;
        uniform float contrast;
        uniform float brightness;
        uniform float vignette;
        in vec2 v_textureCoordinates;
        void main() {
          vec4 c = texture(colorTexture, v_textureCoordinates);
          vec3 g = c.rgb * tint * brightness;
          float luma = dot(g, vec3(0.2126, 0.7152, 0.0722));
          g = mix(vec3(luma), g, saturation);
          g = (g - 0.5) * contrast + 0.5;
          vec2 d = v_textureCoordinates - 0.5;
          float v = 1.0 - vignette * smoothstep(0.25, 0.85, length(d * vec2(1.15, 1.0)));
          g *= v;
          out_FragColor = vec4(mix(c.rgb, clamp(g, 0.0, 1.0), amount), c.a);
        }
      `,
      uniforms: {
        amount: () => this.gradeAmount,
        tint: () => new C.Cartesian3(...this.grade.tint),
        saturation: () => this.grade.saturation,
        contrast: () => this.grade.contrast,
        brightness: () => this.grade.brightness,
        vignette: () => this.grade.vignette,
      },
    }));
  }

  setGrade(grade) {
    this.grade = { ...this.grade, ...grade };
  }

  // ---------- Volumetric-looking cloud layers around a destination ----------
  // `punch` are world positions on the dive path where a cloud is guaranteed,
  // so the camera really goes through one.
  // Layers above the destination are the ones we fall through; layers below
  // (base <= 0) are a sea of clouds seen from a summit and stay after landing.
  buildLayers(place, datumHeight, punch = [], finalCamera) {
    this.clearLayers();
    const noiseOffset = new C.Cartesian3(rand(0, 50), rand(0, 50), 0);
    const above = new C.CloudCollection({ noiseDetail: 16, noiseOffset });
    const below = new C.CloudCollection({ noiseDetail: 16, noiseOffset });
    const enu = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(place.target.lon, place.target.lat, datumHeight));
    const tmp = new C.Cartesian3();
    const camLocal = finalCamera
      ? C.Matrix4.multiplyByPoint(C.Matrix4.inverseTransformation(enu, new C.Matrix4()), finalCamera, new C.Cartesian3())
      : null;

    for (const layer of place.clouds) {
      let placed = 0;
      let guard = 0;
      while (placed < layer.count && guard++ < layer.count * 8) {
        const r = Math.sqrt(Math.random()) * layer.radius;
        const a = Math.random() * Math.PI * 2;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        const z = rand(layer.base, layer.top);
        // Keep the final view clear: no cloud close to the camera or between it and the target.
        if (camLocal && layer.keepOut) {
          const distToSegment = segDist2D(x, y, camLocal.x, camLocal.y, 0, 0);
          if (distToSegment < layer.keepOut * 0.45 || Math.hypot(x - camLocal.x, y - camLocal.y) < layer.keepOut) continue;
        }
        const pos = C.Matrix4.multiplyByPoint(enu, C.Cartesian3.fromElements(x, y, z, tmp), new C.Cartesian3());
        if (layer.base > 0) addCloud(above, pos, rand(900, 2400));
        else addCloud(below, pos, rand(1800, 3600), rand(0.82, 0.95), 0.32);
        placed++;
      }
    }
    for (const p of punch) addCloud(above, p, rand(1600, 2400), 1.0);
    this.layerClouds = this.scene.primitives.add(above);
    this.deckClouds = this.scene.primitives.add(below);
  }

  // After touchdown the layer we fell through would only look like puffs overhead.
  settleLayers() {
    this._settled = true;
    if (this.layerClouds) this.layerClouds.show = false;
  }

  clearLayers() {
    for (const key of ['layerClouds', 'deckClouds']) {
      if (this[key]) this.scene.primitives.remove(this[key]);
      this[key] = null;
    }
    this._settled = false;
  }

  setLayersVisible(v) {
    if (this.deckClouds) this.deckClouds.show = v;
    if (this.layerClouds) this.layerClouds.show = v && !this._settled;
  }

  // ---------- Per-frame ----------
  update({ altitude, time, veil }) {
    // Orbit-scale clouds fade out as we drop below them.
    const shell = smooth(90e3, 420e3, altitude);
    this.shellMaterial.uniforms.opacity = shell;
    this.shellMaterial.uniforms.spin = time * 0.0009;
    this.cloudShell.show = shell > 0.002;

    this.night = smooth(250e3, 1800e3, altitude);
    this.nightStage.enabled = this.night > 0.002;
    this.blurStage.enabled = this.blur > 0.002;
    this.gradeStage.enabled = this.gradeAmount > 0.002;

    this.veil.style.opacity = veil.toFixed(3);
  }
}

function addCloud(clouds, position, size, brightness, flat = 0.42) {
  clouds.add({
    position,
    scale: new C.Cartesian2(size, size * flat),
    maximumSize: new C.Cartesian3(size * 0.9, size * flat * 0.9, size * 0.48),
    slice: rand(0.32, 0.62),
    brightness: brightness ?? rand(0.88, 1.0),
  });
}

function segDist2D(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// ---------------------------------------------------------------------------
// Screen-space weather: snow, sakura petals, desert dust, floating light motes.
// Drawn on a 2D canvas over the globe, in three depth layers for parallax.
// ---------------------------------------------------------------------------
export class Weather {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'none';
    this.intensity = 0;      // 0..1, eased toward target
    this.targetIntensity = 0;
    this.particles = [];
    this.wind = 0;
    this.lastHeading = null;
    this.sprites = {};
    this._resize();
    addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.particles = [];
    const area = (this.w * this.h) / (1280 * 720) * (matchMedia('(pointer: coarse)').matches ? 0.5 : 1);
    const count = { snow: 420, petals: 70, dust: 140, motes: 60, none: 0 }[mode] ?? 0;
    for (let i = 0; i < Math.round(count * Math.min(1.6, Math.max(0.5, area))); i++) {
      this.particles.push(this._spawn(true));
    }
  }

  _spawn(anywhere) {
    const depth = Math.random() ** 1.6;           // 0 = far, 1 = near
    const p = {
      depth,
      x: Math.random() * this.w,
      y: anywhere ? Math.random() * this.h : -20 - Math.random() * 60,
      phase: Math.random() * Math.PI * 2,
      spin: rand(-2, 2),
      rot: Math.random() * Math.PI * 2,
      tw: Math.random(),
    };
    if (this.mode === 'dust' || this.mode === 'motes') {
      if (!anywhere) { p.x = -20; p.y = Math.random() * this.h; }
    }
    return p;
  }

  update(dt, { heading }) {
    this.intensity += (this.targetIntensity - this.intensity) * Math.min(1, dt * 0.8);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.mode === 'none' || this.intensity < 0.01) return;

    // Camera turning shifts the particles: closer ones move more.
    let dHead = 0;
    if (this.lastHeading !== null) {
      dHead = heading - this.lastHeading;
      if (dHead > Math.PI) dHead -= 2 * Math.PI;
      if (dHead < -Math.PI) dHead += 2 * Math.PI;
    }
    this.lastHeading = heading;
    const t = performance.now() / 1000;
    this.wind = Math.sin(t * 0.21) * 0.6 + Math.sin(t * 0.53 + 1.3) * 0.4;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const d = p.depth;
      const parallax = -dHead * (this.w / 1.05) * (0.3 + d * 0.9);
      switch (this.mode) {
        case 'snow': {
          const fall = 22 + d * 120;
          p.x += (this.wind * (30 + d * 90) + Math.sin(t * 1.3 + p.phase) * (6 + d * 14)) * dt + parallax;
          p.y += fall * dt;
          const r = 0.6 + d * d * 5.5;
          const blur = d > 0.75;
          ctx.globalAlpha = this.intensity * (blur ? 0.35 : 0.85) * (0.4 + d * 0.6);
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          if (blur) {
            const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.8);
            g.addColorStop(0, 'rgba(255,255,255,0.9)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
          } else {
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          }
          ctx.fill();
          break;
        }
        case 'petals': {
          p.rot += p.spin * dt;
          p.x += (this.wind * 40 + 25 + Math.sin(t * 0.9 + p.phase) * 30) * (0.4 + d) * dt + parallax;
          p.y += (26 + d * 60 + Math.sin(t * 2 + p.phase) * 12) * dt;
          const s = 3 + d * 9;
          const flip = Math.cos(t * (1.5 + p.tw) + p.phase);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.scale(1, Math.max(0.15, Math.abs(flip)));
          ctx.globalAlpha = this.intensity * (0.55 + d * 0.4);
          const g = ctx.createLinearGradient(-s, 0, s, 0);
          g.addColorStop(0, '#ffd9e2');
          g.addColorStop(1, flip > 0 ? '#ffb3c6' : '#f59ab3');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(0, -s * 0.55);
          ctx.bezierCurveTo(s * 0.9, -s * 0.6, s, s * 0.3, 0, s * 0.6);
          ctx.bezierCurveTo(-s, s * 0.3, -s * 0.9, -s * 0.6, -s * 0.15, -s * 0.5);
          ctx.lineTo(0, -s * 0.3);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'dust':
        case 'motes': {
          const warm = this.mode === 'dust';
          p.x += ((warm ? 35 : 8) + this.wind * (warm ? 40 : 10)) * (0.3 + d) * dt + parallax;
          p.y += Math.sin(t * 0.7 + p.phase) * (warm ? 8 : 5) * dt + (warm ? 2 : -3) * dt;
          const twinkle = 0.5 + 0.5 * Math.sin(t * (1 + p.tw * 3) + p.phase);
          const r = (warm ? 0.6 : 0.8) + d * d * (warm ? 2.4 : 3.2);
          ctx.globalAlpha = this.intensity * (warm ? 0.55 : 0.45) * (0.25 + twinkle * 0.75) * (0.4 + d * 0.6);
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.2);
          g.addColorStop(0, warm ? 'rgba(255,226,170,1)' : 'rgba(255,250,235,1)');
          g.addColorStop(1, 'rgba(255,220,160,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
      // Recycle particles that leave the screen.
      if (p.y > this.h + 30 || p.x > this.w + 40 || p.x < -60 || p.y < -80) {
        const np = this._spawn(false);
        if (p.x < -60) np.x = this.w + 20;
        if (this.mode === 'snow' || this.mode === 'petals') {
          if (p.x > this.w + 40) { np.x = -30; np.y = Math.random() * this.h; }
        }
        this.particles[i] = np;
      }
    }
    ctx.globalAlpha = 1;
  }
}
