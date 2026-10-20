// Surface realism on top of Google's photogrammetry.
//
// The scanned texture is soft up close: sand reads as flat paint and grass as
// a smeared green. A custom shader on the tileset classifies each pixel by
// colour and adds real-scale detail that fades with distance — wind streaks
// and grain on sand, clumps on grass — and lays fresh snow on mountains by
// altitude and slope, lit by the sun.
//
// Detail coordinates are metres relative to the destination, rebuilt from eye
// space every frame so they stay precise (world coordinates in a shader are
// 32-bit and would shimmer).

const C = window.Cesium;

export class SurfaceDetail {
  constructor(tileset, { detail = true } = {}) {
    this.tileset = tileset;
    this.detailEnabled = detail;   // off on phones: the noise is costly per pixel
    this.origin = new C.Cartesian3();
    this.offset = new C.Cartesian3();
    this.shader = new C.CustomShader({
      lightingModel: C.LightingModel.UNLIT,
      uniforms: {
        u_camOffset: { type: C.UniformType.VEC3, value: new C.Cartesian3() },
        u_up: { type: C.UniformType.VEC3, value: new C.Cartesian3(0, 0, 1) },
        u_datumH: { type: C.UniformType.FLOAT, value: 0 },
        u_detail: { type: C.UniformType.FLOAT, value: 0 },
        u_snow: { type: C.UniformType.FLOAT, value: 0 },
        u_snowLine: { type: C.UniformType.FLOAT, value: 3000 },
      },
      fragmentShaderText: /* glsl */ `
        float wr_hash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float wr_noise(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(wr_hash(i), wr_hash(i + vec3(1, 0, 0)), f.x),
                mix(wr_hash(i + vec3(0, 1, 0)), wr_hash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(wr_hash(i + vec3(0, 0, 1)), wr_hash(i + vec3(1, 0, 1)), f.x),
                mix(wr_hash(i + vec3(0, 1, 1)), wr_hash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
        }
        float wr_fbm(vec3 p) {
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) { s += a * wr_noise(p); p = p * 2.07 + 13.1; a *= 0.5; }
          return s;
        }

        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
          if (u_detail <= 0.001 && u_snow <= 0.001) return;
          vec3 posEC = fsInput.attributes.positionEC;
          float dist = length(posEC);
          vec3 local = czm_inverseViewRotation * posEC + u_camOffset;
          float height = u_datumH + dot(local, u_up);

          // Facet normal from screen-space derivatives (the scan has no normals).
          vec3 nEC = normalize(cross(dFdx(posEC), dFdy(posEC)));
          if (dot(nEC, posEC) > 0.0) nEC = -nEC;
          vec3 nWC = czm_inverseViewRotation * nEC;
          float flatness = clamp(dot(nWC, u_up), 0.0, 1.0);

          vec3 c = material.diffuse;
          vec3 s = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));    // classify in display space
          float luma = dot(s, vec3(0.2126, 0.7152, 0.0722));

          if (u_detail > 0.001 && dist < 900.0) {
            float near = u_detail * (1.0 - smoothstep(250.0, 900.0, dist));

            // --- sand: warm, low-saturation, bright, not greener than red ---
            float sand = smoothstep(0.06, 0.16, s.r - s.b) * smoothstep(0.32, 0.5, luma)
                       * (1.0 - smoothstep(0.0, 0.05, s.g - s.r)) * smoothstep(0.55, 0.85, flatness);
            if (sand > 0.01) {
              // Drifts and wind streaks (stretched along one axis), patches, grain.
              float streak = wr_fbm(local * vec3(0.06, 0.6, 0.25));
              float patches = wr_fbm(local * 0.035);
              float grain = wr_noise(local * 3.1) * (1.0 - smoothstep(20.0, 90.0, dist));
              float ripples = sin(dot(local, vec3(2.1, 0.7, 0.0)) + 3.0 * wr_noise(local * 0.6)) * (1.0 - smoothstep(10.0, 45.0, dist));
              float gravel = smoothstep(0.55, 0.75, wr_fbm(local * 0.12));
              float shade = 0.86 + 0.2 * streak + 0.14 * (patches - 0.5) + 0.1 * (grain - 0.5) + 0.04 * ripples - 0.1 * gravel;
              // Pull the flat yellow toward real sand: paler, less saturated, slight grey.
              vec3 g = vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)));
              vec3 real = mix(c, g * vec3(1.18, 1.0, 0.8), 0.32) * shade;
              c = mix(c, real, sand * near);
            }

            // --- grass / vegetation: green-dominant ---
            float grass = smoothstep(0.012, 0.06, s.g - max(s.r, s.b)) * smoothstep(0.35, 0.75, flatness);
            if (grass > 0.01) {
              float clumps = wr_fbm(local * 0.9);
              float tufts = wr_noise(local * 4.3) * (1.0 - smoothstep(15.0, 70.0, dist));
              float mow = wr_fbm(local * vec3(0.05, 0.4, 0.05));
              float shade = 0.78 + 0.32 * clumps + 0.14 * (tufts - 0.5) + 0.08 * (mow - 0.5);
              vec3 tint = mix(vec3(0.95, 1.05, 0.85), vec3(1.08, 1.0, 0.75), wr_noise(local * 0.12));
              c = mix(c, c * shade * tint, grass * near);
            }
          }

          // --- snow on mountains ---
          if (u_snow > 0.001) {
            float drift = wr_fbm(local * 0.008) - 0.5;
            float aboveLine = smoothstep(u_snowLine - 300.0, u_snowLine + 400.0, height + drift * 300.0);
            // Snow holds on anything that isn't a cliff. Noise breaks the edges so
            // they follow the terrain rather than the scan's triangles.
            float fine = wr_fbm(local * 0.06) - 0.5;
            float hold = smoothstep(0.05, 0.72, flatness + drift * 0.4 + fine * 0.35);
            float amount = aboveLine * hold * u_snow;
            if (amount > 0.001) {
              // Light the snow from the photo itself: it already knows which slopes
              // are in sun and which are in shadow (mesh facets would show triangles).
              float lightImg = smoothstep(0.05, 0.55, luma);
              vec3 snow = mix(vec3(0.48, 0.58, 0.79), vec3(1.0, 0.985, 0.95), lightImg);
              snow *= 0.9 + 0.1 * wr_noise(local * 0.2);
              c = mix(c, snow, clamp(amount * 0.9, 0.0, 0.9));
            }
          }

          material.diffuse = c;
        }
      `,
    });
    tileset.customShader = this.shader;
  }

  // Called when a destination is chosen.
  setPlace(place, datumHeight) {
    if (!place) {
      this.shader.setUniform('u_snow', 0);
      this.place = null;
      return;
    }
    this.place = place;
    C.Cartesian3.fromDegrees(place.datum.lon, place.datum.lat, datumHeight, C.Ellipsoid.WGS84, this.origin);
    const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(this.origin, new C.Cartesian3());
    this.shader.setUniform('u_up', up);
    this.shader.setUniform('u_datumH', datumHeight);
    this.shader.setUniform('u_snow', place.snowLine ? 1 : 0);
    this.shader.setUniform('u_snowLine', place.snowLine || 3000);
  }

  // Every frame, after the camera has moved.
  update(camera, altitude) {
    if (!this.place) {
      this.shader.setUniform('u_detail', 0);
      return;
    }
    C.Cartesian3.subtract(camera.positionWC, this.origin, this.offset);
    this.shader.setUniform('u_camOffset', this.offset);
    const d = 1 - Math.min(1, Math.max(0, (altitude - 3000) / 12000));
    this.shader.setUniform('u_detail', this.detailEnabled ? d : 0);
  }
}
