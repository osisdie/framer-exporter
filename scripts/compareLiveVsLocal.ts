/**
 * Side-by-side visual comparison: render the LIVE Framer site and the LOCAL
 * exported copy at the same 3 viewports. Save full-page screenshots, report
 * pixel similarity (image dimensions + byte size as a quick proxy), and flag
 * any external requests the local copy still makes (should be zero).
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

// Auto-load .env (Node ≥ 20.6 / 22 has this built-in).
try { (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env'); } catch { /* .env optional */ }

const LIVE = process.env.LIVE_URL;
const LOCAL = process.env.LOCAL_URL ?? 'http://localhost:3000/';

if (!LIVE) {
  console.error('LIVE_URL not set. Add it to .env (see .env.example) or pass via env.');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const outDir = path.resolve('output/comparison');
fs.mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 1366 },
  { name: 'phone', width: 390, height: 844 },
];

async function shoot(url: string, label: string, vp: typeof viewports[number]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const externalHosts = new Set<string>();
  const failed: string[] = [];

  page.on('response', (resp) => {
    if (resp.status() >= 400) failed.push(`${resp.status()} ${resp.url()}`);
    if (label === 'local') {
      try {
        const u = new URL(resp.url());
        if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
          externalHosts.add(u.hostname);
        }
      } catch {
        /* ignore */
      }
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  // Scroll to bottom + back to trigger any lazy-load animations, then settle
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 1500));

  const file = path.join(outDir, `${vp.name}-${label}.png`);
  const buf = await page.screenshot({ path: file, fullPage: true });
  const dims = await page.evaluate(() => ({
    docHeight: document.documentElement.scrollHeight,
    docWidth: document.documentElement.scrollWidth,
  }));

  await ctx.close();
  return { file, bytes: buf.length, dims, externalHosts, failed };
}

console.log('Comparing live vs local at 3 viewports...\n');

for (const vp of viewports) {
  const live = await shoot(LIVE, 'live', vp);
  const local = await shoot(LOCAL, 'local', vp);
  console.log(`=== ${vp.name} (${vp.width}x${vp.height}) ===`);
  console.log(`  live   → ${live.file}`);
  console.log(`            page ${live.dims.docWidth}x${live.dims.docHeight},  ${live.bytes.toLocaleString()} bytes screenshot,  ${live.failed.length} 4xx/5xx`);
  console.log(`  local  → ${local.file}`);
  console.log(`            page ${local.dims.docWidth}x${local.dims.docHeight},  ${local.bytes.toLocaleString()} bytes screenshot,  ${local.failed.length} 4xx/5xx`);
  console.log(`  page-height delta: ${Math.abs(live.dims.docHeight - local.dims.docHeight)}px`);
  console.log(`  screenshot-byte delta: ${Math.abs(live.bytes - local.bytes).toLocaleString()} (${((Math.abs(live.bytes - local.bytes) / live.bytes) * 100).toFixed(1)}%)`);
  console.log(`  local external hosts: ${local.externalHosts.size === 0 ? '(none — fully decoupled)' : Array.from(local.externalHosts).join(', ')}`);
  if (local.failed.length) {
    console.log(`  local failures:`);
    for (const f of local.failed.slice(0, 5)) console.log(`    - ${f}`);
  }
  console.log();
}

await browser.close();
console.log('Done. Screenshots in output/comparison/');
