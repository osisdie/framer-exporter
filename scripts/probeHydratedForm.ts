/**
 * Determine whether the Subscribe form on a deployed page comes from the
 * static HTML (stripped) or from JS hydration (re-injected after load).
 *
 * Loads the page twice in headless Chrome:
 *   1. With JS DISABLED → only the SSR HTML renders. If the form appears here,
 *      our static-HTML strip didn't take effect.
 *   2. With JS ENABLED  → React + Framer hydrate. If the form appears now (and
 *      not before), Framer's runtime is re-creating it from the JS bundle.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'https://aistyle.pages.dev/';
const browser = await chromium.launch({ headless: true });

async function probe(label: string, javaScriptEnabled: boolean) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    javaScriptEnabled,
  });
  const page = await ctx.newPage();
  // 'load' is more forgiving than 'networkidle' for sites with persistent
  // background sockets / analytics polling. Hydration completes well before load.
  await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
  await new Promise(r => setTimeout(r, javaScriptEnabled ? 3000 : 200));

  const audit = await page.evaluate(`(() => ({
    forms: document.querySelectorAll('form').length,
    emailInputs: document.querySelectorAll('input[type="email"]').length,
    subscribeBtns: document.querySelectorAll('input[value="Subscribe"]').length,
    beFirstText: (document.body.innerText.match(/Be the first to know when we launch/g) || []).length,
    bodyTextSnippet: document.body.innerText.slice(0, 400).replace(/\\s+/g, ' '),
  }))()`);

  console.log(`\n=== ${label} (JS ${javaScriptEnabled ? 'ON' : 'OFF'}) ===`);
  console.log(`  <form>:                     ${audit.forms}`);
  console.log(`  <input type="email">:       ${audit.emailInputs}`);
  console.log(`  <input value="Subscribe">:  ${audit.subscribeBtns}`);
  console.log(`  "Be the first..." matches:  ${audit.beFirstText}`);

  await ctx.close();
  return audit;
}

console.log(`Probing ${URL} ...`);
const ssr = await probe('SSR-only', false);
const hydrated = await probe('Hydrated', true);

console.log('\n=== Verdict ===');
if (hydrated.forms > 0 && ssr.forms === 0) {
  console.log('✗ Form re-injected by JS hydration. Static HTML strip is insufficient — need to also patch the JS bundle or stub the component.');
} else if (ssr.forms > 0) {
  console.log('✗ Form is in the SSR HTML — strip did not take effect for this deploy.');
} else if (hydrated.forms === 0) {
  console.log('✓ Form is gone in both SSR and after hydration. Browser cache is the only remaining explanation.');
} else {
  console.log('? Inconclusive — please re-run.');
}

await browser.close();
