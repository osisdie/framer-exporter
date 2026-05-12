import * as cheerio from 'cheerio';
import parseSrcset from 'parse-srcset';
import { rewriteCss } from './cssRewriter.js';
import { normalizePageUrl, sameOrigin, tryParse } from '../utils/urlUtils.js';

export interface HtmlRewriteContext {
  pageUrl: string;
  /** Origin of the crawl (so internal links rewrite to local HTML paths) */
  siteOrigin: string;
  /** Lookup for asset URLs → local root-relative paths */
  assetLookup: (originalUrl: string) => string | undefined;
  /** Lookup for page URLs → local root-relative HTML paths */
  pageLookup: (normalizedPageUrl: string) => string | undefined;
  /**
   * If set, rewrites <link rel="canonical"> and <meta property="og:url"> to
   * point at this URL. Without this, the captured HTML keeps the Framer
   * preview / framer.app URL it was published with, which leaks the original
   * hosting location to search engines and social embeds.
   */
  canonicalUrl?: string;
}

const URL_ATTRS: Array<{ selector: string; attr: string }> = [
  { selector: 'img[src]', attr: 'src' },
  { selector: 'img[data-src]', attr: 'data-src' },
  { selector: 'img[data-lazy-src]', attr: 'data-lazy-src' },
  { selector: 'source[src]', attr: 'src' },
  { selector: 'video[src]', attr: 'src' },
  { selector: 'video[poster]', attr: 'poster' },
  { selector: 'audio[src]', attr: 'src' },
  { selector: 'iframe[src]', attr: 'src' },
  { selector: 'script[src]', attr: 'src' },
  { selector: 'link[href]', attr: 'href' },
  { selector: 'use[href]', attr: 'href' },
  { selector: 'use[xlink\\:href]', attr: 'xlink:href' },
  { selector: 'object[data]', attr: 'data' },
  { selector: 'embed[src]', attr: 'src' },
  { selector: 'meta[property="og:image"]', attr: 'content' },
  { selector: 'meta[name="twitter:image"]', attr: 'content' },
];

const SRCSET_ATTRS: Array<{ selector: string; attr: string }> = [
  { selector: 'img[srcset]', attr: 'srcset' },
  { selector: 'source[srcset]', attr: 'srcset' },
];

export async function rewriteHtml(html: string, ctx: HtmlRewriteContext): Promise<string> {
  const $ = cheerio.load(html);

  // Strip every Framer owner-only UI element that gets serialized into the
  // captured HTML when the crawler is logged in to Framer. These render
  // floating overlays (a "Made in Framer" badge bottom-right, an edit-pencil
  // button mid-right) that are NOT part of the published site's intended UX.
  //
  // Coverage:
  //   1. Editor-bar bootstrap: <script src="framer.com/edit/...">
  //      and the inline loader script that sets `__framer_force_showing_editorbar`.
  //   2. Editor-bar UI shell: container <div>, button, label, and the iframe
  //      itself (iframe was stripped earlier; the shell still rendered the
  //      circular pencil icon thanks to its CSS).
  //   3. "Made in Framer" badge: container + the <a class="__framer-badge"> link.
  //   4. Telemetry endpoints: events.framer.com is already 204-stubbed at the
  //      interceptor; remove the dangling <script> tags too.
  $('script[src*="framer.com/edit"]').remove();
  $('script').each((_i, el) => {
    const txt = $(el).html();
    if (!txt) return;
    if (txt.includes('framer.com/edit') || txt.includes('__framer_force_showing_editorbar')) {
      $(el).remove();
    }
  });
  $('script[src*="events.framer.com"]').remove();

  // Editor-bar (entire shell)
  $('#__framer-editorbar-container').remove();
  $('#__framer-editorbar-button').remove();
  $('#__framer-editorbar-label').remove();
  $('iframe[id="__framer-editorbar"]').remove();
  $('iframe[src*="framer.com/edit"]').remove();

  // "Made in Framer" badge (the floating bottom-right link)
  $('#__framer-badge-container').remove();
  $('a.__framer-badge').remove();
  $('a[href="https://www.framer.com"]').remove();
  $('a[href="https://framer.com"]').remove();

  // Override SEO canonical / og:url so the export doesn't keep advertising the
  // original Framer preview URL.
  if (ctx.canonicalUrl) {
    $('link[rel="canonical"]').attr('href', ctx.canonicalUrl);
    $('meta[property="og:url"]').attr('content', ctx.canonicalUrl);
    $('meta[name="twitter:url"]').attr('content', ctx.canonicalUrl);
  }

  for (const { selector, attr } of URL_ATTRS) {
    $(selector).each((_i, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      const newValue = mapUrl(value, ctx);
      if (newValue !== undefined && newValue !== value) {
        $(el).attr(attr, newValue);
      }
    });
  }

  for (const { selector, attr } of SRCSET_ATTRS) {
    $(selector).each((_i, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      const newValue = mapSrcset(value, ctx);
      if (newValue !== value) $(el).attr(attr, newValue);
    });
  }

  // <a href> — keep external untouched, rewrite same-origin to local HTML paths
  $('a[href]').each((_i, el) => {
    const value = $(el).attr('href');
    if (!value) return;
    if (
      value.startsWith('mailto:') ||
      value.startsWith('tel:') ||
      value.startsWith('javascript:') ||
      value.startsWith('#')
    ) {
      return;
    }
    const absolute = tryParse(value, ctx.pageUrl)?.toString();
    if (!absolute) return;
    if (!sameOrigin(absolute, ctx.siteOrigin)) return;
    const normalized = normalizePageUrl(absolute);
    if (!normalized) return;
    const localPage = ctx.pageLookup(normalized);
    if (localPage) $(el).attr('href', localPage);
  });

  // <form action> — typically external; rewrite if it points to a captured asset, otherwise leave
  $('form[action]').each((_i, el) => {
    const value = $(el).attr('action');
    if (!value) return;
    const newValue = mapUrl(value, ctx);
    if (newValue && newValue !== value) $(el).attr('action', newValue);
  });

  // Inline <style> blocks — pipe through CSS rewriter
  const styleNodes = $('style').toArray();
  for (const node of styleNodes) {
    const css = $(node).html();
    if (!css) continue;
    const rewritten = await rewriteCss(css, {
      baseUrl: ctx.pageUrl,
      lookup: ctx.assetLookup,
    });
    if (rewritten !== css) $(node).html(rewritten);
  }

  // Inline style="..." attributes containing url(...)
  $('[style]').each((_i, el) => {
    const value = $(el).attr('style');
    if (!value || !value.includes('url(')) return;
    const newValue = rewriteInlineStyle(value, ctx);
    if (newValue !== value) $(el).attr('style', newValue);
  });

  return $.html();
}

function mapUrl(rawUrl: string, ctx: HtmlRewriteContext): string | undefined {
  if (!rawUrl) return undefined;
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return undefined;
  const absolute = tryParse(rawUrl, ctx.pageUrl)?.toString();
  if (!absolute) return undefined;
  return ctx.assetLookup(absolute);
}

function mapSrcset(value: string, ctx: HtmlRewriteContext): string {
  type Candidate = { url: string; d?: string; w?: string; h?: string };
  let candidates: Candidate[];
  try {
    candidates = parseSrcset(value) as Candidate[];
  } catch {
    return value;
  }
  if (!candidates.length) return value;
  return candidates
    .map((c) => {
      const mapped = mapUrl(c.url, ctx) ?? c.url;
      const descriptor = c.d ? ` ${c.d}x` : c.w ? ` ${c.w}w` : '';
      return `${mapped}${descriptor}`;
    })
    .join(', ');
}

function rewriteInlineStyle(value: string, ctx: HtmlRewriteContext): string {
  // Simple regex pass for inline style attributes — full PostCSS would be overkill here.
  return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, urlInner) => {
    const mapped = mapUrl(urlInner, ctx);
    if (!mapped) return match;
    return `url(${quote}${mapped}${quote})`;
  });
}
