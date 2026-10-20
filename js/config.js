// Map data access.
//
// Out of the box the site uses Cesium's built-in evaluation token, which is fine
// for trying it locally. Before you publish it, put your own key in ONE of these:
//
//   cesiumIonToken   – free account at https://ion.cesium.com  (Access Tokens tab).
//                      Google Photorealistic 3D Tiles come through ion.
//   googleMapsApiKey – Google Cloud key with the "Map Tiles API" enabled.
//                      Talks to Google directly instead of through ion.
//
// If the 3D tiles can't be loaded, the site falls back to flat satellite
// imagery so the journey still plays.

const COMMONS = 'https://upload.wikimedia.org/wikipedia/commons';

export const CONFIG = {
  cesiumIonToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IkJudi1uQ05TT2pVelgyN1ciLCJqdGkiOiJhM2YwNzIzZS0zYTk1LTQ1OTktOGYxNy0xOWM4YjE5YWRkMDYiLCJpZCI6NTI5NTg3LCJzdWIiOiJhZm9zaCIsImlzcyI6Imh0dHBzOi8vYXBpLmNlc2l1bS5jb20iLCJhdWQiOiJ3aGF0X3JlbWFpbnMiLCJpYXQiOjE3OTIzNTMzOTd9.dZTQOorljBcJva9R9K8j9EDixVtnkbDggIMCpeHh3wI',
  googleMapsApiKey: '',

  // Lower = sharper buildings, more data. 4–16 is a sensible range.
  landedScreenSpaceError: 12,
  flightScreenSpaceError: 32,

  // Ground ambience: real field recordings, streamed from Wikimedia Commons
  // (MP3 transcodes, which every browser can decode) and looped with a
  // crossfade. Per scene, either one URL or a list of layers:
  //   { url, gain = 1, far = 0 }   far 0–1: duller, quieter, more reverb
  // Every file is normalised to the same loudness first, so gain is the mix.
  // A scene with no entry, or whose files all fail to load, is synthesized.
  // Your own files work too, e.g. rome: 'audio/rome.mp3'.
  // Scene names: desert, rome, acropolis, alpine, fuji. Credits: SOUND_CREDITS.
  ambience: {
    // Giza: wind hissing over open ground, a crowd murmuring far off.
    desert: [
      { url: `${COMMONS}/transcoded/1/11/20221229_-_Abisko_Turiststation_at_night_-_Wind_and_snow.wav/20221229_-_Abisko_Turiststation_at_night_-_Wind_and_snow.wav.mp3`, gain: 1, far: 0.1 },
      { url: `${COMMONS}/transcoded/2/2f/2023-Mai-20_15h35min_Stephansplatz_voller_Gemurmel.wav/2023-Mai-20_15h35min_Stephansplatz_voller_Gemurmel.wav.mp3`, gain: 0.3, far: 0.7 },
    ],
    // Colosseum: a busy square full of voices (church bells and sparrows are synthesized on top).
    rome: [
      { url: `${COMMONS}/transcoded/2/2f/2023-Mai-20_15h35min_Stephansplatz_voller_Gemurmel.wav/2023-Mai-20_15h35min_Stephansplatz_voller_Gemurmel.wav.mp3`, gain: 1, far: 0.15 },
    ],
    // Parthenon: Greek cicadas, a second cicada chorus further off, visitors in the distance.
    acropolis: [
      { url: `${COMMONS}/transcoded/f/f4/Cicadas_in_Greece.ogg/Cicadas_in_Greece.ogg.mp3`, gain: 1 },
      { url: `${COMMONS}/transcoded/a/a8/Cicada_orni.ogg/Cicada_orni.ogg.mp3`, gain: 0.55, far: 0.3 },
      { url: `${COMMONS}/transcoded/2/2f/2023-Mai-20_15h35min_Stephansplatz_voller_Gemurmel.wav/2023-Mai-20_15h35min_Stephansplatz_voller_Gemurmel.wav.mp3`, gain: 0.25, far: 0.6 },
    ],
    // Matterhorn: gusting storm wind on an exposed hill, snow blown across the ground.
    alpine: [
      { url: `${COMMONS}/transcoded/6/63/Killiney_Hill_Storm_Floris_20250804_1537.ogg/Killiney_Hill_Storm_Floris_20250804_1537.ogg.mp3`, gain: 1 },
      { url: `${COMMONS}/transcoded/1/11/20221229_-_Abisko_Turiststation_at_night_-_Wind_and_snow.wav/20221229_-_Abisko_Turiststation_at_night_-_Wind_and_snow.wav.mp3`, gain: 0.55 },
    ],
    // Fuji: wind in the trees, a Japanese bush warbler at a shrine.
    fuji: [
      { url: `${COMMONS}/a/a3/Bourne_woods_windy_2020-05-05_0757.mp3`, gain: 1, far: 0.1 },
      { url: `${COMMONS}/transcoded/1/12/SND_4458a.ogg/SND_4458a.ogg.mp3`, gain: 0.5, far: 0.35 },
    ],
  },
};

// Attribution for the recordings above (all reusable: public domain, CC0, CC BY-SA).
export const SOUND_CREDITS = [
  {
    scene: 'desert, alpine',
    title: '20221229 - Abisko Turiststation at night - Wind and snow',
    author: 'Fabricio Cardenas',
    license: 'CC BY-SA 4.0',
    page: 'https://commons.wikimedia.org/wiki/File:20221229_-_Abisko_Turiststation_at_night_-_Wind_and_snow.wav',
  },
  {
    scene: 'rome, desert, acropolis',
    title: '2023-Mai-20 15h35min Stephansplatz voller Gemurmel',
    author: 'DrTrumpet',
    license: 'CC BY-SA 4.0',
    page: 'https://commons.wikimedia.org/wiki/File:2023-Mai-20_15h35min_Stephansplatz_voller_Gemurmel.wav',
  },
  {
    scene: 'acropolis',
    title: 'Cicadas in Greece',
    author: 'Channel R',
    license: 'Public domain',
    page: 'https://commons.wikimedia.org/wiki/File:Cicadas_in_Greece.ogg',
  },
  {
    scene: 'acropolis',
    title: 'Cicada orni',
    author: 'DavidDelon',
    license: 'Public domain',
    page: 'https://commons.wikimedia.org/wiki/File:Cicada_orni.ogg',
  },
  {
    scene: 'alpine',
    title: 'Killiney Hill Storm Floris 20250804 1537',
    author: 'Karlunun',
    license: 'CC0',
    page: 'https://commons.wikimedia.org/wiki/File:Killiney_Hill_Storm_Floris_20250804_1537.ogg',
  },
  {
    scene: 'fuji',
    title: 'Bourne woods windy 2020-05-05 0757',
    author: 'Robert EA Harvey',
    license: 'CC BY-SA 4.0',
    page: 'https://commons.wikimedia.org/wiki/File:Bourne_woods_windy_2020-05-05_0757.mp3',
  },
  {
    scene: 'fuji',
    title: 'SND 4458a (Japanese bush warbler, Kashihara Shrine)',
    author: 'Fg2',
    license: 'Public domain',
    page: 'https://commons.wikimedia.org/wiki/File:SND_4458a.ogg',
  },
];
