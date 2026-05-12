/**
 * Diagnose the reported "first outfit not highlighted on mobile" issue.
 * Captures the same `outfit` section on both LIVE and LOCAL at phone viewport
 * and dumps DOM structure for comparison.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

try { (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env'); } catch { /* .env optional */ }

const LIVE = process.env.LIVE_URL;
const LOCAL = process.env.LOCAL_URL ?? 'http://localhost:3000/';

if (!LIVE) {
  console.error('LIVE_URL not set. Add it to .env (see .env.example).');
  process.exit(1);
}
// Write diagnostics OUTSIDE output/ — output/ is the deploy artifact and must
// not contain comparison shots of the live site (privacy + bloat).
const OUT = path.resolve('.diagnostic/mobile');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function inspect(label: string, url: string) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  console.log(`\n=== ${label}: ${url} ===`);

  const failed: string[] = [];
  page.on('response', (resp) => {
    if (resp.status() >= 400) failed.push(`${resp.status()} ${resp.url()}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  // Scroll all the way down then back to trigger every animation/lazy mount
  await page.evaluate(async () => {
    const total = document.body.scrollHeight;
    for (let y = 0; y <= total; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  });
  await new Promise((r) => setTimeout(r, 1500));

  // tsx/esbuild instrument arrow & function declarations with `__name(...)`.
  // To avoid that, ship the script as a plain string and run via .evaluate().
  const summaryScript = `
    (() => {
      const allText = document.body.innerText;
      const idx = allText.toLowerCase().indexOf('outfit');
      const around = idx >= 0 ? allText.slice(Math.max(0, idx - 100), idx + 400) : '(no "outfit" text found)';

      const candidates = [];
      document.querySelectorAll('*').forEach((el) => {
        const t = el.textContent || '';
        if (/outfit/i.test(t) && t.length < 200) candidates.push(el);
      });

      const sections = candidates.slice(0, 5).map((c) => ({
        tag: c.tagName.toLowerCase(),
        cls: (c.getAttribute('class') || '').slice(0, 80),
        id: c.id || '',
        text: (c.textContent || '').trim().slice(0, 60).replace(/\\s+/g, ' '),
        imageCount: c.querySelectorAll('img').length,
        images: Array.from(c.querySelectorAll('img')).slice(0, 8).map((img) => ({
          src: img.src.slice(-100),
          alt: img.alt,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          bboxTop: Math.round(img.getBoundingClientRect().top),
          bboxLeft: Math.round(img.getBoundingClientRect().left),
          bboxWidth: Math.round(img.getBoundingClientRect().width),
        })),
      }));

      const allImagesNearOutfit = candidates.length
        ? Array.from(candidates[0].querySelectorAll('img')).map((img) => ({
            src: img.src.slice(-80),
            visible: img.naturalWidth > 0,
            displayed: img.getBoundingClientRect().width > 0,
          }))
        : [];

      return {
        pageHeight: document.documentElement.scrollHeight,
        textAroundOutfit: around,
        outfitContainers: sections,
        allImagesInFirstOutfitContainer: allImagesNearOutfit,
      };
    })()
  `;
  const summary = await page.evaluate(summaryScript);

  console.log(JSON.stringify(summary, null, 2));
  console.log(`failed (${failed.length}):`);
  for (const f of failed.slice(0, 5)) console.log(`  - ${f}`);

  // Take a focused screenshot of the outfit section
  await page.screenshot({
    path: path.join(OUT, `${label}-fullpage.png`),
    fullPage: true,
  });

  await ctx.close();
}

await inspect('live', LIVE);
await inspect('local', LOCAL);
await browser.close();
console.log(`\nFull-page screenshots in ${OUT}/`);
