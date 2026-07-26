#!/usr/bin/env node
// corr.js — Skindex × Bitcoin × players correlation study (OFFLINE STUDY).
// Reads the committed backtest artifacts (backtest/result.json — the SMLX-6
// reconstruction — and backtest/macro.json) and derives backtest/corr.json,
// the data behind backtest.html §7. Pure derivation, no network, no live-index
// input: like backtest.js this validates/characterizes, it never feeds the
// live published series. Re-run after refreshing the backtest artifacts:
//   node corr.js
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = __dirname;

const bt = JSON.parse(fs.readFileSync(path.join(ROOT, "backtest", "result.json"), "utf8"));
const mac = JSON.parse(fs.readFileSync(path.join(ROOT, "backtest", "macro.json"), "utf8"));
const idxSeries = bt.variants.smlx6.series;   // [ ["YYYY-MM-DD", level], ... ] daily
const btcSeries = mac.btc;                    // ~4-day sampled [date, usd]
const playersSeries = mac.players;            // monthly [month-start date, avg players]

const idxMap = new Map(idxSeries);
const D = (s) => new Date(s + "T00:00:00Z");
const r3 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000;
const r1 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10;

// Skindex level on date d, tolerating the BTC grid's ≤4-day sampling gaps.
function idxOn(d, k = 4) {
  const t = D(d).getTime();
  for (let i = 0; i <= k; i++) {
    const dd = new Date(t - i * 864e5).toISOString().slice(0, 10);
    if (idxMap.has(dd)) return idxMap.get(dd);
  }
  return null;
}
function pearson(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// ── aligned grids ───────────────────────────────────────────────────────────
const grid = [];                              // BTC-sampling grid over the index span
for (const [d, p] of btcSeries) {
  if (d < idxSeries[0][0]) continue;
  const iv = idxOn(d);
  if (iv != null && p > 0) grid.push({ d, btc: p, idx: iv });
}
const gRet = [];                              // ~4-day log returns
for (let i = 1; i < grid.length; i++) {
  const dt = (D(grid[i].d) - D(grid[i - 1].d)) / 864e5;
  if (dt < 1 || dt > 10) continue;
  gRet.push({ b: Math.log(grid[i].btc / grid[i - 1].btc), s: Math.log(grid[i].idx / grid[i - 1].idx) });
}
const monthEnd = new Map();                   // ym -> last grid point of the month
for (const g of grid) monthEnd.set(g.d.slice(0, 7), g);
const months = [...monthEnd.keys()].sort();
const mRet = [];                              // monthly log returns
for (let i = 1; i < months.length; i++) {
  const a = monthEnd.get(months[i - 1]), b = monthEnd.get(months[i]);
  mRet.push({ ym: months[i], b: Math.log(b.btc / a.btc), s: Math.log(b.idx / a.idx) });
}
const playersM = new Map(playersSeries.map(([d, v]) => [d.slice(0, 7), v]));

const out = {
  generatedAt: new Date().toISOString(),
  source: "backtest/result.json (SMLX-6 reconstruction, Steam wallet-$ marks) × backtest/macro.json (blockchain.info BTC ~4-day, steamcharts monthly players)",
  coverage: { span: grid[0].d + " → " + grid[grid.length - 1].d, gridPts: grid.length, months: mRet.length },
};

// headline stats
out.corr = {
  grid4d: r3(pearson(gRet.map(r => r.b), gRet.map(r => r.s))),
  monthly: r3(pearson(mRet.map(r => r.b), mRet.map(r => r.s))),
  monthlySe: r3(1 / Math.sqrt(mRet.length - 3)),
  nMonths: mRet.length,
};
{
  const xs = mRet.map(r => r.b), ys = mRet.map(r => r.s);
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  out.corr.betaMonthly = r3(sxy / sxx);
  out.corr.r2Monthly = r3(out.corr.monthly * out.corr.monthly);
}
out.levelsLogLog = {
  btc: r3(pearson(months.map(ym => Math.log(monthEnd.get(ym).btc)), months.map(ym => Math.log(monthEnd.get(ym).idx)))),
  players: (() => {
    const xs = [], ys = [];
    for (const ym of months) { const p = playersM.get(ym); if (p > 0) { xs.push(Math.log(p)); ys.push(Math.log(monthEnd.get(ym).idx)); } }
    return r3(pearson(xs, ys));
  })(),
};

// month-end levels for the page's overlay/scatter/table (both rebased client-side)
out.monthly = months.map(ym => [ym, r1(monthEnd.get(ym).idx), monthEnd.get(ym).btc]);
out.monthlyReturns = mRet.map(r => [r.ym, r3(r.b), r3(r.s)]);

// rolling 12-month correlation
out.rolling12m = [];
for (let i = 12; i <= mRet.length; i++) {
  const w = mRet.slice(i - 12, i);
  out.rolling12m.push([w[w.length - 1].ym, r3(pearson(w.map(r => r.b), w.map(r => r.s)))]);
}

// lead/lag: corr( btc[t-k], skindex[t] ), k>0 = BTC leads
out.leadLagMonthly = {};
for (let k = -6; k <= 6; k++) {
  const xs = [], ys = [];
  for (let i = 0; i < mRet.length; i++) {
    const j = i - k; if (j < 0 || j >= mRet.length) continue;
    xs.push(mRet[j].b); ys.push(mRet[i].s);
  }
  out.leadLagMonthly[k] = r3(pearson(xs, ys));
}

// players: monthly change vs skindex return, contemporaneous + leads
const pRows = [];                             // {ym, p: players log-chg into ym, s: skindex ret of ym}
for (let i = 1; i < months.length; i++) {
  const p0 = playersM.get(months[i - 1]), p1 = playersM.get(months[i]);
  const s = mRet[i - 1];                      // mRet[i-1].ym === months[i]
  if (p0 > 0 && p1 > 0 && s) pRows.push({ ym: months[i], p: Math.log(p1 / p0), s: s.s });
}
out.players = { contemp: r3(pearson(pRows.map(r => r.p), pRows.map(r => r.s))), lead: {} };
for (let k = 1; k <= 3; k++) {
  const xs = [], ys = [];
  for (let i = k; i < pRows.length; i++) { xs.push(pRows[i - k].p); ys.push(pRows[i].s); }
  out.players.lead[k] = r3(pearson(xs, ys));
}

// regimes (BTC cycles, month-end granularity)
const REGIMES = [
  ["2015-01", "2017-12", "2015–17 BTC bull"],
  ["2017-12", "2018-12", "2018 BTC bear"],
  ["2019-01", "2020-02", "2019 recovery"],
  ["2020-03", "2021-11", "2020–21 BTC bull"],
  ["2021-11", "2022-11", "2022 BTC bear"],
  ["2022-11", months[months.length - 1], "2023→ cycle"],
];
out.regimes = REGIMES.map(([a, b, name]) => {
  const A = monthEnd.get(a), B = monthEnd.get(b);
  const sub = mRet.filter(r => r.ym > a && r.ym <= b);
  return { name, span: a + " → " + b,
    btcPct: A && B ? r1((B.btc / A.btc - 1) * 100) : null,
    skindexPct: A && B ? r1((B.idx / A.idx - 1) * 100) : null,
    r: r3(pearson(sub.map(r => r.b), sub.map(r => r.s))), n: sub.length };
});

// decoupling exhibits: each asset's worst 12-month run + the other's move; the
// Skindex's max-drawdown window (from the backtest stats) vs BTC over it.
const worst = (key) => {
  let best = { sum: 1e9 };
  for (let i = 12; i <= mRet.length; i++) {
    const w = mRet.slice(i - 12, i);
    const sum = w.reduce((a, r) => a + r[key], 0);
    if (sum < best.sum) best = { sum, from: mRet[i - 12].ym, to: mRet[i - 1].ym, w };
  }
  return best;
};
{
  const wB = worst("b"), wS = worst("s");
  out.stress = {
    btcWorst12m: { span: wB.from + " → " + wB.to, btcPct: r1((Math.exp(wB.sum) - 1) * 100),
      skindexPct: r1((Math.exp(wB.w.reduce((a, r) => a + r.s, 0)) - 1) * 100) },
    skindexWorst12m: { span: wS.from + " → " + wS.to, skindexPct: r1((Math.exp(wS.sum) - 1) * 100),
      btcPct: r1((Math.exp(wS.w.reduce((a, r) => a + r.b, 0)) - 1) * 100) },
  };
  const st = bt.variants.smlx6.stats;
  const btcNear = (d) => { let best = null; for (const [dd, p] of btcSeries) { if (Math.abs(D(dd) - D(d)) <= 5 * 864e5) best = p; if (dd > d) break; } return best; };
  const a = btcNear(st.maxDrawdownPeak), b = btcNear(st.maxDrawdownTrough);
  out.stress.skindexMaxDD = { span: st.maxDrawdownPeak + " → " + st.maxDrawdownTrough,
    skindexPct: st.maxDrawdownPct, btcPct: a && b ? r1((b / a - 1) * 100) : null };
}

// the "does the players signal trade?" honesty test: top-quartile monthly
// player jumps → next-month (and 3-month) Skindex return vs unconditional.
{
  const rows = [];
  for (let i = 0; i < pRows.length - 1; i++) rows.push({ p: pRows[i].p, s1: pRows[i + 1].s });
  rows.sort((a, b) => a.p - b.p);
  const q = Math.floor(rows.length / 4);
  const mean = (a, k) => a.reduce((x, r) => x + r[k], 0) / a.length;
  const sd = (a, k) => { const m = mean(a, k); return Math.sqrt(a.reduce((x, r) => x + (r[k] - m) ** 2, 0) / (a.length - 1)); };
  const top = rows.slice(-q), all = rows;
  const pct = (x) => r1((Math.exp(x) - 1) * 100);
  out.signalTest = {
    n: rows.length, quartileN: q,
    nextMonthAllPct: pct(mean(all, "s1")),
    nextMonthTopPct: pct(mean(top, "s1")),
    nextMonthBottomPct: pct(mean(rows.slice(0, q), "s1")),
    tStat: r3((mean(top, "s1") - mean(all, "s1")) / (sd(top, "s1") / Math.sqrt(top.length))),
    hitTopPct: r1(top.filter(r => r.s1 > 0).length / top.length * 100),
    hitAllPct: r1(all.filter(r => r.s1 > 0).length / all.length * 100),
    roundTripFeePct: 13,   // Steam ÷1.15 ≈ 13%; Skinport 12%
  };
}

fs.writeFileSync(path.join(ROOT, "backtest", "corr.json"), JSON.stringify(out));
console.log("backtest/corr.json written:",
  "monthly r=" + out.corr.monthly, "beta=" + out.corr.betaMonthly, "R2=" + out.corr.r2Monthly,
  "| months=" + out.corr.nMonths, "| rolling pts=" + out.rolling12m.length,
  "| signal t=" + out.signalTest.tStat);
