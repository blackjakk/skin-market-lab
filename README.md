# Skindex — CS skin market analysis over time

A self-contained market-research tool for Counter-Strike skin investing:
a zero-dependency Node tracker that records prices **over time** and a
dashboard with charts, indicators, cross-market fee math, and a portfolio
P/L ledger. Zero dependencies — plain Node and a static page, nothing to
build. (Grew up inside the hashmark-heroes repo; now lives here.)

> **Not financial advice.** The signal is a transparent heuristic — every
> point of its score is itemized so you can judge the inputs yourself. Skin
> markets are volatile and thin; Steam proceeds are wallet-locked.

## Quick start — just open the link

**https://blackjakk.github.io/skin-market-lab/**

That's the whole product for most use: a GitHub Actions collector
(`collect.yml`) snapshots every item in `watchlist.json` every 3 hours **on
GitHub's servers** and commits the data; the page reads those files. Charts,
momentum, signals, cross-market fee math, and a portfolio (stored in your
browser) — no install, nothing to keep running, works on your phone.

- **Track more items** — edit `watchlist.json` (the ✎ button in the app
  links straight there). Exact Steam `market_hash_name` strings; the next
  collector run picks them up.
- **Snapshot right now** — Actions → *Collect market data* → Run workflow
  (the ⚡ button links there). The site refreshes when it commits.
- **Instant deep history for an item** — commit a Steam pricehistory dump
  as `data/import/<slug>.json` (get the slug from `data/index.json`), or
  use the local tracker's paste-import below. Until an item has ~30 days of
  history the dashboard says so, and its momentum tiles read from Skinport's
  realized-sale medians (marked `*`) so you get a signal from day zero.

## Power mode — the local tracker (optional)

```
git clone https://github.com/blackjakk/skin-market-lab
cd skin-market-lab
npm start                # tracker + dashboard on http://localhost:8790
```

When a local tracker is running, the same page (either URL) switches to
live read/write: on-demand snapshots, full-universe search (the ~20k-name
Skinport dump), devtools paste-import, `STEAM_COOKIE` full-history
bootstrap, and a server-side portfolio. Private data lives in `local-data/`
(gitignored) — the committed `data/` dir belongs to the hosted collector.
On first boot the tracker seeds its watchlist from `watchlist.json`, so it
opens populated.

## Track your own inventory (no sign-in)

Point the app at a Steam profile and it values the whole CS2 inventory,
charts what it has been worth over time, and scores it against the
Skindex — the same ±pp α the portfolio panel shows, for everything you own.

**There is no sign-in, no password, and no API key** — and that is a design
decision, not a missing feature. CS2 inventories are already public JSON
(`steamcommunity.com/inventory/<steamid64>/730/2`), so identity proof buys
nothing here; Steam's OpenID would only add a login screen and force a
backend this project deliberately doesn't have. Paste a **profile URL,
vanity name, or SteamID64** and that's the whole flow.

- **Local tracker** — the server resolves the profile, fetches the public
  inventory (cached, so Steam's rate limits are respected), prices every
  item, and appends a value snapshot each time you load it.
- **Hosted page** — browsers can't read steamcommunity.com directly (no
  CORS headers), so the app gives you the URL, you paste the JSON back in,
  and the identical math runs in your browser. Snapshots live in
  localStorage.

**Privacy:** a SteamID is personal data. Nothing is uploaded anywhere —
the local tracker keeps inventory data in gitignored `local-data/`, the
hosted page keeps it in your own browser, and the only outbound request is
to Steam itself. The tracker answers only its own dashboard (an origin
allowlist, never a wildcard) and listens on loopback unless you set
`SKIN_HOST`. **🧹 Forget** erases the stored SteamID, the cached inventory
and the whole recorded value history — from the tracker's disk and from
this browser.

**Your alpha is measured honestly.** Because each item joins the
reconstruction on its own first price mark, a naive return would count an
item *appearing* as a gain. The window therefore opens only once every
holding has history (it is shown on the tile), and where no like-for-like
window exists the app prints nothing rather than a flattering number.

**Honest coverage:** an inventory holds items far outside the 64-name
tracked set. Items we can price are priced (tracked marks first, then the
Skinport dump); items we can't are reported as unpriced rather than
guessed. The value-over-time reconstruction says what share of your
current value it can actually back-price — the rest is left out of the
line instead of being invented.

## Getting deep history immediately

Snapshots only build history going forward. Two ways to backfill years of
Steam price history per item (both use the local tracker; to publish a
backfill to the hosted dashboard, commit the resulting
`local-data/import/<slug>.json` file as `data/import/<slug>.json`):

1. **Paste-import (no setup):** item view → *📋 Import history* — the modal
   gives you a one-liner to run in the devtools console of any logged-in
   steamcommunity.com tab; paste the result. Steam only serves
   `pricehistory` to logged-in browsers.
2. **Cookie bootstrap:** start the server with
   `STEAM_COOKIE="steamLoginSecure=..."` (copy from your browser's cookies)
   and use *⚡ Bootstrap full history* per item. The cookie stays on your
   machine; treat it like a password.

## The market home (what the header numbers mean)

- **Skindex** — chained: each day's move is the volume-weighted
  mean of tracked cases' daily returns, cumulated from 100 (SMLX-6 —
  weights are each case's median daily dollar volume over the prior
  month-end's trailing 60 days, capped at 10%; new cases season 365 days
  and enter on a published calendar, return-neutrally; each day's returns
  are winsorized at ±5% around the day's *weight-weighted* median, so one
  pumped name can't move the index — and neither can a count-majority of
  thin names, since seizing the clamp center now costs >50% of index
  weight — while market-wide moves still pass through). Cases are the
  market's commodity layer: the de facto "S&P of skins".
- **Cash ratio** — median (third-party realized sale ÷ Steam price).
  ~70–85% is normal; climbing toward 100% = strong real-money demand,
  collapsing = sellers trapped in Steam wallet funds.
- **Units sold/day** — total Steam sales across the tracked set (liquidity).
- **$ volume/day** — units × price paid across the tracked set (the dollar
  turnover the manipulation budgets and OI capacity are priced from); each
  market-table row carries its own sortable `$/day` column.
- **CS2 players** — live in-game count, the market's demand fundamental.
- **Liquids index** — same methodology over the commodity skins/knives
  with real Steam liquidity (≥5 sold/day) — the market's "currency" layer.
- **Art index** — the grail basket (Dragon Lore, Howl, Katowice 2014
  holos…), marked to Skinport 30-day realized-sale medians because these
  trade rarely and sit above Steam's ~$1,800 listing cap. Appraisal-style
  marks: slow, smooth, and honest about it.
- **Cash-adjusted index** (chart, aqua line) — the index × the cash ratio:
  the basket's value in REAL dollars. When the wallet-dollar line rises but
  this one doesn't, that's wallet inflation / exit pressure, not real
  appreciation — the slosh detector.
- **Vs Bitcoin** — 30-day correlation of index returns against BTC
  (CoinGecko benchmark; ETH recorded too). Appears once ten paired days
  accrue — measured, not vibed.
- **CN/US activity** — Asia-evening peak players ÷ US-evening peak
  (the collector's 11:17/23:17 UTC samples). A crude but real gauge of the
  regional demand mix — Chinese demand is this market's biggest swing
  factor.
- **BTC CN/US (30D)** — the same regional lens on the benchmark: each 3h
  BTC return is attributed to the session it ended in (Asia ≈ 09:00–18:00
  Beijing vs US ≈ 09:00–18:00 ET) and cumulated over 30 days; the tile
  shows the Asia−US spread. Accrues once the 3h collector samples exist —
  measured, not vibed.

## Embed the Skindex (stable JSON API)

The index is free to embed — one small JSON, refreshed every collector run
(3-hourly), served straight from this repo:

```
https://raw.githubusercontent.com/blackjakk/skin-market-lab/main/data/skindex.json
```

| Field | Meaning |
|---|---|
| `v` | schema version — within `1`, fields are never renamed or removed, only added |
| `level` / `chg24hPct` | the Skindex (base 100 at 2026-07-25 adoption) and its 24h move |
| `cashRatio` | the wallet-dollar exchange rate (realized cash ÷ Steam price) |
| `liquidsIdx` / `artIdx` | the commodity-skins and grail layers |
| `players` | live CS2 player count |
| `fixings` | every settlement fixing: value (or accruing state) + canonical SHA-256 |
| `updatedAt` / `day` / `methodology` | provenance |

Badge (shields.io endpoint):

```
![Skindex](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fblackjakk%2Fskin-market-lab%2Fmain%2Fdata%2Fbadge.json)
```

Attribution ("Skindex" + a link here) appreciated. Every number is
re-derivable from the committed `data/` files — don't trust the JSON,
verify it (methodology page, one click). Not financial advice.

The portfolio panel scores your lots against the index —
**VS SKINDEX: ±pp α** is your money-weighted out/under-performance over
the same money and holding periods (lots are timestamped at add).

## Settlement fixings (SMLX-6)

Dated settlement marks computed from the committed series by fixed rules —
what a cash-settled future or scalar market would settle against:
**SETTLE-CASE-7D/30D/90D** (means of the daily Skindex; 90D is the
quarterly-dated tenor, added 2026-07-27 as an additive SMLX-6 catalog
entry — new fixings accrue forward and never re-hash history) and
**SETTLE-RATIO-30D** (mean daily cash ratio). Each publishes with a
SHA-256 hash over its canonical form so any counterparty re-derives it
bit-exactly from `data/`; fixings show "accruing" until their minimum day
count exists and are never backfilled. The full rulebook — mark
construction, patch-event policy, the live **manipulation budget**
(fee-burn floor to move a fixing 1%, priced for the uniform, the
cheapest weight-accumulation, and the >50%-weight center-capture
attack), and one-click in-browser
verification — is on the site at
[methodology.html](https://blackjakk.github.io/skin-market-lab/methodology.html).
A measurement, not an offer of any instrument.

**Open-interest capacity** — each settlement record now also publishes
`budget.oiCapacity`: the per-fixing OI a linear instrument could carry
before corrupting the fixing pays (safety condition C(Δ) > N×Δ; bounds
from the concentrated 1% attack and the center-capture attack under a
5%-credible-print dispute layer; published capacity = min(bounds)/3 as
corruption margin; hedging ceiling ≈ the basket's daily $ volume rides
as an independent cap). Assumptions are published inside every entry;
methodology §5b explains the model. Alongside it, **PERPMARK-CASE** is
an *experimental* perp-grade mark preview (median of the last ≤5 daily
prints + a 2% max-step guard, so one corrupted print cannot move it) —
clearly labeled, non-canonical, no hash, not a settlement fixing
(methodology §5c).

**Mark integrity (INTEG-1)** — because every mark is single-venue at its
source, each collector run also publishes a tamper report: every Steam
price is corroborated against the item's own realized-cash ratio history,
against its own realized **sold-per-day** (did the trade follow the
price?), and against Steam's standing order book (a second read path wash
trades can't cheaply fake); art marks publish their sale-count evidence,
and venue loss raises a loud staleness alert. **Evidence is ranked, not
counted**: each lane publishes a strength set by what it would cost to
fake — *strong* for realized sales (faking one burns the venue fee),
*medium* for standing bids, *weak* for third-venue asks, which are free to
post. So divergence from an ask venue still flags at full strength while
its agreement is published but **not** counted as corroboration, and
coverage is reported per tier instead of one number. (That makes these
figures smaller than they read before — deliberately.) Divergences are
**flagged, never auto-rejected** (auto-rejection would let an attacker
knock honest marks out of the index by manipulating the thinner
corroborating venue). Scheduled collector runs add random sampling jitter
so reading instants can't be pinned. The home page shows the current state
as a MARK INTEGRITY tile; the full tier and flag tables are on the
methodology page.

**Backtested.** The methodology's behavior through real history is
measured, not asserted:
[backtest.html](https://blackjakk.github.io/skin-market-lab/backtest.html)
reconstructs the index 2014→now by running the exact shipped code over
Steam's own daily aggregates — +4,346% (CAGR 37.5%), the CS2
announcement (+92%/30d), the 2023–24 −53% drawdown, and per-variant
proof of what each protection rule is worth. The reconstruction also
caught two methodology defects (penny-mark quantization, seasoning far
too short) that are now fixed as SMLX-6 — which is exactly what a
backtest is for. The same page carries a **correlations study**
(`node corr.js` → `backtest/corr.json`): twelve years of Skindex ×
Bitcoin × player-count evidence — monthly return correlation ≈ +0.19
(R² 3.7%), no BTC lead at any monthly lag, decoupled drawdowns in both
directions, and an honest test showing the player-count lead is a
fundamental's fingerprint, not a tradeable edge after fees.

**Don't trust me — witness it.** Fork this repo and enable Actions: your
fork's `witness.yml` then independently verifies every publication — it
re-derives the whole index from the committed raw files with the
collector's own code, checks every fixing hash byte-exactly, and takes its
own live Steam samples against the published marks, every 6 hours. Any
divergence fails the workflow on **your** fork (red CI + GitHub's failure
email), entirely outside the operator's reach. This repo also witnesses
itself (`data/witness.json`) — that catches drift, not dishonesty; real
assurance is running your own. Design + threat analysis:
[TRUST_ARCHITECTURE.md](TRUST_ARCHITECTURE.md).

## What the analytics mean

All computed in `analytics.js` (shared verbatim by server and
browser; unit-pinned by the probe):

- **7D/30D/90D** — momentum vs the closest recorded day that far back.
- **SMA 7/30** — moving averages, also drawn on the chart.
- **RSI 14** — Wilder's; >75 flagged overbought, <30 oversold.
- **Volatility /yr** — annualized σ of daily log returns (last 30d).
- **Off peak** — current drawdown from the all-time recorded high.
- **Sold/day** — median daily units sold (Steam), the liquidity gate.
- **Signal** — additive score in [−100, +100] from the above, verdicts
  STRONG BUY … STRONG SELL, with every contribution listed. Illiquid items
  get dampened — a great chart you can't exit isn't a great investment.
- **Where to sell** — net proceeds after fees on both venues: Steam
  (÷1.15, wallet-locked funds) vs Skinport (−12%, real cash, using the
  median of *actual realized sales*, not asks).

## Data sources

| Source | What | Auth |
|---|---|---|
| Steam `priceoverview` | live median/lowest + 24h volume | none |
| Steam `pricehistory` | full multi-year daily history | login cookie (or paste) |
| Steam listing page (embedded book) | standing order book (bid/ask/depth — the INTEG-1 second read path) | none |
| Skinport `/v1/items` | full item dump → search + ask prices | none (brotli) |
| Skinport `/v1/sales/history` | realized-sale medians 24h/7d/30d/90d | none (brotli) |

Rate limits are respected (3.5s politeness gap to Steam; Skinport cached
30min–12h). Collected data lands in `data/` (committed by the collector); the local tracker keeps its private copy in `local-data/` (gitignored).

## Design System

All UI chrome (dashboard + doc pages) renders through one component
library: `design-system/` — `--ds-*` tokens, `.ds-*` classes, and
`window.DS` factories with escaping by default. A CI ratchet
(`tools/ds-guard.js`) blocks any new hand-rolled component, color, or
font bypass, and a 77-check real-Chromium component test covers every
factory including keyboard and ARIA behavior. See
[design-system/README.md](design-system/README.md).

The visual contract — palette (CS2 identity: one action orange + the
rarity ramp as data colors, all WCAG-validated), type scale, spacing,
radius, elevation, and component rules — lives in
[DESIGN.md](DESIGN.md); the token layer implements it and agents read it
before any UI build.

## Accessibility

The app is built to be completable by keyboard alone, on phones, and at
200% zoom: visible focus everywhere, focus preserved across re-renders, a
focus-trapped import dialog, keyboard-sortable tables with `aria-sort`,
WCAG-AA-measured contrast tokens, 44px touch targets on coarse pointers,
landmarks + status regions, and range-sized data-table equivalents for
every chart. A 34-check real-browser regression gate
(`npm run probe:a11y`) enforces it in CI; the full issue → fix →
residual-risk record is in [A11Y.md](A11Y.md).

## Gates

- `npm run probe` — 273 checks, hermetic (fixture transport):
  analytics math pinned to hand-computed values, full API flow, snapshot
  dedupe, import/bootstrap, portfolio P/L, restart persistence.
- `npm run probe:a11y` — 34 real-Chromium accessibility checks: responsive
  sweeps, keyboard operability, focus management, contrast, touch
  targets, ARIA semantics.
- `npm run probe:ui` — 39 real-Chromium checks across live AND static modes:
  chart pixels actually painted, crosshair tooltip, range switching,
  portfolio form, zero page errors. Screenshot → `/tmp/skin_lab.png`.

All run in CI on every push. The UI probe needs playwright
(`npm i --no-save playwright && npx playwright install chromium`, or set
`PLAYWRIGHT_LIB` to an existing install).
