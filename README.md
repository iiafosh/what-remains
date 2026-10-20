# What Remains · ما يبقى

You start by looking at the real Earth from orbit. Pick a country and the globe turns slowly toward it, then you plunge through re-entry, a cloud layer and open air. You land at the country's best-known landmark, and a message is written in light onto the monument itself, in that country's language.

| Country | Landmark | Message |
|---|---|---|
| 🇪🇬 Egypt | Great Pyramid of Giza (east face) | وسط كل التغيير، فيه حاجات بتفضل. |
| 🇮🇹 Italy | Colosseum (attic of the north wall) | Nel cambiamento, qualcosa resta. |
| 🇬🇷 Greece | Parthenon (west façade) | Μέσα στις αλλαγές, κάτι μένει. |
| 🇨🇭 Switzerland | Matterhorn (east face, snow + frost) | In all dem Wandel bleibt etwas. |
| 🇯🇵 Japan | Mount Fuji (north-east flank) | 変わりゆく世界でも、変わらないものがある。 |

## Run it

It is a static site with no build step. Serve the folder over HTTP, because ES modules don't load from `file://`:

```bash
python serve.py
```

Then open <http://localhost:8080>. Deep links work too, for example <http://localhost:8080/#japan>.

**Map data.** The 3D world is Google Photorealistic 3D Tiles, streamed through Cesium ion. Out of the box the site uses Cesium's built-in evaluation token, which is fine for local testing. Before you publish, put your own free token in `js/config.js`. You can use either:
- a **Cesium ion** token, from <https://ion.cesium.com>, or
- a **Google Maps Platform** key with the Map Tiles API enabled.

If the tiles can't load, the site falls back to flat satellite imagery.

The Matterhorn uses swisstopo's free geodata (terrain and SWISSIMAGE), credited on screen as © swisstopo.

## Controls

| | |
|---|---|
| Drag | Spin the Earth (in space) / orbit the monument (after landing) |
| Wheel / pinch, `+` `−` | Zoom |
| `1`–`5`, dock cards, search box | Travel |
| 🎲 | Random destination |
| `Esc`, globe button | Back to space |
| Compass | Reset the view |
| `M` / `F` / `/` | Sound / fullscreen / search |

## How it works

| File | What it does |
|---|---|
| `js/places.js` | Each destination as data: camera framing, where the text goes, fonts, colours, clouds, weather, colour grade and sound scene. |
| `js/flight.js` | Camera choreography. The camera always orbits a target point (lon, lat, height, heading, pitch, range), so the globe turn, the plunge and the landing are one continuous set of eased numbers. The plunge uses an integrated speed curve: a sharp kick, then a long deceleration. |
| `js/inscription.js` | After landing, it reads the real 3D surface through the depth buffer, fits a plane to the wall or slope, and lays a textured quad on it. A shader then "writes" the text line by line, right-to-left for Arabic. |
| `js/effects.js` | Real cloud texture on a lit shell seen from orbit, night-side shading with a warm terminator, Cesium volumetric cloud layers to fall through, radial motion blur, per-country colour grade and vignette, and screen-space snow, sakura petals, desert dust and light motes. |
| `js/audio.js` | Web Audio soundscape. The journey is synthesized: space drone → re-entry roar and crackle → cloud roar → wind. On the ground, each place plays real field recordings from Wikimedia Commons (see below), looped with a crossfade, with a few synthesized bells and birds on top. |
| `js/giza.js` | Crafted models of the three Giza pyramids (real stepped courses, eroded corners, Khafre's casing cap, Khufu's survey mast) that replace Google's soft scan, which is clipped out underneath. |
| `js/surface.js` | A shader on Google's tiles that adds real-scale detail up close: wind streaks, ripples and gravel on sand, clumps on grass, and a snow cap on Fuji above its snow line. |
| `js/terrain.js` | For the Matterhorn, swaps Google's coarse mountain mesh for Switzerland's open 2 m terrain and 10 cm aerial photos (© swisstopo) during the plunge. |
| `js/credits.js` | The Credits panel (link in the status bar): map, cloud, sound, font and flag attributions. On phones it also measures the map providers' credit strip so the dock and card stack above it. |
| `js/hud.js` | Google-Earth-style UI: breadcrumb search pill, altimeter, compass, scale bar, streaming indicator, destination dock and place card. |

## Adding a sixth country

1. Copy one block in `js/places.js` and change it.
2. Open the site, then in the browser console run `WR.jump('<id>')`. This lands instantly so you can adjust `view`, `anchor` and `width` until the text sits where you want it.
3. To set the anchor, use a point on the surface you want: `viewer.scene.pickPosition(...)`, converted to lon/lat and a height relative to the datum.

## Ground recordings

Each place's ground ambience is a mix of real field recordings. They stream at runtime from Wikimedia Commons, so nothing is stored in this repo. They are listed in `CONFIG.ambience` in `js/config.js`. A scene can be a single URL or a list of layers:

```js
ambience: {
  rome: 'audio/rome.mp3',                                         // one file (your own works too)
  acropolis: [
    { url: 'https://…/Cicadas_in_Greece.ogg.mp3', gain: 1 },
    { url: 'https://…/Gemurmel.wav.mp3', gain: 0.25, far: 0.6 },  // far: duller, quieter, wetter
  ],
}
```

When a file loads, its loudness is measured and brought to the same level as the others, so `gain` only sets the mix. Downloads start as soon as you pick a destination. If none of a scene's files load, that scene is synthesized instead and a warning appears in the console. Scene names are `desert`, `rome`, `acropolis`, `alpine` and `fuji`. If you host the files elsewhere, the server must send `Access-Control-Allow-Origin`, because the files are decoded with Web Audio.

## Sound credits

The field recordings come from [Wikimedia Commons](https://commons.wikimedia.org) and are used under the licences below. The same list is exported as `SOUND_CREDITS` from `js/config.js`.

| Scene | Recording | Author | Licence |
|---|---|---|---|
| Giza, Matterhorn | [20221229 - Abisko Turiststation at night - Wind and snow](https://commons.wikimedia.org/wiki/File:20221229_-_Abisko_Turiststation_at_night_-_Wind_and_snow.wav) | Fabricio Cardenas | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Rome, Giza, Athens | [2023-Mai-20 15h35min Stephansplatz voller Gemurmel](https://commons.wikimedia.org/wiki/File:2023-Mai-20_15h35min_Stephansplatz_voller_Gemurmel.wav) | DrTrumpet | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Athens | [Cicadas in Greece](https://commons.wikimedia.org/wiki/File:Cicadas_in_Greece.ogg) | Channel R | Public domain |
| Athens | [Cicada orni](https://commons.wikimedia.org/wiki/File:Cicada_orni.ogg) | DavidDelon | Public domain |
| Matterhorn | [Killiney Hill Storm Floris 20250804 1537](https://commons.wikimedia.org/wiki/File:Killiney_Hill_Storm_Floris_20250804_1537.ogg) | Karlunun | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Mount Fuji | [Bourne woods windy 2020-05-05 0757](https://commons.wikimedia.org/wiki/File:Bourne_woods_windy_2020-05-05_0757.mp3) | Robert EA Harvey | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Mount Fuji | [SND 4458a (Japanese bush warbler)](https://commons.wikimedia.org/wiki/File:SND_4458a.ogg) | Fg2 | Public domain |

The recordings are filtered, mixed, looped and played quietly. The original files are not modified. Everything else you hear is synthesized in `js/audio.js`.

## Link previews

`og.jpg` (1200×630) is the image shown when the link is shared on WhatsApp, Instagram, X and so on. The `og:` and `twitter:` tags in `index.html` point at `https://what-remains-ruddy.vercel.app/`. If the site moves to another domain, update those URLs, because preview crawlers need absolute links.
