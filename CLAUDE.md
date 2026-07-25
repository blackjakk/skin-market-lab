# skin-market-lab — agent notes

CS skin market research tracker. Zero-dependency Node server (`server.js`,
port 8790) + static dashboard (`index.html`), no build step. `npm start`.
The dashboard also deploys to GitHub Pages (pages.yml) and DISCOVERS a
local tracker (same-origin → saved address → localhost:8790,
`resolveApiBase` in skins.js; the API sends CORS for this) — with no
tracker reachable it renders a setup panel.

## Architecture

- Snapshot-accrual model: watchlist prices append to `data/history/*.jsonl`
  (gitignored) over time; full multi-year Steam history backfills via
  paste-import (`POST /api/skins/import`) or STEAM_COOKIE bootstrap.
- `analytics.js` is UMD and SHARED VERBATIM by server (require) and browser
  (window.SkinAnalytics) — keep it dependency-free and side-effect-free;
  the probe pins its math to hand-computed values.
- `market.js` holds all fetchers with an INJECTABLE transport
  (`setTransport`) — that's what makes both gates hermetic. Any new data
  source goes through it, never a bare fetch.

## Gates (both in CI, run before every push)

- `node probe.js` — 55 checks: analytics units, full API flow, snapshot
  dedupe, import/bootstrap, portfolio P/L, restart persistence.
- `node client-probe.js` — 17 checks, real Chromium (PLAYWRIGHT_LIB env
  overrides the library path): chart-pixels-painted assert, crosshair
  tooltip, portfolio form, static-host discovery + setup panel.
  Screenshot → /tmp/skin_lab.png.

## Traps learned (do not re-learn these)

- Steam volume "31,263" is en-US thousands — `parseMoney` treats a trailing
  3-digit comma group as thousands; unit counts go through `parseCount`
  (digits-only). EU price strings ("43,80€") still parse as decimals.
- Skinport API is brotli-ONLY (`Accept-Encoding: br` +
  `zlib.brotliDecompressSync`) and hard rate-limited (8 req/5min on
  /v1/items) → disk caches with 30min–12h TTLs + politeness gaps in
  market.js. Don't tighten the TTLs.
- Steam `pricehistory` needs a login cookie; `priceoverview` doesn't.
  Logged-out listing pages no longer embed `var line1` history.
- Snapshot volume readings are trailing-24h → daily bucket uses `volMode:
  "max"`; imported history rows are per-interval → `volMode: "sum"`.
- Chart palette (blue/aqua/orange/violet on surface #15161a) is
  dataviz-validated (CVD + normal-vision floors) — don't substitute hues
  casually; magenta beside orange FAILS the normal-vision floor.
- Steam proceeds are wallet-locked; fee math: steam net = price/1.15,
  skinport net = price×0.88 — keep both venues' nets visible, that spread
  is the difference between paper and realizable profit.
