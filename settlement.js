// ─── settlement.js — SMLX-5 settlement fixings + manipulation budget ────────
// UMD, pure, deterministic — shared by the collector (Node), the live
// tracker, and the methodology page (browser: window.SkinSettlement).
//
// A FIXING is a dated settlement value computed from the committed market
// series by published rules, so any counterparty re-derives it bit-exactly
// from the repo's own data files. This is what a cash-settled future or a
// scalar market would settle against. Methodology id: SMLX-5 (any rule
// change bumps the id — a fixing is meaningless without its rulebook).
//
//   SETTLE-CASE-7D   — mean of the last ≤7 daily Lab Case Index values (min 3)
//   SETTLE-CASE-30D  — mean of the last ≤30 daily values (min 10)
//   SETTLE-RATIO-30D — mean of the last ≤30 daily cash-ratio values (min 7)
//
// Averaged fixings are the anti-manipulation choice: to move a 7-day mean
// 1% an attacker must sustain the push for SEVEN days; the winsorization
// clamp (±0.05 log vs the daily median) caps each name's pull at
// weight×0.05, so the push must control ≥ targetMove/clampLog of total
// index WEIGHT — and SMLX-4's volume weights make weight proportional to
// real traded dollars, so there is no thin-name cheap corner.
// manipulationBudget() prices both the uniform attack and the cheapest
// weight-accumulation attack.
//
// NOT FINANCIAL ADVICE and NOT an offer of any instrument — this is a
// published measurement with a verification recipe.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SkinSettlement = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const METHODOLOGY = "SMLX-5";
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
  // deliberately a LOWER bound). The winsorization clamp caps each name's
  // index pull at weight×clampLog, so moving the index by targetMove needs
  // control of ≥ targetMove/clampLog of total index WEIGHT; the optimal
  // attacker accumulates that weight at the lowest fee-burn per unit of
  // weight. Under SMLX-4 volume weights, weight ∝ traded dollars, so cost
  // scales with weight everywhere — no cheap corner. An N-day-average
  // fixing multiplies the burn by N.
  //   items: manifest items [{cat, tier, latest, vol24h, weight, skinport}]
  //   (weight = the published index weight; items without one fall back to
  //    equal share 1/caseTotal, which reproduces the SMLX-3 cheapest-k)
  function manipulationBudget(items, opts) {
    opts = opts || {};
    const feeSteam = opts.feeSteam != null ? opts.feeSteam : 0.15;
    const feeCash = opts.feeCash != null ? opts.feeCash : 0.12;
    const washFraction = opts.washFraction != null ? opts.washFraction : 0.5;
    const clampLog = opts.clampLog != null ? opts.clampLog : 0.05;
    const targetMove = opts.targetMove != null ? opts.targetMove : 0.01;
    const caseMenu = [];
    let caseDollarVol = 0, caseCovered = 0, caseTotal = 0;
    let ratioLegDollarVol30d = 0, ratioCovered = 0, ratioTotal = 0;
    for (const it of items || []) {
      if (it.cat === "case" && it.tier !== "art") {
        caseTotal++;
        if (it.latest != null && it.vol24h != null) {
          const dv = it.latest * it.vol24h;
          caseDollarVol += dv; caseCovered++;
          caseMenu.push({ dv: dv, w: it.weight != null && isFinite(it.weight) ? it.weight : null });
        }
      }
      const s30 = it.skinport && it.skinport.last30d;
      ratioTotal++;
      if (s30 && s30.median != null && s30.volume != null) {
        ratioLegDollarVol30d += s30.median * s30.volume; ratioCovered++;
      }
    }
    const perDayCase = washFraction * caseDollarVol * feeSteam;
    // Greedy weight-accumulation: cheapest fee-burn per unit of index weight
    // until `targetWeight` of total weight is controlled. Both attacks below
    // reduce to buying weight — under SMLX-4 volume weights that means real
    // traded dollars everywhere, so no thin-name cheap corner survives.
    let concentrated = null, centerCapture = null;
    if (caseMenu.length) {
      const anyW = caseMenu.some((c) => c.w != null);
      const menu = caseMenu
        .map((c) => ({ dv: c.dv, w: c.w != null ? c.w : 1 / caseTotal }))
        .sort((a, b) => (a.dv / Math.max(a.w, 1e-12)) - (b.dv / Math.max(b.w, 1e-12)));
      const accumulate = (targetWeight) => {
        let cumW = 0, cost = 0, k = 0;
        for (const c of menu) {
          if (cumW >= targetWeight - 1e-12) break;
          cumW += c.w; cost += washFraction * c.dv * feeSteam; k++;
        }
        return { k: k, cost: cost, cumW: cumW };
      };
      // (1) BOUNDED move: the clamp caps one name's pull at weight×clampLog,
      // so a targetMove needs control of targetMove/clampLog of index weight.
      const weightNeeded = targetMove / clampLog;
      const a1 = accumulate(weightNeeded);
      concentrated = {
        kMin: a1.k,
        weightNeeded: weightNeeded,
        weighted: anyW,
        costMove1pctDay: Math.round(a1.cost),
        costMove1pctFix7d: Math.round(a1.cost * 7),
        costMove1pctFix30d: Math.round(a1.cost * 30),
        note: (anyW ? "cheapest weight-accumulation attack" : "cheapest-k attack (equal-weight fallback)")
          + ": clamp caps one name's pull at weight×" + clampLog + " — a "
          + (targetMove * 100) + "% move needs ≥" + Math.round(weightNeeded * 100)
          + "% of index weight (" + a1.k + " names here)",
      };
      // (2) UNBOUNDED control (SMLX-5): the clamp center is the WEIGHT-weighted
      // median, so seizing >50% of index weight captures the center and lets
      // the attacker move the index arbitrarily. This is the price of control,
      // not of a 1% nudge — the number an instrument's OI cap must respect.
      const a2 = accumulate(0.5);
      centerCapture = {
        kMin: a2.k,
        weightNeeded: 0.5,
        weighted: anyW,
        costPerDay: Math.round(a2.cost),
        costFix7d: Math.round(a2.cost * 7),
        costFix30d: Math.round(a2.cost * 30),
        note: "seize >50% of index weight → control the weighted-median clamp center → UNBOUNDED move ("
          + a2.k + " heaviest names here)",
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
        centerCapture: centerCapture,
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
