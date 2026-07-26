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
- SMLX-5 CONSTRUCTION (perp-grade): indices CHAIN daily returns
  (cumulated from 100) so constituent entry/exit is RETURN-NEUTRAL — no
  level jump to front-run. WINSORIZED since SMLX-3: each constituent's
  daily log-return is clamped to ±INDEX_RULES.clampLog (0.05) around the
  day's MEDIAN return before averaging — market-wide moves pass through
  untouched (the median moves with them), single-name pumps are capped.
  WEIGHTED-MEDIAN CLAMP CENTER since SMLX-5: the clamp is centered on the
  WEIGHT-weighted median (weightedMedian helper), not the plain one —
  SMLX-4's unweighted center was a one-name-one-vote election a COUNT
  majority of thin names could capture (pump them → median follows → pump
  sits unclamped AND honest names get dragged toward it); weighting the
  center means seizing it costs a >50% WEIGHT coalition, and a single name
  (capped 0.10) can never control it. Equal weights → weighted median ==
  plain median EXACTLY, so inception/fallback paths are byte-unchanged.
  VOLUME-WEIGHTED since SMLX-4 (case+liq; art stays
  equal): the day's return is the WEIGHTED mean, weight = median daily
  $volume over the 60d ending at the PRIOR MONTH-END (fully lagged,
  monthly rebalance — today's trading can never move today's weights;
  median ⇒ gaming a weight needs 30+ days of sustained wash volume),
  normalized, capped at weightCap 0.10 (effective max(cap, 1/N), excess
  redistributed pro-rata; one name's max daily pull = 0.10×0.05 = 0.5%).
  Fallbacks are NEUTRAL: <weightMinObs obs in window → median weight of
  observed names; no observations at all (inception month) → equal. The
  clamp center uses these SAME weights (see WEIGHTED-MEDIAN CLAMP CENTER
  above). Current-month weights published in market.weights {case,liq} +
  manifest item.weight (budget consumes them). New listings (first mark
  after INDEX_RULES.adoption 2026-07-25) season 30 days then enter on the
  next first-of-month; founding cohort grandfathered; art marks carry
  forward between sparse observations. includedFromDay/INDEX_RULES
  exported for the probe, which pins no-jump, clamp, passthrough,
  weighting, cap, and median-capture defense directly. NEVER revert to
  level-vs-base — a new case release would create a published riskless
  trade against any instrument settling on the fixing.
  TIME-STABILITY NOTE (probe): adoption 2026-07-25 is now PAST, so a case
  first-seen "today" seasons out (caseIdx null) instead of basing at 100.
  The live/collector index-base probes seed a founding-cohort mark at the
  adoption date (seedFounding helper) so tested items match the real
  basket's grandfathered status — series = {launch, today}, 2 flat marks,
  index 100, stable forever. Seed BEFORE the snapshot (assembleSeries is
  order-sensitive; an out-of-order older line is dropped).
- SETTLEMENT LAYER (SMLX-5, settlement.js — UMD, pure, shared by
  collector/server/methodology page): dated fixings (SETTLE-CASE-7D/30D,
  SETTLE-RATIO-30D) = means over the published daily series with MIN-DAY
  gates (null + "accruing" until met — never fabricated, never backfilled);
  canonical() gives the byte-exact hash preimage (node crypto and browser
  crypto.subtle must agree); manipulationBudget() = fee-burn floor to move
  a fixing 1% — THREE models: uniform (wash 0.5 × basket $vol × fee ×
  window days); concentrated (the clamp caps one name's pull at
  weight×0.05, so a 1% move needs ≥20% of index WEIGHT; greedy cheapest
  fee-burn per unit of weight against the PUBLISHED weights — the
  HEADLINE floor, always quote the cheaper attack; items without a
  weight fall back to equal share = the SMLX-3 cheapest-k); and
  centerCapture (SMLX-5: seize >50% of index weight → control the
  weighted-median clamp center → UNBOUNDED move; the price of CONTROL,
  the number an instrument's total notional / OI cap must respect).
  Collector writes
  data/settlement.json + appends data/settlements.jsonl (readers take
  last-per-day); methodology.html is the public rulebook with in-browser
  re-derivation → ✓ VERIFIED badges. Rule changes bump the methodology id.
  This is a published MEASUREMENT — never present it as operating an
  instrument.
- MARK INTEGRITY (INTEG-1, assessIntegrity in settlement.js — pure,
  probe-pinned): the tamper DETECTOR over the single-venue marks. Four
  lanes: ratio (item's daily skinport÷steam ratio vs its OWN trailing 30d
  median, then vs the day's cross-sectional median deviation — same
  median-relative gate as the index clamp, so market-wide ratio shifts
  never flag; "steam-rich" = pump suspect), book (steam last-sale median
  vs the STANDING order book — the second read path; wash trades fake
  prints, not committed capital; flags when the quote escapes its bid/ask
  bracket ±15%/±30%), art-evidence (<3 realized sales behind an appraisal
  mark), staleness (<50% fresh steam quotes = venue-loss alert). Output:
  manifest.market.integrity + the settlement record's integrity field +
  the home MARK INTEGRITY tile + methodology §5a (#integOut). FLAG-ONLY —
  NEVER auto-reject a mark: rejection would let an attacker manipulate the
  THIN venue (skinport) to force honest steam marks out and surgically
  break return pairs. Flags change no fixing computation, so INTEG does
  NOT bump SMLX (a version bump without a computation change would
  falsely signal a rules change to hash verifiers) — INTEG versions
  independently. Thresholds live in INTEG_RULES, published in every
  record. Server parity: /api/skins/market serves the lanes it has
  (ratio+staleness; book/sales are collector-fed) — coverage strings stay
  honest. Sampling jitter: scheduled collect.yml runs sleep 0-10min
  (schedule-only guard, so probes/manual runs never wait) — reading
  instants can't be pinned; CN/US windows tolerate the shift.
- ORDER-BOOK LANE plumbing: item_nameids scraped ONCE from the public
  listing page (Market_LoadOrderSpread regex) → data/steam-nameids.json
  (committed, auditable); readings rotate BOOK_BUDGET=10 steam-marked
  items/run (data/book-cursor.json) → data/book.json + manifest
  item.book. NEVER write book lines into history jsonl — assembleSeries
  would fold an extra src into daily price marks. Art items are excluded
  (the ~$1,800 listing cap distorts grail asks). TRAPS (live payload):
  highest_buy_order/lowest_sell_order are STRING CENTS ("2250"=$22.50);
  buy/sell_order_graph rows are [price_DOLLARS, CUMULATIVE qty, label].
  On HTTP 4xx for a cached nameid, drop it (renamed item) → re-resolve.
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

- `node probe.js` — 119 checks: analytics units (incl. SMLX-3
  winsorization, SMLX-4 volume weights/cap, SMLX-5 weighted-median
  clamp, concentrated/center-capture budget arithmetic, INTEG-1 lane
  pins, order-book fetcher parsing), full API flow, snapshot dedupe,
  import/bootstrap, portfolio P/L, restart persistence, watchlist
  seeding, the collector (manifest, import merge, dedupe, book store,
  integrity attestation).
- `node client-probe.js` — 36 checks, real Chromium (PLAYWRIGHT_LIB env
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
  sales; the tracker's own caches keep 30min–12h TTLs. AND: skinport
  reports ZEROS (not nulls) for windows with no sales — pz() in market.js
  maps zero prices to null (volume 0 stays); a $0 price is never a mark.
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
