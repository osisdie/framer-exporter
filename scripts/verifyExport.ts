/**
 * Visit the locally-served export at 3 viewport widths, capture screenshots,
 * and log all 404s + console errors + any request that escaped to a non-localhost host.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3000/';

const browser = await chromium.launch({ headless: true });
const verifyDir = path.resolve('output/verification');
fs.mkdirSync(verifyDir, { recursive: true });

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 1366 },
  { name: 'phone', width: 390, height: 844 },
];

for (const vp of viewports) {
  console.log(`\n=== ${vp.name} (${vp.width}x${vp.height}) ===`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();

  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalHosts = new Set<string>();

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400) failedRequests.push(`${resp.status()} ${resp.url()}`);
    try {
      const u = new URL(resp.url());
      if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        externalHosts.add(u.hostname);
      }
    } catch {
      /* skip */
    }
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  await page.screenshot({ path: path.join(verifyDir, `${vp.name}.png`), fullPage: true });
  console.log(`  saved screenshot → output/verification/${vp.name}.png`);

  console.log(`  external hosts (${externalHosts.size}):`);
  for (const h of externalHosts) console.log(`    - ${h}`);

  console.log(`  failed requests / 4xx / 5xx (${failedRequests.length}):`);
  for (const r of failedRequests.slice(0, 20)) console.log(`    - ${r}`);
  if (failedRequests.length > 20) console.log(`    ... and ${failedRequests.length - 20} more`);

  console.log(`  console errors (${consoleErrors.length}):`);
  for (const c of consoleErrors.slice(0, 5)) console.log(`    - ${c.slice(0, 200)}`);

  await ctx.close();
}

await browser.close();
console.log('\nDone.');
