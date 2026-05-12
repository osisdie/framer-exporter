/**
 * Crop a horizontal band from a PNG and save it. Used to zoom in on specific
 * Y-ranges flagged by pixelDiff.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const src = process.argv[2];
const yStart = parseInt(process.argv[3] ?? '0', 10);
const yEnd = parseInt(process.argv[4] ?? '0', 10);
const out = process.argv[5];

if (!src || !out || !yEnd) {
  console.error('Usage: tsx scripts/cropBand.ts <src.png> <yStart> <yEnd> <out.png>');
  process.exit(1);
}

const img = PNG.sync.read(fs.readFileSync(src));
const w = img.width;
const h = yEnd - yStart;
const cropped = new PNG({ width: w, height: h });

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const srcIdx = ((yStart + y) * w + x) * 4;
    const dstIdx = (y * w + x) * 4;
    cropped.data[dstIdx] = img.data[srcIdx]!;
    cropped.data[dstIdx + 1] = img.data[srcIdx + 1]!;
    cropped.data[dstIdx + 2] = img.data[srcIdx + 2]!;
    cropped.data[dstIdx + 3] = img.data[srcIdx + 3]!;
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, PNG.sync.write(cropped));
console.log(`Cropped ${src} y=${yStart}-${yEnd} → ${out}`);
