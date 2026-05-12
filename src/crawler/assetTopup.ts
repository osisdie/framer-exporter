import * as cheerio from 'cheerio';
import parseSrcset from 'parse-srcset';
import type { BrowserContext } from 'playwright';
import { AssetStore } from '../interceptor/assetInterceptor.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { tryParse } from '../utils/urlUtils.js';

/**
 * Hosts whose URLs we want to capture & rewrite. Anything pointing to these hosts
 * but not yet in the AssetStore (e.g. srcset variants the browser didn't actually
 * fetch at the capture viewport, favicons skipped in headless mode) gets pulled
 * down in this top-up phase.
 */
const ASSET_HOST_PATTERNS = [
  /(?:^|\.)framerusercontent\.com$/i,
  /(?:^|\.)framerstatic\.com$/i,
  /(?:^|\.)framercanvas\.com$/i,
  /^framer\.com$/i,  // only path /m/* will be captured (handled by URL filter)
  /(?:^|\.)ingest\.sentry\.io$/i,
  /(?:^|\.)jspm\.io$/i,
];

const ATTRS_TO_SCAN = ['src', 'href', 'data-src', 'data-lazy-src', 'poster', 'content'];
const SRCSET_ATTRS = ['srcset', 'data-srcset'];

export async function topupAssets(
  context: BrowserContext,
  pages: Map<string, string>,
  store: AssetStore,
): Promise<{ fetched: number; skipped: number; failed: number }> {
  const candidates = new Set<string>();

  for (const [pageUrl, html] of pages) {
    collectAssetUrls(html, pageUrl, candidates);
  }

  // Also scan captured JSON / JS / text bodies — Framer often references additional
  // breakpoint-specific image variants only inside its runtime asset manifests.
  for (const rec of store.all()) {
    const ct = rec.contentType.toLowerCase();
    if (
      ct.includes('json') ||
      ct.includes('javascript') ||
      ct.includes('text/css') ||
      ct.includes('text/plain')
    ) {
      const text = rec.body.toString('utf8');
      collectUrlsFromText(text, candidates);
    }
  }

  const missing: string[] = [];
  for (const url of candidates) {
    if (!store.has(url) && shouldFetchHost(url)) {
      missing.push(url);
    }
  }

  logger.info({ candidates: candidates.size, missing: missing.length }, 'topup-starting');

  let fetched = 0;
  let failed = 0;
  let skipped = 0;

  // Use Playwright's request context — sends cookies + UA from the existing session
  const request = context.request;

  // Fetch in parallel batches of 8
  const batchSize = 8;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (url) => {
        try {
          const response = await withRetry(
            () => request.fetch(url, { timeout: 30_000, ignoreHTTPSErrors: true }),
            { attempts: 2, label: `topup ${url}` },
          );
          const status = response.status();
          if (status >= 400) {
            logger.debug({ url, status }, 'topup-non-2xx');
            failed += 1;
            return;
          }
          const body = await response.body();
          const contentType = response.headers()['content-type'] ?? '';
          store.record(url, body, contentType);
          fetched += 1;
        } catch (err) {
          logger.debug({ url, err: (err as Error).message }, 'topup-fetch-failed');
          failed += 1;
        }
      }),
    );
  }
  skipped = candidates.size - missing.length;

  logger.info({ fetched, skipped, failed }, 'topup-complete');
  return { fetched, skipped, failed };
}

/**
 * Find any absolute URL pointing to a known asset host inside text content
 * (JSON manifests, JS bundles, CSS). Catches asset references constructed at
 * runtime that aren't in any HTML attribute.
 */
function collectUrlsFromText(text: string, into: Set<string>): void {
  // Match `https://[subdomain.]host/path` style absolute URLs.
  // The host part allows zero-or-more subdomains (so we match bare
  // `https://framerusercontent.com/...` as well as `https://x.framerusercontent.com/...`).
  // Stop the path at characters that can't appear in a URL value (quotes, whitespace,
  // brackets, comma — comma is a srcset separator and not valid inside a single URL).
  const re = /https?:\/\/(?:[a-z0-9-]+\.)*(?:framerusercontent|framerstatic|framercanvas)\.com[^\s"'`<>(){}\[\]\\,]*/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0]
      // Trim trailing punctuation that often follows URLs in JSON/JS
      .replace(/[.,;:!?'"`)\]}>]+$/g, '');
    if (shouldFetchHost(raw)) into.add(raw);
  }
}

function collectAssetUrls(html: string, baseUrl: string, into: Set<string>): void {
  const $ = cheerio.load(html);

  for (const attr of ATTRS_TO_SCAN) {
    $(`[${attr}]`).each((_i, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      const abs = tryParse(value, baseUrl)?.toString();
      if (abs && shouldFetchHost(abs)) into.add(abs);
    });
  }

  for (const attr of SRCSET_ATTRS) {
    $(`[${attr}]`).each((_i, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      let parts: Array<{ url: string }>;
      try {
        parts = parseSrcset(value) as Array<{ url: string }>;
      } catch {
        return;
      }
      for (const p of parts) {
        const abs = tryParse(p.url, baseUrl)?.toString();
        if (abs && shouldFetchHost(abs)) into.add(abs);
      }
    });
  }

  // Catch-all: anything in inline style url(...) or in <meta> content that's a known host
  $('[style]').each((_i, el) => {
    const value = $(el).attr('style');
    if (!value || !value.includes('url(')) return;
    for (const m of value.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const abs = tryParse(m[1]!, baseUrl)?.toString();
      if (abs && shouldFetchHost(abs)) into.add(abs);
    }
  });
}

function shouldFetchHost(absoluteUrl: string): boolean {
  const u = tryParse(absoluteUrl);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // For framer.com, only capture /m/* (modules) — exclude editor/login URLs
  if (u.hostname.toLowerCase() === 'framer.com' || u.hostname.toLowerCase() === 'www.framer.com') {
    return u.pathname.startsWith('/m/');
  }
  return ASSET_HOST_PATTERNS.some((re) => re.test(u.hostname));
}
