/**
 * Runtime test: fill the email field, click Subscribe, observe outgoing
 * POST requests and any UI feedback. Prints a clear verdict.
 *
 *   LIVE_URL=http://localhost:3000/  npx tsx scripts/probeSubscribe.ts
 */
import { chromium } from 'playwright';
try { (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env'); } catch { /* optional */ }

const URL = process.argv[2] ?? process.env.LOCAL_URL ?? 'http://localhost:3000/';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const requests: { url: string; method: string; body?: string }[] = [];
page.on('request', (req) => {
  if (req.method() !== 'GET') {
    requests.push({ url: req.url(), method: req.method(), body: req.postData() ?? '' });
  }
});

const responses: { url: string; status: number; body?: string }[] = [];
page.on('response', async (resp) => {
  if (resp.request().method() === 'POST') {
    let body = '';
    try { body = (await resp.text()).slice(0, 300); } catch { /* binary or aborted */ }
    responses.push({ url: resp.url(), status: resp.status(), body });
  }
});

console.log(`Probing ${URL} ...`);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await new Promise(r => setTimeout(r, 1500));

const emailInput = page.locator('input[type="email"]').first();
await emailInput.waitFor({ timeout: 5000 });
await emailInput.fill('test-subscribe@example.com');
console.log('  ✓ filled email field');

const submitBtn = page.locator('input[value="Subscribe"], button:has-text("Subscribe")').first();
await submitBtn.click();
console.log('  ✓ clicked Subscribe — waiting for response');
await new Promise(r => setTimeout(r, 3500));

console.log('\n=== Outgoing non-GET requests ===');
if (!requests.length) console.log('  (none)');
for (const r of requests) {
  console.log(`  ${r.method}  ${r.url}`);
  if (r.body) console.log(`     body: ${r.body.slice(0, 200)}`);
}

console.log('\n=== POST responses ===');
if (!responses.length) console.log('  (none)');
for (const r of responses) {
  console.log(`  ${r.status}  ${r.url}`);
  if (r.body) console.log(`     ${r.body}`);
}

const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
const hasSuccessText = /thank|success|subscribed|✓|sent|joined/i.test(visibleText);
const hasErrorText = /error|fail(ed)?|invalid|sorry|unable/i.test(visibleText);
console.log(`\n=== UI feedback after click ===`);
console.log(`  success-y text:  ${hasSuccessText}`);
console.log(`  error-y text:    ${hasErrorText}`);

await browser.close();
