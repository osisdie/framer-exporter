# framer-exporter

[![CI](https://github.com/osisdie/framer-exporter/actions/workflows/ci.yml/badge.svg)](https://github.com/osisdie/framer-exporter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.json)

Crawl a published Framer site, decouple it from Framer's CDNs, and produce a fully self-contained static website you can serve from any HTTP host.

> **Why?** Framer doesn't ship an official "export to HTML" feature, and naive crawlers like `wget` only capture the empty React shell. `framer-exporter` runs a real headless Chromium, lets the site fully hydrate, intercepts every asset the browser actually loads, and rewrites every `framer.com` / `framerusercontent.com` / `framerstatic.com` URL to a local path. The exported site has zero runtime dependency on Framer.

---

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [URL types accepted](#url-types-accepted)
- [CLI reference](#cli-reference)
- [Verifying the export](#verifying-the-export)
- [Helper scripts](#helper-scripts)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- 🎭 **Playwright + persistent session** — log in once, the browser profile persists across runs
- 🕸️ **BFS crawler** — same-origin + path-prefix scoping, scroll-trigger for lazy-loaded assets
- 🪝 **Network interceptor** — `BrowserContext.route('**/*')` records every fetched asset in one pass; no second-phase download
- 🔍 **Top-up phase** — regex-scans HTML / JSON / JS bundles for asset URLs the browser didn't fetch at the capture viewport (covers per-breakpoint variants and runtime-constructed paths)
- ✏️ **Three-engine URL rewriting** — cheerio for HTML, PostCSS + `postcss-url` for CSS, byte-safe `replaceAll` for minified JS bundles (never AST-parsed)
- 🪪 **Privacy filter** — auth tokens and editor-only API responses are blocked from disk
- 🧹 **Owner-UI strip** — Framer "Made in" badge, edit-bar shell, and editor-init module replaced with a no-op stub
- 🔗 **`--canonical-url`** — overrides `<link rel=canonical>` and `og:url` so the export doesn't advertise its source preview URL
- ✂️ **`--strip-selector`** — repeatable CSS selector flag (`:has()` / `:contains()` supported) to hide unconfigured form widgets or any other elements
- 🧪 **Vitest unit tests** + GitHub Actions CI on Node 20 & 22
- 📦 **Bundled `serve`** — `sirv-cli` for one-command local verification

---

## Quick start

```bash
git clone https://github.com/osisdie/framer-exporter.git
cd framer-exporter
npm install                                   # also runs `playwright install chromium`
npm run dev -- export "<published-framer-url>"
npm run serve                                 # open http://localhost:3000
```

First run opens a headed browser so you can sign in to Framer; subsequent runs are headless and reuse the saved session.

---

## URL types accepted

| Form | Example | Notes |
|---|---|---|
| Editor URL | `https://framer.com/projects/<slug>--<id>` | Auto-resolves to `framer.app/preview/<id>` when reachable. |
| Preview URL | `https://framer.app/preview/<id>` | Requires login (uses persisted session). |
| Published URL | `https://<site>.framer.website` | No login needed. |
| Custom domain | `https://example.com` | Site must be Framer-hosted. |

---

## CLI reference

```
framer-exporter export <url> [options]
  -o, --out <dir>           Output directory                  (default: ./output)
  -c, --concurrency <n>     Parallel page crawl                (default: 3)
  -d, --depth <n>           BFS max depth (0 = unlimited)      (default: 10)
      --headed              Force headed browser
      --no-scroll           Skip lazy-load scroll trigger
      --viewport-width <n>  Capture viewport width             (default: 1440)
      --keep-cdn            Don't rewrite CDN URLs (debug)
      --canonical-url <url> Override <link rel=canonical> + og:url
      --strip-selector <s>  Remove every element matching this CSS selector (repeatable)

framer-exporter serve [options]
  -o, --out <dir>           Directory to serve                 (default: ./output)
  -p, --port <n>            Port                                (default: 3000)
```

Common environment variables (loaded from `.env`, see `.env.example`):

| Var | Used by |
|---|---|
| `LIVE_URL` | `scripts/compareLiveVsLocal.ts`, `scripts/diagnoseMobileBug.ts` |
| `LOCAL_URL` | helper scripts |
| `DEPLOY_URL` | `scripts/verifyAccess.ts` |
| `CF_PAGES_PROJECT`, `CF_ACCOUNT_ID`, `CF_TOKEN` | optional Cloudflare deploy automation |

---

## Verifying the export

After `npm run serve`:

1. Open `http://localhost:3000`.
2. **DevTools → Network**, reload, confirm zero requests to `framer.com`, `framerusercontent.com`, `framerstatic.com`.
3. Resize across the three Framer breakpoints (Desktop ≥ 1200, Tablet 810–1199, Phone < 810). Layout should be identical to the live site.
4. **Console**: zero errors expected (the editor-bootstrap stub provides a no-op `createEditorBar`).
5. `cat output/manifest.json` to inspect captured pages and assets.

For automated checks:

```bash
npm test                              # unit tests (vitest)
npx tsx scripts/verifyExport.ts       # screenshot at 3 viewports + log external requests
npx tsx scripts/compareLiveVsLocal.ts # side-by-side live vs local diff
```

---

## Helper scripts

| Script | Purpose |
|---|---|
| `scripts/verifyExport.ts` | Take screenshots at 3 viewports, log external requests + 4xx/5xx + console errors |
| `scripts/compareLiveVsLocal.ts` | Render live + local at 3 viewports, report dimensions / byte deltas |
| `scripts/verifyAccess.ts` | Confirm a deployed URL is gated by Cloudflare Access |
| `scripts/diagnoseMobileBug.ts` | DOM dump at phone viewport (used to track down RWD-specific issues) |
| `scripts/probeSubscribe.ts` | Fill the form on the local copy + click Subscribe + log outgoing POST |
| `scripts/pixelDiff.ts` | Pixel-diff two PNGs with hotspot Y-bands |
| `scripts/cropBand.ts` | Crop a PNG to a Y range (for focused visual review) |

---

## How it works

Full technical write-up:

- [`docs/export-process.md`](docs/export-process.md) (English)
- [`docs/export-process.zh-TW.md`](docs/export-process.zh-TW.md) (繁體中文)

---

## Limitations

- **Form submissions** and runtime CMS fetches are not preserved — this is a static export.
- **Custom-code components** that call external APIs at runtime will still try those APIs (and may 404).
- **Output is uncompressed** for inspectability; gzip / brotli your CDN if you need transfer-size optimisation.
- **Cloudflare Pages preview deployments are public by default** — gate them with Cloudflare Access if your content is confidential.

---

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

Quick dev loop:

```bash
npm run dev -- export <url>   # iterate on the exporter
npm run typecheck             # tsc --noEmit
npm test                      # vitest run
npm run test:watch            # vitest in watch mode
```

---

## License

[MIT](LICENSE) © framer-exporter contributors
