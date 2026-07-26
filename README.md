# Skin Market Lab — CS skin market analysis over time

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
(`collect.yml`) snapshots every item in `watchlist.json` every 6 hours **on
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

- **Lab Case Index** — chained: each day's move is the volume-weighted
  mean of tracked cases' daily returns, cumulated from 100 (SMLX-5 —
  weights are each case's median daily dollar volume over the prior
  month-end's trailing 60 days, capped at 10%; new cases season 30 days
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

## Settlement fixings (SMLX-5)

Dated settlement marks computed from the committed series by fixed rules —
what a cash-settled future or scalar market would settle against:
**SETTLE-CASE-7D/30D** (means of the daily Lab Case Index) and
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

**Mark integrity (INTEG-1)** — because every mark is single-venue at its
source, each collector run also publishes a tamper report: every Steam
price is corroborated against the item's own realized-cash ratio history
*and* against Steam's standing order book (a second read path wash trades
can't cheaply fake), art marks publish their sale-count evidence, and
venue loss raises a loud staleness alert. Divergences are **flagged, never
auto-rejected** (auto-rejection would let an attacker knock honest marks
out of the index by manipulating the thinner corroborating venue).
Scheduled collector runs add random sampling jitter so reading instants
can't be pinned. The home page shows the current state as a MARK INTEGRITY
tile; the full flag table is on the methodology page.

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

## Gates

- `npm run probe` — 117 checks, hermetic (fixture transport):
  analytics math pinned to hand-computed values, full API flow, snapshot
  dedupe, import/bootstrap, portfolio P/L, restart persistence.
- `npm run probe:ui` — 35 real-Chromium checks across live AND static modes:
  chart pixels actually painted, crosshair tooltip, range switching,
  portfolio form, zero page errors. Screenshot → `/tmp/skin_lab.png`.

Both run in CI on every push. The UI probe needs playwright
(`npm i --no-save playwright && npx playwright install chromium`, or set
`PLAYWRIGHT_LIB` to an existing install).
