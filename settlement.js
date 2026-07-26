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

  // ── mark integrity (INTEG-1) — surveillance, NOT settlement rules ────────
  // A published tamper DETECTOR over the marks feeding the index. Three
  // corroboration lanes + a staleness lane, every threshold published:
  //
  //   ratio — each item's daily (skinport realized ÷ steam) ratio vs its OWN
  //     trailing median, then vs the day's CROSS-SECTIONAL median deviation
  //     (the same median-relative logic as the index clamp: a market-wide
  //     move shifts every item's ratio together and is NOT flagged; one name
  //     whose steam price escaped its cash comparable is). "steam-rich" =
  //     steam price high vs realized cash (pump suspect); "steam-lean" =
  //     low (or the skinport leg was pumped — that matters too: art marks
  //     to skinport).
  //   book — last-sale median vs the STANDING order book (second read path;
  //     wash trades fake prints, not committed capital): flagged when the
  //     quote escapes its own bid/ask bracket by the published margin.
  //   art-evidence — appraisal marks need sales: fewer than artMinSales30
  //     realized sales in the 30d marking window is published, not hidden.
  //   staleness — venue loss surfaces as an alert instead of the site
  //     silently serving carried-forward prices.
  //
  // FLAG-ONLY BY DESIGN — flags NEVER remove a mark or reroute the index.
  // Auto-rejection would hand an attacker a cheaper lever: manipulate the
  // THIN venue (skinport) to force honest steam marks out of the index and
  // surgically break return pairs. Detection is published; consumers of the
  // fixings decide their own halt rules (methodology §4). Because flags
  // change no fixing computation, this layer does NOT bump SMLX — bumping
  // the id without a computation change would falsely signal a rules change
  // to every hash verifier. INTEG versions independently.
  const INTEG_RULES = {
    version: "INTEG-1",
    ratioWindow: 30, ratioMinDays: 5, ratioDevWatch: 0.25, ratioDevAlert: 0.5,
    bookBracketWatch: 0.15, bookBracketAlert: 0.30, bookMaxAgeH: 48,
    artMinSales30: 3, quoteFreshH: 12, staleAlertFrac: 0.5,
  };
  function medianOf(vals) {
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // items: [{ name, cat, tier, steamPrice, quoteT, salesT, sales30,
  //           ratioDays: [{day, r}], book: {t,bid,ask,mid,...}|null }]
  // opts: { now } — pure function of its inputs, probe-pinned.
  function assessIntegrity(items, opts) {
    opts = opts || {};
    const now = opts.now != null ? opts.now : 0;
    const R = INTEG_RULES;
    const flags = [];
    const r3 = (v) => Math.round(v * 1000) / 1000;
    // ratio lane: per-item deviation from OWN baseline, then market-gated
    const devs = [];
    let ratioCorroborated = 0, ratioEligible = 0;
    for (const it of items || []) {
      if (it.tier === "art") continue;
      ratioEligible++;
      const rd = (it.ratioDays || []).filter((d) => d && d.r > 0).slice(-(R.ratioWindow + 1));
      if (rd.length < R.ratioMinDays + 1) continue;
      const base = medianOf(rd.slice(0, -1).map((d) => d.r));
      const last = rd[rd.length - 1].r;
      if (!(base > 0) || !(last > 0)) continue;
      devs.push({ it: it, d: Math.log(last / base) });
      ratioCorroborated++;
    }
    const xMed = medianOf(devs.map((x) => x.d)) || 0; // market-move gate
    for (const x of devs) {
      const e = x.d - xMed;
      if (Math.abs(e) >= R.ratioDevWatch) {
        flags.push({ name: x.it.name, lane: "ratio", severity: Math.abs(e) >= R.ratioDevAlert ? "alert" : "watch",
          dev: r3(e), detail: e < 0 ? "steam-rich vs its own cash-ratio baseline" : "steam-lean vs its own cash-ratio baseline (or skinport leg moved)" });
      }
    }
    // book lane: quote vs standing order book (second read path).
    // COMMODITY (case) items ONLY: identical units → one true book, quote
    // must sit near its bid/ask. UNIQUE items (skins/knives with floats)
    // are bucketed by Steam's UI and their buy orders sit on PREMIUM
    // variants (low floats, rare patterns) legitimately far above the
    // generic sale median — bracket-checking them cries wolf (found live
    // 2026-07-26: six false "below the bid wall" alerts, Redline quote $42
    // vs a $197 variant bid). Their books are still recorded as evidence.
    let bookCorroborated = 0, bookEligible = 0;
    for (const it of items || []) {
      const b = it.book;
      if (it.tier === "art" || it.cat !== "case" || it.steamPrice == null) continue;
      bookEligible++;
      if (!b || b.bid == null || b.ask == null || (now && now - b.t > R.bookMaxAgeH * 3600000)) continue;
      bookCorroborated++;
      const hi = b.ask * (1 + R.bookBracketWatch), lo = b.bid * (1 - R.bookBracketWatch);
      if (it.steamPrice > hi || it.steamPrice < lo) {
        const over = it.steamPrice > hi;
        const margin = over ? it.steamPrice / b.ask - 1 : 1 - it.steamPrice / b.bid;
        flags.push({ name: it.name, lane: "book", severity: margin >= R.bookBracketAlert ? "alert" : "watch",
          dev: r3(margin), detail: over ? "last-sale median above the standing ask wall" : "last-sale median below the standing bid wall" });
      }
    }
    // art evidence lane: appraisal marks need visible sales
    let artEvidenced = 0, artTotal = 0;
    for (const it of items || []) {
      if (it.tier !== "art") continue;
      artTotal++;
      if (it.sales30 == null) continue; // unknown ≠ thin — never fabricate
      if (it.sales30 >= R.artMinSales30) artEvidenced++;
      else flags.push({ name: it.name, lane: "art-evidence", severity: "watch",
        dev: it.sales30, detail: it.sales30 + " realized sales in the 30d marking window" });
    }
    // staleness lane: venue loss must surface loudly
    let steamFresh = 0, steamExpected = 0, oldestSalesAgeDays = null;
    for (const it of items || []) {
      if (it.tier !== "art") {
        steamExpected++;
        if (it.quoteT != null && now && now - it.quoteT <= R.quoteFreshH * 3600000) steamFresh++;
      }
      if (it.salesT != null && now) {
        const age = Math.round((now - it.salesT) / 86400000 * 10) / 10;
        if (oldestSalesAgeDays == null || age > oldestSalesAgeDays) oldestSalesAgeDays = age;
      }
    }
    if (steamExpected && steamFresh / steamExpected < R.staleAlertFrac) {
      flags.push({ name: "(market)", lane: "staleness", severity: "alert", dev: r3(steamFresh / steamExpected),
        detail: "only " + steamFresh + "/" + steamExpected + " items have a fresh steam quote — possible venue loss" });
    }
    return {
      version: R.version, t: now, rules: R, flags: flags,
      summary: {
        itemsAssessed: (items || []).length,
        ratioCorroborated: ratioCorroborated + "/" + ratioEligible,
        bookCorroborated: bookCorroborated + "/" + bookEligible,
        steamFresh: steamFresh + "/" + steamExpected,
        artEvidenced: artEvidenced + "/" + artTotal,
        oldestSalesAgeDays: oldestSalesAgeDays,
        watch: flags.filter((f) => f.severity === "watch").length,
        alert: flags.filter((f) => f.severity === "alert").length,
      },
    };
  }

  return { METHODOLOGY: METHODOLOGY, FIXINGS: FIXINGS, computeFixing: computeFixing,
    computeAll: computeAll, canonical: canonical, manipulationBudget: manipulationBudget,
    INTEG_RULES: INTEG_RULES, assessIntegrity: assessIntegrity };
});
