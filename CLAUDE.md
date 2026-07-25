# skin-market-lab — agent notes

CS skin market research tracker. Zero-dependency Node server (`server.js`,
port 8790) + static dashboard (`index.html`), no build step. `npm start`.
The dashboard deploys to GitHub Pages (pages.yml, gh-pages branch mirror)
and boots in one of THREE modes (skins.js): live (a tracker answered
discovery: same-origin → saved address → localhost:8790, CORS-backed),
STATIC (no tracker, but `data/index.json` exists on the host → read-only
dashboard from the collector's committed files), or the setup panel
(neither). Preserve that ladder when touching boot().

## Architecture

- HOSTED COLLECTOR (the primary UX — "the link works alone"): collect.yml
  runs `node collect.js` every 6h on Actions; it snapshots every
  `watchlist.json` item, appends `data/history/<slug>.jsonl`, and writes
  `data/index.json` (manifest: quote + analytics summary per item → the
  static page paints the whole watchlist with ONE fetch), then commits.
  gates.yml paths-ignores `data/**` so those commits skip the probe battery
  but still trigger the Pages mirror. `data/` is PUBLIC and committed;
  `local-data/` is the tracker's PRIVATE dir (gitignored) — never swap the
  two. Committed `data/import/<slug>.json` files merge into collector
  analytics (that's how deep backfills reach the hosted dashboard).
- Static mode is read-only by design: "track more" links to editing
  watchlist.json on GitHub, "snapshot now" links to the workflow_dispatch
  page, the portfolio lives in localStorage. Day-0 momentum falls back to
  Skinport realized-sale medians (tiles marked `*`); items under 30 days
  show a warm-up chip instead of silent dashes.
- Snapshot-accrual model (local tracker): watchlist prices append to
  `local-data/history/*.jsonl` over time; full multi-year Steam history
  backfills via paste-import (`POST /api/skins/import`) or STEAM_COOKIE
  bootstrap. First boot seeds the private watchlist from watchlist.json.
- `assembleSeries` in analytics.js is the ONE canonical raw-records→series
  assembly — server, collector, and browser static mode all call it; never
  fork that logic per surface. Same rule for `marketOverview` (the Lab Case
  Index / cash ratio / volume block): collector publishes it in
  data/index.json, the live server serves it at /api/skins/market — one
  function, three surfaces. today{} must stay non-null for skins-only sets
  (ratio/volume/players don't depend on cases).
- SLOSH DETECTION: `cashAdjustedIndex` (caseIdx × cashRatio rebased — the
  basket in REAL dollars) and `corrDaily` (log-return pearson vs BTC, null
  under 10 paired days) live in analytics.js; the collector records BTC/ETH
  (CoinGecko, keyless) + players per run into data/market.jsonl and folds
  them into market.series. Home chart draws wallet index / cash-adjusted /
  BTC-rebased on ONE base-100 axis (never two scales). Stablecoins are the
  actual cash-out rails but are pegged — that's why BTC/ETH are the
  correlation benchmarks.
- CN/US ACTIVITY gauge: the cron's fixed sample hours double as regional
  peaks — 11:17 UTC ≈ Beijing evening, 23:17 UTC ≈ US evening; collect.js
  windows market.jsonl player readings (10–15 UTC vs 22–03 UTC, max per
  window) into series.cnus = cn/us. Manual runs at other hours don't
  disturb it. Buff-spread integration is PARKED: needs a user-registered
  key (steamwebapi.com free tier serves Buff163 prices) added as an
  Actions secret before wiring.
- THREE INDEX FAMILIES (marketOverview buckets): case (cat "case", steam
  marks), liq (non-case with ≥5 median sold/day — self-gating: "liquids"
  must BE liquid), art (watchlist.json art[] tags, marked to artDaily =
  skinport 30d-median sp30 fields carried on skinport snap lines, because
  grails sit above the ~$1,800 steam listing cap → no steam quote is
  EXPECTED for art, not an error). Art items' manifest latest falls back
  to the 30d sale median.
- HOME-FIRST UI: boot lands on renderHome (strip + movers + ranked sortable
  table + sparklines); item detail is one click deep with a ← Market back
  button. The watchlist is ~all cases (the index basket) + a few blue-chip
  skins — keep the basket broad, the index is only as good as its coverage.
- `analytics.js` is UMD and SHARED VERBATIM by server (require) and browser
  (window.SkinAnalytics) — keep it dependency-free and side-effect-free;
  the probe pins its math to hand-computed values.
- `market.js` holds all fetchers with an INJECTABLE transport
  (`setTransport`) — that's what makes both gates hermetic. Any new data
  source goes through it, never a bare fetch.

## Gates (both in CI, run before every push)

- `node probe.js` — 81 checks: analytics units, full API flow, snapshot
  dedupe, import/bootstrap, portfolio P/L, restart persistence,
  watchlist seeding, the collector (manifest, import merge, dedupe).
- `node client-probe.js` — 32 checks, real Chromium (PLAYWRIGHT_LIB env
  overrides the library path): chart-pixels-painted assert, crosshair
  tooltip, portfolio form, static-host discovery, setup panel, and the
  full STATIC DATA mode (read-only boot from collected files, fallback
  tiles, warm-up chip, localStorage portfolio).
  Screenshots → /tmp/skin_lab.png + /tmp/skin_lab_static.png.

## Traps learned (do not re-learn these)

- Steam volume "31,263" is en-US thousands — `parseMoney` treats a trailing
  3-digit comma group as thousands; unit counts go through `parseCount`
  (digits-only). EU price strings ("43,80€") still parse as decimals.
- Skinport API is brotli-ONLY (`Accept-Encoding: br` +
  `zlib.brotliDecompressSync`) and hard rate-limited: 8 req/5min PER IP on
  /v1/items AND /v1/sales/history (proven empirically 2026-07-25 — exactly
  8 succeed then 429s). The collector therefore refreshes sales for a
  ROTATING 8-item window per run (data/skinport-cursor.json) and serves
  stale aggregates from data/sales.json between turns. NEVER bulk-fetch
  sales; the tracker's own caches keep 30min–12h TTLs.
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
