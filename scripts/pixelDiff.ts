/**
 * Pixel-diff two PNGs and produce a heatmap of differences. Reports rectangles
 * (rough Y-band ranges) where significant differences cluster — useful for
 * spotting region-specific rendering bugs (e.g. a mobile-only carousel state).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const aPath = process.argv[2];
const bPath = process.argv[3];
const outPath = process.argv[4] ?? 'output/mobile-diagnostic/diff.png';

if (!aPath || !bPath) {
  console.error('Usage: tsx scripts/pixelDiff.ts <a.png> <b.png> [diff.png]');
  process.exit(1);
}

const a = PNG.sync.read(fs.readFileSync(aPath));
const b = PNG.sync.read(fs.readFileSync(bPath));

if (a.width !== b.width || a.height !== b.height) {
  console.error(`Size mismatch: a=${a.width}x${a.height}  b=${b.width}x${b.height}`);
  process.exit(1);
}

const diff = new PNG({ width: a.width, height: a.height });
const totalPixels = a.width * a.height;
const numDiff = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
  threshold: 0.1,
  alpha: 0.3,
  diffColor: [255, 0, 0],
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, PNG.sync.write(diff));

console.log(`Total pixels:    ${totalPixels.toLocaleString()}`);
console.log(`Different:       ${numDiff.toLocaleString()} (${((numDiff / totalPixels) * 100).toFixed(2)}%)`);
console.log(`Diff written to: ${outPath}`);

// Report Y-bands where most differences cluster (every 100px row)
const bands = new Map<number, number>();
for (let y = 0; y < a.height; y++) {
  let rowDiff = 0;
  for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
      rowDiff += 1;
    }
  }
  if (rowDiff > 0) {
    const band = Math.floor(y / 100) * 100;
    bands.set(band, (bands.get(band) ?? 0) + rowDiff);
  }
}

console.log('\nTop 10 differing Y-bands (band-start: differing-pixel-count):');
const sorted = Array.from(bands.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [band, count] of sorted) {
  console.log(`  y=${band}–${band + 100}:  ${count.toLocaleString()} diff pixels`);
}
