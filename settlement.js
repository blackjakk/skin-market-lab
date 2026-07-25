// ─── settlement.js — SMLX-3 settlement fixings + manipulation budget ────────
// UMD, pure, deterministic — shared by the collector (Node), the live
// tracker, and the methodology page (browser: window.SkinSettlement).
//
// A FIXING is a dated settlement value computed from the committed market
// series by published rules, so any counterparty re-derives it bit-exactly
// from the repo's own data files. This is what a cash-settled future or a
// scalar market would settle against. Methodology id: SMLX-3 (any rule
// change bumps the id — a fixing is meaningless without its rulebook).
//
//   SETTLE-CASE-7D   — mean of the last ≤7 daily Lab Case Index values (min 3)
//   SETTLE-CASE-30D  — mean of the last ≤30 daily values (min 10)
//   SETTLE-RATIO-30D — mean of the last ≤30 daily cash-ratio values (min 7)
//
// Averaged fixings are the anti-manipulation choice: to move a 7-day mean
// 1% an attacker must sustain the push for SEVEN days, and the SMLX-3
// winsorization clamp (±0.05 log vs the daily median) forces the push
// across MANY names at once — manipulationBudget() prices both the
// uniform attack and the cheapest-k concentrated attack.
//
// NOT FINANCIAL ADVICE and NOT an offer of any instrument — this is a
// published measurement with a verification recipe.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SkinSettlement = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const METHODOLOGY = "SMLX-3";
  const FIXINGS = [
    { name: "SETTLE-CASE-7D", key: "caseIdx", window: 7, minDays: 3, decimals: 2 },
    { name: "SETTLE-CASE-30D", key: "caseIdx", window: 30, minDays: 10, decimals: 2 },
    { name: "SETTLE-RATIO-30D", key: "cashRatio", window: 30, minDays: 7, decimals: 4 },
  ];

  function roundTo(v, d) { const k = Math.pow(10, d); return Math.round(v * k) / k; }

  // One fixing from the market series (array of {day, caseIdx, cashRatio,…}).
  // Returns { name, methodology, window, days:[...], values:[...], value }
  // with value=null (and reason) while the series is too shallow.
  function computeFixing(series, spec) {
    const pts = (series || []).filter((s) => s[spec.key] != null && isFinite(s[spec.key]));
    const w = pts.slice(-spec.window);
    const days = w.map((s) => s.day);
    const values = w.map((s) => roundTo(s[spec.key], spec.decimals));
    if (w.length < spec.minDays) {
      return { name: spec.name, methodology: METHODOLOGY, window: spec.window,
        days: days, values: values, value: null, accruing: w.length + "/" + spec.minDays + " days" };
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { name: spec.name, methodology: METHODOLOGY, window: spec.window,
      days: days, values: values, value: roundTo(mean, spec.decimals) };
  }

  function computeAll(series) {
    const out = {};
    for (const spec of FIXINGS) out[spec.name] = computeFixing(series, spec);
    return out;
  }

  // Canonical byte string for hashing — FIXED field order, no whitespace
  // games, so node crypto and browser crypto.subtle agree byte-for-byte.
  function canonical(f) {
    return JSON.stringify({
      methodology: f.methodology, name: f.name, window: f.window,
      days: f.days, values: f.values, value: f.value,
    });
  }

  // ── manipulation budget (a FLOOR estimate, assumptions published) ────────
  // Model: to shift one item's daily median price by ~1%, an attacker must
  // set the price on ≥ half that day's prints; the irreducible burn is the
  // venue fee on that wash volume (inventory/price risk excluded — this is
  // deliberately a LOWER bound). The index is an equal-weight geometric
  // mean, so moving it 1% requires moving every constituent ~1%; an
  // N-day-average fixing multiplies the burn by N.
  //   items: manifest items [{cat, tier, latest, vol24h, skinport}]
  function manipulationBudget(items, opts) {
    opts = opts || {};
    const feeSteam = opts.feeSteam != null ? opts.feeSteam : 0.15;
    const feeCash = opts.feeCash != null ? opts.feeCash : 0.12;
    const washFraction = opts.washFraction != null ? opts.washFraction : 0.5;
    const clampLog = opts.clampLog != null ? opts.clampLog : 0.05;
    const targetMove = opts.targetMove != null ? opts.targetMove : 0.01;
    const caseDvs = [];
    let caseDollarVol = 0, caseCovered = 0, caseTotal = 0;
    let ratioLegDollarVol30d = 0, ratioCovered = 0, ratioTotal = 0;
    for (const it of items || []) {
      if (it.cat === "case" && it.tier !== "art") {
        caseTotal++;
        if (it.latest != null && it.vol24h != null) {
          const dv = it.latest * it.vol24h;
          caseDollarVol += dv; caseDvs.push(dv); caseCovered++;
        }
      }
      const s30 = it.skinport && it.skinport.last30d;
      ratioTotal++;
      if (s30 && s30.median != null && s30.volume != null) {
        ratioLegDollarVol30d += s30.median * s30.volume; ratioCovered++;
      }
    }
    const perDayCase = washFraction * caseDollarVol * feeSteam;
    // Cheapest-k concentrated attack (the honest MINIMUM): the winsorization
    // clamp means moving the index by targetMove requires pushing at least
    // ceil(N × targetMove / clampLog) names ≥clampLog off the day's median;
    // the optimal attacker picks the k thinnest constituents.
    let concentrated = null;
    if (caseDvs.length) {
      const kMin = Math.max(1, Math.ceil(targetMove * caseTotal / clampLog));
      const sorted = caseDvs.slice().sort((x, y) => x - y);
      const sumK = sorted.slice(0, Math.min(kMin, sorted.length)).reduce((x, y) => x + y, 0);
      const perDayK = washFraction * sumK * feeSteam;
      concentrated = {
        kMin: kMin,
        costMove1pctDay: Math.round(perDayK),
        costMove1pctFix7d: Math.round(perDayK * 7),
        costMove1pctFix30d: Math.round(perDayK * 30),
        note: "cheapest-" + kMin + " attack: clamp forces ≥" + kMin + " names ≥" + (clampLog * 100) + "% off the daily median",
      };
    }
    const ratioBurn30d = washFraction * ratioLegDollarVol30d * feeCash;
    const r2 = (v) => Math.round(v);
    return {
      model: { washFraction: washFraction, feeSteam: feeSteam, feeCash: feeCash,
        clampLog: clampLog, targetMove: targetMove,
        note: "fee-burn floor estimate; inventory and price risk excluded" },
      caseIndex: {
        dailyDollarVolume: r2(caseDollarVol),
        costMove1pctDay: r2(perDayCase),
        costMove1pctFix7d: r2(perDayCase * 7),
        costMove1pctFix30d: r2(perDayCase * 30),
        coverage: caseCovered + "/" + caseTotal + " constituents priced",
        concentrated: concentrated,
      },
      cashRatio: {
        thinLegDollarVolume30d: r2(ratioLegDollarVol30d),
        costMove1pctFix30d: r2(ratioBurn30d),
        coverage: ratioCovered + "/" + ratioTotal + " items with sales data",
      },
    };
  }

  return { METHODOLOGY: METHODOLOGY, FIXINGS: FIXINGS, computeFixing: computeFixing,
    computeAll: computeAll, canonical: canonical, manipulationBudget: manipulationBudget };
});
