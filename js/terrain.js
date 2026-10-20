// High-resolution local terrain for places where Google's scan is too coarse.
//
// Google's photogrammetry of high mountains is a low-poly shell, so the
// Matterhorn looked like a crumpled paper cone. Switzerland publishes its own
// 2 m terrain and 10 cm aerial photographs as open data (swisstopo); with
// real sun shading they give the true horn, ridges, glaciers and snowfields.
// The switch happens high up during the plunge, behind the motion blur.
//
// A globe only loads what its camera sees, and the falling camera doesn't see
// the landed view until the last seconds. So from departure until touchdown the
// globe also selects and loads the tiles of the pose the camera will land in
// (and of the view it first appears in), like main.js's warm-up does for the 3D
// tiles: before the switch in a frame of its own, after it in a second pass
// behind the scene's.
//
// After a visit the globe stays attached to the scene, hidden: Cesium's
// scene.globe setter destroys the globe it replaces. Once the camera has left
// for somewhere else, its tiles are freed and its credits kept off the screen.

const C = window.Cesium;
const D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const noop = () => {};
const byLoadPriority = (a, b) => a._loadPriority - b._loadPriority;

const SOURCES = {
  swisstopo: {
    terrain: 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/',
    // Deeper terrain tiles weigh ~150 KB each (served uncompressed) and the
    // landed view needs a hundred of them, more than the flight can fetch on an
    // ordinary connection. Deeper tiles reuse this level's mesh; their imagery
    // keeps refining.
    terrainMaxLevel: 13,
    imagery: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
    imageryMaxLevel: 19,
    coverage: [5.8, 45.75, 10.6, 47.9],
    credit: '© swisstopo',
  },
};

// Below this camera height the local terrain takes over from the 3D tiles.
const SWITCH_HEIGHT = 55e3;

// Phones and modest machines: the same test as main.js's LOW_POWER.
const LOW_POWER = matchMedia('(pointer: coarse)').matches
  || Math.min(innerWidth, innerHeight) < 600
  || (navigator.deviceMemory && navigator.deviceMemory <= 4)
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

// Detail (screen-space error) of the landed view; coarser on phones, like the
// 3D tiles. While falling, the tolerance grows with the distance to the
// landing, so the plunge draws the tiles the landed view will use (already
// preloaded) instead of finer ones it would show for a moment; high up it is capped.
const LANDED_SSE = LOW_POWER ? 3 : 1.5;
const DIVE_SSE = 4 * LANDED_SSE;

// Tiles kept in memory. While a landing is preloaded, the landed view's tiles
// and the plunge's both have to stay.
const CACHE_TILES = 400;
const PRELOAD_CACHE_TILES = 2000;

// The preload ends once the camera is this close to the landed pose (× range).
const ARRIVED = 0.05;

// Tiles the preload passes to the loader per frame, most urgent first. The rest
// would mostly wait for a free request slot, and checking each costs time.
const PRELOAD_LOADS = 48;

const PRELOAD_PASSES = { render: true };
const NO_CREDITS = { addCreditToNextFrame: noop };

export class LocalTerrain {
  constructor(viewer, tileset) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.tileset = tileset;
    this.globes = {};       // ready globes by source, kept for the session
    this.building = {};     // sources whose globe is being set up
    this.empty = new Set(); // sources whose globe holds no tiles
    this.active = null;     // key of the source currently on screen
    this.wanted = null;     // key for the current destination
    this.linger = null;     // keep the old one until we've climbed back up
    this.place = null;      // the destination, while it has local terrain
    this.target = new C.Cartesian3();

    // Landing preload.
    this.preloading = false;
    this.away = false;      // the camera has been away from the landed pose
    this.loaded = false;    // the landed view's tiles are all in
    this.skipped = 0;
    this.broken = false;
    this.baseFov = viewer.camera.frustum.fov;
    this.landed = new C.Camera(this.scene);       // the view on touchdown
    this.switchView = new C.Camera(this.scene);   // the view when the globe appears
    this.switchSse = DIVE_SSE;
    this.hpr = new C.HeadingPitchRange();
    this.frameState = {};
    this.fog = {};
    this.commands = [];
    this.marks = [];
    this.preloadFrame = 0;
    this.scene.postRender.addEventListener(this.preload, this);
    // Set up now: the providers take a few round trips (Bing's through ion),
    // and until then no tile below the root can load.
    for (const key in SOURCES) this.build(key);
  }

  // At departure: choose the destination's terrain and start loading its landed view.
  prepare(place) {
    this.stopPreload();
    const key = place && place.terrain;
    this.linger = this.active;
    this.wanted = key && SOURCES[key] ? key : null;
    this.place = this.wanted ? place : null;
    if (!this.place) return;
    C.Cartesian3.fromDegrees(place.target.lon, place.target.lat, place.datum.h + place.target.h,
      C.Ellipsoid.WGS84, this.target);
    this.poses(place);
    this.away = !this.arrived();
    this.loaded = false;
    this.preloading = !this.broken;
    if (!this.globes[key]) this.build(key);
    else if (this.preloading) this.globes[key].tileCacheSize = PRELOAD_CACHE_TILES;
  }

  release() {
    this.stopPreload();
    this.linger = this.active;
    this.wanted = null;
    this.place = null;
  }

  get tilesLoaded() {
    return !this.active || this.globes[this.active].tilesLoaded;
  }

  async build(key) {
    if (this.building[key]) return;
    this.building[key] = true;
    const src = SOURCES[key];
    try {
      const terrainProvider = await C.CesiumTerrainProvider.fromUrl(src.terrain, { requestVertexNormals: true });
      const available = terrainProvider.getTileDataAvailable.bind(terrainProvider);
      terrainProvider.getTileDataAvailable = (x, y, level) => level <= src.terrainMaxLevel && available(x, y, level);
      const globe = new C.Globe(C.Ellipsoid.WGS84);
      globe.enableLighting = true;
      globe.dynamicAtmosphereLighting = true;
      globe.showGroundAtmosphere = true;
      globe.depthTestAgainstTerrain = true;
      globe.maximumScreenSpaceError = LANDED_SSE;
      // Cesium also fetches the ancestors of every tile on screen (for zooming
      // out), last, and counts the view as loading until they're in: on landing
      // that held the message back by seconds. The preload fetches them early.
      globe.preloadAncestors = false;
      globe.tileCacheSize = this.preloading && this.wanted === key ? PRELOAD_CACHE_TILES : CACHE_TILES;
      globe.show = false;
      globe.terrainProvider = terrainProvider;
      globe.imageryLayers.add(C.ImageryLayer.fromWorldImagery());
      const [w, s, e, n] = src.coverage;
      globe.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
        url: src.imagery,
        maximumLevel: src.imageryMaxLevel,
        rectangle: C.Rectangle.fromDegrees(w, s, e, n),
        credit: src.credit,
      }));
      // The scene starts a frame for its globe even while it is hidden, and the
      // start adds the providers' credits (© swisstopo, Bing): not while hidden.
      const beginFrame = globe.beginFrame;
      globe.beginFrame = (frameState) => {
        if (globe.show) return beginFrame.call(globe, frameState);
        const credits = frameState.creditDisplay;
        frameState.creditDisplay = NO_CREDITS;
        try {
          beginFrame.call(globe, frameState);
        } finally {
          frameState.creditDisplay = credits;
        }
      };
      this.globes[key] = globe;
      this.empty.add(key);
    } catch (err) {
      console.warn(`Local terrain "${key}" unavailable, staying on 3D tiles.`, err);
      if (this.wanted === key) this.release();
    } finally {
      delete this.building[key];
    }
  }

  // Every frame: decide which surface is visible.
  update(cameraHeight) {
    const camera = this.scene.camera;
    const below = cameraHeight < SWITCH_HEIGHT;
    if (!below) this.linger = null;
    let key = null;
    if (below) {
      // Only over the destination: leaving a low place for it must not swap
      // its terrain in at the old site.
      const over = this.place && C.Cartesian3.distance(camera.positionWC, this.target) < 2 * SWITCH_HEIGHT;
      if (over && this.globes[this.wanted]) key = this.wanted;
      else if (this.globes[this.linger]) key = this.linger;
    }
    if (key !== this.active) {
      if (this.active) this.globes[this.active].show = false;
      this.active = key;
      if (key) this.attach(this.globes[key]);
      if (this.tileset) this.tileset.show = !key;
    }
    // Neither on screen nor the destination's: its tiles (GPU meshes and
    // textures, 90–170 MB after a Matterhorn landing) would otherwise stay for
    // the whole session. A later trip loads them again through the preload.
    for (const k in this.globes) {
      if (k === key || k === this.wanted) this.empty.delete(k);
      else if (!this.empty.has(k)) this.free(k);
    }
    const globe = key && this.globes[key];
    if (!globe) return;
    if (this.preloading && key === this.wanted) {
      const r = C.Cartesian3.distance(camera.positionWC, this.target) / this.place.view.range;
      globe.maximumScreenSpaceError = clamp(LANDED_SSE * r, LANDED_SSE, DIVE_SSE);
    } else if (globe.tileCacheSize !== CACHE_TILES && globe.tilesLoaded) {
      // Back to the normal cache once the view is in: sooner would throw out
      // landed tiles the last frames of the fall happened not to look at.
      globe.tileCacheSize = CACHE_TILES;
    }
  }

  // Cesium's scene.globe setter destroys the globe it replaces, even when it
  // is the same one: assign only a different globe, and forget the old one.
  attach(globe) {
    const old = this.scene.globe;
    if (old !== globe) {
      for (const k in this.globes) if (this.globes[k] === old) delete this.globes[k];
      this.scene.globe = globe;
    }
    globe.show = true;
  }

  // Cesium frees all of a globe's tiles at the start of its next frame, which
  // the scene runs even while it is hidden. A globe the scene doesn't have
  // (only preloaded) gets no frames, so start one here.
  free(key) {
    const globe = this.globes[key];
    this.empty.add(key);
    try {
      globe._surface.invalidateAllTiles();
      if (this.scene.globe !== globe) {
        globe.beginFrame(this.frame());
        this.commands.length = 0;
      }
    } catch (err) {
      console.warn(`Local terrain "${key}": could not free its tiles.`, err);
    }
  }

  poses(place) {
    // Just after touchdown: CameraRig.landedPose in flight.js, less the datum
    // offset measured on arrival (a few metres).
    const v = place.view;
    this.hpr.heading = v.heading * D2R;
    this.hpr.pitch = v.pitch * D2R;
    this.hpr.range = v.range;
    this.landed.lookAt(this.target, this.hpr);
    this.landed.lookAtTransform(C.Matrix4.IDENTITY);
    this.landed.frustum.fov = place.fov ? place.fov * D2R : this.baseFov;

    // At the switch the camera looks almost straight down on the target with
    // the normal lens. Square and as wide as its diagonal, for any heading,
    // with the tolerance scaled to keep the lens's detail per pixel.
    this.hpr.heading = 0;
    this.hpr.pitch = -Math.PI / 2;
    this.hpr.range = SWITCH_HEIGHT - place.datum.h - place.target.h;
    this.switchView.lookAt(this.target, this.hpr);
    this.switchView.lookAtTransform(C.Matrix4.IDENTITY);
    const aspect = this.scene.camera.frustum.aspectRatio;
    const t = Math.tan(this.baseFov / 2);
    const [tx, ty] = aspect >= 1 ? [t, t / aspect] : [t * aspect, t];
    this.switchView.frustum.aspectRatio = 1;
    this.switchView.frustum.fov = 2 * Math.atan(Math.hypot(tx, ty));
    this.switchSse = DIVE_SSE * ty / Math.hypot(tx, ty);
  }

  arrived() {
    return C.Cartesian3.distance(this.scene.camera.positionWC, this.landed.positionWC) < ARRIVED * this.place.view.range;
  }

  stopPreload() {
    if (!this.preloading) return;
    this.preloading = false;
    const globe = this.globes[this.wanted];
    if (globe) globe.maximumScreenSpaceError = LANDED_SSE;
  }

  // After every frame until touchdown: select and load the landed view's tiles
  // (and, before the switch, the first view's) as well. Uses Cesium internals
  // (pinned 1.145) and switches itself off with a warning if they throw.
  preload() {
    if (!this.preloading) return;
    const globe = this.globes[this.wanted];
    if (!globe) return;
    if (!this.arrived()) this.away = true;
    else if (this.away) {
      this.stopPreload();
      return;
    }
    // Once the landed view is in, only look again now and then.
    if (this.loaded && ++this.skipped < 15) return;
    this.skipped = 0;
    try {
      this.preloadPass(globe);
    } catch (err) {
      this.broken = true;
      this.stopPreload();
      console.warn('Local terrain preload unavailable; the landed view loads on arrival.', err);
    }
  }

  preloadPass(globe) {
    const scene = this.scene;
    const surface = globe._surface;
    const queues = [surface._tileLoadQueueHigh, surface._tileLoadQueueMedium, surface._tileLoadQueueLow];
    const fs = this.frame();
    this.landed.frustum.aspectRatio = scene.camera.frustum.aspectRatio;

    if (scene.globe !== globe || !globe.show) {
      // Not on screen yet: run a whole frame for it. The view at the switch is
      // selected last, so the scene's first frame carries on from it as from
      // what it drew before, and its few coarse tiles load first.
      globe.beginFrame(fs);
      this.select(surface, fs, this.landed, LANDED_SSE);
      const counts = queues.map((q) => q.length);
      this.select(surface, fs, this.switchView, this.switchSse);
      queues[0].unshift(...queues.flatMap((q, i) => q.splice(counts[i])));
      this.load(surface, fs, queues);
      // Imagery reprojections queued by the last frame (tiles reaching the poles).
      for (const command of this.commands) if (command instanceof C.ComputeCommand) command.execute(scene._computeEngine);
      this.commands.length = 0;
      return;
    }

    // The scene has just drawn it from the real camera. Select again from the
    // landed one, then put back what the scene's pass left (render list, load
    // queues, each tile's selection result) so its next frame carries on from it.
    const waiting = queues.map((q) => q.splice(0));
    const rendered = surface._tilesToRender.slice();
    const lastSelection = surface._lastSelectionFrameNumber;
    const marks = this.marks;
    const tiles = surface._tileReplacementQueue;
    for (let tile = tiles.head; tile && tile !== tiles._lastBeforeStartOfFrame; tile = tile.replacementNext) {
      marks.push(tile, tile._lastSelectionResult, tile._lastSelectionResultFrame);
    }
    try {
      this.select(surface, fs, this.landed, LANDED_SSE);
      this.load(surface, fs, queues);
    } finally {
      surface._lastSelectionFrameNumber = lastSelection;
      for (let i = 0; i < marks.length; i += 3) {
        marks[i]._lastSelectionResult = marks[i + 1];
        marks[i]._lastSelectionResultFrame = marks[i + 2];
      }
      marks.length = 0;
      queues.forEach((q, i) => { q.length = 0; q.push(...waiting[i]); });
      surface._tilesToRender.length = 0;
      surface._tilesToRender.push(...rendered);
      surface._tilesRenderedThisFrame.clear();
      for (const tile of rendered) surface._tilesRenderedThisFrame.add(tile);
    }
  }

  // The frame state for the globe's frames outside the scene's: nothing is
  // drawn and no credits are shown.
  frame() {
    const fs = Object.assign(this.frameState, this.scene.frameState);
    fs.commandList = this.commands;
    fs.passes = PRELOAD_PASSES;
    fs.creditDisplay = NO_CREDITS;
    fs.cameraUnderground = false;
    fs.fog = this.fog;
    return fs;
  }

  // The globe's tile selection from another camera, without drawing anything.
  select(surface, fs, camera, sse) {
    fs.camera = camera;
    fs.cullingVolume = camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC);
    Object.assign(fs.fog, this.scene.frameState.fog);
    this.scene.fog.update(fs);
    // A frame count of its own, so its marks on tiles never read as the scene's.
    fs.frameNumber = --this.preloadFrame;
    const provider = surface.tileProvider;
    const sceneSse = surface.maximumScreenSpaceError;
    const limit = surface.loadingDescendantLimit;
    const ancestors = surface.preloadAncestors;
    surface.maximumScreenSpaceError = sse;
    // Nothing is shown, so ask for the final tiles at once rather than level by level.
    surface.loadingDescendantLimit = Infinity;
    // And their ancestors after them: the plunge falls back on those while it
    // waits for a tile, and without them on the root (a flat olive world).
    surface.preloadAncestors = true;
    // As if nothing had been drawn before: what it marks as drawn is then
    // always a loaded tile (or the nearest loaded ancestor).
    surface._lastSelectionFrameNumber = NaN;
    provider.beginUpdate = provider.showTileThisFrame = provider.endUpdate = noop;
    try {
      surface.render(fs);
    } finally {
      delete provider.beginUpdate;
      delete provider.showTileThisFrame;
      delete provider.endUpdate;
      surface.maximumScreenSpaceError = sceneSse;
      surface.loadingDescendantLimit = limit;
      surface.preloadAncestors = ancestors;
    }
  }

  // Requests and builds the most urgent of the selected tiles.
  load(surface, fs, queues) {
    this.loaded = queues.every((q) => q.length === 0);
    let room = PRELOAD_LOADS;
    for (const queue of queues) {
      if (queue.length > room) {
        queue.sort(byLoadPriority);
        queue.length = room;
      }
      room -= queue.length;
    }
    surface.endFrame(fs);
  }
}
