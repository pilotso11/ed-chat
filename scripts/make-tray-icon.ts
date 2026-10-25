// Writes resources/tray.png: an orange ring on transparent, 32x32. Run once: npx tsx scripts/make-tray-icon.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const SIZE = 32;
const [R, G, B] = [255, 140, 0];

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Coverage of a ring between radii 10 and 15, sampled 4x4 per pixel for smooth edges.
function alpha(x: number, y: number): number {
  let hits = 0;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const d = Math.hypot(x + (i + 0.5) / 4 - SIZE / 2, y + (j + 0.5) / 4 - SIZE / 2);
      if (d >= 10 && d <= 15) hits++;
    }
  return Math.round((hits / 16) * 255);
}

const rows: Buffer[] = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) row.set([R, G, B, alpha(x, y)], 1 + x * 4);
  rows.push(row);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(Buffer.concat(rows))),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(path.join(import.meta.dirname, "..", "resources", "tray.png"), png);
