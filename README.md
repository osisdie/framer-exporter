# framer-exporter

Download a published or preview Framer site and output a fully-decoupled static website that can be served from any HTTP server. All `framer.com`, `framerusercontent.com`, and `framerstatic.com` URLs are rewritten to local paths — the exported site has zero runtime dependency on Framer.

## Features

- BFS crawl of an entire Framer site (auto-discovers internal pages)
- Captures HTML, CSS, JS, fonts, images, and video via Playwright network interception (no missed assets — what the browser fetches is what we save)
- Rewrites every CDN URL to a local path (HTML via cheerio, CSS via PostCSS, JS via safe string replace)
- Preserves all RWD breakpoints (Desktop ≥ 1200, Tablet 810–1199, Phone < 810) — the rewritten HTML still uses the original CSS media queries
- Persistent browser session (`.browser-data/`) so you only log in once
- Bundled `serve` command (sirv-cli) — verify locally on `http://localhost:3000`

## Quick start

```bash
npm install                                 # also runs `playwright install chromium`
npm run dev -- export "<framer-url>"        # first run opens a browser for login
npm run serve                               # http://localhost:3000
```

### URL types accepted

| Form | Example | Notes |
|---|---|---|
| Editor URL | `https://framer.com/projects/<slug>--<id>` | Requires login. Tool will prompt you to navigate to a preview / published URL in the headed browser. |
| Preview URL | `https://framer.app/preview/<id>` | Requires login. Uses session from `.browser-data/`. |
| Published URL | `https://<site>.framer.website` | No login needed. |
| Custom domain | `https://example.com` | No login needed (assuming the site is on Framer hosting). |

## CLI

```
framer-exporter export <url> [options]
  -o, --out <dir>             Output directory                 (default: ./output)
  -c, --concurrency <n>       Parallel page crawl              (default: 3)
  -d, --depth <n>             BFS max depth (0 = unlimited)    (default: 10)
      --headed                Force headed browser
      --no-scroll             Skip lazy-load scroll trigger
      --viewport-width <n>    Capture viewport width           (default: 1440)
      --keep-cdn              Don't rewrite CDN URLs (debug)

framer-exporter serve [options]
  -o, --out <dir>             Directory to serve               (default: ./output)
  -p, --port <n>              Port                              (default: 3000)
```

## Verifying the export

After `npm run serve`:

1. Open `http://localhost:3000` in a browser
2. Open DevTools → **Network** tab → reload. Confirm zero requests to `framer.com`, `framerusercontent.com`, or `framerstatic.com`. Every request must hit `localhost:3000`.
3. Resize the browser window across the three breakpoints and confirm the layout adapts identically to the live Framer site.
4. Check the **Console** tab for 404s (would indicate JS bundles still reference unmapped CDN URLs).
5. `cat output/manifest.json` to inspect captured pages and assets.

## Notes & limitations

- Form submissions and runtime CMS fetches are not preserved (this is a static export).
- Framer Plugins and custom-code components that call external APIs at runtime will still try to call those APIs (and likely 404).
- The output is uncompressed for inspectability.
- The `output/` and `.browser-data/` directories are gitignored — never commit scraped content.

## Architecture & how it works

- [`docs/export-process.md`](docs/export-process.md) — full technical writeup (English)
- [`docs/export-process.zh-TW.md`](docs/export-process.zh-TW.md) — 完整技術說明(繁體中文)
