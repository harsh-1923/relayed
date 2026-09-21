// The app icon, in the colorway the open account chose (PREFERENCES.md §9).
//
// Main applies this for the same reason it applies the theme: the picture is a
// native object and the preference lives in a database only the sync process
// opens, so main is TOLD rather than deriving it.
//
// WHAT THIS CAN AND CANNOT REACH. `dock.setIcon` replaces the Dock tile of a
// RUNNING app, and `win.setIcon` the window and taskbar entry on Windows and
// Linux. Finder, Launchpad, Spotlight, notifications and the .dmg all read
// `Contents/Resources/icon.icns` inside the bundle, and rewriting that in place
// breaks the code signature — Gatekeeper then refuses to launch the app
// (RELEASE.md §3). So a chosen colorway follows the app while it is open and
// the shipped icon is what everything else shows. That asymmetry is the
// feature's actual shape, not a gap to close later.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron';
import { colorwayOf } from '../shared/icon-colorways.ts';
import { composite, deriveMasks, type IconMasks } from './icon-composite';

/**
 * 512 rather than the 1024 beside it. The Dock draws at most 128pt, so 512
 * covers a 2x display with room to spare, and the masks it derives are a
 * quarter of the memory held for the life of the process.
 */
const SOURCE = 'icon-512.png';

/** `undefined` until the first attempt, `null` once one has failed. */
let masks: IconMasks | null | undefined;
let current: NativeImage | null = null;
let currentId: string | null = null;

/**
 * Packaged builds carry this under `Contents/Resources` via `extraResources`,
 * because `files:` in electron-builder.yml ships `out/` and nothing else —
 * `resources/` is build input, and is not in the app.
 */
function sourcePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', SOURCE)
    : join(__dirname, '../../resources/icons', SOURCE);
}

function loadMasks(): IconMasks | null {
  if (masks !== undefined) return masks;
  masks = null;

  const path = sourcePath();
  if (!existsSync(path)) {
    console.warn('[main] icon source missing — keeping the shipped icon:', path);
    return masks;
  }
  const image = nativeImage.createFromPath(path);
  const { width, height } = image.getSize();
  const derived = deriveMasks(image.toBitmap(), width, height);
  if (!derived) {
    // The icon and `icon-colorways.ts` disagree about what colours it is drawn
    // in, so the mark cannot be separated from its plate. Loud, because the
    // alternative is an icon that silently stops responding to the setting.
    console.warn('[main] the app icon does not match SOURCE_PLATE/SOURCE_MARK — keeping the shipped icon');
    return masks;
  }
  masks = derived;
  return masks;
}

/**
 * Draw and apply one colorway. Unknown ids resolve to the default rather than
 * throwing — this arrives over IPC from a process that may be newer than this
 * one, and a preference is not worth a missing Dock icon.
 */
export function applyAppIcon(id: string): void {
  const colorway = colorwayOf(id);
  if (colorway.id === currentId) return;

  const loaded = loadMasks();
  if (!loaded) return;
  const pixels = composite(loaded, colorway);
  if (!pixels) return;

  current = nativeImage.createFromBitmap(
    Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    { width: loaded.width, height: loaded.height },
  );
  currentId = colorway.id;

  // `app.dock` is undefined off macOS; the windows are where it lands there.
  app.dock?.setIcon(current);
  for (const win of BrowserWindow.getAllWindows()) adoptAppIcon(win);
}

/**
 * Give a newly created window the current icon.
 *
 * macOS has no per-window icon — the Dock tile is the whole of it — so this is
 * deliberately a no-op there rather than a call that quietly does nothing.
 */
export function adoptAppIcon(win: BrowserWindow): void {
  if (process.platform === 'darwin' || !current) return;
  win.setIcon(current);
}
