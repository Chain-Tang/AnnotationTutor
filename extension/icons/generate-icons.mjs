// Generate the extension's PNG icons from the same vector design as icon.svg.
// Chrome's manifest needs raster icons, and no SVG rasterizer is installed, so
// we draw the (deliberately simple) geometry procedurally and encode PNG by
// hand: self-contained CRC32 + zlib deflate, 8-bit RGBA, supersampled for AA.

import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// --- Vector design (128x128 art space, mirrors icon.svg) --------------------

const lerp = (a, b, t) => a + (b - a) * t;

/** Point-in-rounded-rectangle test. */
function insideRR(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const nx = px < x0 + r ? x0 + r : px > x1 - r ? x1 - r : px;
  const ny = py < y0 + r ? y0 + r : py > y1 - r ? y1 - r : py;
  const dx = px - nx;
  const dy = py - ny;
  return dx * dx + dy * dy <= r * r;
}

const BARS = [
  { x0: 34, y0: 38, x1: 92, y1: 46, r: 4, col: [255, 255, 255], a: 0.5 },
  { x0: 28, y0: 57, x1: 104, y1: 77, r: 10, col: [251, 191, 36], a: 1 },
  { x0: 34, y0: 84, x1: 82, y1: 92, r: 4, col: [255, 255, 255], a: 0.5 }
];

/** Composited straight color (0..255) + coverage (0/1) at an art-space point. */
function sample(px, py) {
  if (!insideRR(px, py, 8, 8, 120, 120, 28)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (py - 8) / 112));
  let r = lerp(139, 109, t);
  let g = lerp(92, 40, t);
  let b = lerp(246, 217, t);
  for (const bar of BARS) {
    if (insideRR(px, py, bar.x0, bar.y0, bar.x1, bar.y1, bar.r)) {
      r = r * (1 - bar.a) + bar.col[0] * bar.a;
      g = g * (1 - bar.a) + bar.col[1] * bar.a;
      b = b * (1 - bar.a) + bar.col[2] * bar.a;
    }
  }
  return [r, g, b, 1];
}

/** Render the icon at `size` px with SSx SS supersampling. */
function render(size) {
  const SS = 4;
  const rgba = new Uint8Array(size * size * 4);
  const scale = size / 128;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ax = (x + (sx + 0.5) / SS) / scale;
          const ay = (y + (sy + 0.5) / SS) / scale;
          const [cr, cg, cb, ca] = sample(ax, ay);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const idx = (y * size + x) * 4;
      if (a > 0) {
        rgba[idx] = Math.round(r / a);
        rgba[idx + 1] = Math.round(g / a);
        rgba[idx + 2] = Math.round(b / a);
      }
      rgba[idx + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return rgba;
}

const SIZES = [16, 32, 48, 128];

/** Write icon-<size>.png for every manifest size into `dir`. */
export async function generateIcons(dir) {
  for (const size of SIZES) {
    const png = encodePng(size, size, render(size));
    await writeFile(path.join(dir, `icon-${size}.png`), png);
  }
}

// Standalone: refresh the committed PNGs next to icon.svg.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateIcons(path.resolve(import.meta.dirname));
  console.log(`Icons written: ${SIZES.map((s) => `icon-${s}.png`).join(", ")}`);
}
