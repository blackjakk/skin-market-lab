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
const { witness } = require("./witness.js");

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
const deepBase = A.deepHistoryBase(
  [{ t: T0 - 5 * D, price: 1, vol: 1 }, { t: T0, price: 2, vol: 1 }, { t: T0 + D, price: 3, vol: 1 }],
  [{ t: T0 + D, price: 9, vol: 9 }],
  [{ t: T0 + 2 * D, src: "steam", price: 8, vol: 1 }]);
ok(deepBase.length === 3 && deepBase[0].price === 1 && deepBase[1].price === 2 && deepBase[2].price === 9,
  "deepHistoryBase: deep rows extend ONLY before the first collected/imported day (never override a mark)");
// SMLX-6 needs ≥3 case contributors: A +10%, B +21%, C flat →
// median ret = ln(1.1); B clamped to med+0.05, C to med−0.05 →
// mean = ln(1.1) exactly → index 110.00 (the clamp is symmetric here)
const mo = A.marketOverview([
  { name: "A Case", cat: "case", daily: [{ day: A.dayKey(T0), t: T0, price: 10, vol: 100 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 11, vol: 120 }], skinportDaily: [{ day: A.dayKey(T0 + D), t: T0 + D, price: 8.8, vol: 5 }] },
  { name: "B Case", cat: "case", daily: [{ day: A.dayKey(T0), t: T0, price: 100, vol: 10 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 121, vol: 12 }], skinportDaily: [] },
  { name: "C Case", cat: "case", daily: [{ day: A.dayKey(T0), t: T0, price: 5, vol: 0 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 5, vol: 0 }], skinportDaily: [] },
  { name: "S", cat: "skin", daily: [{ day: A.dayKey(T0), t: T0, price: 50, vol: 7 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 40, vol: 7 }], skinportDaily: [] },
]);
ok(mo.series.length === 2 && mo.series[0].caseIdx === 100 && near(mo.today.caseIdx, 110.00, 0.01),
  "marketOverview: case index = clamped weighted mean of case returns (skins excluded)");
ok(near(mo.today.idx1, 0.10, 0.001) && mo.today.idx7 === null,
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
// chaining continuity: A rises 4%/day (inside the clamp), B and C flat →
// each day's return = ln(1.04)/3, cumulated
const chain = A.marketOverview([
  { name: "A Case", cat: "case", daily: [dcase(T0, 100), dcase(T0 + D, 104), dcase(T0 + 2 * D, 108.16)], skinportDaily: [] },
  { name: "B Case", cat: "case", daily: [dcase(T0, 50), dcase(T0 + D, 50), dcase(T0 + 2 * D, 50)], skinportDaily: [] },
  { name: "C Case", cat: "case", daily: [dcase(T0, 20), dcase(T0 + D, 20), dcase(T0 + 2 * D, 20)], skinportDaily: [] },
]);
ok(chain.series[0].caseIdx === 100 && near(chain.series[1].caseIdx, 100 * Math.exp(Math.log(1.04) / 3), 0.01)
  && near(chain.series[2].caseIdx, 100 * Math.exp(2 * Math.log(1.04) / 3), 0.01),
  "SMLX-2 chaining: index cumulates mean daily log-returns (100 → 101.32 → 102.65)");
// default inclusion calendar: SMLX-6 seasons a new listing 365 days (the
// measured supply-decay phase) → next first-of-month
ok(A.includedFromDay("2026-09-02") === "2027-10-01" && A.includedFromDay("2026-01-05") === "2026-01-05",
  "inclusion calendar: 365d seasoning → next first-of-month; founding cohort grandfathered");
// The seasoning MECHANICS (no-jump, scheduled inclusion) are length-agnostic —
// tested at a 30d override so fixtures stay small; restored right after.
A.INDEX_RULES.seasoningDays = 30;
// no jump on entry: the incumbent must be GRANDFATHERED (first mark before
// the 2026-07-25 adoption date), the newcomer lists after it
const TOLD = Date.UTC(2026, 6, 1);  // grandfathered incumbent from 2026-07-01
const TNEW = Date.UTC(2026, 8, 2);  // newcomer first mark 2026-09-02 → included 2026-11-01 (30d override)
const oldFlat = [];
for (let i = 0; i < 130; i++) oldFlat.push(dcase(TOLD + i * D, 10));
const noJump = A.marketOverview([
  { name: "Old Case", cat: "case", daily: oldFlat.slice(0, 70), skinportDaily: [] }, // through 2026-09-08
  { name: "New Case", cat: "case", daily: [dcase(TNEW, 9999), dcase(TNEW + D, 1), dcase(TNEW + 2 * D, 5000)], skinportDaily: [] },
]);
ok(noJump.series.every((s) => s.caseIdx === 100),
  "SMLX-2 no-jump: a seasoning newcomer's prices cannot move the index (all 100)");
ok(A.includedFromDay("2026-09-02") === "2026-11-01",
  "inclusion calendar mechanics (30d override): eligible → next first-of-month");
// scheduled inclusion: newcomer contributes only after its inclusion date
const newDaily = [];
for (let i = 0; i < 66; i++) {
  const t = TNEW + i * D;
  newDaily.push(dcase(t, mkDay(t) >= "2026-11-03" ? 110 : 100)); // +10% on 2026-11-03
}
const incl = A.marketOverview([
  { name: "Old Case", cat: "case", daily: oldFlat, skinportDaily: [] },
  { name: "Old2 Case", cat: "case", daily: oldFlat, skinportDaily: [] },
  { name: "New Case", cat: "case", daily: newDaily, skinportDaily: [] },
]);
const byDay = new Map(incl.series.map((s) => [s.day, s.caseIdx]));
ok(byDay.get("2026-11-01") === 100 && byDay.get("2026-11-02") === 100
  && near(byDay.get("2026-11-03"), 100 * Math.exp(0.05 / 3), 0.01),
  "SMLX-2 scheduled inclusion: newcomer's returns count only post-inclusion (+10% clamped to +5%, ÷3 → 101.68)");
A.INDEX_RULES.seasoningDays = 365; // restore the shipped default
ok(A.INDEX_RULES.seasoningDays === 365 && A.includedFromDay("2026-09-02") === "2027-10-01",
  "seasoning override restored (shipped default 365d back in force)");
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

// ── SMLX-6 mark-quality floors (found by the 2013-2026 backtest) ───────────
// penny marks: one $0.01 tick at $0.02 is a -50% "return" — quantization
// noise, not information. Sub-$0.25 marks contribute nothing.
const penny = A.marketOverview([
  { name: "P1 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 10)], skinportDaily: [] },
  { name: "P2 Case", cat: "case", daily: [dcase(T0, 8), dcase(T0 + D, 8)], skinportDaily: [] },
  { name: "P3 Case", cat: "case", daily: [dcase(T0, 5), dcase(T0 + D, 5)], skinportDaily: [] },
  { name: "P4 Case", cat: "case", daily: [dcase(T0, 0.02), dcase(T0 + D, 0.01)], skinportDaily: [] },
]);
ok(penny.today.caseIdx === 100,
  "SMLX-6 minPrice: a penny case's -50% tick carries no return information (index unmoved)");
// breadth floor: an "index" of one or two names is that name's price with a
// hat on — under 3 contributors the level carries
const thinDay = A.marketOverview([
  { name: "T1 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 15)], skinportDaily: [] },
  { name: "T2 Case", cat: "case", daily: [dcase(T0, 10), dcase(T0 + D, 10)], skinportDaily: [] },
]);
ok(thinDay.today.caseIdx === 100,
  "SMLX-6 minContributors: a 2-name day carries the level (no single-name passthrough past the clamp)");

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

// ── SMLX-5 weighted-median clamp center: defeats median capture ────────────
// An attacker owns a COUNT majority of thin names (11 of 20) and pumps them
// +50% on one day, trying to drag the clamp center to the fake consensus —
// which under an UNWEIGHTED median center would sit the pump AT the center
// (unclamped) AND clamp the honest names toward it (~+43% index move). With
// the WEIGHT-weighted median center, the 9 heavy honest names hold the center
// at 0, the pump is clamped to +5%, and the index moves only ~0.5%.
const capItems = [], CJ = Date.UTC(2026, 0, 20); // Jan 20+ for the Feb weight window
for (let n = 0; n < 20; n++) {
  const honest = n < 9, vol = honest ? 1000 : 10; // honest names heavy → >50% weight
  const daily = [];
  for (let i = 0; i < 6; i++) daily.push(dcase(CJ + i * D, 10, vol)); // Jan 20-25 ≥ minObs
  daily.push(dcase(TF1, 10, vol));                                    // Feb 1
  daily.push(dcase(TF2, honest ? 10 : 10 * Math.exp(0.405), vol));    // Feb 2: thin pump +50%
  capItems.push({ name: "K" + n + " Case", cat: "case", daily: daily, skinportDaily: [] });
}
const capMo = A.marketOverview(capItems);
const capLast = capMo.series[capMo.series.length - 1].caseIdx;
ok(capLast < 101 && near(capLast, 100.5, 0.2),
  "SMLX-5 weighted-median clamp: a count-majority thin pump (+50% on 11 of 20 names) moves the index <1% — heavy honest names hold the center (unweighted would print ~+43%)");

// ── settlement fixings (SMLX-3) ────────────────────────────────────────────
const setSeries = Array.from({ length: 7 }, (_, i) => ({ day: A.dayKey(T0 + i * D), t: T0 + i * D, caseIdx: 100 + i, cashRatio: 0.65 }));
const fx7 = S.computeFixing(setSeries, S.FIXINGS[0]);
ok(fx7.value === 103 && fx7.days.length === 7 && fx7.methodology === "SMLX-6",
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
ok(wbud.caseIndex.centerCapture && wbud.caseIndex.centerCapture.weighted === true
  && wbud.caseIndex.centerCapture.kMin === 9 && wbud.caseIndex.centerCapture.costPerDay === 25650,
  "SMLX-5 center-capture budget: seizing >50% of index weight (9 heaviest names, $25,650/day) is the price of UNBOUNDED control");

// ══ LANE M1 pin block — SETTLE-CASE-90D + oiCapacity + PERPMARK-CASE ═══════
// One contiguous, self-contained block (OI_SPEC invariant 5): every fixture
// is defined inside it (m1-prefixed), every expected value is HAND-COMPUTED,
// all dates fixed (no clock dependence).
// (1) catalog additivity: 90D is a NEW SMLX-6 entry; shipped names/specs and
//     the methodology id are untouched (hash-stability contract)
ok(S.METHODOLOGY === "SMLX-6"
  && S.FIXINGS.map((f) => f.name).join(",") === "SETTLE-CASE-7D,SETTLE-CASE-30D,SETTLE-CASE-90D,SETTLE-RATIO-30D",
  "M1: SETTLE-CASE-90D is an ADDITIVE SMLX-6 catalog entry (methodology id unchanged, shipped fixings untouched)");
const m1Spec90 = S.FIXINGS.find((f) => f.name === "SETTLE-CASE-90D");
ok(m1Spec90.key === "caseIdx" && m1Spec90.window === 90 && m1Spec90.minDays === 30 && m1Spec90.decimals === 2,
  "M1: 90D spec — mean of last ≤90 daily case values, min 30 days, 2 decimals (30D precision)");
// (2) canonical preimage BYTES of a shipped fixing pinned literally — any
//     drift here re-hashes history and forks every witness (invariant 1)
const m1c3 = [{ day: "2026-01-01", caseIdx: 100 }, { day: "2026-01-02", caseIdx: 101 }, { day: "2026-01-03", caseIdx: 102 }];
ok(S.canonical(S.computeFixing(m1c3, S.FIXINGS[0]))
  === '{"methodology":"SMLX-6","name":"SETTLE-CASE-7D","window":7,"days":["2026-01-01","2026-01-02","2026-01-03"],"values":[100,101,102],"value":101}',
  "M1: canonical preimage bytes of a shipped fixing pinned literally (hash stability)");
// (3) 90D arithmetic: 100 days caseIdx 100..199 → last 90 = 110..199,
//     mean = (110+199)/2 = 154.5
const m1S100 = Array.from({ length: 100 }, (_, i) => ({ day: A.dayKey(T0 + i * D), caseIdx: 100 + i }));
const m1f90 = S.computeFixing(m1S100, m1Spec90);
ok(m1f90.value === 154.5 && m1f90.days.length === 90 && m1f90.days[0] === A.dayKey(T0 + 10 * D)
  && m1f90.methodology === "SMLX-6",
  "M1: SETTLE-CASE-90D = mean of last ≤90 daily values (110..199 → 154.5)");
const m1f90sh = S.computeFixing(m1S100.slice(0, 29), m1Spec90);
ok(m1f90sh.value === null && /29\/30/.test(m1f90sh.accruing),
  "M1: 90D accrues until 30 days (29/30 → null) — never fabricated, never backfilled");
ok(Object.keys(S.computeAll(m1S100)).length === 4 && S.computeAll(m1S100)["SETTLE-CASE-7D"].value === 196,
  "M1: computeAll carries 4 fixings; shipped 7D unchanged by the addition (193..199 → 196)");
// (4) 90d budget costs on the SMLX-4 weighted fixture (42 cases, dv $1k..$42k,
//     weights ∝ dv²): uniform basket $903,000 dv → 0.5×0.15×903000 = $67,725/day
//     ×90 = $6,095,250; concentrated $12,150/day ×90 = $1,093,500; capture
//     $25,650/day ×90 = $2,308,500
const m1sq = Array.from({ length: 42 }, (_, i) => (i + 1) * (i + 1));
const m1sqTot = m1sq.reduce((a, b) => a + b, 0);
const m1wbud = S.manipulationBudget(
  Array.from({ length: 42 }, (_, i) => ({ cat: "case", tier: null, latest: 1000 * (i + 1), vol24h: 1,
    weight: m1sq[i] / m1sqTot, skinport: null })));
ok(m1wbud.caseIndex.costMove1pctFix90d === 6095250
  && m1wbud.caseIndex.concentrated.costMove1pctFix90d === 1093500
  && m1wbud.caseIndex.centerCapture.costFix90d === 2308500,
  "M1: 90d budget costs published (uniform $6,095,250 / concentrated $1,093,500 / capture $2,308,500)");
// (5) oiCapacity: N < C(Δ)/Δ. Weighted fixture, 7d: concentrated $85,050/0.01
//     → 8,505,000; capture $179,550/0.05 → 3,591,000 BINDS; /κ=3 → 1,197,000
const m1cap7 = m1wbud.oiCapacity["SETTLE-CASE-7D"];
ok(m1cap7.boundConcentrated === 8505000 && m1cap7.boundCapture === 3591000 && m1cap7.capacityLinear === 1197000,
  "M1: oiCapacity 7D — capture bound binds: min(8,505,000, 3,591,000)/3 = $1,197,000");
//     30d: capture 769,500/0.05 = 15,390,000 vs con 36,450,000 → 5,130,000;
//     90d: capture 2,308,500/0.05 = 46,170,000 vs con 109,350,000 → 15,390,000
ok(m1wbud.oiCapacity["SETTLE-CASE-30D"].capacityLinear === 5130000
  && m1wbud.oiCapacity["SETTLE-CASE-90D"].capacityLinear === 15390000,
  "M1: oiCapacity 30D/90D — attack cost scales ×N days, so capacity does too ($5.13M / $15.39M)");
// (6) min() flips: equal-weight fixture — concentrated = 9 thinnest
//     ($3,375/day → 7d $23,625 → bound 2,362,500); capture = cheapest 21
//     (Σdv $231,000 → $17,325/day → 7d $121,275 → bound 2,425,500) →
//     CONCENTRATED binds → /3 = 787,500
const m1kbud = S.manipulationBudget(
  Array.from({ length: 42 }, (_, i) => ({ cat: "case", tier: null, latest: 1000 * (i + 1), vol24h: 1, skinport: null })));
const m1kcap7 = m1kbud.oiCapacity["SETTLE-CASE-7D"];
ok(m1kcap7.boundConcentrated === 2362500 && m1kcap7.boundCapture === 2425500 && m1kcap7.capacityLinear === 787500,
  "M1: oiCapacity min() — equal-weight fixture flips to the concentrated bound (2,362,500/3 = $787,500)");
// (7) RATIO: thin-leg 30d burn 0.5×(10×30)×0.12 = $18 → bound 1,800; no
//     capture model → null; capacity 600
const m1rbud = S.manipulationBudget([
  { cat: "case", tier: null, latest: 2, vol24h: 100000, skinport: null },
  { cat: "skin", tier: null, latest: 50, vol24h: 10, skinport: { last30d: { median: 10, volume: 30 } } },
]);
const m1rcap = m1rbud.oiCapacity["SETTLE-RATIO-30D"];
ok(m1rcap.boundConcentrated === 1800 && m1rcap.boundCapture === null && m1rcap.capacityLinear === 600
  && /1% cost alone/.test(m1rcap.assumptions.deltaCap),
  "M1: oiCapacity RATIO — thin-leg 1% cost only (no capture model): $18×… → bound 1,800 → capacity 600");
ok(/linear/.test(m1cap7.assumptions.payoffs) && /binary/.test(m1cap7.assumptions.payoffs)
  && /single-party/.test(m1cap7.assumptions.attacker) && /fee-burn/.test(m1cap7.assumptions.costs)
  && /5%/.test(m1cap7.assumptions.deltaCap) && /κ = 3/.test(m1cap7.assumptions.kappa)
  && /daily \$ volume/.test(m1cap7.assumptions.hedging),
  "M1: oiCapacity assumptions name the whole frame (linear-only, single-party, fee-burn floors, Δcap 5%, κ=3, hedging ceiling)");
// (8) PERPMARK-CASE (EXPERIMENTAL, non-canonical): median-of-≤5 + 2% step guard
const m1pm = (vals) => S.perpMark(vals.map((v, i) => ({ day: A.dayKey(T0 + i * D), caseIdx: v })));
const m1clean = m1pm([100, 101, 102, 103, 104, 105]);
ok(m1clean.value === 103 && m1clean.guarded === false && m1clean.experimental === true
  && m1clean.name === "PERPMARK-CASE" && !("hash" in m1clean) && /NOT a settlement fixing/.test(m1clean.label),
  "M1: PERPMARK-CASE clean drift — median of last 5 (101..105 → 103), unguarded, labeled experimental, NO hash");
const m1one = m1pm([100, 100, 100, 100, 100, 130]);
ok(m1one.value === 100 && m1one.guarded === false,
  "M1: PERPMARK — ONE corrupted print (+30%) cannot move the mark (median absorbs it)");
const m1atk = m1pm([100, 100, 100, 100, 100, 130, 130, 130]);
ok(m1atk.value === 100 && m1atk.guarded === true && m1atk.guardedUpdates === 1,
  "M1: PERPMARK — 3-of-5 print corruption breaches the median but the 2% step guard carries the prior mark (guarded:true)");
const m1move = m1pm([100, 101.5, 103, 104.5, 106]);
ok(m1move.value === 103 && m1move.guarded === false,
  "M1: PERPMARK — a genuine steady move passes the step guard (every update ≤2%)");
// ══ end LANE M1 pin block ══════════════════════════════════════════════════

// ── INTEG-1 mark integrity: the tamper detector (flag-only) ────────────────
const NOWI = Date.UTC(2026, 6, 20, 12);
const rdFlat = (last) => Array.from({ length: 11 }, (_, i) => ({ day: "d" + i, r: i === 10 ? last : 0.8 }));
const integBase = (name, last) => ({ name: name, cat: "case", tier: null, steamPrice: 10, quoteT: NOWI,
  salesT: NOWI - 86400000, sales30: 20, ratioDays: rdFlat(last), book: null });
// one item's steam price pumped → its cash ratio craters vs its OWN baseline
// while the cohort holds → steam-rich alert (median-relative, so only the
// outlier flags)
const gPump = S.assessIntegrity([
  integBase("P Case", 0.45), integBase("H1 Case", 0.8), integBase("H2 Case", 0.8),
  integBase("H3 Case", 0.8), integBase("H4 Case", 0.8),
], { now: NOWI });
ok(gPump.flags.length === 1 && gPump.flags[0].name === "P Case" && gPump.flags[0].lane === "ratio"
  && gPump.flags[0].severity === "alert" && /steam-rich/.test(gPump.flags[0].detail),
  "INTEG-1 ratio lane: a pumped steam price craters its own cash ratio → steam-rich ALERT (cohort clean)");
// market-wide ratio shift (steam-wallet premium moves) → NOT manipulation →
// zero flags (the cross-sectional gate absorbs it, like the index clamp)
const gWide = S.assessIntegrity(
  ["A", "B", "C", "D"].map((n) => integBase(n + " Case", 0.6)), { now: NOWI });
ok(gWide.flags.length === 0 && gWide.summary.ratioCorroborated === "4/4",
  "INTEG-1 ratio lane: a market-wide ratio shift flags NOTHING (median-relative gate)");
// book lane: last-sale median escaping the standing bid/ask bracket
const bookOk = { t: NOWI, bid: 9.5, ask: 10.4, mid: 9.95 };
const gBook = S.assessIntegrity([
  Object.assign(integBase("B1 Case", 0.8), { steamPrice: 15, book: { t: NOWI, bid: 9.5, ask: 10.4, mid: 9.95 } }),
  Object.assign(integBase("B2 Case", 0.8), { steamPrice: 10, book: bookOk }),
], { now: NOWI });
const bookFlags = gBook.flags.filter((f) => f.lane === "book");
ok(bookFlags.length === 1 && bookFlags[0].name === "B1 Case" && bookFlags[0].severity === "alert"
  && /above the standing ask/.test(bookFlags[0].detail) && gBook.summary.bookCorroborated === "2/2",
  "INTEG-1 book lane: quote 44% above the standing ask wall → ALERT; in-bracket quote clean");
// UNIQUE items (floats/patterns) are excluded from the bracket check: their
// buy orders sit on premium variants far above the generic sale median —
// that's collectors bidding, not manipulation (live false-alarm, 2026-07-26)
const gUnique = S.assessIntegrity([
  { name: "AK Skin", cat: "skin", tier: null, steamPrice: 42, quoteT: NOWI, salesT: NOWI, sales30: 20,
    ratioDays: rdFlat(0.8), book: { t: NOWI, bid: 197, ask: 208, mid: 202.5 } },
], { now: NOWI });
ok(gUnique.flags.filter((f) => f.lane === "book").length === 0 && gUnique.summary.bookCorroborated === "0/0",
  "INTEG-1 book lane is COMMODITY-only: a premium-variant bid wall on a unique skin never false-alarms");
// art-evidence lane: thin appraisal evidence is published, unknown is not fabricated
const gArt = S.assessIntegrity([
  { name: "Grail A", tier: "art", sales30: 1, ratioDays: [], book: null },
  { name: "Grail B", tier: "art", sales30: 8, ratioDays: [], book: null },
  { name: "Grail C", tier: "art", sales30: null, ratioDays: [], book: null },
], { now: NOWI });
ok(gArt.flags.length === 1 && gArt.flags[0].lane === "art-evidence" && gArt.flags[0].name === "Grail A"
  && gArt.summary.artEvidenced === "1/3",
  "INTEG-1 art lane: 1 sale in the 30d marking window flagged; unknown evidence never fabricated");
// staleness lane: majority-stale steam quotes = possible venue loss → alert
const gStale = S.assessIntegrity([
  Object.assign(integBase("S1 Case", 0.8), { quoteT: NOWI - 3 * 86400000 }),
  Object.assign(integBase("S2 Case", 0.8), { quoteT: NOWI - 3 * 86400000 }),
  integBase("S3 Case", 0.8),
], { now: NOWI });
ok(gStale.flags.some((f) => f.lane === "staleness" && f.severity === "alert"),
  "INTEG-1 staleness lane: 2/3 quotes stale → venue-loss ALERT surfaces loudly");

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
  if (url.includes("/market/listings/")) // SSR listing page with the embedded react-query order book
    // + full price history (TRAPS mirrored from live: integer CENTS,
    // PER-LEVEL quantities; history time in SECONDS, price in dollars)
    return { status: 200, body: '<html>window.SSR.loaderData = "{\\"amtMaxBuyOrder\\":2250,\\"amtMinSellOrder\\":2350,' +
      '\\"cBuyOrders\\":60,\\"cSellOrders\\":90,\\"rgCompactBuyOrders\\":[2250,5,2200,15,2000,40],' +
      '\\"rgCompactSellOrders\\":[2350,4,2400,11,3000,75],' +
      '\\"ecurrency\\":1,\\"prices\\":[{\\"time\\":1596758400,\\"price_median\\":10.7,\\"purchases\\":57688},' +
      '{\\"time\\":1596844800,\\"price_median\\":6.93,\\"purchases\\":48599}]}"</html>' };
  if (url.includes("steamcharts.com/app/")) // monthly avg players table (macro backfill)
    return { status: 200, body: '<tr><td class="month-cell left">July 2012</td><td class="right num-f">932.57</td></tr>' +
      '<tr><td class="month-cell left">August 2012</td><td class="right num-f">1522.10</td></tr>' };
  if (url.includes("api.blockchain.info/charts/market-price"))
    return { status: 200, body: JSON.stringify({ values: [
      { x: 1282089600, y: 0.0674 }, { x: 1764028800, y: 64095.49 }, { x: 1, y: 0 }] }) };
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
  // order-book fetcher (INTEG-1 second read path) against the SSR fixture
  const book = await M.steamOrderBook("Fracture Case");
  ok(book.bid === 22.5 && book.ask === 23.5 && book.mid === 23 && book.spreadPct === 4.3,
    "steamOrderBook: integer-cents bid/ask parsed from the SSR-embedded book (2250 → $22.50)");
  ok(book.bidQty5 === 20 && book.askQty5 === 15 && book.bidUsd5 === 460 && book.askUsd5 === 345
    && book.cBuy === 60 && book.cSell === 90,
    "steamOrderBook: ±5%-of-mid depth summed over PER-LEVEL quantities + total book sizes");
  const histPub = await M.steamPriceHistoryPublic("Fracture Case");
  ok(histPub.length === 2 && histPub[0].t === 1596758400000 && histPub[0].price === 10.7 && histPub[0].vol === 57688,
    "steamPriceHistoryPublic: full logged-out history from the same SSR payload (seconds → ms)");
  const scMonthly = await M.steamchartsMonthly();
  ok(scMonthly.length === 2 && scMonthly[0].day === "2012-07-01" && scMonthly[0].players === 933
    && scMonthly[1].day === "2012-08-01",
    "steamchartsMonthly: monthly avg players parsed + sorted (macro overlay backfill)");
  const btcHist = await M.btcHistoryAll();
  ok(btcHist.length === 2 && btcHist[0].day === "2010-08-18" && btcHist[0].usd === 0.07
    && btcHist[1].usd === 64095.49,
    "btcHistoryAll: blockchain.info points parsed, zero-price rows dropped");
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

  // Founding-cohort seeding (time-stable index base tests). In production the
  // real basket was first observed on the adoption date, so those cases are
  // grandfathered and index from 100. A case created FRESH in a probe temp dir
  // is first-seen "today", which is now past the adoption cutoff → it correctly
  // SEASONS OUT (caseIdx null) instead of basing at 100. Seed a launch-day mark
  // so the tested items match the real basket's grandfathered status; the
  // series is then exactly {launch-day, today} = 2 flat marks → index 100, and
  // stays 2 marks no matter how far "today" drifts (no interpolated days).
  const ADOPT_T = Date.UTC(2026, 6, 25, 12); // 2026-07-25 — dayKey ≤ INDEX_RULES.adoption
  const seedFounding = (dir, name, line) => {
    const hd = path.join(dir, "history");
    fs.mkdirSync(hd, { recursive: true });
    fs.appendFileSync(path.join(hd, slug(name) + ".jsonl"), JSON.stringify(Object.assign({ t: ADOPT_T }, line)) + "\n");
  };

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
  seedFounding(DATA, "Fracture Case", { src: "steam", price: 23, lowest: 22.1, vol: 57 }); // launch mark FIRST (chronological)
  await api("/api/skins/refresh", { name: "Fracture Case" });
  // item detail merges DISPLAY-ONLY deep history (repo backtest/history/)
  // under the live marks; the market/index path below must NOT see it
  const frIt = await api("/api/skins/item?name=" + encodeURIComponent("Fracture Case"));
  ok(frIt.body.deepDays > 500 && frIt.body.daily.length > 500
    && frIt.body.daily[frIt.body.daily.length - 1].price === 23,
    "item report: deep backfill fills the chart, live snapshot stays the last word (" + frIt.body.deepDays + " deep days)");
  const mkt = await api("/api/skins/market");
  ok(mkt.status === 200 && mkt.body.today && mkt.body.today.caseIdx === 100,
    "live /api/skins/market: grandfathered case indexes at base 100 (launch + today, flat)");
  ok(mkt.body.settlement && mkt.body.settlement.methodology === "SMLX-6"
    && mkt.body.settlement.fixings["SETTLE-CASE-7D"]
    && /^[0-9a-f]{64}$/.test(mkt.body.settlement.fixings["SETTLE-CASE-7D"].hash),
    "live market serves SMLX-6 fixings with 64-hex canonical hashes");
  ok(mkt.body.integrity && mkt.body.integrity.version === "INTEG-1" && mkt.body.integrity.summary,
    "live market serves the INTEG-1 block (assessIntegrity — one function, all surfaces)");
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

  // ═════════════════════════════════════════════════════════════════════════
  // S2 PIN BLOCK (lane S2, feat/inv-server) — Steam INVENTORY routes, storage
  // and INV_REPORT assembly. ONE contiguous block, hand-computed fixtures, on
  // its own temp data dir + port so nothing above or below is disturbed.
  //
  // NO NETWORK: market.js's transport is replaced with a counting fixture, and
  // the data-layer functions (market.js resolve/fetch, analytics.js value/
  // reconstruction) are injected ONLY IF MISSING — so these pins pass before
  // that lane lands and then exercise the REAL functions once it does. The
  // injected stand-ins implement the frozen cross-lane contract exactly, so
  // every number below holds either way (a mismatch after the merge is a
  // genuine contract break, and should fail loudly).
  console.log("— inventory (server) —");
  {
    const { parseInventoryPayload } = require("./server.js");
    ok(/^local-data\/$/m.test(fs.readFileSync(path.join(__dirname, ".gitignore"), "utf8")),
      "local-data/ is gitignored — an inventory + its SteamID can never reach the repo");

    // fake-but-well-formed identity (privacy invariant: never a real SteamID)
    const FAKE_ID = "76561190000000001";
    let invMode = "ok";
    const invHits = { total: 0, inventory: 0, profile: 0 };
    // one CS2 inventory: a duplicate stack (2 assets → qty 2), a case, an item
    // we only know from the Skinport dump, and an unmarketable sticker we
    // cannot price at all
    const asset = (classid, amount) => ({ appid: 730, contextid: "2", assetid: String(invHits.total) + classid,
      classid: classid, instanceid: "0", amount: String(amount) });
    const desc = (classid, name, marketable) => ({ appid: 730, classid: classid, instanceid: "0",
      market_hash_name: name, marketable: marketable, tradable: marketable, currency: 0 });
    const INV_PAYLOAD = {
      success: 1, total_inventory_count: 5,
      assets: [asset("c1", 1), asset("c1", 1), asset("c2", 1), asset("c3", 1), asset("c4", 1)],
      descriptions: [desc("c1", "QQ Skin", 1), desc("c2", "A1 Case", 1),
        desc("c3", "Dump Only Item", 1), desc("c4", "Unknown Sticker", 0)],
    };
    async function invTransport(url, headers) {
      if (url.includes("/inventory/")) {
        invHits.total++; invHits.inventory++;
        if (invMode === "private") return { status: 403, body: JSON.stringify({ success: false }) };
        if (invMode === "ratelimited") return { status: 429, body: "" };
        return { status: 200, body: JSON.stringify(INV_PAYLOAD) };
      }
      if (/steamcommunity\.com\/id\//.test(url)) {
        invHits.total++; invHits.profile++;
        if (invMode === "noprofile") return { status: 200, body: "<html><body>The specified profile could not be found.</body></html>" };
        return { status: 200, body: '<html><script>g_rgProfileData = {"url":"https://steamcommunity.com/id/probe-fake-user",' +
          '"steamid":"' + FAKE_ID + '","personaname":"probe"};</script></html>' };
      }
      return fixtureTransport(url, headers);
    }
    // ── contract stand-ins (installed only where the data lane is absent) ──
    const invSaved = { rp: M.resolveSteamProfile, si: M.steamInventory,
      iv: A.inventoryValue, ir: A.inventoryReconstruction };
    if (typeof M.resolveSteamProfile !== "function") {
      M.resolveSteamProfile = async function (input) {
        const raw = String(input || "").trim();
        if (/^\d{17}$/.test(raw)) return { steamid64: raw, vanity: null, source: "steamid64" };
        const pr = /\/profiles\/(\d{17})/.exec(raw);
        if (pr) return { steamid64: pr[1], vanity: null, source: "url" };
        const vanity = (/\/id\/([^/?#]+)/.exec(raw) || [null, raw])[1];
        const res = await invTransport("https://steamcommunity.com/id/" + encodeURIComponent(vanity));
        const g = /"steamid"\s*:\s*"(\d{17})"/.exec(res.body || "");
        if (!g) throw new Error("no Steam profile named \"" + vanity + "\" — check the URL");
        return { steamid64: g[1], vanity: vanity, source: "vanity" };
      };
    }
    if (typeof M.steamInventory !== "function") {
      M.steamInventory = async function (steamid64) {
        const res = await invTransport("https://steamcommunity.com/inventory/" + steamid64 + "/730/2?l=english&count=5000");
        if (res.status === 403) throw new Error("inventory is private or hidden — set it to Public in Steam privacy settings");
        if (res.status === 429) throw new Error("Steam is rate-limiting inventory reads — try again in a few minutes");
        if (res.status !== 200) throw new Error("steam inventory HTTP " + res.status);
        const p = parseInventoryPayload(res.body);
        return { steamid64: steamid64, count: p.count, items: p.items, truncated: p.truncated };
      };
    }
    if (typeof A.inventoryValue !== "function") {
      A.inventoryValue = function (items, priceOf) {
        let total = 0, pricedCount = 0, unpricedCount = 0;
        const rows = (items || []).map((it) => {
          const p = priceOf(it.name);
          const price = p != null && isFinite(p) && p > 0 ? p : null;
          const value = price != null ? Math.round(price * it.qty * 100) / 100 : null;
          if (price != null) { pricedCount++; total += value; } else unpricedCount++;
          return { name: it.name, qty: it.qty, price: price, value: value };
        });
        rows.sort((a, b) => (b.value == null ? -1 : b.value) - (a.value == null ? -1 : a.value));
        return { total: Math.round(total * 100) / 100, pricedCount: pricedCount, unpricedCount: unpricedCount, rows: rows };
      };
    }
    if (typeof A.inventoryReconstruction !== "function") {
      A.inventoryReconstruction = function (items, historyOf, opts) {
        const priceOf = opts && typeof opts.priceOf === "function" ? opts.priceOf : null;
        const held = [];
        let totalNames = 0, pricedNames = 0;
        const hist = new Map();
        for (const it of items || []) {
          totalNames++;
          const h = (historyOf(it.name) || []).filter((r) => r && r.day && r.price > 0)
            .slice().sort((a, b) => (a.day < b.day ? -1 : 1));
          hist.set(it.name, h);
          if (h.length) { pricedNames++; held.push({ qty: it.qty, rows: h }); }
        }
        const dayset = new Set();
        for (const x of held) for (const r of x.rows) dayset.add(r.day);
        const cur = held.map(() => ({ i: 0, last: null }));
        const days = [];
        for (const day of Array.from(dayset).sort()) {
          let v = 0;
          for (let k = 0; k < held.length; k++) {
            const st = cur[k], rows = held[k].rows;
            // carry forward within THIS item's own series only — never across items
            while (st.i < rows.length && rows[st.i].day <= day) { st.last = rows[st.i].price; st.i++; }
            if (st.last != null) v += st.last * held[k].qty;
          }
          days.push({ day: day, value: Math.round(v * 100) / 100 });
        }
        let num = 0, den = 0;
        for (const it of items || []) {
          const h = hist.get(it.name) || [];
          let p = priceOf ? priceOf(it.name) : null;
          if (p == null && h.length) p = h[h.length - 1].price;
          if (!(p > 0)) continue;
          den += p * it.qty;
          if (h.length) num += p * it.qty;
        }
        return { days: days, coveragePct: den > 0 ? Math.round((num / den) * 1000) / 10 : 0,
          pricedNames: pricedNames, totalNames: totalNames };
      };
    }
    M.setTransport(invTransport);

    // ── fixture tracker state (all synthetic; no repo artifacts involved) ──
    // 3 founding cases 10 → 11 today  ⇒ Skindex 100 → 110 (+10.0%)
    // QQ Skin 100 → 150 today, held ×2;  "Dump Only Item" priced by the dump
    // at $89 with NO history;  "Unknown Sticker" unpriceable.
    const INV_DATA = path.join(os.tmpdir(), "hh-skin-inv-" + Date.now());
    const INV_NOW = Date.now();
    fs.mkdirSync(path.join(INV_DATA, "history"), { recursive: true });
    fs.mkdirSync(path.join(INV_DATA, "cache"), { recursive: true });
    fs.writeFileSync(path.join(INV_DATA, "watchlist.json"), JSON.stringify(["A1 Case", "A2 Case", "A3 Case"]));
    const invMark = (name, t, price) => fs.appendFileSync(path.join(INV_DATA, "history", slug(name) + ".jsonl"),
      JSON.stringify({ t: t, src: "steam", price: price, lowest: price, vol: 1 }) + "\n");
    for (const n of ["A1 Case", "A2 Case", "A3 Case"]) { invMark(n, ADOPT_T, 10); invMark(n, INV_NOW, 11); }
    invMark("QQ Skin", ADOPT_T, 100); invMark("QQ Skin", INV_NOW, 150);
    fs.writeFileSync(path.join(INV_DATA, "cache", "skinport-items.json"), JSON.stringify({ t: INV_NOW, items: [
      { name: "Dump Only Item", min: 89, mean: 95, median: 92, max: 120, qty: 7 },
      { name: "A1 Case", min: 999, mean: 999, median: 999, max: 999, qty: 3 }, // tracked mark must WIN this
    ] }));
    // an earlier load of THIS inventory, 20 min ago — the next load must
    // APPEND beside it. Tagged with the id it describes: a snapshot line now
    // carries whose inventory it is, so a line from another profile can never
    // extend this one (see the identity pins in the F1 block below).
    fs.writeFileSync(path.join(INV_DATA, "inventory.jsonl"),
      JSON.stringify({ t: INV_NOW - 20 * 60000, value: 350, count: 5, id: FAKE_ID, sig: "seed" }) + "\n");

    const IPORT = 5501;
    let iinst = startServer({ port: IPORT, dataDir: INV_DATA, snapHours: 0, steamCookie: "" });
    await new Promise((r) => iinst.server.once("listening", r));
    const iapi = async (p, body) => {
      const opts = body
        ? { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) }
        : { headers: { Connection: "close" } };
      const r = await fetch("http://localhost:" + IPORT + p, opts);
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const noStack = (s) => typeof s === "string" && s.length > 0 && !/\n\s*at /.test(s);

    // (1) plain-English errors, correct codes, never a stack trace
    const iBad = await iapi("/api/skins/inventory");
    ok(iBad.status === 400 && noStack(iBad.body.error) && /SteamID64/.test(iBad.body.error)
      && /no sign-in/i.test(iBad.body.error),
      "GET inventory with no profile → 400 plain English (and says the no-sign-in part out loud)");
    const iBadPaste = await iapi("/api/skins/inventory", { paste: "<html>not json</html>" });
    ok(iBadPaste.status === 400 && noStack(iBadPaste.body.error) && /JSON/.test(iBadPaste.body.error),
      "POST paste that isn't inventory JSON → 400 with the fix, not a parser stack");

    // (2) full flow: resolve vanity → fetch → price → value → recon → series
    const iR1 = await iapi("/api/skins/inventory?profile=probe-fake-user");
    ok(iR1.status === 200 && iR1.body.steamid64 === FAKE_ID && iR1.body.cached === false
      && iR1.body.count === 5 && iR1.body.profile === "probe-fake-user",
      "GET ?profile=<vanity> resolves → fetches → INV_REPORT (5 assets, 4 item types)");
    const iV = iR1.body.value;
    // priced/unpriced count UNITS (the canonical analytics semantics), so they
    // sum to the inventory's unit count: 2×QQ + 1×A1 + 1×Dump = 4 priced units,
    // 1 unpriced unit, 5 total — across 4 distinct names.
    ok(iV.total === 400 && iV.pricedCount === 4 && iV.unpricedCount === 1
      && iV.pricedCount + iV.unpricedCount === iR1.body.count && iV.rows.length === 4,
      "inventoryValue: 2×QQ Skin@150 + A1 Case@11 + Dump Only@89 = $400; priced/unpriced are UNITS summing to count, 1 unit unpriced (never guessed)");
    ok(iV.rows[0].name === "QQ Skin" && iV.rows[0].qty === 2 && iV.rows[0].value === 300
      && iV.rows[3].name === "Unknown Sticker" && iV.rows[3].price === null,
      "rows sort by value desc, duplicate stacks merged to qty 2, the unpriceable item reports null");
    ok(iV.rows.find((r) => r.name === "A1 Case").price === 11,
      "pricing order: our own tracked mark ($11) beats the Skinport dump ($999) for the same name");
    ok(iV.rows.find((r) => r.name === "Dump Only Item").price === 89,
      "pricing order: an untracked item falls back to the cached Skinport dump ($89)");
    ok(invHits.profile === 1 && invHits.inventory === 1 && invHits.total === 2,
      "one vanity resolve + one inventory read, nothing else (Steam is IP-rate-limited)");

    // (3) reconstruction — hand-computed. Only names with their OWN history
    // count: 2×QQ Skin + 1×A1 Case = 2×100+10 = 210 on the founding day,
    // 2×150+11 = 311 today. Coverage is by VALUE: 311 of the $400 total = 77.8%.
    const iRec = iR1.body.recon;
    ok(iRec.days.length === 2 && iRec.days[0].day === "2026-07-25" && iRec.days[0].value === 210
      && iRec.days[1].value === 311,
      "inventoryReconstruction values TODAY's holdings backwards on each item's own history (210 → 311)");
    ok(iRec.coveragePct === 77.8 && iRec.pricedNames === 2 && iRec.totalNames === 4,
      "coverage is share of VALUE with usable history (311/400 = 77.8%), 2 of 4 names — no interpolation for the rest");

    // (4) alpha vs the Skindex over that same span: inventory +48.1%
    // (311/210), index 100 → 110 = +10.0% ⇒ alpha +38.1
    const iB = iR1.body.benchmark;
    ok(iB && iB.invPct === 48.1 && iB.idxPct === 10 && iB.alpha === 38.1 && iB.spanDays === 2,
      "benchmark: inventory +48.1% vs Skindex +10.0% over the reconstruction span → alpha +38.1");

    // (5) snapshot series: appended beside the 20-min-old line, then deduped
    ok(iR1.body.series.length === 2 && iR1.body.series[0].value === 350
      && iR1.body.series[1].value === 400 && iR1.body.series[1].count === 5,
      "snapshot appended to local-data/inventory.jsonl (prior load 20 min ago kept, new one beside it)");

    // (6) a cached read must not touch the network AT ALL — not the inventory
    // fetch, not even the vanity resolve
    const iR2 = await iapi("/api/skins/inventory?profile=probe-fake-user");
    ok(iR2.status === 200 && iR2.body.cached === true && iR2.body.value.total === 400
      && iR2.body.fetchedAt === iR1.body.fetchedAt && invHits.total === 2,
      "second read inside the 10-min TTL is served from cache — transport call count still 2 (no re-fetch)");
    ok(iR2.body.series.length === 2 && /Cached read/.test(iR2.body.note),
      "snapshot deduped inside 10 minutes (series still 2 lines) and the note says the read was cached");
    // the FILE is append-only (every load is recorded, nothing is ever
    // rewritten); the 10-minute dedupe is a collapse applied on READ, which is
    // what lets a correction inside the window win instead of being dropped
    ok(fs.readFileSync(path.join(INV_DATA, "inventory.jsonl"), "utf8").trim().split("\n").length === 3,
      "the snapshot file stays append-only (3 lines for 3 loads) while the SERIES collapses the 10-minute window to 2 points");

    // (7) paste path (the static-host idiom) — identical math, zero network
    const iPaste = await iapi("/api/skins/inventory", { paste: JSON.stringify(INV_PAYLOAD) });
    ok(iPaste.status === 200 && iPaste.body.value.total === 400 && iPaste.body.count === 5
      && iPaste.body.recon.coveragePct === 77.8 && invHits.total === 2,
      "POST {paste} parses assets+descriptions locally → identical INV_REPORT, no network call");
    ok(iPaste.body.value.rows[0].qty === 2 && /pasted inventory JSON/.test(iPaste.body.note),
      "paste path merges duplicate stacks on classid_instanceid the same way the fetcher does");
    // the join itself: the server's standalone fallback must agree item-for-
    // item with the data layer's SHARED parseSteamInventory (the function its
    // fetcher uses), which the paste route delegates to once market.js has it
    const iNorm = (its) => JSON.stringify(its.slice().sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((i) => [i.name, i.qty, !!i.marketable, !!i.tradable]));
    const iLocal = parseInventoryPayload(JSON.stringify(INV_PAYLOAD));
    ok(iLocal.count === 5 && iLocal.items.length === 4 && iLocal.truncated === false
      && iNorm(iLocal.items) === '[["A1 Case",1,true,true],["Dump Only Item",1,true,true],["QQ Skin",2,true,true],["Unknown Sticker",1,false,false]]'
      && (typeof M.parseSteamInventory !== "function"
        || iNorm(M.parseSteamInventory(INV_PAYLOAD).items) === iNorm(iLocal.items)),
      "paste join: the server fallback matches the shared parseSteamInventory item-for-item (qty summed, marketable/tradable carried)");

    // (8) upstream failures surface as the user's own next action
    invMode = "private";
    const iPriv = await iapi("/api/skins/inventory", { profile: "probe-fake-user" });
    // 403 (not 404): the profile exists, its inventory is just hidden — a
    // different user fix than a mistyped profile, so clients can branch on it
    ok(iPriv.status === 403 && noStack(iPriv.body.error) && /private or hidden/.test(iPriv.body.error)
      && /Public/.test(iPriv.body.error),
      "private inventory → 403 + Steam's own fix (\"set it to Public\"), distinct from a 404 unknown profile, never a 500 or a stack");
    // ── CORS/CSRF lock (adversarial review, BLOCKER) ────────────────────────
    // The API answers with personal data (portfolio lots, SteamID, holdings).
    // A wildcard ACAO let any page the user had open read all of it, and a
    // no-preflight text/plain POST rewrite server state. A foreign Origin must
    // now be refused OUTRIGHT (403, no ACAO) — withholding the header alone
    // would still have let the request RUN.
    const originGet = async (p, origin) => {
      const r = await fetch("http://127.0.0.1:" + IPORT + p, { headers: { Origin: origin, Connection: "close" } });
      return { status: r.status, acao: r.headers.get("access-control-allow-origin") };
    };
    const evilRead = await originGet("/api/skins/portfolio", "https://evil.example");
    ok(evilRead.status === 403 && !evilRead.acao,
      "foreign origin CANNOT read the API: 403 and no Access-Control-Allow-Origin (personal data stays put)");
    const evilInv = await originGet("/api/skins/inventory?profile=probe-fake-user", "https://evil.example");
    ok(evilInv.status === 403 && !evilInv.acao,
      "foreign origin CANNOT reach the inventory route (SteamID + holdings unreadable cross-site)");
    const evilWrite = await fetch("http://127.0.0.1:" + IPORT + "/api/skins/inventory", {
      method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain", Connection: "close" },
      body: JSON.stringify({ profile: "76561198999999999" }) });
    ok(evilWrite.status === 403,
      "CSRF write refused: a no-preflight cross-origin POST cannot repoint the stored profile");
    const pagesOk = await originGet("/api/skins/health", "https://blackjakk.github.io");
    ok(pagesOk.status === 200 && pagesOk.acao === "https://blackjakk.github.io",
      "the hosted dashboard's own origin is still allowed (reflected, not wildcarded)");
    const localOk = await originGet("/api/skins/health", "http://localhost:1234");
    ok(localOk.status === 200 && localOk.acao === "http://localhost:1234",
      "a localhost dashboard on any port is still allowed");

    invMode = "ratelimited";
    const iRate = await iapi("/api/skins/inventory", { profile: "probe-fake-user" });
    ok(iRate.status === 429 && /rate-limiting/.test(iRate.body.error),
      "Steam rate-limit → 429 with the wait-and-retry message");
    invMode = "noprofile";
    const iMiss = await iapi("/api/skins/inventory", { profile: "no-such-probe-user" });
    ok(iMiss.status === 404 && noStack(iMiss.body.error),
      "unknown vanity name → 404 (a failed resolve is a missing profile, not an upstream fault)");
    invMode = "ok";

    // (9) restart: the snapshot series, the last profile and the fetch cache
    // all come back from local-data/ — and the cached read still costs nothing
    const hitsBefore = invHits.total;
    await iinst.close();
    iinst = startServer({ port: IPORT, dataDir: INV_DATA, snapHours: 0, steamCookie: "" });
    await new Promise((r) => iinst.server.once("listening", r));
    const iSer = await iapi("/api/skins/inventory/series");
    // the LAST load was the paste, which carries no SteamID — it keeps its own
    // composition-keyed line rather than being attributed to the resolved
    // profile's, so this replays one point, from disk, after a restart
    ok(iSer.status === 200 && iSer.body.series.length === 1 && iSer.body.series[0].value === 400,
      "restart: GET /api/skins/inventory/series replays the last loaded inventory's own line from disk");
    const iR3 = await iapi("/api/skins/inventory");
    ok(iR3.status === 200 && iR3.body.cached === true && iR3.body.profile === "probe-fake-user"
      && iR3.body.value.total === 400 && invHits.total === hitsBefore,
      "restart: the last profile + its cached inventory survive, and re-reading still makes no network call");

    // ── the right to be forgotten (privacy control) ─────────────────────────
    // A feature that stores a SteamID and a holdings history must let the user
    // erase it, or the panel's privacy copy is a promise it cannot keep.
    const fGet = await fetch("http://127.0.0.1:" + IPORT + "/api/skins/inventory/forget", { headers: { Connection: "close" } });
    ok(fGet.status === 405, "erasing inventory data is POST-only (a GET cannot destroy it, so no link or prefetch can)");
    const seriesBefore = (await iapi("/api/skins/inventory/series")).body.series;
    const forget = await iapi("/api/skins/inventory/forget", {});
    ok(forget.status === 200 && forget.body.ok === 1 && forget.body.cleared >= seriesBefore.length,
      "POST /inventory/forget reports how many recorded points it erased");
    ok(!fs.existsSync(path.join(INV_DATA, "inventory.json")) && !fs.existsSync(path.join(INV_DATA, "inventory.jsonl")),
      "forget deletes the stored SteamID/profile AND the whole recorded value history from disk");
    const seriesAfter = (await iapi("/api/skins/inventory/series")).body.series;
    ok(Array.isArray(seriesAfter) && seriesAfter.length === 0,
      "after forget the series reads empty — nothing personal survives the erase");

    await iinst.close();

    M.setTransport(fixtureTransport);
    M.resolveSteamProfile = invSaved.rp; M.steamInventory = invSaved.si;
    A.inventoryValue = invSaved.iv; A.inventoryReconstruction = invSaved.ir;
    for (const [o, k] of [[M, "resolveSteamProfile"], [M, "steamInventory"],
      [A, "inventoryValue"], [A, "inventoryReconstruction"]]) if (o[k] === undefined) delete o[k];
    fs.rmSync(INV_DATA, { recursive: true, force: true });
  }
  // ═══ end S2 pin block ═════════════════════════════════════════════════════

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
  // committed deep history for the SPARK backfill (display-only): 18 daily
  // closes ending 3 days ago, strictly before Fracture's founding mark — the
  // 14d sparkline must splice deep→collected while mi.daily (the index
  // input) stays deep-blind
  fs.mkdirSync(path.join(CROOT, "backtest", "history"), { recursive: true });
  fs.writeFileSync(path.join(CROOT, "backtest", "history", slug("Fracture Case") + ".json"),
    JSON.stringify({ rows: Array.from({ length: 18 }, (_, i) => [Date.now() - (20 - i) * D, 10 + i * 0.5, 100]) }));
  // grandfather the case + art grail (see seedFounding note) so the index
  // bases at 100 instead of seasoning out now that "today" > adoption date
  seedFounding(path.join(CROOT, "data"), "Fracture Case", { src: "steam", price: 23, lowest: 22.1, vol: 57 });
  seedFounding(path.join(CROOT, "data"), "M4A4 | Howl (Field-Tested)", { src: "skinport", price: 20, vol: 21, sp30: 20 });
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
  // TIME-STABLE (fixed 2026-07-27, was pinned to "2/3 days"): the founding
  // seed sits at the adoption date and the fixture case's flat level CARRIES
  // across every day since, so the series grows one flat 100-mark per real
  // day — below minDays the fixing must accrue, at/after it must value at
  // exactly 100 (mean of a flat founding series), forever.
  const fxDaysN = setPub.detail["SETTLE-CASE-7D"].days.length;
  ok(fxPub && (fxDaysN < 3
      ? fxPub.value === null && new RegExp("^" + fxDaysN + "/3").test(fxPub.accruing || "")
      : fxPub.value === 100 && fxPub.accruing === null)
    && fxPub.hash === crypto.createHash("sha256").update(S.canonical(setPub.detail["SETTLE-CASE-7D"])).digest("hex"),
    "collector publishes settlement.json; hash re-derives from canonical detail (flat founding series: accrue below 3 days, value 100 after)");
  ok(fs.existsSync(path.join(CROOT, "data", "settlements.jsonl"))
    && c1.manifest.market.settlement && c1.manifest.market.settlement.budget.caseIndex.dailyDollarVolume === 1311,
    "fixing history appended; manipulation budget from live volumes (23×57=$1,311)");
  const cCon = c1.manifest.market.settlement.budget.caseIndex.concentrated;
  ok(cCon && cCon.kMin === 1 && cCon.costMove1pctDay === 98,
    "collector publishes the concentrated attack budget (cheapest-1 of a 1-case basket: 0.5×1311×0.15≈$98)");
  // ── integration wiring pins (perpmark publication + market-universe budget) ──
  // The fixture's case series is a flat founding run of 100-marks, so the
  // published PERPMARK (median of the last ≤5 prints, 2% step guard) must be
  // exactly 100 with zero guarded updates — hand-computed, time-stable.
  ok(setPub.latest.perpmark && setPub.latest.perpmark.name === "PERPMARK-CASE"
    && setPub.latest.perpmark.experimental === true
    && setPub.latest.perpmark.value === 100 && setPub.latest.perpmark.guardedUpdates === 0,
    "collector publishes PERPMARK-CASE in the non-canonical latest area (flat series → mark 100, 0 guards)");
  ok("marketUniverse" in setPub.latest.budget
    && (setPub.latest.budget.marketUniverse === null
      || (setPub.latest.budget.marketUniverse.centerCapture.weightNeeded === 0.5
        && Number.isInteger(setPub.latest.budget.marketUniverse.concentrated.costMove1pctDay))),
    "budget carries the SMLX-7 preview market-universe economics slot (null or well-formed)");
  // ── market-metrics pins (dollar volume · deep-spark backfill · BTC sessions) ──
  const frRow = c1.manifest.items.find((i) => i.name === "Fracture Case");
  const nmRow = c1.manifest.items.find((i) => i.name === NAME);
  ok(nmRow && nmRow.dvol === 1311 && frRow && frRow.dvol === 23 * 57,
    "manifest rows publish dollar volume (units × price paid: 23×57=$1,311)");
  ok(frRow && frRow.spark.length === 14 && new Set(frRow.spark).size > 2
    && frRow.spark[frRow.spark.length - 1] === 23,
    "14d spark backfills from committed deep history (display-only splice; ends at the collected mark)");
  ok(c1.manifest.market.today.btcSessions && c1.manifest.market.today.btcSessions.ready === false,
    "today publishes the BTC session-split slot (accruing until 3h-cadence samples exist)");
  // ── embed API + benchmark pins ─────────────────────────────────────────
  const emb = JSON.parse(fs.readFileSync(path.join(CROOT, "data", "skindex.json"), "utf8"));
  ok(emb.v === 1 && emb.name === "Skindex" && emb.methodology === "SMLX-6"
    && emb.level === 100 && emb.fixings["SETTLE-CASE-7D"]
    && /^https:/.test(emb.links.site) && /attribution/i.test(emb.terms),
    "collector publishes the stable embed JSON (v1, level from the founding series, fixings + terms)");
  const bdg = JSON.parse(fs.readFileSync(path.join(CROOT, "data", "badge.json"), "utf8"));
  ok(bdg.schemaVersion === 1 && bdg.label === "Skindex" && /^100\.0/.test(bdg.message),
    "collector publishes the shields.io endpoint badge");
  // benchmarkGrowth — hand-computed: index 100 → 105 → 110 over three days;
  // lot A ($100 at day 1) grows ×1.10, lot B ($300 at day 2) ×(110/105);
  // cost-weighted factor = (100×1.10 + 300×110/105) / 400 = 1.06071…
  {
    const D1 = Date.UTC(2026, 0, 1), DD = 86400000;
    const ser = [
      { day: "2026-01-01", caseIdx: 100 },
      { day: "2026-01-02", caseIdx: 105 },
      { day: "2026-01-03", caseIdx: 110 }];
    const bg = A.benchmarkGrowth(
      [{ t: D1, cost: 100 }, { t: D1 + DD, cost: 300 }, { t: null, cost: 50 }], ser);
    ok(near(bg.factor, (100 * 1.10 + 300 * 110 / 105) / 400, 1e-9)
      && bg.idxPct === 6.1 && bg.covered === 2 && bg.total === 3,
      "benchmarkGrowth: cost-weighted index growth since each lot's day (undated lots excluded, never fabricated)");
    const clamp = A.benchmarkGrowth([{ t: D1 - 30 * DD, cost: 100 }], ser);
    ok(near(clamp.factor, 1.10, 1e-9), "benchmarkGrowth: pre-index lots clamp to inception (×1.10)");
  }
  // btcSessionSplit unit pins — fixed-clock synthetic samples, hand-computed:
  // one UTC day sampled every 3h; Asia leg compounds 1% per 3h step
  // (ends 03/06/09 UTC → +3.0301% ≈ 3.0), US leg round-trips to 0.
  {
    const B0 = Date.UTC(2026, 0, 5), H = 3600000;
    const mk = (h, v) => ({ t: B0 + h * H + 17 * 60000, btc: v });
    const oneDay = [mk(0, 100), mk(3, 101), mk(6, 102.01), mk(9, 103.0301),
      mk(12, 103.0301), mk(15, 104.060401), mk(18, 103.0301), mk(21, 103.0301)];
    const s1 = A.btcSessionSplit(oneDay);
    ok(s1.asiaPct === 3 && s1.usPct === 0 && s1.days === 1 && s1.ready === false,
      "btcSessionSplit: session-attributed returns (Asia +3.0% vs US 0.0%), accruing below 5 days");
    const sixDays = [];
    for (let d = 0; d < 6; d++) for (const r of oneDay)
      sixDays.push({ t: r.t + d * 24 * H, btc: r.btc * Math.pow(1.030301, d) });
    const s6 = A.btcSessionSplit(sixDays);
    ok(s6.days === 6 && s6.ready === true && s6.asiaPct === 19.6 && s6.usPct === 0,
      "btcSessionSplit: 6 both-bucket days → ready, Asia compounds to +19.6% (1.030301^6)");
  }
  const frW = c1.manifest.items.find((i) => /Fracture/.test(i.name));
  ok(frW && frW.weight === 1 && cCon.weighted === true,
    "manifest items carry the published index weight; the budget prices on it (single case → weight 1)");
  // INTEG-1 through the collector: book store + clean attestation
  const bookPub = JSON.parse(fs.readFileSync(path.join(CROOT, "data", "book.json"), "utf8"));
  ok(bookPub[slug("Fracture Case")] && bookPub[slug("Fracture Case")].mid === 23 && frW.book && frW.book.mid === 23,
    "collector publishes order-book readings (data/book.json + manifest item.book)");
  const cInteg = c1.manifest.market.integrity;
  ok(cInteg && cInteg.version === "INTEG-1" && cInteg.flags.length === 0
    && cInteg.summary.bookCorroborated === "1/1" && cInteg.summary.artEvidenced === "1/1",
    "collector publishes INTEG-1: fixture marks corroborate clean (book 1/1 — commodity-only, art evidenced, 0 flags)");
  ok(setPub.latest.integrity && setPub.latest.integrity.version === "INTEG-1",
    "settlement record carries the integrity attestation alongside the fixings");
  const c2 = await collect({ root: CROOT });
  const hl2 = fs.readFileSync(path.join(CROOT, "data", "history", slug(NAME) + ".jsonl"), "utf8").trim().split("\n");
  ok(hl2.length === hl1.length && c2.manifest.items.length === 4, "immediate re-run dedupes snapshots, still refreshes the manifest");

  // ═════════════════════════════════════════════════════════════════════════
  // M2 PIN BLOCK (lane M2, feat/market-index) — SMLX-7 market-index preview
  // + center-corroboration observation lane. ONE contiguous block, hand-
  // computed fixtures. The byte-identity pins embed the EXACT pre-change
  // output of the shipped `mo` fixture (captured from the committed tree
  // before this lane's diff), so any drift in an already-published field
  // fails loudly — the preview must stay strictly ADDITIVE.
  console.log("— M2: SMLX-7 preview + center corroboration —");
  // (1) byte-identity of every pre-existing published field on the shipped
  // `mo` fixture (same inputs as the analytics-section pin above)
  const m2ProjRow = (r) => JSON.stringify({ day: r.day, t: r.t, caseIdx: r.caseIdx,
    liqIdx: r.liqIdx, artIdx: r.artIdx, cashRatio: r.cashRatio, volTotal: r.volTotal });
  const m2mo = A.marketOverview([
    { name: "A Case", cat: "case", daily: [{ day: A.dayKey(T0), t: T0, price: 10, vol: 100 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 11, vol: 120 }], skinportDaily: [{ day: A.dayKey(T0 + D), t: T0 + D, price: 8.8, vol: 5 }] },
    { name: "B Case", cat: "case", daily: [{ day: A.dayKey(T0), t: T0, price: 100, vol: 10 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 121, vol: 12 }], skinportDaily: [] },
    { name: "C Case", cat: "case", daily: [{ day: A.dayKey(T0), t: T0, price: 5, vol: 0 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 5, vol: 0 }], skinportDaily: [] },
    { name: "S", cat: "skin", daily: [{ day: A.dayKey(T0), t: T0, price: 50, vol: 7 }, { day: A.dayKey(T0 + D), t: T0 + D, price: 40, vol: 7 }], skinportDaily: [] },
  ]);
  ok(m2ProjRow(m2mo.series[0]) === '{"day":"2026-01-01","t":1767225600000,"caseIdx":100,"liqIdx":100,"artIdx":null,"cashRatio":null,"volTotal":117}'
    && m2ProjRow(m2mo.series[1]) === '{"day":"2026-01-02","t":1767312000000,"caseIdx":110,"liqIdx":80,"artIdx":null,"cashRatio":0.8,"volTotal":139}',
    "M2 byte-identity: shipped series fields on the `mo` fixture are byte-exact vs the pre-preview capture");
  ok(JSON.stringify({ day: m2mo.today.day, caseIdx: m2mo.today.caseIdx, idx1: m2mo.today.idx1, idx7: m2mo.today.idx7,
    liqIdx: m2mo.today.liqIdx, artIdx: m2mo.today.artIdx, cashRatio: m2mo.today.cashRatio, volTotal: m2mo.today.volTotal })
    === '{"day":"2026-01-02","caseIdx":110,"idx1":0.10000000000000009,"idx7":null,"liqIdx":80,"artIdx":null,"cashRatio":0.8,"volTotal":139}'
    && JSON.stringify(m2mo.weights) === '{"case":{"A Case":0.333333,"B Case":0.333333,"C Case":0.333333},"liq":{"S":1}}',
    "M2 byte-identity: shipped today{} fields + published weights byte-exact (weights shape untouched)");
  ok(Object.keys(m2mo.series[0]).join(",") === "day,t,caseIdx,liqIdx,artIdx,cashRatio,volTotal,marketIdx",
    "M2 additive-only: series rows keep every shipped key in place; marketIdx is APPENDED");
  // mo combined universe (A,B,C cases + liquid S), day 2, equal weights:
  // rets [ln1.1, 2ln1.1, 0, ln0.8]; weighted median = (0 + ln1.1)/2 =
  // 0.0476551; clamp ±0.05 → [ln1.1, med+.05, 0, med−.05] → mean
  // 0.04765509 → 100·e^0.04765509 = 104.88
  ok(near(m2mo.series[1].marketIdx, 104.88, 0.01) && m2mo.today.marketIdx === m2mo.series[1].marketIdx,
    "SMLX-7 preview: combined case+liq index under the exact SMLX-6 rules (104.88); today mirrors the last day");
  // (2) preview construction: breadth, floors, seasoning, clamp — post-
  // adoption fixture (founding marks on the adoption day, per seedFounding)
  const M2A = Date.UTC(2026, 6, 25), M2B = Date.UTC(2026, 8, 1), M2C = Date.UTC(2026, 8, 2);
  const m2mk = A.marketOverview([
    { name: "MA Case", cat: "case", daily: [dcase(M2A, 10), dcase(M2B, 10), dcase(M2C, 11)], skinportDaily: [] },
    { name: "MB Case", cat: "case", daily: [dcase(M2A, 10), dcase(M2B, 10), dcase(M2C, 10)], skinportDaily: [] },
    { name: "ML Skin", cat: "skin", daily: [dcase(M2A, 50), dcase(M2B, 50), dcase(M2C, 50)], skinportDaily: [] },
    { name: "MP Skin", cat: "skin", daily: [dcase(M2A, 20), dcase(M2B, 20), dcase(M2C, 30)], skinportDaily: [] },
    { name: "MN Case", cat: "case", daily: [dcase(M2B, 999), dcase(M2C, 5)], skinportDaily: [] },
  ]);
  // day 3 combined: rets [ln1.1, 0, 0, ln1.5]; equal weights (no lagged
  // volume) → weighted median (0+ln1.1)/2 = 0.0476551; MP clamps to
  // med+0.05 = 0.0976551 → mean 0.04824132 → 104.94. The 2-name case
  // family is UNDER minContributors → caseIdx carries at 100 the whole way
  // (combined breadth is the point of the preview); the seasoning
  // newcomer's 999→5 crash moves NOTHING.
  ok(near(m2mk.series[2].marketIdx, 104.94, 0.01) && m2mk.series[2].caseIdx === 100 && m2mk.series[1].marketIdx === 100,
    "SMLX-7 preview: liquids give the breadth cases lack (marketIdx 104.94 while caseIdx carries); +50% outlier clamped; seasoning newcomer inert");
  ok(near(m2mk.series[2].liqIdx, 122.47, 0.01) && m2mk.today.marketIdx === m2mk.series[2].marketIdx,
    "SMLX-7 preview: liq family itself unchanged by the combined pass (√1.5 → 122.47)");
  ok(m2mk.marketPreview && m2mk.marketPreview.label === "SMLX-7 draft preview — NOT a settlement input"
    && m2mk.marketPreview.universe.members === 5 && m2mk.marketPreview.universe.caseMembers === 3
    && m2mk.marketPreview.universe.liqMembers === 2,
    "marketPreview published with the exact NOT-a-settlement-input label + universe census");
  ok(Object.keys(m2mk.marketPreview.weights).length === 5 && near(m2mk.marketPreview.weights["MA Case"], 0.2, 1e-9)
    && near(m2mk.marketPreview.weights["MP Skin"], 0.2, 1e-9),
    "capture-economics input: combined-universe current-month weights published (equal 1/5 pre-volume; budget wiring at integration)");
  ok(A.INDEX_RULES.marketPreview && A.INDEX_RULES.marketPreview.centerToleranceLog === 0.03
    && A.INDEX_RULES.marketPreview.label === "SMLX-7 draft preview — NOT a settlement input"
    && A.INDEX_RULES.marketPreview.seasoningDays === A.INDEX_RULES.seasoningDays
    && A.INDEX_RULES.marketPreview.clampLog === A.INDEX_RULES.clampLog
    && A.INDEX_RULES.marketPreview.minPrice === A.INDEX_RULES.minPrice
    && A.INDEX_RULES.marketPreview.minContributors === A.INDEX_RULES.minContributors
    && A.INDEX_RULES.version === "SMLX-6" && A.INDEX_RULES.adoption === "2026-07-25",
    "INDEX_RULES.marketPreview additive (params = load-time copies of SMLX-6); shipped SMLX-6 fields untouched");
  // (3) center-corroboration lane. NO-FLAG: steam and cash move together
  // (both centers ln1.1 → dev 0). FLAG: a market-wide steam pump with cash
  // flat — the ratio lane's cross-sectional gate absorbs exactly this move
  // (see the gWide pin above), but it drags the steam CENTER 0.0953 log off
  // the cash center → the lane observes what INTEG-1 cannot.
  const m2cc = (spPrices) => A.marketOverview([1, 2, 3, 4].map((n) => ({
    name: "CC" + n + " Case", cat: "case",
    daily: [dcase(T0, 10), dcase(T0 + D, 11)],
    skinportDaily: spPrices ? [{ day: A.dayKey(T0), t: T0, price: spPrices[0], vol: 5 },
      { day: A.dayKey(T0 + D), t: T0 + D, price: spPrices[1], vol: 5 }] : [],
  })));
  const m2ccOk = m2cc([8, 8.8]);
  const m2ccOkCheck = m2ccOk.marketPreview.centerCheck;
  ok(m2ccOkCheck.stats.daysObserved === 1 && m2ccOkCheck.stats.daysWouldBind === 0
    && m2ccOkCheck.flags.length === 0 && m2ccOkCheck.latest.devLog === 0
    && m2ccOkCheck.latest.steamCenter === 0.0953 && m2ccOkCheck.latest.cashCenter === 0.0953,
    "center lane: cash-corroborated day (both centers ln1.1) observes clean — no flag, 0/1 would-bind");
  const m2ccPump = m2cc([8, 8]);
  const m2ccPumpCheck = m2ccPump.marketPreview.centerCheck;
  ok(m2ccPumpCheck.stats.daysObserved === 1 && m2ccPumpCheck.stats.daysWouldBind === 1
    && m2ccPumpCheck.boundDays.length === 1 && near(m2ccPumpCheck.latest.devLog, 0.0953, 1e-4)
    && near(m2ccPump.series[1].marketIdx, 110, 0.01),
    "center lane: market-wide steam pump vs flat cash binds (dev 0.0953 > 0.03) while the clamp passes it (index 110) — the gap this lane exists for");
  const m2flag = m2ccPumpCheck.flags[0];
  ok(m2ccPumpCheck.flags.length === 1 && m2flag.name === "(market)" && m2flag.lane === "center"
    && m2flag.severity === "watch" && near(m2flag.dev, 0.0953, 1e-4)
    && /SMLX-7 observation phase/.test(m2flag.detail) && /must corroborate/.test(m2flag.detail)
    && /the day carries/.test(m2flag.detail) && /flag-only/.test(m2flag.detail),
    "center lane flag row: INTEG-1 shape, watch severity, and the exact observation-phase language (corroborate or the day carries; flag-only)");
  const m2ccThin = A.marketOverview([1, 2, 3, 4].map((n) => ({
    name: "CT" + n + " Case", cat: "case",
    daily: [dcase(T0, 10), dcase(T0 + D, 11)],
    skinportDaily: n <= 2 ? [{ day: A.dayKey(T0), t: T0, price: 8, vol: 5 },
      { day: A.dayKey(T0 + D), t: T0 + D, price: 8, vol: 5 }] : [],
  })));
  const m2ccThinCheck = m2ccThin.marketPreview.centerCheck;
  ok(m2ccThinCheck.stats.daysObserved === 0 && m2ccThinCheck.flags.length === 0 && m2ccThinCheck.latest === null,
    "center lane: under minContributors cash names the day is NOT an observation (2 of 4 have sales) — never flags on thin evidence");
  // (4) collector integration: preview + merged lane ride the published
  // artifacts. Fixture has one skinport day → zero cash return pairs → the
  // lane observes nothing, adds no flag, and publishes honest 0/0 counts
  // into BOTH data/index.json and the settlement record's integrity block.
  const m2cm = c1.manifest.market;
  ok(m2cm.today.marketIdx === 100 && m2cm.marketPreview
    && m2cm.marketPreview.label === "SMLX-7 draft preview — NOT a settlement input"
    && m2cm.marketPreview.universe.members === 3 && m2cm.marketPreview.universe.caseMembers === 1
    && m2cm.marketPreview.universe.liqMembers === 2,
    "collector publishes the preview (1 case + 2 liquids; index carries at 100 — never ≥3 paired marks)");
  ok(Object.keys(m2cm.marketPreview.weights).length === 3
    && Object.values(m2cm.marketPreview.weights).every((w) => w > 0 && w <= 1),
    "collector publishes combined-universe weights for all 3 members (capture-economics input)");
  ok(m2cm.integrity.summary.centerCorroborated === "0/0" && m2cm.integrity.summary.centerDaysWouldBind === 0
    && m2cm.integrity.flags.length === 0 && m2cm.integrity.summary.watch === 0 && m2cm.integrity.summary.alert === 0,
    "center lane merged into INTEG report as an ADDITIVE lane (0/0 observed, no flags, counts intact)");
  ok(setPub.latest.integrity.summary.centerCorroborated === "0/0"
    && JSON.parse(fs.readFileSync(path.join(CROOT, "data", "index.json"), "utf8")).market.marketPreview.centerCheck.stats.daysObserved === 0,
    "running observed/would-bind counts persist per run (settlement.json integrity block + data/index.json)");
  // ═══ end M2 pin block ═════════════════════════════════════════════════════
  // ── witness protocol against the collector's published tree ──────────────
  console.log("— witness —");
  const readLocal = async (rel) => {
    const f = path.join(CROOT, rel);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  };
  const w1 = await witness({ read: readLocal, primary: "fixture://primary", obsN: 3 });
  ok(w1.verdict === "ATTESTED" && w1.checks.series.mismatchedDays === 0 && w1.checks.weightsMatch
    && Object.values(w1.checks.fixings).every(Boolean)
    && w1.checks.observations.length === 3 && w1.checks.observations.every((o) => o.ok === true),
    "witness ATTESTS an honest primary (full re-derivation + hashes + 3 independent samples)");
  // tampered published index value → the re-derivation catches it
  const wTamperIdx = async (rel) => {
    const t = await readLocal(rel);
    if (rel !== "data/index.json" || t == null) return t;
    const j = JSON.parse(t);
    j.market.series[j.market.series.length - 1].caseIdx = 999.99;
    return JSON.stringify(j);
  };
  const w2 = await witness({ read: wTamperIdx, primary: "fixture://primary", obsN: 0 });
  ok(w2.verdict === "MISMATCH" && w2.checks.series.mismatchedDays >= 1
    && w2.reasons.some((r) => /do not re-derive from the committed history/.test(r)),
    "witness catches a fabricated index value (published series ≠ re-derivation from raw files)");
  // tampered fixing hash → the byte-exact hash check catches it
  const wTamperFix = async (rel) => {
    const t = await readLocal(rel);
    if (rel !== "data/settlement.json" || t == null) return t;
    const j = JSON.parse(t);
    j.latest.fixings["SETTLE-CASE-7D"].hash = "0".repeat(64);
    return JSON.stringify(j);
  };
  const w3 = await witness({ read: wTamperFix, primary: "fixture://primary", obsN: 0 });
  ok(w3.verdict === "MISMATCH" && w3.checks.fixings["SETTLE-CASE-7D"] === false
    && w3.checks.fixings["SETTLE-RATIO-30D"] === true,
    "witness catches a tampered fixing hash (and vouches for the untouched ones)");
  // primary's marks diverge from live reality → the observation lane alarms
  fixture.steamPrice = "$40.00";
  const w4 = await witness({ read: readLocal, primary: "fixture://primary", obsN: 3 });
  fixture.steamPrice = "$23.00";
  ok(w4.verdict === "MISMATCH" && w4.checks.observations.filter((o) => o.ok === false).length >= 2
    && w4.reasons.some((r) => /independently sampled prices diverge/.test(r)),
    "witness alarms when the primary's marks diverge from independently sampled reality (≥2 names)");
  fs.rmSync(CROOT, { recursive: true, force: true });

  // ── backtest engine plumbing (variants via INDEX_RULES override) ──────────
  console.log("— backtest —");
  const { computeBacktest } = require("./backtest.js");
  const BT0 = Date.UTC(2020, 0, 1);
  const btItems = ["X1 Case", "X2 Case", "X3 Case"].map((n) => ({
    name: n, cat: "case", tier: null, skinportDaily: [], artDaily: [],
    daily: Array.from({ length: 800 }, (_, i) => dcase(BT0 + i * D, 10)),
  }));
  const bt = computeBacktest(btItems);
  ok(Object.keys(bt.variants).length === 4 && bt.variants.smlx6.stats && bt.variants.smlx6.stats.endLevel === 100
    && bt.variants.smlx6.stats.firstDay === "2021-01-01" && bt.clamp.engagedDays === 0,
    "backtest: 4 variants over shipped code; flat cohort seasons 365d → included 2021-01-01 (leap year) at level 100");
  ok(A.INDEX_RULES.version === "SMLX-6" && A.INDEX_RULES.adoption === "2026-07-25"
    && A.INDEX_RULES.seasoningDays === 365 && A.INDEX_RULES.clampLog === 0.05 && A.INDEX_RULES.weightMinObs === 5,
    "backtest variant overrides fully restore the shipped INDEX_RULES (no leakage into production math)");

  // ═══ BEGIN LANE S1 PINS — inventory data layer (market.js + analytics.js) ═
  // Hand-computed, hermetic: a FIXTURE transport (never the network) and the
  // obviously-fake SteamID 76561190000000001 — a real one is personal data.
  console.log("— inventory (S1) —");
  const INV_ID = "76561190000000001", INV_PRIV = "76561190000000002", INV_BUSY = "76561190000000003";
  let invCalls = 0;
  // Steam's real payload shape: `assets` carry the counts, `descriptions`
  // carry the names, joined on classid_instanceid. Three assets share the
  // case's key (1+1+3 = qty 5), one asset has NO description at all.
  const invPayload = {
    success: 1, total_inventory_count: 6,
    assets: [
      { classid: "1", instanceid: "0", amount: "1" },
      { classid: "1", instanceid: "0", amount: "1" },
      { classid: "1", instanceid: "0", amount: "3" },
      { classid: "2", instanceid: "0", amount: "1" },
      { classid: "3", instanceid: "0", amount: "1" },
      { classid: "9", instanceid: "0", amount: "1" },   // orphan → dropped
    ],
    descriptions: [
      { classid: "1", instanceid: "0", market_hash_name: "Fracture Case", marketable: 1, tradable: 1 },
      { classid: "2", instanceid: "0", market_hash_name: "AK-47 | Redline (Field-Tested)", marketable: 1, tradable: 1 },
      { classid: "3", instanceid: "0", market_hash_name: "Sticker | Probe (Glitter)", marketable: 0, tradable: 0 },
    ],
  };
  M.setTransport(async (url) => {
    invCalls++;
    if (url.includes("/id/probe-vanity"))
      return { status: 200, body: '<html><script>g_rgProfileData = {"url":"https://steamcommunity.com/id/probe-vanity/",' +
        '"steamid":"' + INV_ID + '","personaname":"probe"};</script></html>' };
    if (url.includes("/inventory/" + INV_ID + "/730/2")) return { status: 200, body: JSON.stringify(invPayload) };
    if (url.includes("/inventory/" + INV_PRIV + "/730/2")) return { status: 403, body: "null" };
    if (url.includes("/inventory/" + INV_BUSY + "/730/2")) return { status: 429, body: "" };
    return { status: 404, body: "" };
  });
  const rId = await M.resolveSteamProfile(INV_ID);
  const rUrl = await M.resolveSteamProfile("https://steamcommunity.com/profiles/" + INV_ID + "/");
  ok(rId.steamid64 === INV_ID && rId.vanity === null && rId.source === "steamid64"
    && rUrl.steamid64 === INV_ID && rUrl.vanity === null && rUrl.source === "profile-url" && invCalls === 0,
    "resolveSteamProfile: 17-digit id + /profiles/ URL pass straight through — zero network reads");
  const rVanUrl = await M.resolveSteamProfile("https://steamcommunity.com/id/probe-vanity/");
  const rVan = await M.resolveSteamProfile("probe-vanity");
  ok(rVanUrl.steamid64 === INV_ID && rVanUrl.vanity === "probe-vanity" && rVanUrl.source === "vanity-url"
    && rVan.steamid64 === INV_ID && rVan.vanity === "probe-vanity" && rVan.source === "vanity" && invCalls === 2,
    "resolveSteamProfile: vanity URL + bare vanity scrape g_rgProfileData's steamid (no sign-in, no API key)");
  const eJunk = await M.resolveSteamProfile("not a profile!!").then(() => null, (e) => e.message);
  const eGone = await M.resolveSteamProfile("missing-user").then(() => null, (e) => e.message);
  ok(/paste your profile URL/.test(eJunk) && eGone === 'no Steam profile found for "missing-user" — check the spelling',
    "resolveSteamProfile: junk input and a missing profile throw plain-English errors (no HTTP jargon)");

  const inv = await M.steamInventory(INV_ID);
  const invCase = inv.items.find((i) => i.name === "Fracture Case");
  const invStick = inv.items.find((i) => /^Sticker/.test(i.name));
  ok(inv.steamid64 === INV_ID && inv.count === 7 && inv.items.length === 3 && inv.truncated === false
    && invCase.qty === 5 && invCase.marketable === true && invCase.tradable === true
    && invStick.marketable === false && invStick.tradable === false,
    "steamInventory: assets×descriptions merged on classid_instanceid — duplicate stacks sum to qty 5 (count 7 units), unmarketable flagged, description-less asset dropped (a name is never invented)");
  const ePriv = await M.steamInventory(INV_PRIV).then(() => null, (e) => e.message);
  ok(ePriv === "inventory is private or hidden — set it to Public in Steam privacy settings",
    "steamInventory: HTTP 403 → the exact plain-English private-inventory message");
  const eBusy = await M.steamInventory(INV_BUSY).then(() => null, (e) => e.message);
  ok(eBusy === "Steam is rate-limiting inventory reads — try again in a few minutes",
    "steamInventory: HTTP 429 → the exact plain-English rate-limit message");

  // 5 cases @ $5 = $25, 1 skin @ $20.50, 1 sticker with no price at all.
  const invPx = { "Fracture Case": 5, "AK-47 | Redline (Field-Tested)": 20.5 };
  const invPriceOf = (n) => (invPx[n] == null ? null : invPx[n]);
  const invVal = A.inventoryValue(inv.items, invPriceOf);
  ok(invVal.total === 45.5 && invVal.rows.length === 3
    && invVal.rows[0].name === "Fracture Case" && invVal.rows[0].qty === 5 && invVal.rows[0].value === 25
    && invVal.rows[1].name === "AK-47 | Redline (Field-Tested)" && invVal.rows[1].value === 20.5,
    "inventoryValue: 5×$5 + 1×$20.50 = $45.50, rows sorted by VALUE desc (the $5 case outranks the $20.50 skin)");
  ok(invVal.pricedCount === 6 && invVal.unpricedCount === 1
    && invVal.rows[2].price === null && invVal.rows[2].value === null
    && invVal.pricedCount + invVal.unpricedCount === inv.count,
    "inventoryValue: priced/unpriced are UNITS summing to the inventory count; an unpriceable item is reported, never guessed");

  // Case marks 2026-01-01 $1 → 2026-01-03 $2; skin marks 2026-01-02 $10 only.
  const invHist = {
    "Fracture Case": [{ day: "2026-01-01", price: 1 }, { day: "2026-01-03", price: 2 }],
    "AK-47 | Redline (Field-Tested)": [{ day: "2026-01-02", price: 10 }],
  };
  const invRec = A.inventoryReconstruction(inv.items, (n) => invHist[n] || null, { priceOf: invPriceOf });
  ok(invRec.days.length === 3
    && invRec.days[0].day === "2026-01-01" && invRec.days[0].value === 5
    && invRec.days[1].day === "2026-01-02" && invRec.days[1].value === 15
    && invRec.days[2].day === "2026-01-03" && invRec.days[2].value === 20
    && invRec.pricedNames === 2 && invRec.totalNames === 3 && invRec.coveragePct === 100,
    "inventoryReconstruction: day1 = 5×$1 alone (the skin has no mark yet), day2 = carried $5 + $10 skin = 15, day3 = 5×$2 + carried $10 = 20 (carry-forward within an item, never across items)");
  const invPart = A.inventoryReconstruction(inv.items,
    (n) => (n === "Fracture Case" ? invHist["Fracture Case"] : null), { priceOf: invPriceOf });
  ok(invPart.days.length === 2 && invPart.days[0].value === 5 && invPart.days[1].value === 10
    && invPart.coveragePct === 54.9 && invPart.pricedNames === 1 && invPart.totalNames === 3,
    "inventoryReconstruction: coverage is VALUE-weighted — $25 of $45.50 = 54.9% (a count would claim 33.3%), and the historyless skin never joins the line");
  // ── like-for-like alpha lock (adversarial review, BLOCKER) ───────────────
  // An item ENTERING the reconstruction on its own first mark is not a gain.
  // Prices here are flat and the market is flat, yet measuring from days[0]
  // printed +900% (the sub-basket grows as B joins). fullFrom marks the day
  // the basket is whole; every return leg must open at or after it.
  const staggerHist = {
    A: [{ day: "2026-01-01", price: 100 }, { day: "2026-01-02", price: 100 }, { day: "2026-01-03", price: 100 }],
    B: [{ day: "2026-01-03", price: 900 }],
  };
  const stagger = A.inventoryReconstruction(
    [{ name: "A", qty: 1 }, { name: "B", qty: 1 }],
    (n) => staggerHist[n] || null,
    { priceOf: (n) => (n === "A" ? 100 : 900) });
  const naiveRet = (stagger.days[stagger.days.length - 1].value / stagger.days[0].value - 1) * 100;
  const lfl = stagger.days.filter((d) => d.day >= stagger.fullFrom);
  ok(stagger.fullFrom === "2026-01-03" && Math.round(naiveRet) === 900 && lfl.length === 1,
    "reconstruction publishes fullFrom (the day the basket is COMPLETE): measuring from day 0 would book B's entry as +900% on a flat portfolio in a flat market");
  const flatFull = A.inventoryReconstruction(
    [{ name: "A", qty: 1 }, { name: "B", qty: 1 }],
    (n) => (n === "A" ? staggerHist.A : [{ day: "2026-01-01", price: 900 }, { day: "2026-01-03", price: 900 }]),
    { priceOf: (n) => (n === "A" ? 100 : 900) });
  const flatWin = flatFull.days.filter((d) => d.day >= flatFull.fullFrom);
  ok(flatFull.fullFrom === "2026-01-01" && flatWin.length >= 2
    && flatWin[flatWin.length - 1].value === flatWin[0].value,
    "a genuinely whole basket keeps its full window and a flat market reads as 0% (the fix does not just suppress every number)");

  const invT = A.inventoryReconstruction([{ name: "Fracture Case", qty: 2 }],
    () => [{ t: Date.UTC(2026, 0, 5), price: 3 }, { t: Date.UTC(2026, 0, 5), price: 4 }, { t: Date.UTC(2026, 0, 4), price: 1 }]);
  const invNone = A.inventoryReconstruction(inv.items, () => null, { priceOf: invPriceOf });
  ok(invT.days.length === 2 && invT.days[0].day === "2026-01-04" && invT.days[0].value === 2
    && invT.days[1].day === "2026-01-05" && invT.days[1].value === 8
    && invNone.days.length === 0 && invNone.coveragePct === 0,
    "inventoryReconstruction: {t,price} rows accepted (last row wins a repeated day, order-independent); no history → no fabricated days and coverage 0");
  M.setTransport(fixtureTransport);
  // ═══ END LANE S1 PINS ════════════════════════════════════════════════════

  // ═══ BEGIN F1 PINS — inventory defects closed by the adversarial review ══
  // ONE contiguous block, its own tmp data dir / port / fixture transport, so
  // nothing above is disturbed. Every check names the defect it locks and was
  // verified to go RED with that fix (and only that fix) reverted.
  //   1 snapshot identity + composition fingerprint (a second profile used to
  //     extend the first one's value line)      2 assets that join nothing
  //     reported as a successful $0 read        3 unbounded `amount`
  //   4 one truncation sentence for three causes 5 dedupe inverted vs the
  //     browser (first won, corrections dropped) 6 unbounded paste work
  //   7 the "upload too large" 400 was unreachable (socket destroyed first)
  console.log("— inventory (F1 fixes) —");
  {
    const F1_A = "76561190000000011", F1_B = "76561190000000012";
    const F1_DROP = "76561190000000013", F1_SHORT = "76561190000000014", F1_MIX = "76561190000000015";
    const f1asset = (classid, amount) => ({ appid: 730, contextid: "2", assetid: "f1" + classid,
      classid: classid, instanceid: "0", amount: String(amount == null ? 1 : amount) });
    const f1desc = (classid, name) => ({ appid: 730, classid: classid, instanceid: "0",
      market_hash_name: name, marketable: 1, tradable: 1 });
    // A owns 2 × $100 = $200 · B owns 1 × $5 = $5 — two different people
    const f1PayloadA = { success: 1, total_inventory_count: 2,
      assets: [f1asset("1"), f1asset("1")], descriptions: [f1desc("1", "F1 Alpha Item")] };
    const f1PayloadB = { success: 1, total_inventory_count: 1,
      assets: [f1asset("2")], descriptions: [f1desc("2", "F1 Beta Item")] };
    // A after buying one $7 item — SAME person, DIFFERENT basket ($207)
    const f1PayloadA2 = { success: 1, total_inventory_count: 3,
      assets: [f1asset("1"), f1asset("1"), f1asset("3")],
      descriptions: [f1desc("1", "F1 Alpha Item"), f1desc("3", "F1 Extra Item")] };
    // Steam sent the assets half without the descriptions half: every asset
    // joins NOTHING (a broken read, not an empty inventory)
    const f1PayloadDrop = { success: 1, total_inventory_count: 3,
      assets: [f1asset("1"), f1asset("2"), f1asset("3")], descriptions: [] };
    const f1PayloadMix = { success: 1, total_inventory_count: 5,   // 5 assets, 2 orphans
      assets: [f1asset("1"), f1asset("1"), f1asset("3"), f1asset("8"), f1asset("9")],
      descriptions: [f1desc("1", "F1 Alpha Item"), f1desc("3", "F1 Extra Item")] };
    const f1PayloadShort = { success: 1, total_inventory_count: 9, // declares 9, sends 1
      assets: [f1asset("1")], descriptions: [f1desc("1", "F1 Alpha Item")] };
    let f1A = f1PayloadA;
    M.setTransport(async (url, headers) => {
      const m = /\/inventory\/(\d{17})\/730\/2/.exec(url);
      if (!m) return fixtureTransport(url, headers);
      const body = m[1] === F1_A ? f1A : m[1] === F1_B ? f1PayloadB : m[1] === F1_DROP ? f1PayloadDrop
        : m[1] === F1_MIX ? f1PayloadMix : m[1] === F1_SHORT ? f1PayloadShort : null;
      return body ? { status: 200, body: JSON.stringify(body) } : { status: 404, body: "" };
    });

    const F1_DATA = path.join(os.tmpdir(), "hh-skin-f1-" + Date.now());
    const F1_NOW = Date.now();
    fs.mkdirSync(path.join(F1_DATA, "cache"), { recursive: true });
    fs.writeFileSync(path.join(F1_DATA, "watchlist.json"), JSON.stringify(["A1 Case"]));
    fs.writeFileSync(path.join(F1_DATA, "cache", "skinport-items.json"), JSON.stringify({ t: F1_NOW, items: [
      { name: "F1 Alpha Item", min: 100, mean: 100, median: 100, max: 100, qty: 5 },
      { name: "F1 Beta Item", min: 5, mean: 5, median: 5, max: 5, qty: 5 },
      { name: "F1 Extra Item", min: 7, mean: 7, median: 7, max: 7, qty: 5 },
    ] }));
    // one earlier load PER PROFILE, both older than the 10-minute window,
    // plus one UNTAGGED line of the kind written before snapshots carried an
    // identity (it belongs to nobody we can name — it must not be adopted)
    fs.writeFileSync(path.join(F1_DATA, "inventory.jsonl"),
      JSON.stringify({ t: F1_NOW - 50 * 60000, value: 999, count: 1 }) + "\n" +
      JSON.stringify({ t: F1_NOW - 40 * 60000, value: 111, count: 1, id: F1_A, sig: "seedA" }) + "\n" +
      JSON.stringify({ t: F1_NOW - 30 * 60000, value: 222, count: 1, id: F1_B, sig: "seedB" }) + "\n");

    const F1PORT = 5503;
    const f1inst = startServer({ port: F1PORT, dataDir: F1_DATA, snapHours: 0, steamCookie: "" });
    await new Promise((r) => f1inst.server.once("listening", r));
    const f1api = async (p, body) => {
      const opts = body
        ? { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) }
        : { headers: { Connection: "close" } };
      const r = await fetch("http://localhost:" + F1PORT + p, opts);
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const f1vals = (s) => (s || []).map((r) => r.value).join(",");
    const f1sig = (s) => (s && s.length ? s[s.length - 1].sig : null);
    const f1last = (s) => (s && s.length ? s[s.length - 1].value : null);
    const f1lines = () => { try {
      return fs.readFileSync(path.join(F1_DATA, "inventory.jsonl"), "utf8").trim().split("\n").length;
    } catch (e) { return 0; } };

    // ── 1. the value line belongs to ONE inventory ──────────────────────────
    const f1RA = await f1api("/api/skins/inventory?profile=" + F1_A);
    const f1RB = await f1api("/api/skins/inventory?profile=" + F1_B);
    ok(f1RA.status === 200 && f1RA.body.value.total === 200 && f1vals(f1RA.body.series) === "111,200"
      && f1RB.status === 200 && f1RB.body.value.total === 5 && f1vals(f1RB.body.series) === "222,5",
      "a second profile's load starts its OWN line: B's series is B's two points only — loading someone else's inventory can no longer extend yours (it used to print a −$195 'loss')");
    const f1RA2 = await f1api("/api/skins/inventory", { profile: F1_A });
    ok(f1RA2.status === 200 && f1vals(f1RA2.body.series) === "111,200"
      && !/222|,5$/.test(f1vals(f1RA2.body.series)),
      "profile A's line is intact and unpolluted after B was loaded in between (identity is per-snapshot, not per-file)");
    ok(!/999/.test(f1vals(f1RA.body.series)) && !/999/.test(f1vals(f1RB.body.series))
      && /Your value line starts here: 1 earlier load was recorded before/.test(f1RA.body.note),
      "an untagged pre-fix load is neither adopted by the next profile that loads nor silently dropped — the report says the line restarts");

    // ── 2. composition fingerprint: buying an item is not a return ──────────
    const f1SigA = f1sig(f1RA2.body.series);
    f1A = f1PayloadA2;                                  // A buys the $7 item
    const f1RA3 = await f1api("/api/skins/inventory", { profile: F1_A });
    const f1RA4 = await f1api("/api/skins/inventory", { profile: F1_A });  // identical basket again
    ok(f1SigA && f1sig(f1RA3.body.series) && f1SigA !== f1sig(f1RA3.body.series)
      && f1sig(f1RA3.body.series) === f1sig(f1RA4.body.series) && f1RA3.body.value.total === 207,
      "every snapshot carries a composition fingerprint: identical holdings → identical sig, a bought item → a different sig, so a consumer can tell a value change from a return");

    // ── 3. dedupe agrees with the browser: NEWEST wins inside the window ────
    ok(f1vals(f1RA3.body.series) === "111,207" && f1vals(f1RA4.body.series) === "111,207"
      && f1lines() === 8,
      "inside the 10-minute window the NEWEST value wins (was: the first was kept and every correction silently dropped, disagreeing with the browser's own line) — and the file stays append-only, 8 lines for 5 loads + 3 seeds");

    // ── 4. an all-drop payload is a broken read, not an empty inventory ─────
    const f1LinesBefore = f1lines();
    const f1Drop = await f1api("/api/skins/inventory?profile=" + F1_DROP);
    const f1State = JSON.parse(fs.readFileSync(path.join(F1_DATA, "inventory.json"), "utf8"));
    ok(f1Drop.status === 502 && /no matching description/.test(f1Drop.body.error)
      && f1lines() === f1LinesBefore && f1State.cache && f1State.cache.steamid64 !== F1_DROP,
      "a payload whose assets joined NOTHING fails with the reason (502) — no $0 point in the append-only series, no poisoned 10-minute cache (it used to report a cheerful $0 / 0 items)");
    const f1DropPaste = await f1api("/api/skins/inventory", { paste: JSON.stringify(f1PayloadDrop) });
    ok(f1DropPaste.status === 400 && /matched a description/.test(f1DropPaste.body.error)
      && /3/.test(f1DropPaste.body.error) && f1lines() === f1LinesBefore,
      "the same paste says how many items failed to join and what to do about it (\"copy it whole\"), instead of the misleading \"no CS2 items found\"");

    // ── 5. the drop is surfaced when the read partly worked ────────────────
    const f1Mix = await f1api("/api/skins/inventory?profile=" + F1_MIX);
    ok(f1Mix.status === 200 && f1Mix.body.count === 3
      && /2 assets had no matching description/.test(f1Mix.body.note),
      "a partial join is disclosed in the note (\"2 assets had no matching description\") — the line existed but nothing ever set the counter");

    // ── 6. the truncation note names the cause that actually fired ─────────
    const f1Short = await f1api("/api/skins/inventory?profile=" + F1_SHORT);
    ok(f1Short.status === 200 && /fewer items than it declared/.test(f1Short.body.note)
      && !/5000/.test(f1Short.body.note),
      "an 11-item short payload no longer claims \"Steam capped the read at 5000 items\" — the note names the cause that fired");
    const f1Cap = A.parseSteamInventory({ success: 1, total_inventory_count: 3,
      assets: [f1asset("1"), f1asset("2"), f1asset("3")],
      descriptions: [f1desc("1", "N1"), f1desc("2", "N2"), f1desc("3", "N3")] }, null, 2);
    const f1More = A.parseSteamInventory({ success: 1, total_inventory_count: 1, more_items: 1,
      assets: [f1asset("1")], descriptions: [f1desc("1", "N1")] });
    const f1ShortP = A.parseSteamInventory(f1PayloadShort);
    ok(f1Cap.truncatedBy === "cap" && f1Cap.items.length === 2 && f1Cap.count === 2
      && f1More.truncatedBy === "more_items" && f1ShortP.truncatedBy === "short_payload"
      && A.parseSteamInventory(f1PayloadA).truncatedBy === null,
      "parseSteamInventory reports WHICH truncation fired (cap / more_items / short_payload), and `max` is a real cap on the work — it used to parse every asset and only then set a flag");

    // ── 7. `amount` cannot write an absurd valuation into the series ───────
    const f1Huge = { success: 1, total_inventory_count: 1,
      assets: [f1asset("1", "1e9")], descriptions: [f1desc("1", "F1 Alpha Item")] };
    const f1HugeP = A.parseSteamInventory(f1Huge);
    const f1HugeR = await f1api("/api/skins/inventory", { paste: JSON.stringify(f1Huge) });
    ok(f1HugeP.count === 5000 && f1HugeP.items[0].qty === 5000
      && f1HugeR.status === 200 && f1HugeR.body.count === 5000 && f1HugeR.body.value.total === 500000
      && f1last(f1HugeR.body.series) === 500000,
      "a single asset claiming amount 1e9 is clamped (5000, Steam's own page cap) — a $150bn point can no longer be written permanently into the append-only series");

    // ── 8. an unbounded paste cannot run unbounded work ────────────────────
    const f1BigAssets = [], f1BigDescs = [];
    for (let i = 0; i < 5200; i++) { f1BigAssets.push(f1asset("b" + i)); f1BigDescs.push(f1desc("b" + i, "F1 Bulk " + i)); }
    const f1BigPaste = await f1api("/api/skins/inventory",
      { paste: JSON.stringify({ success: 1, total_inventory_count: 5200, assets: f1BigAssets, descriptions: f1BigDescs }) });
    ok(f1BigPaste.status === 200 && f1BigPaste.body.count === 5000
      && f1BigPaste.body.value.rows.length === 5000
      && /Only the first 5000 items were read/.test(f1BigPaste.body.note),
      "a 5200-asset paste is parsed, valued and sorted for 5000 items and no more — the cap bounds the synchronous work AND says so, instead of blocking this single-threaded server on whatever arrived");

    // ── 9. two anonymous pastes are not one inventory ──────────────────────
    const f1PA = await f1api("/api/skins/inventory", { paste: JSON.stringify(f1PayloadA) });
    const f1PB = await f1api("/api/skins/inventory", { paste: JSON.stringify(f1PayloadB) });
    ok(f1PA.status === 200 && f1vals(f1PA.body.series) === "200"
      && f1PB.status === 200 && f1vals(f1PB.body.series) === "5",
      "a paste carries no SteamID, so its line is keyed by COMPOSITION — two different people's anonymous pastes never share one value line");

    // ── 10. the over-cap reply reaches the client in words ─────────────────
    const f1Big = await fetch("http://localhost:" + F1PORT + "/api/skins/inventory", {
      method: "POST", headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ paste: "x".repeat(9 * 1024 * 1024) }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }),
      (e) => ({ status: 0, body: null, err: String((e && e.message) || e) }));
    ok(f1Big.status === 400 && f1Big.body && /too large/.test(f1Big.body.error) && /8 MB/.test(f1Big.body.error),
      "a body over the cap gets the plain-English 400 it was always meant to get — the socket used to be destroyed in the same tick, so the client saw only ECONNRESET");
    const f1Ok = await f1api("/api/skins/inventory", { paste: JSON.stringify(f1PayloadA) });
    ok(f1Ok.status === 200 && f1Ok.body.value.total === 200,
      "and the connection is still usable for a normal paste afterwards (the cap closes one request, not the server)");

    await f1inst.close();
    M.setTransport(fixtureTransport);
    fs.rmSync(F1_DATA, { recursive: true, force: true });
  }
  // ═══ END F1 PINS ═════════════════════════════════════════════════════════

  M.setTransport(null);
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log("\n" + (fail ? fail + " FAILURE(S)" : "ALL PASS (" + pass + " checks)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); process.exit(1); });
