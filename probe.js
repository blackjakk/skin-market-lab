#!/usr/bin/env node
// probe.js — hermetic gate for the CS skin market tracker.
//
// NO network: market.js's transport is replaced with a fixture, the server
// runs in-process on an ephemeral port with a tmp data dir, timers off.
// Battery: analytics math pinned to hand-computed values, then the full HTTP
// flow (search → watch → snapshot/dedupe → paste-import → cookie-bootstrap →
// analytics report → cross-market compare → portfolio P/L → restart
// persistence). Exit 0 = all pass.
//
//   node probe.js
"use strict";
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const A = require("./analytics.js");
const M = require("./market.js");
const S = require("./settlement.js");
const { startServer, slug } = require("./server.js");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ FAIL " + label); } };
const near = (a, b, eps) => a != null && Math.abs(a - b) <= (eps == null ? 1e-9 : eps);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── analytics units ────────────────────────────────────────────────────────
console.log("— analytics —");
ok(A.parseMoney("$43.80") === 43.8 && A.parseMoney("1,234.56 USD") === 1234.56, "parseMoney US formats");
ok(A.parseMoney("1.234,56€") === 1234.56 && A.parseMoney("43,80€") === 43.8, "parseMoney EU formats");
ok(A.parseMoney(null) === null && A.parseMoney("--") === null && A.parseMoney(7) === 7, "parseMoney junk/number");
ok(A.parseMoney("31,263") === 31263 && A.parseMoney("1,234") === 1234, "parseMoney: trailing 3-digit comma group = thousands (steam volume trap)");
ok(A.parseCount("31,263") === 31263 && A.parseCount("57") === 57 && A.parseCount("") === null, "parseCount: unit counts are digits-only");
ok(A.sma([1, 2, 3, 4, 5], 5) === 3 && A.sma([1, 2, 3, 4, 5], 2) === 4.5, "sma");
const trk = A.smaTrack([1, 2, 3, 4, 5], 3);
ok(trk[0] === null && trk[1] === null && trk[2] === 2 && trk[4] === 4, "smaTrack overlay");
ok(near(A.ema([1, 2, 3, 4, 5], 2), 4.5, 1e-12), "ema (SMA-seeded recursion)");
ok(A.rsi(Array.from({ length: 20 }, (_, i) => 10 + i), 14) === 100, "rsi all-gains = 100");
ok(A.rsi(Array.from({ length: 20 }, (_, i) => 40 - i), 14) < 1e-9, "rsi all-losses = 0");
const dd = A.maxDrawdown([10, 12, 6, 9]);
ok(near(dd.dd, 0.5) && dd.peakIdx === 1 && dd.troughIdx === 2, "maxDrawdown peak→trough");
ok(near(A.currentDrawdown([10, 12, 6, 9]), 0.25), "currentDrawdown vs all-time peak");
ok(A.volAnnualized([5, 5, 5, 5, 5, 5]) === 0, "volatility of constant series = 0");

const D = 86400000, T0 = Date.UTC(2026, 0, 1);
const expDaily = Array.from({ length: 30 }, (_, i) => ({ day: A.dayKey(T0 + i * D), t: T0 + i * D, price: 100 * Math.exp(0.01 * i), vol: 10 }));
ok(near(A.trendSlope(expDaily, 30), Math.exp(0.01) - 1, 1e-9), "trendSlope recovers exact exponential");
ok(near(A.momentum(expDaily, 7), Math.exp(0.01 * 7) - 1, 1e-9), "momentum 7d vs 7d-ago point");
ok(A.liquidity(expDaily, 30) === 10, "liquidity = median daily volume");

const hourly = [
  { t: T0 + 1 * 3600000, price: 10, vol: 5 },
  { t: T0 + 5 * 3600000, price: 14, vol: 7 },
  { t: T0 + 9 * 3600000, price: 12, vol: 3 },
  { t: T0, price: -1, vol: 1 },           // bad row dropped
  { t: NaN, price: 10, vol: 1 },           // bad row dropped
];
const dSum = A.toDaily(hourly, { volMode: "sum" });
ok(dSum.length === 1 && dSum[0].price === 12 && dSum[0].vol === 15, "toDaily: median price + summed vol (history mode)");
const dMax = A.toDaily(hourly, { volMode: "max" });
ok(dMax[0].vol === 7, "toDaily: max vol (trailing-24h snapshot mode)");
const merged = A.mergeDaily([{ day: "2026-01-01", t: T0, price: 1, vol: 1 }], [{ day: "2026-01-01", t: T0, price: 9, vol: 9 }, { day: "2026-01-02", t: T0 + D, price: 2, vol: 2 }]);
ok(merged.length === 2 && merged[0].price === 1 && merged[1].price === 2, "mergeDaily: primary wins collisions, gaps filled");
ok(A.netProceeds(11.5, "steam") === 10 && A.netProceeds(100, "skinport") === 88, "fee math (steam /1.15, skinport -12%)");
ok(M.parseSteamDate("Dec 06 2013 01: +0") === Date.UTC(2013, 11, 6, 1), "steam history date parse");
const asm = A.assembleSeries(
  [{ t: T0, price: 5, vol: 10 }],
  [{ t: T0, src: "steam", price: 9, vol: 3 }, { t: T0 + D, src: "steam", price: 6, vol: 2 }, { t: T0, src: "skinport", price: 4, vol: 1 }]);
ok(asm.daily.length === 2 && asm.daily[0].price === 5 && asm.daily[1].price === 6
  && asm.skinportDaily.length === 1 && asm.skinportDaily[0].price === 4,
  "assembleSeries: import wins collisions, skinport split out");
const mo = A.marketOverview([
  { name: "A Case", cat: "case", daily: [{ day: A.dayKey(T0), t: T0, price: 10, vol: 100 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 11, vol: 120 }], skinportDaily: [{ day: A.dayKey(T0 + D), t: T0 + D, price: 8.8, vol: 5 }] },
  { name: "B Case", cat: "case", daily: [{ day: A.dayKey(T0), t: T0, price: 100, vol: 10 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 121, vol: 12 }], skinportDaily: [] },
  { name: "S", cat: "skin", daily: [{ day: A.dayKey(T0), t: T0, price: 50, vol: 7 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 40, vol: 7 }], skinportDaily: [] },
]);
ok(mo.series.length === 2 && mo.series[0].caseIdx === 100 && near(mo.today.caseIdx, 115.37, 0.01),
  "marketOverview: case index = geometric mean of case relatives (skins excluded)");
ok(near(mo.today.idx1, 0.1537, 0.001) && mo.today.idx7 === null,
  "marketOverview: 24h index change; 7d withheld while series is shallow");
ok(near(mo.today.cashRatio, 0.8, 1e-9) && mo.today.volTotal === 139,
  "marketOverview: cash ratio median + summed daily volume");
ok(near(mo.today.liqIdx, 80, 0.01),
  "liquids index: liquid non-case items bucket separately (S 50→40 → 80)");
const moArt = A.marketOverview([
  { name: "Grail", cat: "skin", tier: "art", daily: [], skinportDaily: [],
    artDaily: [{ day: A.dayKey(T0), t: T0, price: 100 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 110 }] },
]);
ok(moArt.today.artIdx === 110 && moArt.today.caseIdx === null && moArt.today.liqIdx === null,
  "art index marks to skinport 30d-median artDaily, never steam");
const moSkins = A.marketOverview([
  { name: "S", cat: "skin", daily: [{ day: A.dayKey(T0), t: T0, price: 50, vol: 7 }], skinportDaily: [{ day: A.dayKey(T0), t: T0, price: 40, vol: 2 }] },
]);
ok(moSkins.today && moSkins.today.caseIdx === null && near(moSkins.today.cashRatio, 0.8, 1e-9) && moSkins.today.volTotal === 7,
  "marketOverview: skins-only set still reports ratio/volume (index null, not blank)");
const caSame = A.cashAdjustedIndex([
  { day: "d1", t: T0, caseIdx: 100, cashRatio: 0.8 },
  { day: "d2", t: T0 + D, caseIdx: 110, cashRatio: 0.8 },
]);
const caDiv = A.cashAdjustedIndex([
  { day: "d1", t: T0, caseIdx: 100, cashRatio: 0.8 },
  { day: "d2", t: T0 + D, caseIdx: 110, cashRatio: 0.72 },
]);
ok(caSame[1].cashIdx === 110 && caDiv[1].cashIdx === 99,
  "cashAdjustedIndex: flat ratio tracks the index; falling ratio discounts it (slosh detector)");
const corrSeries = Array.from({ length: 15 }, (_, i) => {
  const p = 100 * Math.exp(0.01 * Math.sin(i));
  return { day: "c" + i, t: T0 + i * D, caseIdx: p, btc: 2 * p, inv: 1 / p };
});
ok(A.corrDaily(corrSeries, "caseIdx", "btc", 30).corr === 1 && A.corrDaily(corrSeries, "caseIdx", "inv", 30).corr === -1,
  "corrDaily: perfect co-movement = +1, perfect inverse = -1 (log-return pearson)");
ok(A.corrDaily(corrSeries.slice(0, 5), "caseIdx", "btc", 30).corr === null,
  "corrDaily: refuses to correlate on <10 paired returns");

// ── SMLX-2 chained construction: seasoning + scheduled inclusion ───────────
const mkDay = (t) => A.dayKey(t);
const dcase = (t, price, vol) => ({ day: mkDay(t), t, price, vol: vol == null ? 10 : vol });
// chaining continuity: A rises 10%/day, B flat → index = geometric mean path
const chain = A.marketOverview([
  { name: "A Case", cat: "case", daily: [dcase(T0, 100), dcase(T0 + D, 110), dcase(T0 + 2 * D, 121)], skinportDaily: [] },
  { name: "B Case", cat: "case", daily: [dcase(T0, 50), dcase(T0 + D, 50), dcase(T0 + 2 * D, 50)], skinportDaily: [] },
]);
ok(chain.series[0].caseIdx === 100 && near(chain.series[1].caseIdx, 104.88, 0.01) && near(chain.series[2].caseIdx, 110, 0.01),
  "SMLX-2 chaining: index cumulates mean daily log-returns (100 → 104.88 → 110)");
// no jump on entry: the incumbent must be GRANDFATHERED (first mark before
// the 2026-07-25 adoption date), the newcomer lists after it
const TOLD = Date.UTC(2026, 6, 1);  // grandfathered incumbent from 2026-07-01
const TNEW = Date.UTC(2026, 8, 2);  // newcomer first mark 2026-09-02 → included 2026-11-01
const oldFlat = [];
for (let i = 0; i < 130; i++) oldFlat.push(dcase(TOLD + i * D, 10));
const noJump = A.marketOverview([
  { name: "Old Case", cat: "case", daily: oldFlat.slice(0, 70), skinportDaily: [] }, // through 2026-09-08
  { name: "New Case", cat: "case", daily: [dcase(TNEW, 9999), dcase(TNEW + D, 1), dcase(TNEW + 2 * D, 5000)], skinportDaily: [] },
]);
ok(noJump.series.every((s) => s.caseIdx === 100),
  "SMLX-2 no-jump: a seasoning newcomer's prices cannot move the index (all 100)");
ok(A.includedFromDay("2026-09-02") === "2026-11-01" && A.includedFromDay("2026-01-05") === "2026-01-05",
  "inclusion calendar: 30d seasoning → next first-of-month; founding cohort grandfathered");
// scheduled inclusion: newcomer contributes only after its inclusion date
const newDaily = [];
for (let i = 0; i < 66; i++) {
  const t = TNEW + i * D;
  newDaily.push(dcase(t, mkDay(t) >= "2026-11-03" ? 110 : 100)); // +10% on 2026-11-03
}
const incl = A.marketOverview([
  { name: "Old Case", cat: "case", daily: oldFlat, skinportDaily: [] },
  { name: "New Case", cat: "case", daily: newDaily, skinportDaily: [] },
]);
const byDay = new Map(incl.series.map((s) => [s.day, s.caseIdx]));
ok(byDay.get("2026-11-01") === 100 && byDay.get("2026-11-02") === 100 && near(byDay.get("2026-11-03"), 104.88, 0.01),
  "SMLX-2 scheduled inclusion: newcomer's returns count only post-inclusion (+10% ÷ 2 items → 104.88)");
// art carry-forward: sparse marks fill between observations
const artCarry = A.marketOverview([
  { name: "Grail", cat: "skin", tier: "art", daily: [], skinportDaily: [],
    artDaily: [{ day: mkDay(T0), t: T0, price: 100 }, { day: mkDay(T0 + 2 * D), t: T0 + 2 * D, price: 110 }] },
  { name: "Filler Case", cat: "case", daily: [dcase(T0, 5), dcase(T0 + D, 5), dcase(T0 + 2 * D, 5)], skinportDaily: [] },
]);
ok(artCarry.series[1].artIdx === 100 && artCarry.series[2].artIdx === 110,
  "art marks carry forward between sparse observations (100 → 100 → 110)");

// ── SMLX-3 winsorization: median-relative ±0.05 log clamp ──────────────────
// 4 flat names + 1 pumped +50% in a day: median return 0 → the outlier's
// contribution clamps to +0.05 → index moves e^(0.05/5) ≈ +1.005% (unclamped
// SMLX-2 would have printed ≈ +8.4% — the concentrated attack this closes)
const winso = A.marketOverview([
  { name: "W1 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 15)], skinportDaily: [] },
  { name: "W2 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 10)], skinportDaily: [] },
  { name: "W3 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 10)], skinportDaily: [] },
  { name: "W4 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 10)], skinportDaily: [] },
  { name: "W5 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 10)], skinportDaily: [] },
]);
ok(near(winso.today.caseIdx, 100 * Math.exp(0.05 / 5), 0.01),
  "SMLX-3 winsorization: one name pumped +50% moves the index only ≈1% (clamped at ±0.05 vs daily median)");
// market-wide moves pass through UNTOUCHED: the median moves with the market,
// so a real crash is never clamped — only single-name deviations are
const mktWide = A.marketOverview([
  { name: "C1 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 8)], skinportDaily: [] },
  { name: "C2 Case", cat: "case", daily: [dcase(T0, 50), dcase(T0 + D, 40)], skinportDaily: [] },
  { name: "C3 Case", cat: "case", daily: [dcase(T0, 5), dcase(T0 + D, 4)], skinportDaily: [] },
]);
ok(near(mktWide.today.caseIdx, 80, 0.01),
  "SMLX-3 passthrough: a uniform −20% crash prints −20% (median-relative clamp never fights the market)");
ok(winso.weights && winso.weights.case && Math.abs(winso.weights.case["W1 Case"] - 0.2) < 1e-9,
  "SMLX-4 inception month (no prior-month volume): equal weights published");

// ── SMLX-4 volume weights: lagged median-$vol, capped 0.10, monthly ────────
// Jan gives N1 twice the $volume of N2..N12 (raw weight 2/13 ≈ 0.154 → capped
// at 0.10, excess redistributed); Feb 2 only N1 moves +e^0.04 → the index
// return is exactly weight × return = 0.10 × 0.04
const TF1 = Date.UTC(2026, 1, 1), TF2 = Date.UTC(2026, 1, 2);
const wItems = [];
for (let n = 1; n <= 12; n++) {
  const vol = n === 1 ? 200 : 100;
  const daily = [];
  for (let i = 0; i < 5; i++) daily.push(dcase(T0 + (19 + i) * D, 10, vol)); // Jan 20–24 ≥ minObs
  daily.push(dcase(TF1, 10, vol));
  daily.push(dcase(TF2, n === 1 ? 10 * Math.exp(0.04) : 10, vol));
  wItems.push({ name: "N" + n + " Case", cat: "case", daily: daily, skinportDaily: [] });
}
const wmo = A.marketOverview(wItems);
ok(near(wmo.series[wmo.series.length - 1].caseIdx, 100 * Math.exp(0.10 * 0.04), 0.001),
  "SMLX-4 weighting: +4% on the capped-0.10 heavyweight moves the index exactly 0.4% (lagged monthly $vol weights)");
ok(wmo.weights && near(wmo.weights.case["N1 Case"], 0.10, 1e-6) && near(wmo.weights.case["N2 Case"], 0.9 / 11, 1e-4),
  "published weights: raw 2/13 clipped to the 0.10 cap, excess redistributed pro-rata");

// ── settlement fixings (SMLX-3) ────────────────────────────────────────────
const setSeries = Array.from({ length: 7 }, (_, i) => ({ day: A.dayKey(T0 + i * D), t: T0 + i * D, caseIdx: 100 + i, cashRatio: 0.65 }));
const fx7 = S.computeFixing(setSeries, S.FIXINGS[0]);
ok(fx7.value === 103 && fx7.days.length === 7 && fx7.methodology === "SMLX-4",
  "SETTLE-CASE-7D = mean of last 7 daily index values (100..106 → 103)");
const fxShallow = S.computeFixing(setSeries.slice(0, 2), S.FIXINGS[0]);
ok(fxShallow.value === null && /2\/3/.test(fxShallow.accruing),
  "fixing withholds a value below min days (accruing 2/3) — never fabricated");
ok(S.canonical(fx7) === S.canonical(S.computeFixing(setSeries, S.FIXINGS[0])),
  "canonical fixing bytes are deterministic (re-derivable hash)");
const bud = S.manipulationBudget([
  { cat: "case", tier: null, latest: 2, vol24h: 100000, skinport: null },
  { cat: "skin", tier: null, latest: 50, vol24h: 10, skinport: { last30d: { median: 10, volume: 30 } } },
]);
ok(bud.caseIndex.dailyDollarVolume === 200000 && bud.caseIndex.costMove1pctDay === 15000
  && bud.caseIndex.costMove1pctFix7d === 105000 && bud.cashRatio.costMove1pctFix30d === 18,
  "manipulation budget: fee-burn floor arithmetic (0.5 × $vol × fee × window)");
ok(bud.caseIndex.concentrated && bud.caseIndex.concentrated.kMin === 1
  && bud.caseIndex.concentrated.costMove1pctDay === 15000,
  "concentrated budget: single-case basket → cheapest-1 attack equals the uniform floor");
// cheapest-k arithmetic: 42 cases, dv = $1000×(i+1) → clamp forces
// k = ⌈42×0.01/0.05⌉ = 9 names; cheapest 9 sum $45,000 → 0.5×0.15×45000
const kbud = S.manipulationBudget(
  Array.from({ length: 42 }, (_, i) => ({ cat: "case", tier: null, latest: 1000 * (i + 1), vol24h: 1, skinport: null })));
ok(kbud.caseIndex.concentrated.kMin === 9 && kbud.caseIndex.concentrated.costMove1pctDay === 3375
  && kbud.caseIndex.concentrated.costMove1pctFix7d === 23625,
  "concentrated budget, equal-weight fallback: k = ⌈N×move/clamp⌉ = 9 thinnest names ($3,375/day)");
// SMLX-4 weighted attack: with published weights the attacker accumulates
// ≥20% of index WEIGHT at the lowest fee-burn per unit of weight. Weights
// ∝ dv² here so cost/weight strictly FALLS with size — the greedy provably
// follows the weights (takes the 4 biggest names), not the thin names.
const sq = Array.from({ length: 42 }, (_, i) => (i + 1) * (i + 1));
const sqTot = sq.reduce((a, b) => a + b, 0);
const wbud = S.manipulationBudget(
  Array.from({ length: 42 }, (_, i) => ({ cat: "case", tier: null, latest: 1000 * (i + 1), vol24h: 1,
    weight: sq[i] / sqTot, skinport: null })));
ok(wbud.caseIndex.concentrated.weighted === true && wbud.caseIndex.concentrated.kMin === 4
  && wbud.caseIndex.concentrated.costMove1pctDay === 12150,
  "SMLX-4 weighted budget: attack must buy real weight — 4 heavyweight names, $12,150/day (thin names useless)");

const up = A.signal({ mom7: 0.05, mom30: 0.25, slope30: 0.008, rsi14: 60, curDD: 0.1, vol30: 0.4, liq30: 50 });
ok(up.score > 12 && /BUY/.test(up.verdict), "signal: sustained uptrend → BUY (" + up.score + ")");
const crash = A.signal({ mom7: -0.1, mom30: -0.3, slope30: -0.01, rsi14: 40, curDD: 0.35, vol30: 0.4, liq30: 50 });
ok(crash.score < -12 && /SELL/.test(crash.verdict), "signal: downtrend → SELL (" + crash.score + ")");
const thin = A.signal({ mom7: 0.05, mom30: 0.25, slope30: 0.008, rsi14: 60, curDD: 0.1, vol30: 0.4, liq30: 1 });
ok(Math.abs(thin.score) < Math.abs(up.score) && thin.reasons.some((r) => /illiquid/.test(r)), "signal: illiquidity dampens score");
ok(up.reasons.length >= 2, "signal reasons itemized (transparent heuristic)");

// ── fixture transport ──────────────────────────────────────────────────────
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function steamDateStr(t) {
  const d = new Date(t);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return MON[d.getUTCMonth()] + " " + p(d.getUTCDate()) + " " + d.getUTCFullYear() + " " + p(d.getUTCHours()) + ": +0";
}
const fixture = { steamPrice: "$23.00", steamLow: "$22.10", steamVol: "57" };
async function fixtureTransport(url, headers) {
  if (url.includes("/market/priceoverview/")) {
    if (url.includes("Howl")) // art grail: steam success with NO price fields (above the cap)
      return { status: 200, body: JSON.stringify({ success: true }) };
    return { status: 200, body: JSON.stringify({ success: true, lowest_price: fixture.steamLow, volume: fixture.steamVol, median_price: fixture.steamPrice }) };
  }
  if (url.includes("/market/pricehistory/")) {
    if (!headers || !headers.Cookie) return { status: 400, body: "" };
    const now = Date.now();
    const prices = Array.from({ length: 40 }, (_, i) => [steamDateStr(now - (40 - i) * D), 4 + i * 0.1, "" + (50 + i)]);
    return { status: 200, body: JSON.stringify({ success: true, price_prefix: "$", prices }) };
  }
  if (url.includes("api.steampowered.com/ISteamUserStats")) {
    return { status: 200, body: JSON.stringify({ response: { player_count: 1534000, result: 1 } }) };
  }
  if (url.includes("api.coingecko.com")) {
    return { status: 200, body: JSON.stringify({ bitcoin: { usd: 60000 }, ethereum: { usd: 1800 } }) };
  }
  if (url.includes("api.skinport.com/v1/items")) {
    return { status: 200, body: JSON.stringify([
      { market_hash_name: "AWP | Dragon Lore (Factory New)", min_price: 12000, mean_price: 12500, max_price: 15000, quantity: 3 },
      { market_hash_name: "AK-47 | Redline (Field-Tested)", min_price: 20.5, mean_price: 24, max_price: 60, quantity: 400 },
    ]) };
  }
  if (url.includes("api.skinport.com/v1/sales/history")) {
    const agg = (mul) => ({ min: 18 * mul, max: 30 * mul, avg: 21 * mul, median: 20 * mul, volume: 21 });
    return { status: 200, body: JSON.stringify([{ market_hash_name: decodeURIComponent(/market_hash_name=([^&]+)/.exec(url)[1]), last_24_hours: agg(1), last_7_days: agg(1), last_30_days: agg(1), last_90_days: agg(1) }]) };
  }
  return { status: 404, body: "" };
}

// ── server flow ────────────────────────────────────────────────────────────
(async () => {
  console.log("— server —");
  M.setTransport(async () => ({ status: 200, body: JSON.stringify([{ market_hash_name: "Z",
    last_24_hours: { min: 0, max: 0, avg: 0, median: 0, volume: 0 },
    last_7_days: { min: 0, max: 0, avg: 0, median: 0, volume: 0 },
    last_30_days: { min: 0, max: 0, avg: 0, median: 0, volume: 0 },
    last_90_days: { min: 0, max: 0, avg: 0, median: 0, volume: 0 } }]) }));
  const zeroed = await M.skinportSalesHistory("Z");
  ok(zeroed.last30d.median === null && zeroed.last24h.volume === 0,
    "skinport zero-medians (never sold) map to null — a $0 price is never a mark");
  M.setTransport(fixtureTransport);
  const DATA = path.join(os.tmpdir(), "hh-skin-probe-" + Date.now());
  // pre-write an EMPTY watchlist so the first-boot auto-seed (from the
  // repo's committed watchlist.json) doesn't inject items under this test;
  // the seeding behavior itself gets its own check at the end.
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "watchlist.json"), "[]");
  const PORT = 5391;
  let inst = startServer({ port: PORT, dataDir: DATA, snapHours: 0, steamCookie: "steamLoginSecure=probe" });
  const api = async (p, body) => {
    // Connection:close — the probe restarts the server; pooled keep-alive
    // sockets to the dead instance would otherwise poison the next fetch.
    const opts = body
      ? { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) }
      : { headers: { Connection: "close" } };
    const r = await fetch("http://localhost:" + PORT + p, opts);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const NAME = "AK-47 | Redline (Field-Tested)";
  const KNIFE = "★ Karambit | Doppler (Factory New)";

  const h = await api("/api/skins/health");
  ok(h.status === 200 && h.body.ok === 1 && h.body.steamCookie === true, "health up (fixture cookie visible)");

  let s = await api("/api/skins/search?q=redline");
  ok(s.body.results.some((r) => r.name === NAME), "search finds seed item pre-dump");
  s = await api("/api/skins/search?q=bravo");
  ok(s.body.results.some((r) => r.name === "Operation Bravo Case"), "search: cases in the seed universe");

  let w = await api("/api/skins/watch", { name: NAME });
  ok(w.body.watchlist.includes(NAME), "watch add");
  await api("/api/skins/watch", { name: KNIFE });

  const r1 = await api("/api/skins/refresh", {});
  const mine = r1.body.results.find((x) => x.name === NAME);
  ok(r1.status === 200 && mine && mine.ok && mine.appended === true, "refresh snapshots the watchlist (fixture steam quote)");
  const r2 = await api("/api/skins/refresh", { name: NAME });
  ok(r2.body.results[0].appended === false, "snapshot dedupe (<30min apart is skipped)");
  const histLines = fs.readFileSync(path.join(DATA, "history", slug(NAME) + ".jsonl"), "utf8").trim().split("\n");
  ok(histLines.filter((l) => JSON.parse(l).src === "steam").length === 1, "exactly one steam line on disk after dedupe");
  ok(fs.existsSync(path.join(DATA, "history", slug(KNIFE) + ".jsonl")), "unicode/star name maps to a safe history file");

  await sleep(150); // dump refresh is fire-and-forget inside /refresh
  s = await api("/api/skins/search?q=dragon lore");
  const dl = s.body.results.find((r) => r.name === "AWP | Dragon Lore (Factory New)");
  ok(dl && dl.price === 12000, "search universe extends with the cached skinport dump");

  let it = await api("/api/skins/item?name=" + encodeURIComponent(NAME));
  ok(it.body.quote && it.body.quote.price === 23 && it.body.quote.vol === 57, "item quote = latest steam snapshot");
  ok(it.body.skinport.sales && it.body.skinport.sales.last24h.median === 20, "skinport sale aggregates cached on item");
  ok(it.body.compare.steam.net === 20 && it.body.compare.skinport.net === 17.6, "cross-market net proceeds (fees applied)");
  ok(it.body.skinportDaily.length === 1 && it.body.skinportDaily[0].price === 20, "skinport realized-price series accrues too");

  // paste-import a 60-day uptrend ending yesterday → real time-series analytics
  const now = Date.now();
  const paste = Array.from({ length: 60 }, (_, i) => [steamDateStr(now - (60 - i) * D), 10 * Math.exp(0.005 * i), "50"]);
  const imp = await api("/api/skins/import", { name: NAME, prices: paste });
  ok(imp.status === 200 && imp.body.rows === 60, "paste-import accepts steam pricehistory shape");
  it = await api("/api/skins/item?name=" + encodeURIComponent(NAME));
  ok(it.body.daily.length >= 61, "imported history + live snapshots merge into one series");
  ok(it.body.daily[it.body.daily.length - 1].price === 23, "today's point comes from the live snapshot");
  const an = it.body.analytics;
  ok(an.mom30 != null && an.mom30 > 0 && an.slope30 > 0, "analytics: momentum/trend computed over merged series");
  ok(an.signal && typeof an.signal.score === "number" && an.signal.reasons.length > 0, "analytics: signal + itemized reasons served");
  ok(an.rsi14 != null && an.vol30 != null && an.maxDD != null && an.liq30 === 50, "analytics: rsi/vol/drawdown/liquidity populated");

  const bs = await api("/api/skins/bootstrap", { name: KNIFE });
  ok(bs.status === 200 && bs.body.rows === 40, "cookie bootstrap pulls full steam history (fixture)");
  it = await api("/api/skins/item?name=" + encodeURIComponent(KNIFE));
  ok(it.body.imported === true && it.body.daily.length >= 40, "bootstrapped history feeds the series");

  const bad = await api("/api/skins/import", { name: NAME, prices: [["not a date", "x"]] });
  ok(bad.status === 400, "import rejects unparseable rows");

  // portfolio: 3 @ $10, latest 23 → net/unit 20 → netSteam 60, P/L +30 (+100%)
  let pf = await api("/api/skins/lot", { name: NAME, qty: 3, unitCost: 10 });
  const lot = pf.body.lots[0];
  ok(lot.cost === 30 && lot.netSteam === 60 && lot.pl === 30 && lot.plPct === 100, "portfolio P/L net of steam fees");
  ok(pf.body.totals.cost === 30 && pf.body.totals.pl === 30, "portfolio totals fold");
  ok((await api("/api/skins/lot", { name: NAME, qty: -1, unitCost: 5 })).status === 400, "lot validation rejects qty<=0");
  pf = await api("/api/skins/lot", { remove: lot.id });
  ok(pf.body.lots.length === 0, "lot remove");
  await api("/api/skins/lot", { name: NAME, qty: 2, unitCost: 15 });

  const wl = await api("/api/skins/watchlist");
  const row = wl.body.items.find((x) => x.name === NAME);
  ok(row && row.latest === 23 && row.verdict && row.days >= 61, "watchlist summary rows (latest/verdict/days)");

  // restart: everything must come back from disk
  await inst.close();
  inst = startServer({ port: PORT, dataDir: DATA, snapHours: 0, steamCookie: "" });
  await new Promise((r) => inst.server.once("listening", r));
  const h2 = await api("/api/skins/health");
  ok(h2.body.watch === 2 && h2.body.lots === 1 && h2.body.steamCookie === false, "restart: watchlist+portfolio reload from disk");
  it = await api("/api/skins/item?name=" + encodeURIComponent(NAME));
  ok(it.body.daily.length >= 61 && it.body.quote.price === 23, "restart: history + imports intact");
  const bs2 = await api("/api/skins/bootstrap", { name: NAME });
  ok(bs2.status === 400, "bootstrap without STEAM_COOKIE fails with guidance");

  await api("/api/skins/watch", { name: "Fracture Case" });
  await api("/api/skins/refresh", { name: "Fracture Case" });
  const mkt = await api("/api/skins/market");
  ok(mkt.status === 200 && mkt.body.today && mkt.body.today.caseIdx === 100,
    "live /api/skins/market: case index at base 100 on day one");
  ok(mkt.body.settlement && mkt.body.settlement.methodology === "SMLX-4"
    && mkt.body.settlement.fixings["SETTLE-CASE-7D"]
    && /^[0-9a-f]{64}$/.test(mkt.body.settlement.fixings["SETTLE-CASE-7D"].hash),
    "live market serves SMLX-4 fixings with 64-hex canonical hashes");
  ok(near(mkt.body.today.cashRatio, 0.87, 0.001) && mkt.body.today.players === 1534000,
    "live market: cash ratio + live player count");
  ok(mkt.body.today.btc === 60000 && mkt.body.today.eth === 1800,
    "live market: crypto benchmarks attached (cached macro fetch)");
  const wl2 = await api("/api/skins/watchlist");
  const fr = wl2.body.items.find((x) => x.name === "Fracture Case");
  ok(fr && fr.cat === "case" && Array.isArray(fr.spark) && fr.vol24h === 57,
    "watchlist rows carry cat/spark/vol24h for the home table");

  await inst.close();

  // first boot on a VIRGIN data dir seeds the private watchlist from the
  // repo's committed watchlist.json — the dashboard opens populated
  const FRESH = path.join(os.tmpdir(), "hh-skin-fresh-" + Date.now());
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, "watchlist.json"), "utf8")).items;
  const inst3 = startServer({ port: PORT + 1, dataDir: FRESH, snapHours: 0, steamCookie: "" });
  await new Promise((r) => inst3.server.once("listening", r));
  const h3 = await (await fetch("http://localhost:" + (PORT + 1) + "/api/skins/health", { headers: { Connection: "close" } })).json();
  ok(h3.watch === committed.length && committed.length > 0, "virgin boot seeds watchlist from the committed starter set (" + committed.length + ")");
  await inst3.close();
  fs.rmSync(FRESH, { recursive: true, force: true });

  // ── collector (the hosted always-on tracker) ─────────────────────────────
  console.log("— collector —");
  const { collect } = require("./collect.js");
  const CROOT = path.join(os.tmpdir(), "hh-skin-collect-" + Date.now());
  fs.mkdirSync(path.join(CROOT, "data", "import"), { recursive: true });
  fs.writeFileSync(path.join(CROOT, "watchlist.json"), JSON.stringify({
    items: [NAME, KNIFE, "Fracture Case", "M4A4 | Howl (Field-Tested)"],
    art: ["M4A4 | Howl (Field-Tested)"] }));
  const impRows = Array.from({ length: 40 }, (_, i) => ({ t: Date.now() - (40 - i) * D, price: 4 + i * 0.1, vol: 50 + i }));
  fs.writeFileSync(path.join(CROOT, "data", "import", slug(KNIFE) + ".json"), JSON.stringify({ t: Date.now(), source: "probe", rows: impRows }));
  // pre-write CN-evening (11:17 UTC) and US-evening (23:17 UTC) player
  // readings for today — values big enough that the live fixture reading
  // (1.53M, appended at whatever hour CI runs) can never win the window max
  const nowD = new Date();
  const mkT = (h, m) => Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate(), h, m);
  fs.writeFileSync(path.join(CROOT, "data", "market.jsonl"),
    JSON.stringify({ t: mkT(11, 17), players: 5000000 }) + "\n" +
    JSON.stringify({ t: mkT(23, 17), players: 4000000 }) + "\n");
  const c1 = await collect({ root: CROOT });
  ok(c1.steamOk === 3 && c1.manifest.items.length === 4 && c1.manifest.errors.length === 0,
    "collect: art item with no steam quote is NOT an error (marks to sales)");
  const howl = c1.manifest.items.find((i) => /Howl/.test(i.name));
  ok(howl && howl.tier === "art" && howl.latest === 20 && c1.manifest.market.today.artIdx === 100,
    "art item: tier tagged, latest = 30d sale median, art index at base");
  ok(c1.manifest.market && c1.manifest.market.today && c1.manifest.market.today.caseIdx === 100
    && c1.manifest.market.today.players === 1534000,
    "collector publishes the market block (index base + players)");
  ok(c1.manifest.market.today.btc === 60000
    && c1.manifest.market.series.some((sr) => sr.btc === 60000),
    "collector records BTC/ETH benchmarks into the macro series");
  ok(c1.manifest.market.today.cnus === 1.25
    && c1.manifest.market.series.some((sr) => sr.cnus === 1.25),
    "CN/US activity gauge: Asia-evening ÷ US-evening peak ratio (5M/4M)");
  const idx = JSON.parse(fs.readFileSync(path.join(CROOT, "data", "index.json"), "utf8"));
  const rd = idx.items.find((i) => i.name === NAME), kn = idx.items.find((i) => i.name === KNIFE);
  ok(rd && rd.quote && rd.quote.price === 23 && typeof rd.score === "number" && rd.verdict && rd.slug === slug(NAME),
    "manifest rows carry quote + analytics summary (one fetch paints the site)");
  ok(kn && kn.imported === true && kn.days >= 41, "committed import files merge into collector analytics");
  ok(rd.cat === "skin" && kn.spark.length === 14 && rd.vol24h === 57,
    "manifest rows carry cat/spark/vol24h for the static home table");
  const hl1 = fs.readFileSync(path.join(CROOT, "data", "history", slug(NAME) + ".jsonl"), "utf8").trim().split("\n");
  ok(hl1.some((l) => JSON.parse(l).src === "steam") && hl1.some((l) => JSON.parse(l).src === "skinport"),
    "collector history jsonl gets steam + skinport lines");
  ok(fs.existsSync(path.join(CROOT, "data", "sales.json")) && fs.existsSync(path.join(CROOT, "data", "skinport-cursor.json")),
    "skinport sales store + rotation cursor persisted (8-per-run budget)");
  const setPub = JSON.parse(fs.readFileSync(path.join(CROOT, "data", "settlement.json"), "utf8"));
  const fxPub = setPub.latest.fixings["SETTLE-CASE-7D"];
  ok(fxPub && fxPub.value === null && /1\/3/.test(fxPub.accruing)
    && fxPub.hash === crypto.createHash("sha256").update(S.canonical(setPub.detail["SETTLE-CASE-7D"])).digest("hex"),
    "collector publishes settlement.json; hash re-derives from canonical detail");
  ok(fs.existsSync(path.join(CROOT, "data", "settlements.jsonl"))
    && c1.manifest.market.settlement && c1.manifest.market.settlement.budget.caseIndex.dailyDollarVolume === 1311,
    "fixing history appended; manipulation budget from live volumes (23×57=$1,311)");
  const cCon = c1.manifest.market.settlement.budget.caseIndex.concentrated;
  ok(cCon && cCon.kMin === 1 && cCon.costMove1pctDay === 98,
    "collector publishes the concentrated attack budget (cheapest-1 of a 1-case basket: 0.5×1311×0.15≈$98)");
  const frW = c1.manifest.items.find((i) => /Fracture/.test(i.name));
  ok(frW && frW.weight === 1 && cCon.weighted === true,
    "manifest items carry the published index weight; the budget prices on it (single case → weight 1)");
  const c2 = await collect({ root: CROOT });
  const hl2 = fs.readFileSync(path.join(CROOT, "data", "history", slug(NAME) + ".jsonl"), "utf8").trim().split("\n");
  ok(hl2.length === hl1.length && c2.manifest.items.length === 4, "immediate re-run dedupes snapshots, still refreshes the manifest");
  fs.rmSync(CROOT, { recursive: true, force: true });

  M.setTransport(null);
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log("\n" + (fail ? fail + " FAILURE(S)" : "ALL PASS (" + pass + " checks)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); process.exit(1); });
