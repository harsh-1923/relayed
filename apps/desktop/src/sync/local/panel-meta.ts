// A panel's meta as the screen reports it (PANELS.md), checked before it is
// kept. The report comes from a page's own script — the icon is read inside
// the `<webview>` — so everything here is untrusted input, bounded and typed.
import { createHash } from 'node:crypto';
import type { PanelMeta } from '../../shared/panels.ts';
import { isWebUrl, withoutFragmentDirective } from '../../shared/web-panels.ts';

/** A tab icon, not an image: anything larger is not a favicon. */
export const MAX_ICON_BYTES = 256 * 1024;
const MAX_TITLE = 300;
const MAX_URL = 32 * 1024;
/**
 * No SVG. The blob store serves bytes without a type, so an SVG would not draw
 * as an image — and one that did could carry script.
 */
const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon']);

export interface MetaReport {
  currentUrl?: unknown;
  pageTitle?: unknown;
  /** A `data:` URL, as the page produced it. */
  icon?: unknown;
}

/** A committed web location fit to restore on this device. */
export function currentUrlFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = withoutFragmentDirective(value);
  return url.length <= MAX_URL && isWebUrl(url) ? url : undefined;
}

/** The icon's bytes and their content address, or null when it is not a small raster image. */
export function iconFromDataUrl(value: unknown): { id: string; bytes: Uint8Array } | null {
  if (typeof value !== 'string' || value.length > MAX_ICON_BYTES * 2) return null;
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value);
  if (!match || !ICON_TYPES.has(match[1]!.toLowerCase())) return null;
  const bytes = new Uint8Array(Buffer.from(match[2]!, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return null;
  return { id: createHash('sha256').update(bytes).digest('hex'), bytes };
}

/** A page title fit to keep: a string, trimmed and bounded, or nothing. */
export function pageTitleFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return title || undefined;
}

/** The fields of a report worth writing, with the icon stored through `putBlob`. */
export function metaPatch(report: MetaReport, putBlob: (id: string, bytes: Uint8Array) => void): PanelMeta {
  const patch: PanelMeta = {};
  const currentUrl = currentUrlFrom(report.currentUrl);
  if (currentUrl) patch.currentUrl = currentUrl;
  const pageTitle = pageTitleFrom(report.pageTitle);
  if (pageTitle) patch.pageTitle = pageTitle;
  const icon = iconFromDataUrl(report.icon);
  if (icon) {
    putBlob(icon.id, icon.bytes);
    patch.iconBlob = icon.id;
  }
  return patch;
}
