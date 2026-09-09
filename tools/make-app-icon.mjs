#!/usr/bin/env node
// Builds the app icon — macOS .icns, Windows .ico, a PNG set, and an SVG
// master — from the asterisk mark, with no npm dependencies.
//
//   node tools/make-app-icon.mjs
//   node tools/make-app-icon.mjs --bg '#1D3FE0' --fg '#FFFFFF'
//
// Zero deps is the point: the brand colors are not settled yet, so this has
// to stay runnable on any checkout without an install step. PNGs are encoded
// here (node:zlib is enough), .ico is assembled by hand, and only .icns needs
// a platform tool (`iconutil`, macOS-only — the rest still build elsewhere).

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// The mark, in its own 266x273 space. Single source of truth for every
// output below, so the raster and the SVG can never drift apart.
const MARK_PATH =
  'M109.74 3.01Q133 -3.01 156.26 3.01L154.29 40.71L184 11Q200.66 15.89 214 27L171.15 69.85L254.01 73.81' +
  'Q262.66 89.44 266 107L173.52 102.81L257.72 189.27Q253.31 205.52 242 218L152.55 128.55L148.58 270.99' +
  'Q133 275.01 117.42 270.99L113.45 128.55L24 218Q12.69 205.52 8.28 189.27L92.48 102.81L0 107' +
  'Q3.34 89.44 11.99 73.81L94.85 69.85L52 27Q65.34 15.89 82 11L111.71 40.71L109.74 3.01Z';
const MARK_W = 266;
const MARK_H = 273;

// Flat sides with superelliptical corners — |u/r|^n + |v/r|^n = 1 around a
// centre set r in from each edge. Unlike a plain border-radius corner (n=2)
// the curvature starts at zero where it meets the straight edge, which is the
// continuous-corner character macOS icons have; a pure superellipse body has
// no flat sides at all and reads as a blob next to native icons.
const CORNER_RATIO = 0.26;  // of the body, not the canvas
const CORNER_N = 3.2;

// Two geometries, not one scaled artwork. Below ~32px, Apple's 10% canvas
// padding is pure waste (1.5px of a 16px tile) and the mark collapses, so the
// small sizes get a body that nearly fills the tile and a proportionally
// larger mark. Apple ships size-specific variants for the same reason.
const VARIANTS = {
  large: { bodyRatio: 824 / 1024, markRatio: 0.53 },
  small: { bodyRatio: 960 / 1024, markRatio: 0.62 },
};
const variantFor = (size) => (size <= 32 ? VARIANTS.small : VARIANTS.large);

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// iconutil requires these exact names; 32 and 64 each serve two entries.
const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

// ---------------------------------------------------------------- path maths

// Flattens the M/L/Q/Z subset the mark uses into a polygon.
function flattenPath(d, steps = 24) {
  const tokens = d.match(/[MLQZ]|-?\d*\.?\d+/gi) ?? [];
  const pts = [];
  let i = 0, cur = [0, 0], cmd = null;
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[MLQZ]/i.test(tokens[i])) { cmd = tokens[i++].toUpperCase(); if (cmd === 'Z') continue; }
    if (cmd === 'M' || cmd === 'L') {
      cur = [num(), num()];
      pts.push(cur);
    } else if (cmd === 'Q') {
      const c = [num(), num()], p = [num(), num()], p0 = cur;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        pts.push([
          u * u * p0[0] + 2 * t * u * c[0] + t * t * p[0],
          u * u * p0[1] + 2 * t * u * c[1] + t * t * p[1],
        ]);
      }
      cur = p;
    } else { i++; }
  }
  return pts;
}

// Area and centroid via the shoelace formula — used for optical centering.
function polygonMetrics(pts) {
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    a2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const area = a2 / 2;
  return { area: Math.abs(area), cx: cx / (3 * a2), cy: cy / (3 * a2) };
}

// --------------------------------------------------------------- rasterizing

// Coverage is analytic across x and supersampled down y. Exact horizontal
// spans mean the near-vertical arm edges stay crisp at 8 sub-rows, where
// point sampling would need 64x the work for the same result.
const SUB_ROWS = 8;

function accumulateSpan(row, size, x0, x1) {
  const a = Math.max(0, x0), b = Math.min(size, x1);
  if (b <= a) return;
  const i0 = Math.floor(a), i1 = Math.ceil(b) - 1;
  if (i0 === i1) { row[i0] += b - a; return; }
  row[i0] += i0 + 1 - a;
  for (let i = i0 + 1; i < i1; i++) row[i] += 1;
  row[i1] += b - i1;
}

// The body's horizontal extent at a given y, in closed form — so the edge is
// mathematically exact rather than a polygon approximation of itself.
function bodySpan(y, size, inset, r, n) {
  const top = inset, bottom = size - inset;
  if (y <= top || y >= bottom) return null;
  const dy = Math.min(y - top, bottom - y);
  if (dy >= r) return [inset, size - inset];       // flat side
  const k = (r - dy) / r;                           // 0 at the side, 1 at the corner
  const dx = r * Math.pow(1 - Math.pow(k, n), 1 / n);
  return [inset + r - dx, size - inset - r + dx];
}

// Non-zero winding, so the mark's one sub-pixel seam self-intersection at the
// path's start point cannot punch a hole the way even-odd would.
function polygonSpans(pts, y) {
  const xs = [];
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    if (y1 === y2) continue;
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    if (y < lo || y >= hi) continue;
    xs.push({ x: x1 + ((y - y1) / (y2 - y1)) * (x2 - x1), dir: y2 > y1 ? 1 : -1 });
  }
  xs.sort((p, q) => p.x - q.x);
  const spans = [];
  let w = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    w += xs[i].dir;
    if (w !== 0) spans.push([xs[i].x, xs[i + 1].x]);
  }
  return spans;
}

function renderIcon(size, bg, fg) {
  const { bodyRatio, markRatio } = variantFor(size);
  const center = size / 2;
  const inset = (size * (1 - bodyRatio)) / 2;
  const corner = size * bodyRatio * CORNER_RATIO;

  const markPoly = flattenPath(MARK_PATH);
  const { cy: centroidY } = polygonMetrics(markPoly);
  // The mark's mass sits above its bounding box centre (the arms cluster up
  // top, only the stem reaches down). Splitting the difference between box
  // centre and centre of mass reads level; either extreme looks like it is
  // sliding within the tile.
  const opticalY = (MARK_H / 2 + centroidY) / 2;

  const markScale = (size * bodyRatio * markRatio) / MARK_H;
  const tx = center - (MARK_W / 2) * markScale;
  const ty = center - opticalY * markScale;
  const placed = markPoly.map(([x, y]) => [x * markScale + tx, y * markScale + ty]);

  const bodyCov = new Float32Array(size * size);
  const markCov = new Float32Array(size * size);
  const rowBody = new Float32Array(size);
  const rowMark = new Float32Array(size);

  for (let py = 0; py < size; py++) {
    rowBody.fill(0);
    rowMark.fill(0);
    for (let s = 0; s < SUB_ROWS; s++) {
      const y = py + (s + 0.5) / SUB_ROWS;
      const b = bodySpan(y, size, inset, corner, CORNER_N);
      if (b) accumulateSpan(rowBody, size, b[0], b[1]);
      for (const [x0, x1] of polygonSpans(placed, y)) accumulateSpan(rowMark, size, x0, x1);
    }
    for (let px = 0; px < size; px++) {
      bodyCov[py * size + px] = rowBody[px] / SUB_ROWS;
      markCov[py * size + px] = rowMark[px] / SUB_ROWS;
    }
  }

  // Composite premultiplied, then divide back out. Doing it the other way
  // fringes every edge with a halo of whichever colour had more coverage.
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(1, bodyCov[i]);
    const m = Math.min(markCov[i], a);
    const bgPart = a - m;
    const o = i * 4;
    if (a <= 0) continue;
    for (let ch = 0; ch < 3; ch++) {
      rgba[o + ch] = Math.round(Math.min(255, (bg[ch] * bgPart + fg[ch] * m) / a));
    }
    rgba[o + 3] = Math.round(a * 255);
  }
  return rgba;
}

// -------------------------------------------------------------- png encoding

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour + alpha
  // Each scanline is prefixed with filter type 0; deflate handles the rest.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------- ico assembly

// PNG-compressed entries, supported by Windows Vista onward — well below
// anything Electron 44 will run on.
function encodeIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const table = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;   // 0 means 256 in the ICO directory
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);           // colour planes
    e.writeUInt16LE(32, 6);          // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    table.push(e);
    offset += png.length;
  }
  return Buffer.concat([dir, ...table, ...entries.map((e) => e.png)]);
}

// ---------------------------------------------------------------- svg master

// Emits the same body as bodySpan, as straight edges plus corner curves.
// Each corner is a quarter superellipse about a centre r in from both edges;
// cubics are fitted to interpolate it at the third points, which keeps the
// path compact and editable instead of a sampled polygon.
function bodyPath(size, inset, r, n, perCorner = 4) {
  const num = (v) => Number(v.toFixed(2));
  const lo = inset, hi = size - inset;
  const at = (cx, cy, sx, sy, t) => [
    cx + sx * r * Math.pow(Math.cos(t), 2 / n),
    cy + sy * r * Math.pow(Math.sin(t), 2 / n),
  ];

  function corner(cx, cy, sx, sy, tFrom, tTo) {
    let d = '';
    for (let k = 0; k < perCorner; k++) {
      const t0 = tFrom + ((tTo - tFrom) * k) / perCorner;
      const t1 = tFrom + ((tTo - tFrom) * (k + 1)) / perCorner;
      const p0 = at(cx, cy, sx, sy, t0), p3 = at(cx, cy, sx, sy, t1);
      const q1 = at(cx, cy, sx, sy, t0 + (t1 - t0) / 3);
      const q2 = at(cx, cy, sx, sy, t0 + (2 * (t1 - t0)) / 3);
      const p1 = [], p2 = [];
      for (let j = 0; j < 2; j++) {
        const r1 = 27 * q1[j] - 8 * p0[j] - p3[j];
        const r2 = 27 * q2[j] - p0[j] - 8 * p3[j];
        p1[j] = (2 * r1 - r2) / 18;
        p2[j] = (r2 - 6 * p1[j]) / 12;
      }
      d += `C${num(p1[0])} ${num(p1[1])} ${num(p2[0])} ${num(p2[1])} ${num(p3[0])} ${num(p3[1])}`;
    }
    return d;
  }

  const H = Math.PI / 2;
  return `M${num(lo + r)} ${num(lo)}` +
    `L${num(hi - r)} ${num(lo)}` + corner(hi - r, lo + r, 1, -1, H, 0) +
    `L${num(hi)} ${num(hi - r)}` + corner(hi - r, hi - r, 1, 1, 0, H) +
    `L${num(lo + r)} ${num(hi)}` + corner(lo + r, hi - r, -1, 1, H, 0) +
    `L${num(lo)} ${num(lo + r)}` + corner(lo + r, lo + r, -1, -1, 0, H) +
    'Z';
}

function buildSvg(bgHex, fgHex) {
  const S = 1024;
  const { bodyRatio, markRatio } = VARIANTS.large;
  const { cy: centroidY } = polygonMetrics(flattenPath(MARK_PATH));
  const opticalY = (MARK_H / 2 + centroidY) / 2;
  const scale = (S * bodyRatio * markRatio) / MARK_H;
  const tx = S / 2 - (MARK_W / 2) * scale;
  const ty = S / 2 - opticalY * scale;
  const body = bodyPath(S, (S * (1 - bodyRatio)) / 2, S * bodyRatio * CORNER_RATIO, CORNER_N);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="Relayed app icon">
  <path fill="${bgHex}" d="${body}"/>
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(5)})">
    <path fill="${fgHex}" d="${MARK_PATH}"/>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------- main

function parseHex(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const bgHex = arg('bg', '#1D3FE0');
const fgHex = arg('fg', '#FFFFFF');
// resources/, not build/ — build/ is gitignored, and these are brand source
// art that has to survive a clean checkout (CI on Linux cannot rebuild .icns).
const outDir = arg('out', 'apps/desktop/resources');
const bg = parseHex(bgHex);
const fg = parseHex(fgHex);

mkdirSync(join(outDir, 'icons'), { recursive: true });

const pngs = new Map();
for (const size of PNG_SIZES) {
  pngs.set(size, encodePng(size, renderIcon(size, bg, fg)));
  writeFileSync(join(outDir, 'icons', `icon-${size}.png`), pngs.get(size));
}

writeFileSync(join(outDir, 'icon.png'), pngs.get(1024));
writeFileSync(join(outDir, 'icon.svg'), buildSvg(bgHex, fgHex));
writeFileSync(join(outDir, 'icon.ico'), encodeIco(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) }))));

let icns = 'skipped (needs macOS iconutil)';
if (process.platform === 'darwin') {
  const iconset = join(outDir, 'icon.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const [name, size] of ICONSET) writeFileSync(join(iconset, name), pngs.get(size));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(outDir, 'icon.icns')]);
  rmSync(iconset, { recursive: true, force: true });
  icns = 'icon.icns';
}

console.log(`app icon: ${bgHex} on ${fgHex}`);
console.log(`  ${outDir}/icon.svg, icon.png (1024), icon.ico (${ICO_SIZES.length} sizes), ${icns}`);
console.log(`  ${outDir}/icons/icon-{${PNG_SIZES.join(',')}}.png`);
