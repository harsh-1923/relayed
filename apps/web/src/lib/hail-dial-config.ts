import type { DialConfig } from "dialkit";
import type { DEFAULT_HAIL_SETTINGS } from "./hail-presets";

export function createHailDialConfig(settings: typeof DEFAULT_HAIL_SETTINGS) {
  return {
    palette: { ...settings.palette },
    logo: { size: [settings.logo.size, 140, 640, 2] },
    rays: {
      colorOne: settings.rays.colorOne,
      colorTwo: settings.rays.colorTwo,
      colorThree: settings.rays.colorThree,
      intensity: [settings.rays.intensity, 0, 4, 0.05],
      opacity: [settings.rays.opacity, 0, 1, 0.01],
      count: [settings.rays.count, 0, 64, 1],
      distortion: [settings.rays.distortion, 0, 5, 0.05],
      lightMode: settings.rays.lightMode,
      blend: {
        type: "select",
        options: ["screen", "lighten", "multiply", "normal"],
        default: settings.rays.blend,
      },
    },
    motion: {
      enabled: settings.motion.enabled,
      paused: settings.motion.paused,
      type: {
        type: "select",
        options: ["rotate3d", "rotate", "hover"],
        default: settings.motion.type,
      },
      speed: [settings.motion.speed, 0, 1.5, 0.05],
    },
  } satisfies DialConfig;
}
