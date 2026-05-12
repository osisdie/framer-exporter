/**
 * Smoke-test the deployed CF Pages site is BEHIND Access:
 * - Hitting the deploy URL should redirect to a Cloudflare Access login page,
 *   NOT show the actual site content.
 * - The redirect URL should mention "cloudflareaccess" / "Access".
 *
 * URL precedence: argv[2] > $DEPLOY_URL > error.
 */
import { chromium } from 'playwright';

try { (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env'); } catch { /* .env optional */ }

const URL = process.argv[2] ?? process.env.DEPLOY_URL;
if (!URL) {
  console.error('No URL supplied. Pass as argv[2] or set DEPLOY_URL in .env.');
  process.exit(1);
}
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

console.log(`Probing ${URL} ...`);
const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await new Promise((r) => setTimeout(r, 2000));

console.log('\nFinal URL:    ', page.url());
console.log('Final status: ', resp?.status());
console.log('Page title:   ', await page.title());

const text = (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 500);
console.log('\nBody snippet (500 chars):');
console.log(text);

console.log('\n--- Verdict ---');
const finalUrl = page.url();
if (finalUrl.includes('cloudflareaccess.com') || finalUrl.includes('access.')) {
  console.log('✓ Behind CF Access — login challenge presented as expected.');
} else if (resp && resp.status() === 200 && !finalUrl.includes('cloudflareaccess')) {
  console.log('✗ Site appears PUBLIC — content reachable without auth challenge.');
  process.exit(1);
} else {
  console.log('? Unexpected — please inspect manually.');
}

await browser.close();
