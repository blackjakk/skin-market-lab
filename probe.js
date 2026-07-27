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
  ok(fxPub && fxPub.value === null && /2\/3/.test(fxPub.accruing)
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

  M.setTransport(null);
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log("\n" + (fail ? fail + " FAILURE(S)" : "ALL PASS (" + pass + " checks)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); process.exit(1); });
