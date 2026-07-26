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
- SMLX-6 CONSTRUCTION (perp-grade): indices CHAIN daily returns
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
  after INDEX_RULES.adoption 2026-07-25) season 365 days (SMLX-6 — the
  measured supply-decay phase; was 30) then enter on the
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
- SETTLEMENT LAYER (SMLX-6, settlement.js — UMD, pure, shared by
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
  prints, not committed capital; COMMODITY/case items ONLY — unique
  items' buy orders sit on premium float/pattern variants far above the
  generic median (live false-alarm 2026-07-26: Redline quote $42 vs a
  $197 variant bid → 6 bogus alerts); flags when the quote escapes its bid/ask
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
- ORDER-BOOK LANE plumbing (rebuilt live 2026-07-26): Steam's listing
  pages are now an SSR React app — Market_LoadOrderSpread/item_nameid are
  GONE from the HTML and the legacy itemordershistogram flow is
  unreachable (do NOT resurrect it). steamOrderBook(name) instead
  extracts the book from the SSR hydration payload's react-query cache
  (queryKey ["market","orderbook",730,name]): ONE public request per
  item, no id, no auth. TRAPS: amtMaxBuyOrder/amtMinSellOrder are
  INTEGER CENTS; rgCompactBuy/SellOrders are flat [cents,qty,…] pairs
  with PER-LEVEL quantities (SUM within range for depth — not cumulative
  like the old graphs); payload is nested-escaped JSON → strip ALL
  backslashes then plain-regex the keys (fields are numeric, nothing in
  them can hold a backslash); listing URLs 302 to a canonical code URL →
  httpGet follows ≤3 redirect hops (don't remove that). Readings rotate
  BOOK_BUDGET=10 steam-marked items/run (data/book-cursor.json) →
  data/book.json + manifest item.book. NEVER write book lines into
  history jsonl — assembleSeries would fold an extra src into daily
  price marks. Art items are excluded (the ~$1,800 listing cap distorts
  grail asks). BONUS FOUND: the same SSR payload embeds the FULL
  multi-year price history LOGGED-OUT (the "prices" query — {time,
  price_median, purchases} back to release) — a future replacement for
  the cookie/paste-import backfill machinery, unwired for now.
- HOME-FIRST UI: boot lands on renderHome (strip + movers + ranked sortable
  table + sparklines); item detail is one click deep with a ← Market back
  button. The watchlist is ~all cases (the index basket) + a few blue-chip
  skins — keep the basket broad, the index is only as good as its coverage.
- WITNESS PROTOCOL (witness.js + witness.yml — the trust-architecture
  layer; design doc TRUST_ARCHITECTURE.md): anyone forks the repo +
  enables Actions → their fork independently verifies every publication
  each 6h cycle (cron :47, 30min after the collector's :17). Three
  checks: (1) FULL RE-DERIVATION — fetch watchlist + every history
  jsonl + import file from the primary's Pages site and rebuild the
  index with collect.js's exported assembleMarketItem (ONE function
  shared by collector and witness — forking that logic false-alarms
  every witness; that's why it's exported), compare every published
  day's index fields + weights; (2) fixing hashes byte-exact +
  methodology stamp; (3) independent live Steam samples vs the
  primary's marks (|log dev| ≤ 0.12, alarm needs ≥2 divergent names —
  single-name drift between sampling instants is noise). MISMATCH/
  UNREACHABLE → exit 1 → red CI on the WITNESS repo + GitHub's failure
  email = the alarm, outside the primary operator's control. This repo
  self-witnesses (L0: catches drift/corruption, NOT operator honesty —
  the ladder is in the design doc). Verified live before shipping:
  ATTESTED against the real Pages site on first run. Buff163 third
  venue: DESIGNED in TRUST_ARCHITECTURE.md §4, deliberately NOT
  dark-built — wire it + live-verify in the same session the
  BUFF_API_KEY secret lands (the book-lane incident is the lesson).
- BACKTEST (backfill.js + backtest.js + backtest.html + backtest/ —
  offline STUDY, never a live-index input): reconstructs the case index
  2014→now by running the EXACT shipped marketOverview over Steam's own
  daily aggregates (steamPriceHistoryPublic — the SSR listing payload's
  "prices" query, logged-out). Variants isolate each protection by
  overriding the EXPORTED INDEX_RULES (withRules helper, restored in
  finally; probe pins zero leakage): shipped / noSeason / noClamp /
  equalWeight. STRICT SEPARATION: backtest/history/*.json must NEVER be
  copied into data/import/ — the collector merges import files into the
  LIVE index and a silent multi-year backfill would rebase every fixing.
  Regenerate: node backfill.js (network, ~4min, idempotent) then node
  backtest.js (pure, ~3s) → backtest/result.json → backtest.html.
  FINDINGS THAT BECAME SMLX-6 (the backtest caught two real defects):
  (1) penny-era marks ($0.02-0.10, one tick = ±30-50%) + 1-2-contributor
  days (the mover IS the weighted median → clamp can't fire) ratcheted
  the index to literal zero → minPrice 0.25 + minContributors 3;
  (2) 30d seasoning admitted cases mid-supply-decay (measured: −1590%/yr
  ann. months 0-3, −36%/yr months 3-12, SIGN FLIPS after year 1, +41%/yr
  4y+) while volume weights concentrate on exactly those high-volume new
  names → −95% over 12y vs equal-weight +2000% (the commodity-contango
  problem in skin form) → seasoningDays 365 (the measured knee: 30d→4.8,
  180d→2793, 365d→4446, 730d→4612 end level; equal-weight+365d → 5488,
  so the weighted-vs-equal gap is back to ~2%/yr = the honest cost of
  manipulation resistance). Reference result: +4,346% (CAGR 37.5%, vol
  40%, maxDD −53% peaking 2023-04-18 post-CS2-announce). Clamp engages
  ~97% of days and costs ~10%/yr of right tail vs noClamp — the
  measured, published price of settlement-grade manipulation resistance.
- ITEM-DETAIL DEEP HISTORY (deepHistoryBase in analytics.js, display
  layer ONLY): item charts + item analytics merge backtest/history/
  <slug>.json rows STRICTLY BEFORE the item's first collected/imported
  day (never overriding a collected mark). Wired in server.js itemReport
  + skins.js staticItemReport, each with an on-page disclosure hint.
  HARD RULE: this base must NEVER reach dailyFor/marketReport/the
  collector — the live index + fixings start at adoption and are never
  backfilled. backfill.js fetches ALL non-art watchlist items (cases
  feed the backtest; skins/knives exist ONLY for these item charts —
  backtest.js loadItems filters catOf==="case"). COVERAGE QUIRK (live,
  2026-07-26): unique items' SSR history depth varies wildly (Karambit
  Doppler FN 2,150 days; Redline FT exactly 1 row — bucketed UI serves
  some items almost nothing); cases are always rich (commodities).
  Shallow files merge harmlessly (deepDays 0 → no hint). The client
  probe keeps Fracture DAY-0 by 404ing its deep file in makeStatic (the
  warm-up/fallback path stays tested) and tests the deep chart on
  Kilowatt Case.
- HOME-CHART OVERLAYS (skins.js): the home chart stitches the backtest
  reconstruction to the live index and offers CS-players + BTC toggle
  overlays (state.overlays, default on). Sources: backtest/macro.json —
  steamchartsMonthly() (monthly avg players since July 2012, HTML parse)
  + btcHistoryAll() (blockchain.info, keyless, since 2010; CoinGecko free
  tier caps history at 365d — verified 401, don't retry) — one-shot via
  backfill.js, then joined to the LIVE daily players/btc the collector
  folds into market.series. REBASE SEMANTICS: every line rebases to 100
  at the first visible point of the selected range (1Y/5Y/ALL chips);
  the index family (recon+live+cash) shares ONE factor so the seam and
  the wallet-vs-real gap survive; overlays are CLAMPED to the index's
  own span (pre-index BTC at $0.07 would explode the scale). Log axis
  auto-engages when any visible line spans >6x. Axis labels have k/M
  tiers (a 7-char label overflows the 40px gutter).
- `analytics.js` is UMD and SHARED VERBATIM by server (require) and browser
  (window.SkinAnalytics) — keep it dependency-free and side-effect-free;
  the probe pins its math to hand-computed values.
- `market.js` holds all fetchers with an INJECTABLE transport
  (`setTransport`) — that's what makes both gates hermetic. Any new data
  source goes through it, never a bare fetch.

## Gates (both in CI, run before every push)

- `node probe.js` — 133 checks: analytics units (incl. SMLX-3
  winsorization, SMLX-4 volume weights/cap, SMLX-5 weighted-median
  clamp, concentrated/center-capture budget arithmetic, INTEG-1 lane
  pins, order-book fetcher parsing), full API flow, snapshot dedupe,
  import/bootstrap, portfolio P/L, restart persistence, watchlist
  seeding, the collector (manifest, import merge, dedupe, book store,
  integrity attestation).
- `node client-probe.js` — 39 checks, real Chromium (PLAYWRIGHT_LIB env
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
