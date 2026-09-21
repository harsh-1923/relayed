export const DEFAULT_HAIL_SETTINGS = {
  palette: { background: "#08090d", logo: "#faf6e6" },
  logo: { size: 480 },
  rays: { colorOne: "#8662ff", colorTwo: "#ef629f", colorThree: "#b4caff", intensity: 1.7, opacity: 0.85, count: 24, distortion: 1, lightMode: false, blend: "screen" },
  motion: { enabled: true, paused: false, type: "rotate3d", speed: 0.35 },
};

export const HAIL_PRESETS = [
  { name: "Obsidian", note: "Violet / rose / ink", settings: DEFAULT_HAIL_SETTINGS },
  { name: "Midnight", note: "Ice blue / navy", settings: {
    ...DEFAULT_HAIL_SETTINGS,
    palette: { background: "#080f24", logo: "#edf3ff" },
    rays: { ...DEFAULT_HAIL_SETTINGS.rays, colorOne: "#203eab", colorTwo: "#709fff", colorThree: "#d9efff", intensity: 1.5, count: 32, distortion: 0.5 },
    motion: { ...DEFAULT_HAIL_SETTINGS.motion, speed: 0.2 },
  } },
  { name: "Aurora", note: "Mint / deep forest", settings: {
    ...DEFAULT_HAIL_SETTINGS,
    palette: { background: "#051511", logo: "#e6faef" },
    rays: { ...DEFAULT_HAIL_SETTINGS.rays, colorOne: "#0f876f", colorTwo: "#76ebba", colorThree: "#d9f2af", intensity: 1.4, count: 18, distortion: 1.8 },
    motion: { ...DEFAULT_HAIL_SETTINGS.motion, speed: 0.25 },
  } },
  { name: "Ember", note: "Copper / warm charcoal", settings: {
    ...DEFAULT_HAIL_SETTINGS,
    palette: { background: "#170c09", logo: "#ffe8ce" },
    rays: { ...DEFAULT_HAIL_SETTINGS.rays, colorOne: "#c83c2c", colorTwo: "#ed9a51", colorThree: "#ffe1ac", intensity: 1.6, count: 16, distortion: 0.7 },
    motion: { ...DEFAULT_HAIL_SETTINGS.motion, type: "rotate", speed: 0.25 },
  } },
  { name: "Paper", note: "Ivory / plum ink", settings: {
    ...DEFAULT_HAIL_SETTINGS,
    palette: { background: "#f5f0e5", logo: "#281f35" },
    rays: { ...DEFAULT_HAIL_SETTINGS.rays, colorOne: "#695497", colorTwo: "#b6697c", colorThree: "#bb9352", intensity: 1, opacity: 0.6, lightMode: true, blend: "multiply", count: 24 },
    motion: { ...DEFAULT_HAIL_SETTINGS.motion, speed: 0.2 },
  } },
  { name: "Cobalt", note: "Original blue / cream", settings: {
    ...DEFAULT_HAIL_SETTINGS,
    palette: { background: "#1347f5", logo: "#faf6e6" },
    rays: { ...DEFAULT_HAIL_SETTINGS.rays, colorOne: "#ff007a", colorTwo: "#4d3dff", colorThree: "#ffffff", intensity: 2, opacity: 1, blend: "lighten" },
    motion: { ...DEFAULT_HAIL_SETTINGS.motion, speed: 0.5 },
  } },
];
