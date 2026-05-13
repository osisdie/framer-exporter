import path from 'node:path';
import { AssetStore, installAssetInterceptor } from '../interceptor/assetInterceptor.js';
import { crawlSite } from '../crawler/crawler.js';
import { topupAssets } from '../crawler/assetTopup.js';
import { ensureCleanDir, writeFileEnsured } from '../output/fileWriter.js';
import { writeManifest, type Manifest } from '../output/manifestWriter.js';
import { rewriteCss } from '../rewriter/cssRewriter.js';
import { rewriteHtml } from '../rewriter/htmlRewriter.js';
import { buildJsReplacements, rewriteJs } from '../rewriter/jsRewriter.js';
import { editorToPreviewUrl, openSession, pickActivePageUrl } from '../session/browserSession.js';
import { logger } from '../utils/logger.js';
import { isTextual } from '../utils/mimeUtils.js';
import { pageLocalPath, rootRelativeAssetPath } from '../utils/urlUtils.js';

export interface ExportCommandOptions {
  url: string;
  outDir: string;
  concurrency: number;
  depth: number;
  headed: boolean;
  scroll: boolean;
  viewportWidth: number;
  keepCdn: boolean;
  userDataDir: string;
  /** If set, override the captured canonical / og:url metadata */
  canonicalUrl?: string;
  /** Extra CSS selectors removed from every page during HTML rewrite */
  stripSelectors?: string[];
  /** If set, transform the subscribe form into a redirect link instead of stripping it */
  subscribeRedirect?: { url: string; text?: string };
}

export async function runExport(opts: ExportCommandOptions): Promise<void> {
  const outDir = path.resolve(opts.outDir);
  await ensureCleanDir(outDir);

  const session = await openSession({
    userDataDir: opts.userDataDir,
    headed: opts.headed,
    viewportWidth: opts.viewportWidth,
    viewportHeight: 900,
    initialUrl: opts.url,
  });

  try {
    // After user logged-in & navigated, take the visible page URL as the start.
    let liveUrl = pickActivePageUrl(session.context) ?? opts.url;

    // If the user is still on the editor page, derive the preview URL automatically.
    if (liveUrl.includes('framer.com/projects')) {
      const previewUrl = editorToPreviewUrl(liveUrl);
      if (previewUrl) {
        logger.info({ from: liveUrl, to: previewUrl }, 'editor-url-redirected-to-preview');
        liveUrl = previewUrl;
      }
    }
    logger.info({ providedUrl: opts.url, liveUrl }, 'start-url-resolved');

    const startHost = new URL(liveUrl).hostname;
    const store = new AssetStore();
    await installAssetInterceptor(session.context, store, { pageHost: startHost });

    // For sandboxed preview URLs (framer.app/preview/<id>), restrict crawl to that path subtree
    // so we don't spread into framer.app's own marketing pages (/preview, /preview/enterprise, ...).
    const pathPrefixScope =
      liveUrl.includes('framer.app/preview/') || liveUrl.includes('framer.com/preview/');

    const crawlResult = await crawlSite(session.context, {
      startUrl: liveUrl,
      concurrency: opts.concurrency,
      maxDepth: opts.depth,
      viewportWidth: opts.viewportWidth,
      viewportHeight: 900,
      scroll: opts.scroll,
      pageTimeoutMs: 60_000,
      pathPrefixScope,
    });

    logger.info(
      { pages: crawlResult.pages.size, assets: store.size() },
      'crawl-finished-starting-topup',
    );

    // Top-up phase: scan HTML for asset URLs the browser didn't fetch (srcset
    // variants for other viewports, favicons skipped in headless, etc.) and pull
    // them down explicitly so the exported site renders correctly at every breakpoint.
    await topupAssets(session.context, crawlResult.pages, store);

    logger.info({ assets: store.size() }, 'topup-finished-starting-rewrite');

    if (opts.keepCdn) {
      await writeAssets(outDir, store, /* rewrite */ false, new Set());
      await writePages(outDir, crawlResult.pages, crawlResult.origin, store, /* rewrite */ false, opts.canonicalUrl, opts.stripSelectors, opts.subscribeRedirect);
    } else {
      const hosts = collectHosts(store);
      const jsReplacements = buildJsReplacements(hosts);
      await writeAssets(outDir, store, true, hosts, jsReplacements);
      await writePages(outDir, crawlResult.pages, crawlResult.origin, store, true, opts.canonicalUrl, opts.stripSelectors, opts.subscribeRedirect);
    }

    // Stub Framer's editor-bootstrap module: the rewritten JS bundles still
    // perform `import('/assets/framer.com/edit/init.mjs')` for owner-only UX.
    // Serving an empty ES module makes the dynamic import resolve as a no-op
    // instead of throwing a 404 → "Failed to fetch dynamically imported module"
    // console error on every page load.
    // The Framer runtime does:
    //   const { createEditorBar: e } = await import('/assets/framer.com/edit/init.mjs')
    //   return { default: e() }
    // So we MUST export a callable `createEditorBar` to avoid a TypeError.
    // It returns null so React renders nothing.
    await writeFileEnsured(
      outDir,
      'assets/framer.com/edit/init.mjs',
      `/* stubbed by framer-exporter — editor bootstrap is a no-op in static export */
export const createEditorBar = () => null;
export default createEditorBar;
`,
    );

    const manifest = buildManifest(liveUrl, crawlResult.origin, crawlResult.pages, store);
    await writeManifest(outDir, manifest);

    logger.info(
      { pages: manifest.totals.pages, assets: manifest.totals.assets, bytes: manifest.totals.assetBytes },
      'export-complete',
    );
    process.stderr.write(
      `\nDone. ${manifest.totals.pages} page(s), ${manifest.totals.assets} asset(s) saved to ${outDir}\n` +
        `Run:  npm run serve   (or:  framer-exporter serve)   then open http://localhost:3000\n\n`,
    );
  } finally {
    await session.close();
  }
}

function collectHosts(store: AssetStore): Set<string> {
  const hosts = new Set<string>();
  for (const rec of store.all()) {
    try {
      hosts.add(new URL(rec.url).hostname);
    } catch {
      // ignore malformed
    }
  }
  return hosts;
}

async function writeAssets(
  outDir: string,
  store: AssetStore,
  rewrite: boolean,
  _hosts: Set<string>,
  jsReplacements: ReturnType<typeof buildJsReplacements> = [],
): Promise<void> {
  const assetLookup = (originalUrl: string): string | undefined => {
    const rec = store.lookup(originalUrl);
    return rec?.rootRelativePath;
  };

  for (const rec of store.all()) {
    if (!rewrite || !isTextual(rec.contentType)) {
      await writeFileEnsured(outDir, rec.localPath, rec.body);
      continue;
    }

    let text = rec.body.toString('utf8');
    const lower = (rec.contentType.split(';')[0] ?? '').toLowerCase();

    if (lower === 'text/css') {
      text = await rewriteCss(text, { baseUrl: rec.url, lookup: assetLookup });
    } else if (
      lower === 'application/javascript' ||
      lower === 'text/javascript' ||
      rec.localPath.endsWith('.js') ||
      rec.localPath.endsWith('.mjs')
    ) {
      text = rewriteJs(text, { replacements: jsReplacements });
    } else if (lower === 'image/svg+xml') {
      // SVG can have <style> with url() and href references — treat like CSS for url() at minimum
      text = await rewriteCss(text, { baseUrl: rec.url, lookup: assetLookup });
    }
    // JSON / plain text: leave alone

    await writeFileEnsured(outDir, rec.localPath, text);
  }
}

async function writePages(
  outDir: string,
  pages: Map<string, string>,
  origin: string,
  store: AssetStore,
  rewrite: boolean,
  canonicalUrl?: string,
  stripSelectors?: string[],
  subscribeRedirect?: { url: string; text?: string },
): Promise<void> {
  // Build page lookup map: normalized URL → root-relative HTML path
  const pageMap = new Map<string, string>();
  for (const url of pages.keys()) {
    const local = pageLocalPath(url);
    // Rewrite "/foo/index.html" → "/foo/" for clean URLs (sirv --single handles both)
    const clean = local === 'index.html' ? '/' : '/' + local.replace(/\/index\.html$/, '/');
    pageMap.set(url, clean);
  }

  const assetLookup = (originalUrl: string): string | undefined => {
    const rec = store.lookup(originalUrl);
    return rec?.rootRelativePath;
  };
  const pageLookup = (url: string): string | undefined => pageMap.get(url);

  for (const [url, html] of pages) {
    let out = html;
    if (rewrite) {
      out = await rewriteHtml(html, {
        pageUrl: url,
        siteOrigin: origin,
        assetLookup,
        pageLookup,
        canonicalUrl,
        stripSelectors,
        subscribeRedirect,
      });
    }
    const rel = pageLocalPath(url);
    await writeFileEnsured(outDir, rel, out);
  }
}

function buildManifest(
  sourceUrl: string,
  origin: string,
  pages: Map<string, string>,
  store: AssetStore,
): Manifest {
  let totalBytes = 0;
  const assetEntries = store.all().map((rec) => {
    totalBytes += rec.body.length;
    return {
      url: rec.url,
      localPath: rootRelativeAssetPath(rec.localPath),
      bytes: rec.body.length,
      contentType: rec.contentType,
    };
  });

  return {
    sourceUrl,
    origin,
    runAt: new Date().toISOString(),
    pages: Array.from(pages.keys()).map((url) => ({
      url,
      localPath: '/' + pageLocalPath(url),
    })),
    assets: assetEntries,
    totals: {
      pages: pages.size,
      assets: assetEntries.length,
      assetBytes: totalBytes,
    },
  };
}
