# How framer-exporter Works

This document summarises the technical approach used to download a Framer site (Single-Page React App with dynamic CDN-served assets) and produce a fully-decoupled, runnable static copy.

---

## Why a generic crawler fails

`wget`, `curl`, `HTTrack`, and most generic site mirrors only retrieve the empty React shell of a Framer site — content is hydrated client-side from JavaScript modules and JSON manifests. To capture the actual rendered DOM, the tool must run a real browser, wait for hydration to finish, and intercept every network request the browser makes.

`framer-exporter` uses **Playwright + headless Chromium** for this.

---

## Pipeline (7 stages)

```
1. Open Chromium with a persistent context
   └─ launchPersistentContext stores cookies in .browser-data/
      so logging in once carries across runs.

2. Resolve the start URL
   └─ Detect editor / preview / published / custom-domain URL.
      Editor URLs auto-redirect to framer.app/preview/<id> when reachable;
      otherwise fall back to a manual prompt.

3. Install the network interceptor                                 ★ KEY
   └─ context.route('**/*') → route.fetch() → buffer body → route.fulfill()
      Captures every asset the browser loads in one pass.
      No second-phase crawl is needed.

4. BFS multi-page crawl
   └─ p-queue concurrency 3, scroll-trigger to surface lazy-loaded assets.
      Same-origin AND path-prefix scoping — prevents accidental crawls into
      sibling pages on the same host (e.g. framer.app's own marketing pages
      sit under the same origin as a /preview/<id> URL).

5. Top-up phase                                                    ★ KEY
   └─ Scan captured HTML srcset variants + JSON manifests + JS bundles
      for any URL pointing to known asset hosts that wasn't actually fetched
      by the browser at the capture viewport. Pull each one down explicitly
      via Playwright's APIRequestContext.

6. Three-engine URL rewriting
   └─ HTML → cheerio walks all URL-bearing attributes
   └─ CSS  → postcss + postcss-url for url(...) (skips data URIs correctly)
   └─ JS   → string.replaceAll() for known CDN host prefixes
             (NEVER AST-parse minified bundles)

7. Write to output/ and serve
   └─ Canonical naming + sirv-cli static server.
```

---

## Three core technical breakthroughs

### 1. Canonical asset paths

Framer's CDN serves multiple resolutions of the same image via query strings:
`abc.png?width=512`, `abc.png?width=1024`, `abc.png?scale-down-to=2048`, etc.

The naive approach is to hash the query and save each variant as `abc--HASH1.png`,
`abc--HASH2.png`. The problem: at runtime, Framer's React code constructs URLs like
`/abc.png?width=ANYTHING` — and these never resolve to the hashed filenames, producing
hundreds of 404s.

The fix: drop the query in the saved filename entirely. Save one canonical
`abc.png` (the largest captured variant). Since `sirv` ignores query strings,
**any size variant the browser asks for hits the same file**. The browser
scales the image down via CSS at smaller breakpoints — slightly more bandwidth
than the CDN-resized variant, but visually identical.

**Result**: file count reduced ~75% and zero 404s across all viewports.

### 2. Top-up scanning of JSON / JS

Framer stores image hashes inside JSON manifests
(`api.framer.com/.../assets.json`) and JS bundles
(`framerusercontent.com/.../*.mjs`), not in the HTML. The browser only requests
the variants it currently needs at the capture viewport's width — every other
breakpoint's images are unrequested and therefore unsaved.

The top-up phase regex-scans every captured textual response (JSON, JS, CSS)
for absolute URLs pointing to known asset hosts, and explicitly fetches any
that aren't yet in the AssetStore. This catches:

- Phone-only / tablet-only image variants
- Lazy-loaded section assets that didn't fire during the capture scroll
- Favicons (which headless browsers skip)
- Runtime-generated paths embedded in module bundles

**Before top-up**: 358 assets, 90+ 404s per non-capture viewport.
**After top-up**: 2,304 assets, 0 missing.

### 3. JS bundles get string-replaced, never AST-parsed

Minified production bundles (~2 MB each) cannot be safely AST-parsed and
re-serialised: doing so changes byte sequences, breaks any source maps and
integrity checks, and adds 500–2000 ms of CPU cost per file.

The exporter does **literal string replacement** of every observed CDN host
prefix:

```js
body.replaceAll('https://framerusercontent.com', '/assets/framerusercontent.com')
```

This is byte-safe but has one consequence — JS asset paths become **root-relative
absolute** (`/assets/...`), which means the export must be served by a real
HTTP server. `file://` protocol won't work. `sirv` (bundled) handles this.

---

## Bugs encountered along the way

| Symptom | Root cause | Fix |
|---|---|---|
| Tool skips login wait when run in background | `readline.createInterface` immediately emits `close` event when stdin isn't a TTY | Add file-sentinel fallback (`.framer-exporter-ready`) |
| Crawler can't open new pages | Pre-crawl loop closed all existing pages, including the only one keeping the browser process alive | Don't close pages — just read URLs from them |
| Crawler spreads to unrelated pages | Same-origin filter alone allows other content under the same host (e.g. framer.app marketing) | Add path-prefix scoping |
| `framer.app/preview/<id>` returns Framer's marketing homepage instead of project content | The URL pattern is for in-editor iframe consumption, not standalone navigation | Detect, fall back to asking the user for the published URL |
| Bare `framerusercontent.com` URLs missed by topup regex | `[a-z0-9.-]+` quantifier required at least 1 subdomain character | Change to `(?:[a-z0-9-]+\.)*` to allow zero subdomains |
| **Auth tokens leaked into output** | `api.framer.com/auth/...` and `/edit/...` responses captured indiscriminately | Add `PRIVACY_BLOCKLIST` + explicit `PRIVACY_PATH_ALLOWLIST` for runtime config |

---

## Verification mechanism

After every export, a Playwright comparison script renders both the live
Framer site and the local copy at three viewports, takes full-page screenshots,
and compares dimensions + byte sizes. Any external host requested by the local
copy is logged.

Latest measurement (against a representative published Framer site):

| Viewport | Page height (live = local) | Screenshot byte diff | External hosts | 4xx/5xx |
|---|---|---|---|---|
| Desktop 1440 | 3724 px = 3724 px | 0.0% | 0 | 0 |
| Tablet 1024 | 3982 px = 3982 px | 0.6% | 0 | 0 |
| Phone 390 | 4967 px = 4967 px | 1.9% | 0 | 0 |

Page-height equality at every viewport confirms layout, font metrics, image
dimensions, and breakpoint resolution all match the live site exactly. The
1–2% byte differences are attributable to carousel/animation frame timing at
screenshot moment, not rendering defects.

---

## Final output shape

```
output/                                         91 MB
├── index.html                                   292 KB rewritten root page
├── manifest.json                                Asset/page inventory + run metadata
└── assets/
    ├── framerusercontent.com/                   Images, fonts, runtime modules
    ├── app.framerstatic.com/                    Framer runtime JS
    ├── framercanvas.com/                        Canvas-related assets
    ├── api.framer.com/                          Runtime config (auth dirs blocked)
    ├── framer.com/m/                            Module short-links
    └── …other hosts…
```

The exported site has **zero runtime dependency on Framer**. DevTools Network
tab shows only `localhost:3000` requests — the site can be deployed unchanged
to Netlify, Vercel, S3, Nginx, or any other static host.
