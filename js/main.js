import { CONFIG } from './config.js';
import { PLACES, byId } from './places.js';
import { CameraRig } from './flight.js';
import { Effects, Weather } from './effects.js';
import { SurfaceDetail } from './surface.js';
import { LocalTerrain } from './terrain.js';
import { createGiza } from './giza.js';
import { Inscription, renderMessage } from './inscription.js';
import { SoundScape } from './audio.js';
import { Hud } from './hud.js';
import { setupCredits } from './credits.js';

const C = window.Cesium;
const D2R = Math.PI / 180;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Phones, tablets and modest machines get a lighter profile: coarser 3D tiles,
// a smaller cache, 30 fps, and no close-up surface detail.
const LOW_POWER = matchMedia('(pointer: coarse)').matches
  || Math.min(innerWidth, innerHeight) < 600
  || (navigator.deviceMemory && navigator.deviceMemory <= 4)
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
const QUALITY = LOW_POWER
  ? { landedSSE: CONFIG.landedScreenSpaceError * 2, flightSSE: CONFIG.flightScreenSpaceError * 1.5, cacheMB: 256, overflowMB: 128, fps: 30 }
  : { landedSSE: CONFIG.landedScreenSpaceError, flightSSE: CONFIG.flightScreenSpaceError, cacheMB: 512, overflowMB: 256, fps: 60 };

if (CONFIG.cesiumIonToken) C.Ion.defaultAccessToken = CONFIG.cesiumIonToken;
if (CONFIG.googleMapsApiKey) C.GoogleMaps.defaultApiKey = CONFIG.googleMapsApiKey;

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
const viewer = new C.Viewer('globe', {
  globe: false,                 // Google's 3D tiles are the whole planet
  animation: false,
  timeline: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  baseLayerPicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  scene3DOnly: true,
  shouldAnimate: false,
});
const scene = viewer.scene;
scene.screenSpaceCameraController.enableInputs = false;
scene.screenSpaceCameraController.enableCollisionDetection = false;
scene.skyAtmosphere.show = true;
scene.atmosphere.dynamicLighting = C.DynamicAtmosphereLightingType.SUNLIGHT;
scene.fog.enabled = true;
if (scene.moon) scene.moon.show = false;
scene.backgroundColor = C.Color.fromCssColorString('#020306');
viewer.clock.shouldAnimate = false;
// Without a cap the browser renders at the monitor's rate (120–144 Hz on many screens).
viewer.targetFrameRate = QUALITY.fps;

const rig = new CameraRig(viewer);
const effects = new Effects(viewer);
const weather = new Weather(document.getElementById('weather'));
const inscription = new Inscription(viewer);
const audio = new SoundScape();
let surface = null;
let terrain = null;
let giza = null;     // crafted pyramids replacing Google's soft scan at Giza

let tileset = null;
let streaming = 0;
let streamPeak = 1;

// ---------------------------------------------------------------------------
// HUD wiring
// ---------------------------------------------------------------------------
const hud = new Hud({
  onBegin: begin,
  onSelect: (place) => travel(place),
  onSpace: () => { if (rig.mode !== 'space') rig.returnToSpace(); },
  onZoom: (f) => rig.zoomBy(f),
  onResetView: () => rig.resetView(),
  onToggleSound: () => { audio.setMuted(!audio.muted); return audio.muted; },
  onRewrite: () => rewrite(),
  onNext: () => {
    const i = PLACES.indexOf(rig.place);
    travel(PLACES[(i + 1) % PLACES.length]);
  },
});
hud.setMode('intro');
hud.setBeginReady(false, 'Preparing the planet…');
setupCredits();

function travel(place) {
  if (!place) return;
  if (rig.place === place && rig.mode === 'landed') { rig.resetView(); return; }
  if (rig.place === place && rig.mode === 'flying' && !ascending) return;
  rig.goTo(place);
}

// ---------------------------------------------------------------------------
// 3D tiles (with a flat fallback)
// ---------------------------------------------------------------------------
async function loadWorld() {
  try {
    tileset = await C.createGooglePhotorealistic3DTileset(
      { onlyUsingWithGoogleGeocoder: true },
      {
        maximumScreenSpaceError: QUALITY.flightSSE,
        showCreditsOnScreen: true,
        // Cesium's Google default is 1.5 GB + 1 GB overflow; that exhausts smaller GPUs.
        cacheBytes: QUALITY.cacheMB * 1024 * 1024,
        maximumCacheOverflowBytes: QUALITY.overflowMB * 1024 * 1024,
      },
    );
    scene.primitives.add(tileset);
    surface = new SurfaceDetail(tileset, { detail: !LOW_POWER });
    terrain = new LocalTerrain(viewer, tileset);
    tileset.loadProgress.addEventListener((pending, processing) => {
      streaming = pending + processing;
      if (streaming === 0) streamPeak = 1;
      else streamPeak = Math.max(streamPeak, streaming);
    });
  } catch (err) {
    console.warn('Photorealistic 3D tiles unavailable, falling back to flat imagery.', err);
    scene.globe = new C.Globe(C.Ellipsoid.WGS84);
    scene.globe.enableLighting = true;
    scene.imageryLayers.add(C.ImageryLayer.fromProviderAsync(
      C.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'),
    ));
    hud.toast('3D buildings unavailable — showing flat satellite imagery. Add a token in js/config.js.', 6000);
  }
}

function waitForTiles(maxMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    let calm = 0;
    const check = () => {
      const done = (!tileset || !tileset.show || tileset.tilesLoaded) && (!terrain || terrain.tilesLoaded);
      calm = done ? calm + 1 : 0;
      if (calm >= 3 || performance.now() - start > maxMs) resolve();
      else setTimeout(check, 120);
    };
    check();
  });
}

// Real ground height under the destination, measured from the tiles.
async function sampleDatum(place) {
  try {
    const exclude = [effects.cloudShell, effects.layerClouds, effects.deckClouds, inscription.primitive, ...(giza?.primitives || [])].filter(Boolean);
    const [res] = await scene.sampleHeightMostDetailed([C.Cartographic.fromDegrees(place.datum.lon, place.datum.lat)], exclude);
    if (rig.place === place && res && Number.isFinite(res.height)) {
      rig.datumOffsetTarget = res.height - place.datum.h;
      surface?.setPlace(place, res.height);
      console.info(`[${place.id}] ground at datum: ${res.height.toFixed(1)} m (guess ${place.datum.h} m)`);
    }
  } catch (err) {
    console.warn('Height sampling failed', err);
  }
}

// ---------------------------------------------------------------------------
// Landing warm-up: from departure until touchdown the tileset also loads the
// landed view, so the monument is sharp on arrival. It is an extra tile pass
// from the pose the rig will land in, like the one Cesium runs for a
// camera.flyTo destination, but it must not starve the fall. Cesium refines a
// tile only once all its children have arrived, and some of those are far
// off-screen and rank last: flood the queue with a big landed view (Rome on
// desktop is ~900 tiles) and they never get through, and the whole descent
// shows a handful of continent-sized tiles. So while the screen is waiting
// for tiles, the warm-up keeps to two thirds of Cesium's requests per server,
// at normal priority (the request-render-mode check pass has the options of
// Cesium's preload without its absolute priority); beyond that it only touches
// its tiles so they stay cached and in flight (a pick pass: same traversal, no
// requests).
// ---------------------------------------------------------------------------
const LOADING = C.Cesium3DTileContentState?.LOADING ?? 1;
let warmPlace = null;
let warmCamera = null;
let warmPass = null;
let warmBroken = !C.Cesium3DTilePass || !C.Cesium3DTilePassState;
const warmLoading = new Set();       // tiles the warm-up asked for and is waiting on
const warmCommands = [];             // what the pick pass draws, thrown away

function startWarm(place) {
  warmPlace = place;
  warmLoading.clear();
}

scene.postUpdate.addEventListener(() => {
  // A place drawn with local terrain hides the tiles once the camera is low.
  if (!warmPlace || warmBroken || !tileset || !tileset.show || (warmPlace.terrain && terrain?.wanted)) return;
  try {
    if (!warmCamera) {
      warmCamera = new C.Camera(scene);
      warmPass = new C.Cesium3DTilePassState({ pass: C.Cesium3DTilePass.PICK, camera: warmCamera, commandList: warmCommands });
    }
    for (const tile of warmLoading) if (tile._contentState !== LOADING) warmLoading.delete(tile);
    const perServer = C.RequestScheduler.maximumRequestsPerServer;
    const screenWaiting = tileset._statisticsPerPass[C.Cesium3DTilePass.RENDER].numberOfAttemptedRequests > 0;
    const requesting = warmLoading.size < (screenWaiting ? Math.round(perServer * 2 / 3) : perServer);
    warmPass.pass = requesting ? C.Cesium3DTilePass.REQUEST_RENDER_MODE_DEFER_CHECK : C.Cesium3DTilePass.PICK;
    rig.landedPose(warmCamera, warmPlace);
    warmCamera.frustum.aspectRatio = viewer.camera.frustum.aspectRatio;
    warmPass.cullingVolume = warmCamera.frustum.computeCullingVolume(warmCamera.positionWC, warmCamera.directionWC, warmCamera.upWC);
    // The traversal reads these two per-frame values; give it the landed view's.
    const sse = tileset._memoryAdjustedScreenSpaceError;
    const density = tileset._dynamicScreenSpaceErrorComputedDensity;
    tileset._memoryAdjustedScreenSpaceError = QUALITY.landedSSE * sse / tileset.maximumScreenSpaceError;
    tileset._dynamicScreenSpaceErrorComputedDensity = horizonDensity(warmCamera);
    try {
      tileset.updateForPass(scene.frameState, warmPass);
    } finally {
      tileset._memoryAdjustedScreenSpaceError = sse;
      tileset._dynamicScreenSpaceErrorComputedDensity = density;
      warmCommands.length = 0;
    }
    // Of the tiles the pass wanted, those it got are loading now. The rest are
    // unmarked, or the render pass would skip them this frame.
    for (const tile of tileset._requestedTiles) {
      if (tile._contentState === LOADING) warmLoading.add(tile);
      else tile._requestedFrame = 0;
    }
  } catch (err) {
    warmBroken = true;
    console.warn('Landing warm-up unavailable; tiles will load on arrival.', err);
  }
});

// Cesium coarsens tiles toward the horizon by a density it works out from the
// camera every frame (Cesium3DTileset's updateDynamicScreenSpaceError). The same
// for another camera, so the warm-up keeps what the landed view will keep.
function horizonDensity(camera) {
  if (!tileset.dynamicScreenSpaceError) return 0;
  const root = tileset.root;
  const volume = root.contentBoundingVolume;
  const bounds = volume.boundingVolume;                 // oriented box or sphere
  const toLocal = C.Matrix4.inverseTransformation(root.computedTransform, new C.Matrix4());
  const center = C.Matrix4.multiplyByPoint(toLocal, bounds.center, new C.Cartesian3());
  let up, direction, height, low, high;
  if (volume.minimumHeight !== undefined || C.Cartesian3.magnitude(center) > C.Ellipsoid.WGS84.minimumRadius) {
    up = C.Cartesian3.normalize(camera.positionWC, new C.Cartesian3());
    direction = camera.directionWC;
    height = camera.positionCartographic.height;
    low = volume.minimumHeight ?? 0;
    high = volume.maximumHeight ?? C.Cartographic.fromCartesian(center).height * 2;
  } else {
    // Defined in local coordinates, z up (Google's tileset: an Earth-centred box).
    up = C.Cartesian3.UNIT_Z;
    direction = C.Cartesian3.normalize(C.Matrix4.multiplyByPointAsVector(toLocal, camera.directionWC, new C.Cartesian3()), new C.Cartesian3());
    height = C.Matrix4.multiplyByPoint(toLocal, camera.positionWC, new C.Cartesian3()).z;
    const half = bounds.halfAxes ? C.Cartesian3.magnitude(C.Matrix3.getColumn(bounds.halfAxes, 2, new C.Cartesian3())) : bounds.radius;
    low = center.z - half;
    high = center.z + half;
  }
  const close = low + (high - low) * tileset.dynamicScreenSpaceErrorHeightFalloff;
  const t = clamp01((height - close) / (high - close));
  return tileset.dynamicScreenSpaceErrorDensity * (1 - Math.abs(C.Cartesian3.dot(direction, up))) * (1 - t);
}

// ---------------------------------------------------------------------------
// Journey events
// ---------------------------------------------------------------------------
let writeSeq = 0;
let ascending = false;

rig.on('depart', (place) => {
  writeSeq++;
  ascending = false;
  hud.setMode('flying');
  hud.setCurrent(place);
  hud.hidePlaceCard();
  inscription.clear();
  weather.targetIntensity = 0;
  effects.setGrade(place.grade);
  audio.setPlace(place);
  surface?.setPlace(place, place.datum.h);
  terrain?.prepare(place);
  if (place.id === 'egypt') setGiza(true);
  if (tileset) tileset.maximumScreenSpaceError = QUALITY.flightSSE;
  startWarm(place);

  const layersAbove = place.clouds.filter((l) => l.base > 0).map((l) => (l.base + l.top) / 2);
  const punch = rig.predictDivePoints(place, layersAbove);
  effects.buildLayers(place, place.datum.h, punch, rig.finalCameraPosition(place));
  sampleDatum(place);
  history.replaceState(null, '', `#${place.id}`);
  pinVisible = true;
});

rig.on('hover', () => audio.cue('hover'));
rig.on('dive', (place) => {
  pinVisible = false;
  audio.cue('dive', place);
});

// The last seconds of the fall already frame the landed view (mostly loaded by
// the warm-up), so they can show it at landed detail.
rig.on('approach', () => {
  if (tileset) tileset.maximumScreenSpaceError = QUALITY.landedSSE;
});

rig.on('arrive', (place) => {
  warmPlace = null;
  hud.setMode('landed');
  audio.cue('land', place);
  weather.setMode(place.weather);
  weather.targetIntensity = 1;
  effects.settleLayers();
  if (tileset) tileset.maximumScreenSpaceError = QUALITY.landedSSE;
  writeMessage(place);
});

rig.on('ascend', () => {
  writeSeq++;
  ascending = true;
  warmPlace = null;
  hud.setMode('flying');
  hud.hidePlaceCard();
  audio.cue('ascend');
  inscription.clear();
  weather.targetIntensity = 0;
  terrain?.release();
  pinVisible = false;
  if (tileset) tileset.maximumScreenSpaceError = QUALITY.flightSSE;
  history.replaceState(null, '', location.pathname);
});

rig.on('space', () => {
  setGiza(false);
  ascending = false;
  hud.setMode('space');
  hud.setCurrent(null);
  effects.clearLayers();
  audio.setPlace(null);
  surface?.setPlace(null);
});

function setGiza(on) {
  if (on && !giza && tileset) {
    try {
      giza = createGiza(viewer, tileset);
    } catch (err) {
      console.warn('Giza models failed, keeping the scan.', err);
    }
  } else if (!on && giza) {
    giza.destroy();
    giza = null;
  }
}

async function writeMessage(place) {
  const token = ++writeSeq;
  const msgPromise = renderMessage(place);
  await waitForTiles(8000);
  const msg = await msgPromise;
  if (token !== writeSeq || rig.place !== place || rig.mode !== 'landed') return;

  // Hold the camera still and hide clouds for two frames, then read the surface.
  const measure = async () => {
    rig.freeze = true;
    effects.setLayersVisible(false);
    await inscription.nextFrame();
    await inscription.nextFrame();
    const result = inscription.fitSurface(place, rig.datumHeight(place));
    effects.setLayersVisible(true);
    rig.freeze = false;
    return result;
  };
  // A good fit lands near the anchor; if the surface wasn't fully drawn yet
  // (tiles or models still arriving), wait a little and measure again.
  const anchorWC = C.Cartesian3.fromDegrees(place.anchor.lon, place.anchor.lat, rig.datumHeight(place) + place.anchor.h);
  const good = (f) => f.ok && C.Cartesian3.distance(f.center, anchorWC) < place.width * 0.5;
  let frame = await measure();
  for (let tries = 0; tries < 5 && !good(frame) && token === writeSeq; tries++) {
    console.info(`[${place.id}] surface fit off by ${C.Cartesian3.distance(frame.center, anchorWC).toFixed(0)} m, measuring again`);
    await waitForTiles(4000);
    await new Promise((r) => setTimeout(r, 1200));
    if (token !== writeSeq) return;
    frame = await measure();
  }
  if (token !== writeSeq) return;
  console.info(`[${place.id}] surface fit from ${frame.samples} samples (${frame.ok ? 'plane' : 'fallback'})`);

  inscription.build(place, msg, frame);
  const duration = 2.6 * place.lines.length + 0.4;
  inscription.write(duration);
  audio.write(place, duration, place.lines.length);
  setTimeout(() => { if (token === writeSeq) hud.showPlaceCard(place); }, duration * 650);
}

function rewrite() {
  const place = rig.place;
  if (!place || rig.mode !== 'landed' || !inscription.material) return;
  rig.resetView();
  const duration = 2.6 * place.lines.length + 0.4;
  inscription.write(duration);
  audio.write(place, duration, place.lines.length);
}

// ---------------------------------------------------------------------------
// Pointer / wheel input on the globe
// ---------------------------------------------------------------------------
const globeEl = document.getElementById('globe');
const pointers = new Map();
let pinchDist = 0;

globeEl.addEventListener('pointerdown', (e) => {
  if (document.body.classList.contains('is-intro')) return;
  globeEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  rig.user.dragging = true;
  rig._resetting = false;
  globeEl.classList.add('dragging');
  if (pointers.size === 2) pinchDist = pinchDistance();
});
globeEl.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (rig.mode === 'flying' || rig.freeze) return;
  if (pointers.size === 1) rig.drag(dx, dy);
  else if (pointers.size === 2) {
    const d = pinchDistance();
    if (pinchDist > 0 && d > 0) rig.zoomBy(pinchDist / d);
    pinchDist = d;
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    rig.user.dragging = false;
    globeEl.classList.remove('dragging');
  }
  pinchDist = pointers.size === 2 ? pinchDistance() : 0;
};
globeEl.addEventListener('pointerup', endPointer);
globeEl.addEventListener('pointercancel', endPointer);
globeEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (document.body.classList.contains('is-intro')) return;
  rig.zoomBy(Math.exp(e.deltaY * 0.0012));
}, { passive: false });

function pinchDistance() {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

// ---------------------------------------------------------------------------
// Ground collision: after landing, the camera never dips into the scenery.
// ---------------------------------------------------------------------------
const GROUND_CLEARANCE = 4;          // metres kept between the eye and the surface
const collideCarto = new C.Cartographic();
let groundBelow;                     // surface height under the camera (async, refreshed continuously)
let groundAt = null;                 // where the last sample was taken
let groundSampling = false;

// Cesium's synchronous sampleHeight is unreliable with Google's tiles, so keep
// one "most detailed" sample in flight at a time under the moving camera.
function refreshGround() {
  if (groundSampling || rig.mode !== 'landed') return;
  // Each sample loads the finest tiles under the eye, so take a new one only once
  // it has moved a fair way for its height (otherwise tiles never finish loading).
  if (groundAt && groundBelow !== undefined) {
    const moved = C.Cartesian3.distance(
      C.Cartesian3.fromRadians(groundAt.longitude, groundAt.latitude),
      C.Cartesian3.fromRadians(collideCarto.longitude, collideCarto.latitude));
    if (moved < Math.max(5, 0.25 * (collideCarto.height - groundBelow))) return;
  }
  groundSampling = true;
  const where = C.Cartographic.clone(collideCarto);
  const exclude = [effects.cloudShell, effects.layerClouds, effects.deckClouds, inscription.primitive].filter(Boolean);
  scene.sampleHeightMostDetailed([where], exclude)
    .then(([res]) => {
      if (rig.mode === 'landed' && Number.isFinite(res?.height)) { groundBelow = res.height; groundAt = where; }
    })
    .catch(() => {})
    .finally(() => {
      groundSampling = false;
      // The sample renders from its own camera and leaves it in the frame state;
      // the next frame would work out tile detail from it (tiles flicker between
      // two levels and are requested and cancelled every frame). Put ours back.
      scene.updateFrameState();
    });
}

function keepAboveGround() {
  if (rig.mode !== 'landed') { groundBelow = undefined; groundAt = null; return; }
  const cam = viewer.camera;
  C.Cartographic.fromCartesian(cam.positionWC, C.Ellipsoid.WGS84, collideCarto);
  refreshGround();
  // Local terrain (Matterhorn) can be read directly and instantly.
  if (scene.globe && scene.globe.show) {
    const t = scene.globe.getHeight(collideCarto);
    if (Number.isFinite(t)) groundBelow = t;
  }
  if (groundBelow === undefined || rig.freeze) return;
  const min = groundBelow + GROUND_CLEARANCE;
  if (collideCarto.height >= min) return;
  // Lift the eye straight up, keeping where it looks, and stop the drag digging further.
  cam.setView({
    destination: C.Cartesian3.fromRadians(collideCarto.longitude, collideCarto.latitude, min),
    orientation: { direction: C.Cartesian3.clone(cam.directionWC), up: C.Cartesian3.clone(cam.upWC) },
  });
  const u = rig.user;
  if (u.vPitch > 0) u.vPitch = 0;
  if (u.zoomTarget < u.zoom) u.zoomTarget = u.zoom;
  u.pitch = Math.max(u.pitch - 0.5, -60 - rig.place.view.pitch);
}

// ---------------------------------------------------------------------------
// Frame loop (runs on the clock tick, before Cesium renders)
// ---------------------------------------------------------------------------
const SUN_BASE = C.JulianDate.fromIso8601('2026-06-21T12:00:00Z');
let last = performance.now();
let elapsed = 0;
let prevCam = null;
let prevAlt = null;
let speedNorm = 0;
let speedKmh = 0;
let lastCloud = 0;
let pinVisible = false;
const scratchCarto = new C.Cartographic();

viewer.clock.onTick.addEventListener(frame);

function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  elapsed += dt;

  rig.update(dt);
  keepAboveGround();

  // Keep the sun where it looks best relative to what we're looking at.
  // It also ticks in real time, which Cesium's particle systems need.
  C.JulianDate.addMinutes(SUN_BASE, -4 * (rig.s.lon + rig.sunOffset) + elapsed / 60, viewer.clock.currentTime);

  const camera = viewer.camera;
  const cam = camera.positionWC;
  C.Cartographic.fromCartesian(cam, C.Ellipsoid.WGS84, scratchCarto);
  const place = rig.place;
  const ground = place ? rig.datumHeight(place) : 0;
  const altitude = Math.max(1, scratchCarto.height - ground);
  terrain?.update(scratchCarto.height);
  // Leaving Giza: swap the models back out only once we're high enough not to see it.
  if (giza && rig.place?.id !== 'egypt' && scratchCarto.height > 50e3) setGiza(false);

  // Speed: real (for the readout) and perceived (log-altitude rate, for sound/blur).
  if (prevCam) {
    const v = C.Cartesian3.distance(cam, prevCam) / dt;
    speedKmh += (v * 3.6 - speedKmh) * Math.min(1, dt * 6);
    const dln = Math.abs(Math.log(altitude) - Math.log(prevAlt)) / dt;
    const target = rig.mode === 'flying' ? clamp01(dln / 2.2) : 0;
    speedNorm += (target - speedNorm) * Math.min(1, dt * 5);
  }
  prevCam = C.Cartesian3.clone(cam, prevCam || new C.Cartesian3());
  prevAlt = altitude;

  // Re-entry band and cloud layers.
  const reentry = smooth(150e3, 70e3, altitude) * smooth(9e3, 25e3, altitude);
  let cloud = 0;
  if (place && rig.mode === 'flying') {
    const altD = scratchCarto.height - ground;
    for (const l of place.clouds) {
      if (l.base <= 0) continue;
      cloud = Math.max(cloud, smooth(l.base - 260, l.base + 120, altD) * (1 - smooth(l.top - 120, l.top + 260, altD)));
    }
  }
  if (cloud > 0.5 && lastCloud <= 0.5) audio.cue('cloudPunch', place);
  lastCloud = cloud;

  const flying = rig.mode === 'flying';
  effects.blur = reducedMotion || !flying ? 0 : Math.pow(speedNorm, 1.6) * 0.75;
  rig.shake = reducedMotion ? 0 : (reentry * 0.55 + cloud * 1.3) * (flying ? 0.3 + speedNorm : 0);
  const near = place ? smooth(6000, 800, altitude) : 0;
  effects.gradeAmount = near;
  effects.update({ altitude: scratchCarto.height, time: elapsed, veil: cloud * 0.92 });

  weather.update(dt, { heading: rig.viewHeading * D2R });
  surface?.update(camera, altitude);
  document.body.classList.toggle('frosty', !!place && place.id === 'switzerland' && altitude < 3500 && rig.mode !== 'space');

  inscription.update(dt, elapsed);

  const landed = rig.mode === 'landed' ? smooth(0, 3, rig.time - rig.landedAt) : 0;
  audio.update(dt, { altitude, speed: speedNorm, cloud, reentry: reentry * (flying ? 1 : 0), landed });

  // Destination pin while the globe turns.
  let pin = null;
  if (pinVisible && place) {
    const p = C.Cartesian3.fromDegrees(place.target.lon, place.target.lat, place.datum.h);
    const toCam = C.Cartesian3.subtract(cam, p, new C.Cartesian3());
    if (C.Cartesian3.dot(C.Cartesian3.normalize(p, new C.Cartesian3()), toCam) > 0) {
      const sp = C.SceneTransforms.worldToWindowCoordinates(scene, p);
      if (sp) pin = { x: sp.x, y: sp.y, label: `${place.flag}  ${place.landmark}` };
    }
  }

  let metersPerPixel = null;
  if (altitude < 2000e3) {
    const fov = camera.frustum.fov;
    const w = scene.canvas.clientWidth, h = scene.canvas.clientHeight;
    const fovx = w >= h ? fov : 2 * Math.atan(Math.tan(fov / 2) * (w / h));
    metersPerPixel = (2 * rig.s.range * rig.user.zoom * Math.tan(fovx / 2)) / Math.max(1, w);
  }

  hud.update({
    // On a mountain the destination is the summit, so show height above sea level instead.
    altitude: place && place.datum.h > 1500 ? scratchCarto.height : altitude,
    speedKmh,
    lon: rig.s.lon,
    lat: rig.s.lat,
    heading: rig.viewHeading,
    metersPerPixel,
    place,
    pin,
    streaming,
    loadProgress: streaming === 0 ? 1 : clamp01(1 - streaming / streamPeak),
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
// Phones: iOS routes Web Audio through the ringer channel, so the silent switch
// mutes it. Declaring a playback session (Safari 17+) and playing a silent
// media element inside the tap moves it to the media channel like a video.
let silentLoop = null;
function unlockMobileAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older browsers */ }
  try {
    if (!silentLoop) {
      const rate = 8000, n = rate / 2;                     // half a second of silence, 8-bit mono WAV
      const buf = new ArrayBuffer(44 + n);
      const v = new DataView(buf);
      const str = (o, t) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
      str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
      str(36, 'data'); v.setUint32(40, n, true);
      new Uint8Array(buf, 44).fill(128);
      silentLoop = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
      silentLoop.loop = true;
      silentLoop.setAttribute('playsinline', '');
    }
    silentLoop.play().catch(() => {});
  } catch { /* nothing else to try */ }
}

// Phones suspend or interrupt audio (lock screen, calls, tab switches); any tap brings it back.
const wakeAudio = () => {
  const ctx = audio.ctx;
  if (ctx && ctx.state !== 'running' && !audio.muted) {
    ctx.resume().catch(() => {});
    if (silentLoop && silentLoop.paused) silentLoop.play().catch(() => {});
  }
};
addEventListener('pointerdown', wakeAudio, { passive: true });
addEventListener('touchend', wakeAudio, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeAudio(); });

async function begin() {
  unlockMobileAudio();
  await audio.start();
  hud.setMode('space');
  const fromHash = byId(location.hash.slice(1));
  if (fromHash) setTimeout(() => travel(fromHash), 1200);
}

(async () => {
  await loadWorld();
  await Promise.race([waitForTiles(9000), new Promise((r) => setTimeout(r, 9000))]);
  hud.setBeginReady(true, byId(location.hash.slice(1)) ? 'Begin the descent' : 'Begin');
})();

// Debug handle for tuning views from the console: WR.jump('egypt') lands instantly.
window.WR = {
  viewer, rig, effects, inscription, audio, PLACES,
  jump(id) {
    const p = byId(id);
    if (!p) return;
    rig._cancel();
    Object.assign(rig.user, { heading: 0, pitch: 0, zoom: 1, zoomTarget: 1, vHeading: 0, vPitch: 0 });
    rig.place = p;
    rig.emit('depart', p);
    pinVisible = false;
    rig.sunOffset = p.sunOffset;
    rig.mode = 'landed';
    rig.landedAt = rig.time;
    rig.emit('arrive', p);
  },
};
