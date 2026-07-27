# Skindex (repo: skin-market-lab) — agent notes

NAMING: the product is **Skindex** — wordmark, page titles, the flagship
index's display name, and all prose. FROZEN identifiers that are NOT
branding and must never be renamed: the `SMLX-*` methodology version
codes, the `SETTLE-*` fixing IDs, canonical-hash inputs, data-file schema
keys (e.g. `caseIdx`), localStorage keys, and the repo name / URLs
(`skin-market-lab`, blackjakk.github.io/skin-market-lab) until the GitHub
repo itself is renamed.

OFFLINE STUDIES pattern: `backtest.js` → `backtest/result.json` and
`corr.js` → `backtest/corr.json` (Skindex × BTC × players correlation
study, backtest.html §7; home VS-BITCOIN tile shows its 12y baseline).
Studies are pure derivations of committed artifacts — no network, never
inputs to the live index. Re-run `node corr.js` whenever the backtest
artifacts refresh.

SETTLEMENT SCALE-UP (2026-07-27) — OI capacity + contracts:
- HASH-STABILITY RULE (the invariant everything hangs on): `METHODOLOGY`
  stays "SMLX-6" — it is embedded in every fixing's canonical form, so
  changing it re-hashes history and forks every witness. New fixings are
  ADDITIVE catalog entries (SETTLE-CASE-90D, added 2026-07-27, minDays 30)
  with their own accrual; witness/server/collector pick them up dynamically
  (they iterate computeAll's keys). A canonical-preimage byte pin in probe.js
  fails CI on any drift. Probe fixtures must be TIME-STABLE: never pin a
  value that flips when the wall-clock date crosses a fixture threshold
  (the 2026-07-27 date-rollover bug — pins now derive expectations from the
  fixture's own published state).
- `budget.oiCapacity` (settlement.js): per-fixing OI line — safety condition
  C(Δ) > N×Δ; boundConcentrated = cost1pct/1%, boundCapture = captureCost/5%
  (Δcap under a dispute layer), capacityLinear = min/3 (κ=3). Bounds divide
  the PUBLISHED rounded costs so the line re-derives from the record's own
  bytes. methodology.html §5b renders it. LISTING.md is the venue-facing
  parameter sheet (read capacity live, linear-only, no near-money binaries).
- PERPMARK-CASE (settlement.js S.perpMark): EXPERIMENTAL perp-grade mark —
  median of last ≤5 daily prints + 2% step guard, pure fold over the
  published series, NON-canonical (latest.perpmark, no hash), nothing
  settles on it. methodology §5c.
- SMLX-7 DRAFT PREVIEW (analytics.js): `marketIdx` = cases+liquids under
  the exact SMLX-6 rules — additive fields only, labeled "NOT a settlement
  input" everywhere; center-corroboration INTEG lane (steam clamp center vs
  Skinport cash-implied center, |dev|>0.03 log ⇒ flag-only) publishes
  daysObserved/daysWouldBind — the observation phase gating the future
  SMLX-7 hardening (center must corroborate or the day carries).
  budget.marketUniverse publishes the combined universe's capture economics
  (informational; no fixings → no capacity line).
- CONTRACTS (contracts/, hardhat devDeps ONLY — runtime stays zero-dep):
  SkindexSettlement.sol (bonded propose → challenge window → resolver →
  finalize; getFixing reverts unless finalized) + WitnessOracle.sol
  (curated registry, quorum median). 58 tests, `npm ci && npx hardhat test`
  (a `contracts` job in gates.yml). Deploy = user action (DEPLOY.md).
- Collector cadence: every 3h (hourly is the M5 end-state, noted in
  collect.yml). Known one-shot: first 3-hourly run after a new fixing ships
  may show one self-healing witness MISMATCH cycle (≤3h window).

EVIDENCE TIERS (INTEG-1 revision `2026-07-27-evidence-tiers`) — corroboration
is RANKED, never counted:
- Every lane publishes a `strength` + cost-to-fake in `INTEG_RULES.lanes`
  (published in every record): **strong** = realized sales (`ratio`,
  `volume`, `art-evidence` — faking them burns the 15%/12% venue fee, the
  same burn manipulationBudget prices), **medium** = standing bids (`book` —
  no fee to post/pull, real capital at risk), **weak** = asks (`venue` — a
  listing is FREE to post), **n/a** = `staleness` (liveness, corroborates no
  price).
- THE RULE: **divergence from an ask venue is evidence; agreement is not.**
  The venue lane keeps every watch/alert it had, at the same thresholds; its
  AGREEMENT no longer counts as corroboration. Coverage is published, not
  dropped: per venue `checked`/`agreed`/`counts:false`, and
  `summary.corroboration.{strong,medium,weak}` reports per tier —
  NEVER one summed number. Summary key `venueCorroborated` was RENAMED
  `venueChecked` on purpose (the old name asserted something false).
  Be honest in any UI/doc copy: this made the published corroboration
  numbers SMALLER than they read before. That is the fix, not a regression.
- `volume` LANE (new, strong): steam sold-per-day vs the item's OWN trailing
  30d baseline, then median-gated cross-sectionally (market-wide surge or
  drought flags nobody — same logic as the ratio lane and the index clamp).
  Flags a significant idiosyncratic move whose volume response collapsed vs
  the market. Fed from `mi.daily` (collector) / `it.daily` (server) — no new
  fetch, no new store. THRESHOLDS ARE MEASURED over backtest/history (49
  items, 103,518 item-days since 2019), documented inline in INTEG_RULES:
  move watch 0.10 = 97.1st pct, alert 0.20 = 99.2nd; response watch −0.5 =
  1.4th pct, alert −1.0 = 0.16th; volMinUnits 10 = the measured knee (flag
  rate 1.06% below 10 units/day vs 0.15% above); joint rate 0.111% of
  item-days. THE MEASUREMENT CORRECTED THE PREMISE: genuine big moves do NOT
  come with a volume surge (median response +0.04 log), so "volume didn't
  rise" is useless as a rule — the discriminator is the LEFT TAIL. Re-measure
  if you change a threshold; never guess one.
- BUDGET: `manipulationBudget().detection` states the tiering only where it
  can be stated without inventing a number — ask surcharge exactly 0, strong
  and medium tiers explicitly UNPRICED, and the note that no lane's move
  threshold binds a clamp-limited (0.05 log) push, so no published floor
  changed.
- Gate: the contiguous "EVIDENCE-TIER + VOLUME-LANE PINS" block in probe.js
  (hand-computed; ends with the firewall pin — collector run with
  assessIntegrity LIVE vs STUBBED → byte-identical series/weights/budget/
  fixing preimages/hashes).

THIRD-VENUE LANE (INTEG-1 `venue`, 2026-07-27, WEAK tier — see above)
— corroborate the marks:
- Pluggable ADAPTER interface (`M.venueAdapters`), never one hardcoded
  scraper: TM Market + Waxpeer (public dumps) and Buff163. THE BUFF
  FINDING: `/api/market/goods/info?goods_id=<id>` answers logged OUT —
  only name→id DISCOVERY needs a session, so `BUFF_COOKIE` gates that one
  call and `data/buff-ids.json` (an UNTRUSTED hint map, re-verified every
  read) keeps the lane credential-free. No cookie + no id → "not
  configured", published unavailable, collector run untouched.
- NEVER add a venue whose price is DERIVED from Steam. BitSkins was
  rejected for exactly this: its suggested_price measured a 1.000 median
  ratio to our own Steam mark, so it would agree by construction and
  inflate coverage with a tautology. Verify independence before adding.
- Comparison is MEDIAN-RELATIVE, not level — these venues sit ~0.66×
  Steam and the discount moves with FX, so a level test flags the whole
  market daily. Tolerances published in every record (venueDevWatch .25 /
  venueDevAlert .5 / venueUniqueMult 1.6 / venueMinQuotes 5 /
  venueMaxAgeH 48).
- Readings live in `data/venues.json`, NEVER in the history jsonl — a
  stray `src` line would fold a third venue's ask into assembleSeries and
  silently change the published index.
- FLAG-ONLY + FIREWALLED, proven by a probe pin that runs the collector
  twice (all venues live vs all dead) and asserts byte-identical series,
  weights, budget, fixing preimages and fixing HASHES.
- Coverage is honest: per-venue `ok | insufficient | no-quotes |
  unavailable` with a reason; an unavailable venue is never counted as
  agreement, a stale quote is not even checked — and since the evidence
  tiering an AVAILABLE venue's agreement buys no corroboration either.
- Known limits: all three publish ASKS not realized sales (hence weak tier);
  TM Market and Waxpeer correlate strongly (~1.3 independent reads, not 3).

STEAM INVENTORY (2026-07-27) — "value my inventory, chart it, beat the index":
- NO SIGN-IN BY DESIGN. CS2 inventories are PUBLIC JSON
  (`steamcommunity.com/inventory/<id>/730/2`); Steam OpenID would only prove
  identity (useless here) and needs a backend callback the static Pages build
  cannot have. Input is a profile URL / vanity / SteamID64. Do NOT "add login"
  as an improvement — it removes capability and adds attack surface.
- ONE CANONICAL JOIN: `A.parseSteamInventory` (analytics.js, UMD) is the only
  assets×descriptions implementation; market.js DELEGATES to it so the Node
  fetch path and the browser paste path cannot drift (same rule as
  `assembleSeries`). Rows key on `classid_instanceid` — one market_hash_name
  may appear on several rows (floats/stickers); `A.inventoryValue` is where
  names are aggregated, so build UI tables off ITS rows, never raw `items`.
- FIREWALL: inventory data is display-only. It never enters marketOverview,
  the published series, a fixing, or a hash — same status as item-view deep
  history.
- PRIVACY: a SteamID is personal data. Live mode stores under `local-data/`
  (gitignored), static mode in localStorage; nothing is uploaded; the only
  outbound call is to Steam. Probe fixtures use the fake id
  76561190000000001 — never commit a real one.
- NEVER FABRICATE: unpriceable items are counted as unpriced, not guessed;
  the reconstruction publishes a VALUE-weighted `coveragePct` and omits
  historyless items from the line rather than interpolating them.
- Steam rate-limits inventory reads: go through `polite()` and the ≥10-minute
  server cache; a cached read must not re-fetch (probe-pinned).
- CORS IS AN ALLOWLIST, NEVER `*` (adversarial review, BLOCKER). This API
  answers with personal data — portfolio lots, SteamID64, holdings. A
  wildcard ACAO let ANY page the user had open read all of it via a
  no-preflight GET, and a `text/plain` POST rewrite stored state (CSRF);
  both reproduced end-to-end. `corsOrigin()` reflects only the Pages
  origin / localhost / `SKIN_ALLOW_ORIGIN`, a foreign origin is refused
  403 BEFORE any handler runs (omitting the header still lets the request
  EXECUTE), and the socket binds 127.0.0.1 unless `SKIN_HOST` opens it.
  Probe-pinned in both directions — never reintroduce `*`.
- LIKE-FOR-LIKE RETURNS (adversarial review, BLOCKER). The reconstruction
  admits each item on its OWN first mark, so a return measured from
  `days[0]` books an item ENTERING the basket as a gain — a flat portfolio
  in a flat market printed +900pp alpha, and real data +23,842pp. Every
  return leg opens at `max(recon.fullFrom, index inception)` and truncates
  the index at the inventory's last day; where no like-for-like window
  exists, print NOTHING rather than a number. `spanDays` is a DURATION,
  not a count of marked days. The server and client copies must stay
  identical (cross-surface probe check).
- SNAPSHOT SERIES ARE IDENTITY-KEYED: `{t,value,count,id,sig}` — `id` the
  SteamID64 (digested client-side so it never enters localStorage), `sig`
  a fingerprint of the sorted name×qty composition. A line joins like with
  like only; anonymous pastes key on composition. Without this a second
  person's inventory extended your line and printed a nonsense loss.
- THE USER CAN ERASE EVERYTHING: `POST /api/skins/inventory/forget` (+ the
  🧹 UI control) deletes the stored profile/SteamID, the fetch cache and
  the whole recorded history; POST-only so no link or prefetch can fire
  it. Any new personal-data storage must extend it — storing what cannot
  be withdrawn makes the panel's privacy copy false.

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
  fork that logic per surface. Same rule for `marketOverview` (the
  Skindex / cash ratio / volume block): collector publishes it in
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
  probe-pinned): the tamper DETECTOR over the single-venue marks. Lanes are
  TIERED by cost-to-fake (see "EVIDENCE TIERS" above — read that before
  touching a lane or a coverage string): ratio (item's daily skinport÷steam ratio vs its OWN trailing 30d
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

## Design System (all DOM/UI chrome) — route ALL new UI through it

**`DESIGN.md` (repo root) is the visual contract — READ IT BEFORE ANY UI
BUILD** (markup, CSS, canvas paint, DS work). It spells out color (CS2
palette on Coinbase discipline: ONE action orange, rarity-ramp data
colors, WCAG-validated values), type scale, spacing, radius (pill CTAs),
elevation, and component rules. The skins.css :root palette + --ds-*
tokens are its implementation; if the doc and a token disagree, fix one
in the same diff. A palette change = update DESIGN.md + the token + the
ds-component-test pins together, and re-run the WCAG math (a11y-probe
gates the floors).

The dashboard + doc pages render their chrome through ONE Design System in
`design-system/` (tokens.css → --ds-* aliases over the skins.css :root
palette + spacing/radius/type scales; ds.css → .ds-* component classes,
token-only; ds.js → UMD `window.DS` HTML-string factories, analytics.js
pattern). **Non-negotiable: all NEW UI goes through DS.* factories /
.ds-* classes / --ds-* tokens — never hand-roll.** Enforced by
`node tools/ds-guard.js` (no-bypass ratchet, in gates.yml; baseline
tools/ds-guard-baseline.json, debt locked at 20 post-migration — lower is
fine, `--update-baseline` ONLY to lock a verified gain, never to admit a
bypass; judge by BARE exit code).
- Factories: DS.tile/tiles/chip/toggle/btn/rangeChips/legendItem/panel/
  hint/badge/specTable + helpers esc/cx/attrs/keyActivate. Text escaped by
  default; TRUSTED slots are html/labelHtml/valueHtml/subHtml/body +
  specTable {html} cells. No inline handlers — factories emit data-* hooks,
  consumers bind addEventListener after innerHTML; DS.keyActivate binds
  click+Enter+Space (the .mrow pattern). Docs: design-system/README.md,
  rules: CONTRACT.md, live demo: gallery.html, gate:
  `node tools/ds-component-test.js` (72 checks, real Chromium, port 5410).
- PROBE CONTRACTS RIDE ALONGSIDE: legacy classes/ids asserted by
  probe.js/client-probe.js (.mrow, .tile .lb, .ranges .btn[data-r],
  .ovToggle, .moverChip, .sigCard, .warmup, table.mkt, a.btn, …) are kept
  NEXT TO the .ds-* classes via the cls slot — never rename/remove them.
  Two spots deliberately keep hand structure + ds- outer class because a
  frozen INNER selector can't be produced by the factory: item-view stat
  tiles (`.tile .lb`) and item-view range chips (`.ranges .btn[data-r]`).
- DETERMINISM FIREWALL: DS is DOM-only. analytics.js / settlement.js /
  collect.js / witness.js / backtest.js / server-side math never import or
  depend on it; index + fixings stayed byte-identical through the
  migration (probe 133 pins it).
- KNOWN survivors (in baseline, legitimate): canvas stroke/fill literals
  in skins.js + backtest.html chart scripts (canvas needs literal color
  strings; getComputedStyle resolves the vars at runtime) and the modal
  backdrop rgba (no scrim token yet).
- Review: the `design-system-review` skill
  (.claude/skills/design-system-review/SKILL.md) is the checklist for ANY
  UI diff — guard + escaping + frozen contracts + determinism + gates.

## Accessibility (hardened 2026-07-26 — keep it that way)

Full record (issues → fixes → proof → residual risks): `A11Y.md`. Reviewer
checklist for ANY UI diff: the `accessibility-review` skill
(.claude/skills/accessibility-review/SKILL.md) — run it alongside
design-system-review. Gate: `node tools/a11y-probe.js` (34 checks, in CI).
Traps learned (do not re-learn):

- Bare `1fr` grid tracks are `minmax(auto,1fr)` — min-content of a table or
  a JS-sized canvas dictates PAGE width (home locked itself at 873px on
  phones). Tracks around content-sized things must be `minmax(0,1fr)`, and
  any canvas whose backing is set from JS must pin `cv.style.width` too.
- Hover style ≠ focus style: reusing the bg-swap for `:focus-visible` +
  `outline:none` made 64 tab stops invisible (1.09:1). House ring =
  `2px solid var(--ds-focus)`, offset −2px inside rows/options.
- innerHTML re-renders dump focus to `<body>`: any handler that re-renders
  sets `pendingFocus` (applied by renderHome/renderItem). Use the function
  form for ids — ds-guard's hex lexer reads the string `"#backBtn"` as a
  color and trips the ratchet.
- Modal discipline: opener captured INSIDE `openImport()` (open-path-
  agnostic), one shared `closeImport()` restores it, Tab wraps while open,
  Esc scoped + stopPropagation. `window.openImport/closeImport` stay
  exposed — the a11y probe drives them (static mode has no import button).
- Sort headers: real `<button class="thbtn">` inside the th (clicks bubble
  to the legacy th listener; native key activation); `aria-sort` on the
  active th only.
- Touch targets live in `@media (pointer: coarse)` (44px buttons/toggles,
  32px chips, ≥24px floor) — desktop metrics stay byte-identical.
- Contrast tokens are measured values (`--text-muted #878a94`,
  `--line-input #6a6e7a`, `--vol-bar #636a7a`); canvas paint READS
  `--text-muted` (never hardcode a token copy in JS). Doc-page tables live
  inside `.ds-scroll-x`.
- Deliberately deferred (see A11Y.md): roving tabindex on market rows and
  link-in-name-cell row semantics — both blocked by the frozen `.mrow
  tabindex=0` probe contract; skip link + range-sized data tables are the
  mitigations. Chart crosshair stays mouse-only by design.

## Gates (all in CI, run before every push)

- `node probe.js` — 273 checks: analytics units (incl. SMLX-3
  winsorization, SMLX-4 volume weights/cap, SMLX-5 weighted-median
  clamp, concentrated/center-capture budget arithmetic, INTEG-1 lane
  pins incl. the evidence-tier + volume-lane block, order-book fetcher
  parsing), full API flow, snapshot dedupe,
  import/bootstrap, portfolio P/L, restart persistence, watchlist
  seeding, the collector (manifest, import merge, dedupe, book store,
  integrity attestation).
- `node tools/ds-guard.js` — DS no-bypass ratchet (exit 0 required).
- `node tools/ds-component-test.js` — 77 checks, real Chromium: every DS
  factory, escaping, aria-pressed toggles, keyboard activation, specTable
  scroll wrapper + scope.
- `node tools/a11y-probe.js` — 34 checks, real Chromium (~15s): viewport
  sweeps (no horizontal scroll at 390/768/1000/1360), phone tap hit-test,
  focus rings under real Tab, keyboard sort, modal trap/restore,
  stale-search-Enter, WCAG contrast on computed styles, coarse-pointer
  target sizes, ARIA/landmark batch, skip link, focus restore, zero page
  errors.
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
