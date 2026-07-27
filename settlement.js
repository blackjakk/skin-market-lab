// ─── settlement.js — SMLX-6 settlement fixings + manipulation budget ────────
// UMD, pure, deterministic — shared by the collector (Node), the live
// tracker, and the methodology page (browser: window.SkinSettlement).
//
// A FIXING is a dated settlement value computed from the committed market
// series by published rules, so any counterparty re-derives it bit-exactly
// from the repo's own data files. This is what a cash-settled future or a
// scalar market would settle against. Methodology id: SMLX-6 (any rule
// change bumps the id — a fixing is meaningless without its rulebook).
//
//   SETTLE-CASE-7D   — mean of the last ≤7 daily Skindex values (min 3)
//   SETTLE-CASE-30D  — mean of the last ≤30 daily values (min 10)
//   SETTLE-CASE-90D  — mean of the last ≤90 daily values (min 30; ADDITIVE
//                      SMLX-6 catalog entry, 2026-07-27 — accrues forward
//                      under its own min-day gate, never backfilled; adding
//                      a fixing changes no existing canonical form or hash,
//                      which is why the methodology id does not bump)
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

  const METHODOLOGY = "SMLX-6";
  const FIXINGS = [
    { name: "SETTLE-CASE-7D", key: "caseIdx", window: 7, minDays: 3, decimals: 2 },
    { name: "SETTLE-CASE-30D", key: "caseIdx", window: 30, minDays: 10, decimals: 2 },
    { name: "SETTLE-CASE-90D", key: "caseIdx", window: 90, minDays: 30, decimals: 2 },
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
        costMove1pctFix90d: Math.round(a1.cost * 90),
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
        costFix90d: Math.round(a2.cost * 90),
        note: "seize >50% of index weight → control the weighted-median clamp center → UNBOUNDED move ("
          + a2.k + " heaviest names here)",
      };
    }
    // ── market-universe (SMLX-7 preview) capture economics ───────────────
    // Informational only: the combined cases+liquids universe has NO fixings
    // yet, so no oiCapacity is published for it — these numbers exist to
    // show what the broader basket buys (kMin and capture cost multiply).
    // Weights come from the overview's marketPreview (name → weight map).
    let marketUniverse = null;
    if (opts.marketWeights && Object.keys(opts.marketWeights).length >= 3) {
      const mMenu = [];
      let mDollarVol = 0, mCovered = 0;
      const mTotal = Object.keys(opts.marketWeights).length;
      for (const it of items || []) {
        const w = opts.marketWeights[it.name];
        if (w == null || !isFinite(w) || it.tier === "art") continue;
        if (it.latest != null && it.vol24h != null) {
          const dv = it.latest * it.vol24h;
          mDollarVol += dv; mCovered++;
          mMenu.push({ dv: dv, w: w });
        }
      }
      if (mMenu.length >= 3) {
        mMenu.sort((a, b) => (a.dv / Math.max(a.w, 1e-12)) - (b.dv / Math.max(b.w, 1e-12)));
        const mAccumulate = (targetWeight) => {
          let cumW = 0, cost = 0, k = 0;
          for (const c of mMenu) {
            if (cumW >= targetWeight - 1e-12) break;
            cumW += c.w; cost += washFraction * c.dv * feeSteam; k++;
          }
          return { k: k, cost: cost };
        };
        const m1 = mAccumulate(targetMove / clampLog), m2 = mAccumulate(0.5);
        marketUniverse = {
          label: "SMLX-7 draft preview universe (cases + liquids) — no fixings, no capacity line",
          dailyDollarVolume: Math.round(mDollarVol),
          coverage: mCovered + "/" + mTotal + " constituents priced",
          concentrated: { kMin: m1.k, weightNeeded: targetMove / clampLog,
            costMove1pctDay: Math.round(m1.cost), costMove1pctFix30d: Math.round(m1.cost * 30) },
          centerCapture: { kMin: m2.k, weightNeeded: 0.5,
            costPerDay: Math.round(m2.cost), costFix30d: Math.round(m2.cost * 30) },
        };
      }
    }
    const ratioBurn30d = washFraction * ratioLegDollarVol30d * feeCash;
    const r2 = (v) => Math.round(v);
    // ── open-interest capacity, per fixing ───────────────────────────────
    // Safety condition: corrupting a fixing by Δ must cost more than it can
    // pay. With LINEAR payoffs and the single-party worst case (one attacker
    // holds the entire opposing side of open interest N), a Δ move pays
    // N×Δ, so the fixing is safe while C(Δ) > N×Δ — i.e. N < C(Δ)/Δ.
    //   boundConcentrated = costMove1pctFix / 0.01 — the bounded (clamped)
    //     attack: the cheapest 1% push over the fixing window.
    //   boundCapture = captureCostFix / 0.05 — center capture is UNBOUNDED
    //     in Δ, so this bound only exists under a dispute/challenge layer
    //     that caps the largest CREDIBLE print at Δcap = 5%; without such a
    //     layer, total notional must stay below the raw capture cost.
    //   capacityLinear = round(min(bounds) / κ), κ = 3 corruption margin —
    //     the publishable OI line. Linear payoffs ONLY: near-the-money
    //     binary/digital payoffs make a tiny Δ decisive → capacity ≈ zero.
    // The ratio fixing has no capture model (no weighted-median center on a
    // two-leg ratio) → bounded by its 1% thin-leg cost alone.
    // Bounds divide the PUBLISHED (rounded) costs, so any counterparty
    // reproduces the capacity line from this record's own numbers.
    const OI_DELTA_CAP = 0.05, OI_KAPPA = 3;
    const oiAssumptions = (hasCapture) => ({
      payoffs: "linear payoffs only — near-the-money binary/digital payoffs make a tiny move decisive, so their capacity on these fixings is ≈ zero",
      attacker: "single-party worst case: one attacker holds the entire opposing side of the open interest",
      costs: "fee-burn floors (wash fraction × venue fee); inventory and price risk excluded, so true attack cost is higher",
      deltaCap: hasCapture
        ? "center capture is unbounded; the capture bound assumes a dispute layer capping the credible print at Δcap = 5%"
        : "no capture model for this fixing — bound taken from its 1% cost alone (Δcap 5% not applicable)",
      kappa: "κ = 3 corruption margin: capacityLinear = round(min(bounds) / 3)",
      hedging: "independent ceiling: hedgeable OI ≈ the underlying's daily $ volume — capacity beyond what spot absorbs is unusable",
    });
    const oiFromCosts = (costCon, costCap) => {
      const bc = costCon != null ? Math.round(costCon / targetMove) : null;
      const bk = costCap != null ? Math.round(costCap / OI_DELTA_CAP) : null;
      const bounds = [bc, bk].filter((v) => v != null);
      return {
        boundConcentrated: bc,
        boundCapture: bk,
        capacityLinear: bounds.length ? Math.round(Math.min.apply(null, bounds) / OI_KAPPA) : null,
        assumptions: oiAssumptions(costCap != null),
      };
    };
    return {
      model: { washFraction: washFraction, feeSteam: feeSteam, feeCash: feeCash,
        clampLog: clampLog, targetMove: targetMove,
        note: "fee-burn floor estimate; inventory and price risk excluded" },
      caseIndex: {
        dailyDollarVolume: r2(caseDollarVol),
        costMove1pctDay: r2(perDayCase),
        costMove1pctFix7d: r2(perDayCase * 7),
        costMove1pctFix30d: r2(perDayCase * 30),
        costMove1pctFix90d: r2(perDayCase * 90),
        coverage: caseCovered + "/" + caseTotal + " constituents priced",
        concentrated: concentrated,
        centerCapture: centerCapture,
      },
      cashRatio: {
        thinLegDollarVolume30d: r2(ratioLegDollarVol30d),
        costMove1pctFix30d: r2(ratioBurn30d),
        coverage: ratioCovered + "/" + ratioTotal + " items with sales data",
      },
      oiCapacity: {
        "SETTLE-CASE-7D": concentrated ? oiFromCosts(concentrated.costMove1pctFix7d, centerCapture.costFix7d) : null,
        "SETTLE-CASE-30D": concentrated ? oiFromCosts(concentrated.costMove1pctFix30d, centerCapture.costFix30d) : null,
        "SETTLE-CASE-90D": concentrated ? oiFromCosts(concentrated.costMove1pctFix90d, centerCapture.costFix90d) : null,
        "SETTLE-RATIO-30D": oiFromCosts(r2(ratioBurn30d), null),
      },
      marketUniverse: marketUniverse,
    };
  }

  // ── PERPMARK-CASE — EXPERIMENTAL perp-grade mark preview ─────────────────
  // NOT a settlement fixing: no hash, no canonical form, outside the SMLX-6
  // FIXINGS catalog, and nothing settles on it. Purpose: preview the
  // liquidation-grade smoothing a perpetual venue would mark positions to —
  // the median of the last ≤5 daily case-index prints, with a max-step guard:
  // an update that would move the mark by more than 2% carries the previous
  // mark instead and publishes guarded:true. The median means ONE corrupted
  // print cannot move the mark at all, and the step guard stops even a
  // 3-of-5-print corruption at 2% per update.
  // Pure fold over the published daily series — no state, no clock — so any
  // counterparty re-derives the entire mark path from data/index.json alone.
  // Publication home: the NON-CANONICAL `latest` area of the settlement
  // output (latest.perpmark — the collector attaches
  // S.perpMark(market.series) beside the budget); the methodology page also
  // re-derives it in-browser.
  const PERPMARK = { name: "PERPMARK-CASE", key: "caseIdx", window: 5, maxStep: 0.02, decimals: 2, experimental: true };
  function perpMark(series) {
    const prints = (series || []).filter((s) => s[PERPMARK.key] != null && isFinite(s[PERPMARK.key]));
    let mark = null, guarded = false, guardedUpdates = 0;
    for (let i = 0; i < prints.length; i++) {
      const win = prints.slice(Math.max(0, i - PERPMARK.window + 1), i + 1).map((s) => s[PERPMARK.key]);
      const med = medianOf(win);
      if (mark != null && Math.abs(med / mark - 1) > PERPMARK.maxStep) { guarded = true; guardedUpdates++; }
      else { mark = med; guarded = false; }
    }
    return {
      name: PERPMARK.name,
      experimental: true,
      label: "EXPERIMENTAL perp-grade mark preview — NOT a settlement fixing, no hash, outside the SMLX-6 canonical catalog",
      value: mark != null ? roundTo(mark, PERPMARK.decimals) : null,
      guarded: guarded,
      guardedUpdates: guardedUpdates,
      window: PERPMARK.window,
      maxStep: PERPMARK.maxStep,
      day: prints.length ? prints[prints.length - 1].day : null,
      prints: prints.slice(-PERPMARK.window).map((s) => ({ day: s.day, v: roundTo(s[PERPMARK.key], PERPMARK.decimals) })),
      note: "median of the last ≤" + PERPMARK.window + " daily case-index prints; |step| > "
        + (PERPMARK.maxStep * 100) + "% per update carries the previous mark (guarded) — liquidation-grade smoothing",
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
  //   venue — THIRD-VENUE corroboration: every mark is single-venue at
  //     source (Steam), so this lane compares it against independent
  //     marketplaces (market.js's pluggable venue adapters). A wash trader
  //     who moves a Steam mark must now move unrelated venues in the same
  //     direction at the same time or the divergence is published.
  //     MEDIAN-RELATIVE, exactly like the ratio lane and the index clamp:
  //     third venues sit at a structural discount to Steam (measured ~0.66×
  //     on 2026-07-27 — Steam proceeds are wallet-locked) and that discount
  //     moves with FX, fee changes and market-wide sentiment, so the gate is
  //     each item's deviation from the DAY'S median venue/steam ratio, not
  //     from 1.0. A venue-wide move flags nothing; one name that escaped its
  //     own venue's consensus flags. Unique (non-case) items get
  //     venueUniqueMult more room: a venue quote is the cheapest ask on ONE
  //     float/pattern/phase variant while the Steam mark is a bucketed
  //     median — the same asymmetry that made the book lane commodity-only
  //     (live false alarms, 2026-07-26). An unavailable venue is REPORTED
  //     unavailable; it is never counted as agreement.
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
    // venue lane (third-venue corroboration). Thresholds MIRROR the ratio
    // lane — same median-relative log deviation, same watch/alert steps —
    // because it is the same kind of measurement against a different second
    // read path. Measured against live venue data on 2026-07-27 (55 tracked
    // non-art names × market.csgo + waxpeer) these produced 0 and 1 flags
    // respectively: wide enough not to cry wolf, tight enough that a 30%+
    // single-name divergence is published the day it appears.
    venueDevWatch: 0.25, venueDevAlert: 0.5, venueUniqueMult: 1.6,
    venueMinQuotes: 5, venueMaxAgeH: 48,
  };
  function medianOf(vals) {
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // items: [{ name, cat, tier, steamPrice, quoteT, salesT, sales30,
  //           ratioDays: [{day, r}], book: {t,bid,ask,mid,...}|null,
  //           venues: { <venueId>: { price, t } } | null }]
  // opts: { now,
  //         venues: [{ id, label, kind, ccy, ok, reason, mode, t }] — the
  //           per-run venue ROSTER. It is passed separately from the quotes
  //           so a venue that answered nothing is still published (a silent
  //           absence would read as agreement). Callers with no venue layer
  //           (the live server) simply omit it and the lane reports 0/0.
  //       } — pure function of its inputs, probe-pinned.
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
    // venue lane: third-venue corroboration (see the header note). FLAG-ONLY
    // like every other lane — a divergence here never removes a mark, never
    // reroutes the index and never touches a fixing. That is not politeness:
    // third venues are THINNER than Steam, so auto-rejection would let an
    // attacker knock honest marks out of the index by moving the cheaper
    // market. Detection is published; consumers decide their own halt rules.
    const vRoster = opts.venues || [];
    const vEligible = (items || []).filter((it) => it.tier !== "art" && it.steamPrice > 0);
    const vCorroboratedItems = new Set();
    let venuesAnswered = 0;
    const venueReport = [];
    for (const v of vRoster) {
      const row = { id: v.id, label: v.label || v.id, kind: v.kind || null, ccy: v.ccy || null,
        mode: v.mode || null, status: "unavailable", reason: v.reason || null,
        corroborated: "0/" + vEligible.length, medianRatio: null, watch: 0, alert: 0,
        t: v.t != null ? v.t : null };
      if (!v.ok) { venueReport.push(row); continue; } // unavailable ≠ agreement
      venuesAnswered++;
      const pairs = [];
      for (const it of vEligible) {
        const q = it.venues ? it.venues[v.id] : null;
        if (!q || !(q.price > 0)) continue;
        // a reading older than venueMaxAgeH is dropped, NOT carried: a stale
        // quote that happens to agree is not corroboration
        if (now && q.t != null && now - q.t > R.venueMaxAgeH * 3600000) continue;
        pairs.push({ it: it, q: q, lr: Math.log(q.price / it.steamPrice) });
      }
      row.corroborated = pairs.length + "/" + vEligible.length;
      if (pairs.length < R.venueMinQuotes) {
        // too few names to trust a cross-sectional median — publish the
        // coverage, raise nothing (the ratioMinDays discipline)
        row.status = pairs.length ? "insufficient" : "no-quotes";
        row.reason = row.reason || (pairs.length + " fresh quotes, below venueMinQuotes "
          + R.venueMinQuotes + " — coverage published, no flags raised");
        venueReport.push(row);
        continue;
      }
      row.status = "ok";
      // only a venue that actually got EVALUATED counts toward the summary's
      // item coverage — quotes a venue held but could not be gated on are
      // published in its own row, never folded into "corroborated"
      for (const p of pairs) vCorroboratedItems.add(p.it.name);
      const vMed = medianOf(pairs.map((p) => p.lr));
      row.medianRatio = r3(Math.exp(vMed));
      for (const p of pairs) {
        const e = p.lr - vMed;
        const mult = p.it.cat === "case" ? 1 : R.venueUniqueMult;
        if (Math.abs(e) < R.venueDevWatch * mult) continue;
        const sev = Math.abs(e) >= R.venueDevAlert * mult ? "alert" : "watch";
        if (sev === "alert") row.alert++; else row.watch++;
        flags.push({ name: p.it.name, lane: "venue", venue: v.id, severity: sev,
          dev: r3(e), ratio: r3(Math.exp(p.lr)), venueMedianRatio: row.medianRatio,
          steamPrice: p.it.steamPrice, venuePrice: p.q.price,
          detail: (e < 0 ? "steam-rich" : "steam-lean") + " vs " + (v.label || v.id)
            + " (" + (v.kind || "quote") + " " + p.q.price + " vs steam " + p.it.steamPrice
            + " = " + r3(Math.exp(p.lr)) + "×, venue median " + row.medianRatio + "×)" });
      }
      venueReport.push(row);
    }

    return {
      version: R.version, t: now, rules: R, flags: flags, venues: venueReport,
      summary: {
        itemsAssessed: (items || []).length,
        ratioCorroborated: ratioCorroborated + "/" + ratioEligible,
        bookCorroborated: bookCorroborated + "/" + bookEligible,
        steamFresh: steamFresh + "/" + steamExpected,
        artEvidenced: artEvidenced + "/" + artTotal,
        // honest per-run coverage: how many tracked items ANY third venue
        // actually corroborated, and how many venues answered at all
        venueCorroborated: vCorroboratedItems.size + "/" + vEligible.length,
        venuesAnswered: venuesAnswered + "/" + vRoster.length,
        oldestSalesAgeDays: oldestSalesAgeDays,
        watch: flags.filter((f) => f.severity === "watch").length,
        alert: flags.filter((f) => f.severity === "alert").length,
      },
    };
  }

  return { METHODOLOGY: METHODOLOGY, FIXINGS: FIXINGS, computeFixing: computeFixing,
    computeAll: computeAll, canonical: canonical, manipulationBudget: manipulationBudget,
    PERPMARK: PERPMARK, perpMark: perpMark,
    INTEG_RULES: INTEG_RULES, assessIntegrity: assessIntegrity };
});
