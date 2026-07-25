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

- **Lab Case Index** — geometric mean of every tracked case's price
  relative to its own first recorded day, ×100. Cases are the market's
  commodity layer, so this basket is the de facto "S&P of skins".
- **Cash ratio** — median (third-party realized sale ÷ Steam price).
  ~70–85% is normal; climbing toward 100% = strong real-money demand,
  collapsing = sellers trapped in Steam wallet funds.
- **Units sold/day** — total Steam sales across the tracked set (liquidity).
- **CS2 players** — live in-game count, the market's demand fundamental.
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
| Skinport `/v1/items` | full item dump → search + ask prices | none (brotli) |
| Skinport `/v1/sales/history` | realized-sale medians 24h/7d/30d/90d | none (brotli) |

Rate limits are respected (3.5s politeness gap to Steam; Skinport cached
30min–12h). Collected data lands in `data/` (committed by the collector); the local tracker keeps its private copy in `local-data/` (gitignored).

## Gates

- `npm run probe` — 77 checks, hermetic (fixture transport):
  analytics math pinned to hand-computed values, full API flow, snapshot
  dedupe, import/bootstrap, portfolio P/L, restart persistence.
- `npm run probe:ui` — 31 real-Chromium checks across live AND static modes:
  chart pixels actually painted, crosshair tooltip, range switching,
  portfolio form, zero page errors. Screenshot → `/tmp/skin_lab.png`.

Both run in CI on every push. The UI probe needs playwright
(`npm i --no-save playwright && npx playwright install chromium`, or set
`PLAYWRIGHT_LIB` to an existing install).
