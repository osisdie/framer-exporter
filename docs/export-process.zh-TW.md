# framer-exporter 運作原理

這份文件摘要 `framer-exporter` 把 Framer 站(React SPA + 動態 CDN assets)下載成可獨立運行的靜態網站時所用的技術手法。

---

## 為什麼一般爬蟲不行

`wget` / `curl` / `HTTrack` 等通用 site mirror 工具對 Framer 站只能抓到空的 React shell — 內容都靠 client-side 從 JS modules 和 JSON manifest 動態 hydrate 出來。要拿到完整渲染後的 DOM,必須:

1. 跑真的瀏覽器
2. 等 hydration 完成
3. 攔截 browser 發出的每個網路請求

`framer-exporter` 用 **Playwright + headless Chromium** 達成。

---

## Pipeline(7 階段)

```
1. 開 Chromium(持久 context)
   └─ launchPersistentContext 把 cookies 存在 .browser-data/
      登入一次,後續執行不用重登。

2. 解析 start URL
   └─ 偵測編輯器 / preview / published / custom-domain URL。
      編輯器 URL 自動轉換為 framer.app/preview/<id>(若可達);
      失敗則 fallback 到請使用者手動指定。

3. 安裝網路攔截器                                                 ★ 關鍵
   └─ context.route('**/*') → route.fetch() → buffer body → route.fulfill()
      一次 crawl 同時側錄 HTML 和所有 assets,
      不需要第二階段 download。

4. BFS 多頁爬取
   └─ p-queue 併發 3,scroll 觸發 lazy-loaded assets。
      Same-origin + path-prefix 雙重 scope 限制 — 防止意外擴散到
      同 host 但不相關的頁(例如 framer.app 上的行銷頁
      跟 /preview/<id> 共用同 origin)。

5. Top-up phase                                                  ★ 關鍵
   └─ 掃 HTML 內 srcset 變體 + JSON manifest + JS bundle 內所有
      指向已知 asset hosts 但 browser 在此 viewport 沒實際 fetch 的 URL,
      用 Playwright 的 APIRequestContext 補抓下來。

6. 三引擎 URL 改寫
   └─ HTML → cheerio walk 所有帶 URL 的 attribute
   └─ CSS  → postcss + postcss-url 處理 url(...)(自動跳過 data URI)
   └─ JS   → 已知 CDN host prefix 做 string.replaceAll()
             (絕對不對 minified bundle 做 AST parse)

7. 寫到 output/ 並 serve
   └─ Canonical 命名 + sirv-cli static server。
```

---

## 三個核心技術突破

### 1. Canonical asset paths(規範化檔名)

Framer 的圖片 CDN 用 query string 提供多解析度:
`abc.png?width=512`、`abc.png?width=1024`、`abc.png?scale-down-to=2048` 等等。

直覺做法是把 query 雜湊成 suffix,各變體存成 `abc--HASH1.png`、`abc--HASH2.png`。
**但問題是**:Framer 的 React runtime 在執行時會構造 URL 像
`/abc.png?width=ANYTHING` — 這些 URL 永遠對不上雜湊命名的檔名,結果產生
數百個 404。

解法:**完全捨棄 query 在檔名中的呈現**。每張圖只存一份 canonical
`abc.png`(取最大解析度的變體)。因為 `sirv` 會忽略 query string,
**browser 不論要哪種尺寸的變體,都會 hit 到同一個檔案**。Browser 在較小
viewport 用 CSS 縮放 — 比 CDN 動態壓縮多耗一點頻寬,但視覺完全相同。

**結果**:檔案數減少 ~75%,所有 viewport 全部 0 個 404。

### 2. Top-up 掃描 JSON / JS

Framer 把圖片 hash 大量塞在 JSON manifest
(`api.framer.com/.../assets.json`)和 JS bundle
(`framerusercontent.com/.../*.mjs`)裡,**不在 HTML 中**。Browser 只會
請求當前 capture viewport 寬度需要的變體 — 其他 breakpoint 的圖完全
沒被 request 到,自然也沒存到。

Top-up phase 用 regex 掃描每個被攔截到的 textual response(JSON、JS、CSS),
找出所有指向已知 asset hosts 的絕對 URL,把還不在 AssetStore 內的
全部抓下來。這樣會捕捉到:

- 只在 phone / tablet 顯示的圖片變體
- Lazy-loaded section 的 assets(scroll 階段沒 trigger 到的)
- Favicon(headless browser 不下載)
- Runtime 動態構造、嵌在 module bundle 內的路徑

**Top-up 前**:358 assets,non-capture viewport 各有 90+ 個 404。
**Top-up 後**:2,304 assets,完全 0 missing。

### 3. JS bundle 只能字串替換,絕不 AST parse

Minified 生產 bundle(每個 ~2 MB)如果做 AST parse 再 serialise:
- 會改變 byte sequence
- 破壞 source map 和 integrity check
- 每檔多 500–2000 ms CPU 成本

Exporter 對每個觀察到的 CDN host prefix 做**字面字串替換**:

```js
body.replaceAll('https://framerusercontent.com', '/assets/framerusercontent.com')
```

這做法 byte-safe,但帶來一個副作用 — JS 內的 asset 路徑變成
**root-relative absolute**(`/assets/...`),所以 export 後**必須用真的
HTTP server 提供**,`file://` 協定不能用。`sirv`(已內建)處理掉這部分。

---

## 過程中遇到的 bug

| 症狀 | 根本原因 | 修法 |
|---|---|---|
| 背景執行時跳過 login wait | 非 TTY 環境下 `readline.createInterface` 立刻 emit `close` event | 加 file-sentinel fallback (`.framer-exporter-ready`) |
| Crawler 開不了新 page | Pre-crawl loop 把所有 page close 了,連讓 browser 進程活著的最後一個 page 也關掉 | 不要 close,只讀 URL |
| Crawler 擴散到不相關的頁 | 只用 same-origin 過濾,同 host 下的 marketing 頁也被當成內部連結 | 加 path-prefix scope |
| `framer.app/preview/<id>` 顯示的是 Framer 行銷頁不是你的內容 | 該 URL 設計給編輯器內 iframe 用,不能 standalone | 偵測無效 → 請 user 提供 published URL |
| Bare `framerusercontent.com` URL 被 topup regex 漏掉 | `[a-z0-9.-]+` quantifier 強制要求至少 1 個 subdomain 字元 | 改 `(?:[a-z0-9-]+\.)*` 容許 0 subdomain |
| **Auth token 洩漏進 output** | `api.framer.com/auth/...` 和 `/edit/...` 的回應被無差別捕捉 | 加 `PRIVACY_BLOCKLIST` 並用 `PRIVACY_PATH_ALLOWLIST` 明列例外的 runtime config |

---

## 驗證機制

Export 完成後會跑 Playwright 比對腳本:同時渲染 live Framer 站和 local
副本(三個 viewport),拍 full-page screenshot,比對 dimensions + byte 大小,
並記錄 local 副本若有任何外部 host 請求。

最近一次跑(against 某個有代表性的 published Framer 站)的數據:

| Viewport | Page height(live = local) | Screenshot byte diff | 外部 hosts | 4xx/5xx |
|---|---|---|---|---|
| Desktop 1440 | 3724 px = 3724 px | 0.0% | 0 | 0 |
| Tablet 1024 | 3982 px = 3982 px | 0.6% | 0 | 0 |
| Phone 390 | 4967 px = 4967 px | 1.9% | 0 | 0 |

每個 viewport 的 page height 完全相同,代表 layout、字體 metrics、圖片
尺寸、breakpoint 解析全都跟 live 一致。1–2% 的 byte 差異來自 carousel /
動畫的 frame timing 在截圖瞬間的微小不同,不是渲染瑕疵。

---

## 最終 output 結構

```
output/                                         91 MB
├── index.html                                   292 KB 改寫過的主頁
├── manifest.json                                Assets/pages 清單 + 執行 metadata
└── assets/
    ├── framerusercontent.com/                   圖片、字體、runtime modules
    ├── app.framerstatic.com/                    Framer runtime JS
    ├── framercanvas.com/                        Canvas 相關
    ├── api.framer.com/                          Runtime config(auth/edit 路徑被擋)
    ├── framer.com/m/                            Module short-links
    └── …其他 hosts…
```

Export 出來的站**對 Framer 完全零 runtime 依賴**。DevTools Network tab
只會看到 `localhost:3000` 請求 — 可以原封不動 deploy 到 Netlify、Vercel、
S3、Nginx,或任何 static host。
