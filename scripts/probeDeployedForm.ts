/**
 * Headless probe of the deployed theaistyle.pages.dev (or any URL) to check
 * whether the Subscribe form / "Be the first..." text are actually still there.
 * Uses a fresh browser context (no shared cache) and the persistent Framer
 * session for CF Access auth.
 */
import { chromium } from 'playwright';
import path from 'node:path';

const URL = process.argv[2] ?? 'https://theaistyle.pages.dev/';

const ctx = await chromium.launchPersistentContext(path.resolve('./.browser-data'), {
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

// Defeat any HTTP cache by appending a unique query string.
const cacheBust = `${URL}${URL.includes('?') ? '&' : '?'}_cb=${Date.now()}`;
console.log(`Probing ${cacheBust} ...`);

const resp = await page.goto(cacheBust, { waitUntil: 'networkidle', timeout: 30_000 });
console.log('Final URL:', page.url());
console.log('Status:', resp?.status());

if (page.url().includes('cloudflareaccess.com')) {
  console.log('\n⚠ Still at Access login page — script does not have OTP creds. Aborting.');
  console.log('  (Open the same URL in a normal browser to test, or get this script an OTP cookie.)');
  await ctx.close();
  process.exit(0);
}

const audit = await page.evaluate(`(() => {
  const forms = document.querySelectorAll('form').length;
  const inputs = document.querySelectorAll('input[type="email"]').length;
  const subscribeBtns = document.querySelectorAll('input[value="Subscribe"], button:has-text(\\"Subscribe\\")').length;
  const beFirstText = (document.body.innerText.match(/Be the first to know when we launch/g) || []).length;
  return { forms, inputs, subscribeBtns, beFirstText };
})()`);

console.log('\n=== Deployed page audit ===');
console.log(`  <form> elements:           ${audit.forms}`);
console.log(`  <input type="email">:      ${audit.inputs}`);
console.log(`  Subscribe inputs/buttons:  ${audit.subscribeBtns}`);
console.log(`  "Be the first..." text:    ${audit.beFirstText}`);

if (audit.forms === 0 && audit.beFirstText === 0) {
  console.log('\n✓ Deployed content matches stripped local export.');
} else {
  console.log('\n✗ Deployed content STILL contains widgets — likely browser cache or older deployment.');
}

await ctx.close();
