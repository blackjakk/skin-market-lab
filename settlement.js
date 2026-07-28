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
      // ── what INTEG-1's evidence tiers are worth in attack-cost terms ─────
      // Stated ONLY where it can be stated without inventing a number. The
      // costs above are unchanged: detection flags, it never rejects a mark,
      // and no lane threshold binds the cheapest 1% attack (see boundedAttack).
      detection: {
        note: "informational — no number above depends on this block. INTEG-1 lanes are flag-only surveillance; "
          + "this records what each evidence tier does, and does NOT do, to the price of an attack.",
        boundedAttack: "the concentrated floor already assumes each attacked name is pushed by at most clampLog ("
          + clampLog + " log ≈ " + Math.round((Math.exp(clampLog) - 1) * 1000) / 10 + "%), and every corroboration "
          + "lane's MOVE threshold is wider than that (ratio/venue watch 0.25 log, volume watch 0.10 log). So no "
          + "corroboration lane raises the cost of the cheapest 1% index push. The book lane is a LEVEL test, so it "
          + "can still catch a push that carries a quote outside the standing bid/ask bracket.",
        weakTierSurcharge: 0,
        weakTierWhy: "third-venue corroboration is ASKS, and a listing is free to post: an attacker moving a steam "
          + "mark can post matching asks on every third venue at zero cost. Ask agreement therefore adds exactly "
          + "nothing to attack cost — the reason it is no longer counted as corroboration (INTEG_RULES.lanes.venue).",
        strongTierWhy: "realized-sale corroboration (skinport medians/volumes, steam sold-per-day) can only be faked "
          + "by transacting, i.e. by burning feeSteam/feeCash on the washed units — the same burn priced above. For a "
          + "LARGE-Δ attack that would cross those lanes' thresholds the surcharge is real, but it depends on a Δ this "
          + "model does not assume, so it is left UNPRICED rather than invented.",
        mediumTierWhy: "standing bids cost no fee to post or pull — their cost is capital at risk of being filled, "
          + "which a fee-burn model cannot price. Left unpriced.",
      },
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
  // A published tamper DETECTOR over the marks feeding the index. Several
  // corroboration lanes + a staleness lane, every threshold published.
  //
  // EVIDENCE IS NOT ALL EQUAL (2026-07-27 revision). Every lane now carries an
  // explicit evidence STRENGTH, ranked by what it costs an attacker to FAKE
  // the corroboration — and coverage is reported per tier instead of as one
  // undifferentiated count:
  //
  //   strong — REALIZED SALES (skinport realized medians/volumes, steam's own
  //     sold-per-day). Faking one burns the venue fee on the washed units
  //     (steam 15%, skinport 12%) — the SAME fee-burn manipulationBudget is
  //     built on. This is evidence an attacker has to pay for.
  //   medium — STANDING BIDS (the book lane). Committed capital that can
  //     actually get filled. Posting and pulling a bid costs no fee, so it is
  //     cheaper to fake than a sale, but while it stands it is real money at
  //     risk of being hit.
  //   weak — ASKS / LISTINGS (the venue lane: TM Market, Waxpeer, BUFF
  //     sell_min_price). FREE to post. Anyone pumping a steam mark can list
  //     matching asks on every third venue at zero cost.
  //
  // THE ASYMMETRY THAT FOLLOWS — and the point of the revision:
  //   *** Divergence from an ask venue is evidence. Agreement is not. ***
  // A disagreeing ask venue keeps FULL flagging power (an attacker who did not
  // bother to move it is caught, and the venues' own cross-section is a real
  // independent read). An AGREEING ask venue no longer counts toward "this
  // mark is corroborated" — it used to inflate coverage as though three venues
  // had confirmed the mark, which overstated the evidence. The venue lane's
  // coverage is still published in full (checked / agreed, per venue); it is
  // published in the WEAK tier with counted:false rather than silently dropped.
  //
  // The version id stays INTEG-1: no fixing computation, canonical form or
  // hash changes (this layer never touched them and still does not). What
  // changed is what the record SAYS about its own evidence — published in
  // INTEG_RULES.revision / .revisionNote / .lanes.
  //
  // Lanes:
  //
  //   ratio — each item's daily (skinport realized ÷ steam) ratio vs its OWN
  //     trailing median, then vs the day's CROSS-SECTIONAL median deviation
  //     (the same median-relative logic as the index clamp: a market-wide
  //     move shifts every item's ratio together and is NOT flagged; one name
  //     whose steam price escaped its cash comparable is). "steam-rich" =
  //     steam price high vs realized cash (pump suspect); "steam-lean" =
  //     low (or the skinport leg was pumped — that matters too: art marks
  //     to skinport).
  //   volume — REALIZED-SALE COUNTS (steam's own sold-per-day) against the
  //     item's OWN trailing baseline, then median-gated cross-sectionally.
  //     The strong-evidence detector we already had the data for: a mark set
  //     on a thin tape — a big idiosyncratic price move on a day this name's
  //     traded volume collapsed relative to both its own baseline and the
  //     market's — is exactly what a price printed without trade looks like,
  //     and volume is the one input that costs ~15% of every unit to fake.
  //     MEASURED, not guessed (see the threshold comment in INTEG_RULES): the
  //     naive premise "a genuine move arrives with a volume SURGE" is NOT what
  //     the committed history shows (median volume response on a big-move day
  //     is only +4%), so the lane does not flag "volume failed to rise" — it
  //     flags the LEFT TAIL, where the volume response is far below what the
  //     rest of the market did that day.
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
  //     unavailable; it is never counted as agreement — and since 2026-07-27
  //     neither is an AVAILABLE one: these venues publish ASKS, which are free
  //     to post, so agreement here is weak-tier evidence that is published
  //     (checked / agreed, per venue) but never counted as corroboration.
  //     Divergence keeps every bit of its flagging power.
  //
  // FLAG-ONLY BY DESIGN — flags NEVER remove a mark or reroute the index.
  // Auto-rejection would hand an attacker a cheaper lever: manipulate the
  // THIN venue (skinport) to force honest steam marks out of the index and
  // surgically break return pairs. Detection is published; consumers of the
  // fixings decide their own halt rules (methodology §4). Because flags
  // change no fixing computation, this layer does NOT bump SMLX — bumping
  // the id without a computation change would falsely signal a rules change
  // to every hash verifier. INTEG versions independently.
  // Per-lane EVIDENCE STRENGTH, published in every record inside
  // INTEG_RULES.lanes so a consumer can rank a flag (and a coverage number) by
  // what it would cost to fake. `counts` says whether the lane's AGREEMENT is
  // counted as corroboration — false for asks (free to post) and for the
  // liveness lane (it corroborates no mark at all).
  const INTEG_LANES = {
    ratio: { strength: "strong", counts: true,
      evidence: "realized sales on both legs (skinport realized median ÷ steam last-sale median)",
      costToFake: "venue fee on the washed units — steam 15% / skinport 12% — on BOTH venues at once" },
    volume: { strength: "strong", counts: true,
      evidence: "realized sale COUNTS (steam's own sold-per-day) vs the item's own trailing baseline",
      costToFake: "~15% of every unit: volume can only be manufactured by transacting through steam's fee" },
    book: { strength: "medium", counts: true,
      evidence: "standing bids/asks on steam — committed capital that can actually be filled",
      costToFake: "no fee to post or pull, but a standing bid is real money at risk of being hit" },
    venue: { strength: "weak", counts: false,
      evidence: "third-venue ASKS (TM Market / Waxpeer / BUFF sell_min_price) — quoted level, not executed trade",
      costToFake: "zero — a listing is free to post, so an attacker pumping steam can post matching asks at no cost",
      asymmetry: "divergence from an ask venue is evidence and still flags at full strength; AGREEMENT is not counted as corroboration" },
    "venue-book": { strength: "medium", counts: true,
      evidence: "standing BIDS on a third venue (BUFF163 buy_max_price) — independent capital offering to buy near the mark",
      costToFake: "no fee to post, but the bid is real money exposed to being hit — and it sits on a venue the attacker "
        + "does not control, in another currency and another jurisdiction from the mark being defended",
      why: "same tier as the book lane and for the same reason, but the capital is INDEPENDENT: steam's order book and "
        + "steam's price are one venue, so whoever can wash the mark owns both sides of that test",
      provisional: "thresholds are NOT yet measured (the venue lane's ask distribution is not a bid distribution and "
        + "coverage is too thin to fit one) — set wide, so the lane corroborates now and flags only gross divergence" },
    "art-evidence": { strength: "strong", counts: true,
      evidence: "the count of REALIZED sales behind an appraisal mark (skinport 30d sale count)",
      costToFake: "skinport's 12% fee per fabricated sale, on an item priced in the thousands" },
    staleness: { strength: "n/a", counts: false, kind: "liveness",
      evidence: "how many marks arrived fresh at all — it corroborates no price, so it carries no evidence strength",
      costToFake: "n/a" },
    center: { strength: "strong", counts: false, kind: "observation",
      evidence: "SMLX-7 preview: the index clamp centre vs the skinport cash-implied centre (realized sales both legs)",
      costToFake: "same as the ratio lane — moving realized cash prints",
      note: "computed by analytics.js in its observation phase and merged into this record by the collector; not gated on, so its agreement is not counted" },
  };
  const INTEG_RULES = {
    version: "INTEG-1",
    revision: "2026-07-27-evidence-tiers",
    revisionNote: "Lanes now publish an explicit evidence STRENGTH (strong = realized sales, medium = standing bids, "
      + "weak = asks) and coverage is reported per tier instead of one undifferentiated count. Ask-venue AGREEMENT no "
      + "longer counts as corroboration (asks are free to post); ask-venue DIVERGENCE still flags at full strength. "
      + "New strong-tier `volume` lane (steam sold-per-day vs the item's own baseline, median-gated cross-sectionally). "
      + "No fixing computation, canonical form or hash changed — the version id stays INTEG-1 for that reason.",
    lanes: INTEG_LANES,
    ratioWindow: 30, ratioMinDays: 5, ratioDevWatch: 0.25, ratioDevAlert: 0.5,
    bookBracketWatch: 0.15, bookBracketAlert: 0.30, bookMaxAgeH: 48,
    artMinSales30: 3, quoteFreshH: 12, staleAlertFrac: 0.5,
    // volume lane. Thresholds MEASURED over the committed backtest history
    // (backtest/history/*.json — steam's own daily [t, price, sold] aggregates,
    // 49 items), running this exact rule: 103,518 eligible item-days across
    // 2,764 days since 2019 (137,951 / 4,590 days since 2014).
    //   volMoveWatch 0.10 — |return − the day's cross-sectional median return|.
    //     Sits at the 97.1st percentile of measured idiosyncratic daily moves
    //     (p90 0.051, p95 0.074, p99 0.176). volMoveAlert 0.20 = 99.2nd pct.
    //   volRespWatch −0.5 — the item's log volume response (today vs its own
    //     trailing median) MINUS the day's cross-sectional median response.
    //     Sits at the 1.4th percentile of the measured response distribution
    //     (p1 −0.552, p5 −0.318); volRespAlert −1.0 at the 0.16th.
    //     NEGATIVE by measurement, not by taste: the median volume response on
    //     a big-move day is only +0.04 log, so "volume did not rise" describes
    //     ~45% of honest big-move days and would be useless. What IS rare is a
    //     big move whose volume response collapses relative to the market.
    //   Joint flag rate: watch 0.111% of item-days (one every ~24 market-days
    //     across ~37 eligible names), alert 0.040% (one every ~67). The
    //     conjunction is also INFORMATIVE, not just rare: P(response ≤ −0.5 |
    //     move ≥ 0.10) = 3.9% vs 1.1% on calm days (3.7×); at the alert step
    //     5.1% vs 0.06% (80×). Worst measured day flagged 3 of ~37 names — the
    //     cross-sectional gate does keep a market-wide event from flagging all.
    //   volMinUnits 10 — the measured knee. Flag rate by baseline volume:
    //     2-5 units/day 1.20%, 5-10 1.06%, 10-25 0.15%, 25-100 0.11%, 100+
    //     0.07%. Below ~10 units/day integer granularity dominates and the
    //     lane cries wolf; above it, cases and liquid skins behave alike
    //     (0.109% vs 0.219%) — which is why this lane needs NO unique-item
    //     multiplier, unlike the venue and book lanes.
    //   volMinDays 5 — matches ratioMinDays; measured to be immaterial once
    //     volMinUnits is in force (0.089% at minDays 5 vs 0.087% at 10).
    //   volMinNames 3 — no cross-sectional median from fewer than 3 gated
    //     names, borrowed from INDEX_RULES.minContributors rather than
    //     measured separately.
    // HONEST LIMIT: the measurement basis is steam's calendar-day sold counts,
    // while the live lane reads trailing-24h priceoverview snapshots bucketed
    // per day (volMode "max") — a smoother series, so these rates are an upper
    // bound on live false positives. Re-measure once the live series is deep.
    volWindow: 30, volMinDays: 5, volMinUnits: 10, volMinNames: 3,
    volMoveWatch: 0.10, volMoveAlert: 0.20,
    volRespWatch: -0.5, volRespAlert: -1.0,
    // venue lane (third-venue corroboration). Thresholds MIRROR the ratio
    // lane — same median-relative log deviation, same watch/alert steps —
    // because it is the same kind of measurement against a different second
    // read path. Measured against live venue data on 2026-07-27 (55 tracked
    // non-art names × market.csgo + waxpeer) these produced 0 and 1 flags
    // respectively: wide enough not to cry wolf, tight enough that a 30%+
    // single-name divergence is published the day it appears.
    venueDevWatch: 0.25, venueDevAlert: 0.5, venueUniqueMult: 1.6,
    venueMinQuotes: 5, venueMaxAgeH: 48,
    // venue-book lane (third-venue standing BIDS). Deliberately NOT copied
    // from the venue lane's ask thresholds: a bid book thins out for honest
    // reasons an ask book does not, so the ask distribution is not evidence
    // about this one, and coverage (6 mapped BUFF ids) is far too thin to fit
    // a distribution of its own. PROVISIONAL and wide — the lane's job today
    // is to CORROBORATE (independent capital stands near the mark) and to
    // catch only gross divergence. Tighten when the readings accrue, and
    // publish the measurement the way the volume lane did.
    //   vbookMinOrders 3 — one buy order is a person, not a book.
    //   CASE-ONLY, exactly like the book lane and for the reason that lane
    //   learned live on 2026-07-26: buy orders on unique items target
    //   specific floats/patterns and sit legitimately far from a bucketed
    //   steam median (a $42 Redline mark vs a $197 variant bid). Six false
    //   alerts bought that rule; it is not being re-learned here.
    vbookDevWatch: 0.35, vbookDevAlert: 0.6, vbookProvisional: true,
    vbookMinQuotes: 5, vbookMinOrders: 3, vbookMaxAgeH: 48,
  };
  function medianOf(vals) {
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // items: [{ name, cat, tier, steamPrice, quoteT, salesT, sales30,
  //           ratioDays: [{day, r}], book: {t,bid,ask,mid,...}|null,
  //           volDays: [{day, price, vol}] | null,
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
    // Per-lane coverage as NAME SETS, so the tiered summary can answer "how
    // many distinct marks does STRONG evidence actually cover" without adding
    // weak agreement to strong agreement.
    const cover = {};
    const laneOf = (lane) => (cover[lane] || (cover[lane] = { eligible: new Set(), corroborated: new Set() }));
    const raise = (f) => {
      const L = R.lanes[f.lane];
      f.strength = L ? L.strength : null;   // every flag says how hard its evidence is to fake
      flags.push(f);
      return f;
    };
    // ratio lane: per-item deviation from OWN baseline, then market-gated
    const devs = [];
    for (const it of items || []) {
      if (it.tier === "art") continue;
      laneOf("ratio").eligible.add(it.name);
      const rd = (it.ratioDays || []).filter((d) => d && d.r > 0).slice(-(R.ratioWindow + 1));
      if (rd.length < R.ratioMinDays + 1) continue;
      const base = medianOf(rd.slice(0, -1).map((d) => d.r));
      const last = rd[rd.length - 1].r;
      if (!(base > 0) || !(last > 0)) continue;
      devs.push({ it: it, d: Math.log(last / base) });
      laneOf("ratio").corroborated.add(it.name);
    }
    const xMed = medianOf(devs.map((x) => x.d)) || 0; // market-move gate
    for (const x of devs) {
      const e = x.d - xMed;
      if (Math.abs(e) >= R.ratioDevWatch) {
        raise({ name: x.it.name, lane: "ratio", severity: Math.abs(e) >= R.ratioDevAlert ? "alert" : "watch",
          dev: r3(e), detail: e < 0 ? "steam-rich vs its own cash-ratio baseline" : "steam-lean vs its own cash-ratio baseline (or skinport leg moved)" });
      }
    }
    // ── volume lane: did the trade follow the price? ───────────────────────
    // STRONG evidence (see INTEG_LANES): steam's sold-per-day is realized
    // trade, and the only way to manufacture it is to pay ~15% per unit.
    // Construction mirrors the ratio lane exactly — each item against its OWN
    // trailing baseline, then gated on the day's CROSS-SECTIONAL median so a
    // market-wide volume surge (or drought) flags nobody.
    //   move  = ln(price_t / price_{t−1}) − the day's median of the same
    //   resp  = ln((vol_t + 1) / (baseline + 1)) − the day's median of the same
    //           (+1 smoothing so a zero-volume day is defined, not dropped:
    //            "absent volume" is precisely the case worth flagging)
    // FLAG = a significant idiosyncratic move whose volume response collapsed
    // relative to the market. Thresholds and their measured basis live in
    // INTEG_RULES above. FLAG-ONLY, like every other lane.
    const volPanel = [];
    let volPanelDay = null, volSkippedStale = 0;
    for (const it of items || []) {
      if (it.tier === "art") continue;
      laneOf("volume").eligible.add(it.name);
      const vd = (it.volDays || []).filter((d) => d && d.price > 0);
      if (vd.length < 2) continue;
      const cur = vd[vd.length - 1], prev = vd[vd.length - 2];
      if (cur.vol == null || !isFinite(cur.vol)) continue;
      // a true DAILY return only: a gap means the move is multi-day and the
      // volume comparison would be against the wrong denominator
      if (Math.round((Date.parse(cur.day) - Date.parse(prev.day)) / 86400000) !== 1) continue;
      const win = vd.slice(Math.max(0, vd.length - 1 - R.volWindow), vd.length - 1)
        .filter((d) => d.vol != null && isFinite(d.vol));
      if (win.length < R.volMinDays) continue;
      const base = medianOf(win.map((d) => d.vol));
      if (!(base >= R.volMinUnits)) continue;   // thin tape is noise, not evidence
      volPanel.push({ it: it, day: cur.day, vol: cur.vol, base: base,
        move: Math.log(cur.price / prev.price),
        resp: Math.log((cur.vol + 1) / (base + 1)) });
      if (volPanelDay == null || cur.day > volPanelDay) volPanelDay = cur.day;
    }
    // one panel day only — an item whose last marked day is older is published
    // as skipped, never compared against a fresher cross-section
    const volDayPanel = volPanel.filter((p) => {
      if (p.day === volPanelDay) return true;
      volSkippedStale++;
      return false;
    });
    const volReport = { day: volPanelDay, checked: volDayPanel.length + "/" + laneOf("volume").eligible.size,
      status: "insufficient", reason: null, medianMove: null, medianResponse: null,
      staleSkipped: volSkippedStale, watch: 0, alert: 0 };
    if (volDayPanel.length < R.volMinNames) {
      volReport.reason = volDayPanel.length + " names with a gated volume baseline"
        + (volDayPanel.length ? ", below volMinNames " + R.volMinNames
          : " (a name needs " + R.volMinDays + " prior daily marks and a ≥" + R.volMinUnits
            + " units/day baseline)")
        + " — coverage published, no flags raised";
      if (!volDayPanel.length) volReport.status = "no-data";
    } else {
      volReport.status = "ok";
      const mMove = medianOf(volDayPanel.map((p) => p.move));
      const mResp = medianOf(volDayPanel.map((p) => p.resp));
      volReport.medianMove = r3(mMove);
      volReport.medianResponse = r3(mResp);
      for (const p of volDayPanel) {
        laneOf("volume").corroborated.add(p.it.name);
        const move = p.move - mMove, resp = p.resp - mResp;
        if (Math.abs(move) < R.volMoveWatch || resp > R.volRespWatch) continue;
        const sev = Math.abs(move) >= R.volMoveAlert && resp <= R.volRespAlert ? "alert" : "watch";
        if (sev === "alert") volReport.alert++; else volReport.watch++;
        raise({ name: p.it.name, lane: "volume", severity: sev, dev: r3(resp), move: r3(move),
          vol: p.vol, volBaseline: p.base, day: p.day,
          detail: (move > 0 ? "+" : "") + Math.round(move * 1000) / 10 + "% idiosyncratic price move on "
            + p.vol + " units vs a " + p.base + "/day baseline — volume response " + r3(Math.abs(resp))
            + " log BELOW the market's (a price move the tape did not confirm)" });
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
    for (const it of items || []) {
      const b = it.book;
      if (it.tier === "art" || it.cat !== "case" || it.steamPrice == null) continue;
      laneOf("book").eligible.add(it.name);
      if (!b || b.bid == null || b.ask == null || (now && now - b.t > R.bookMaxAgeH * 3600000)) continue;
      laneOf("book").corroborated.add(it.name);
      const hi = b.ask * (1 + R.bookBracketWatch), lo = b.bid * (1 - R.bookBracketWatch);
      if (it.steamPrice > hi || it.steamPrice < lo) {
        const over = it.steamPrice > hi;
        const margin = over ? it.steamPrice / b.ask - 1 : 1 - it.steamPrice / b.bid;
        raise({ name: it.name, lane: "book", severity: margin >= R.bookBracketAlert ? "alert" : "watch",
          dev: r3(margin), detail: over ? "last-sale median above the standing ask wall" : "last-sale median below the standing bid wall" });
      }
    }
    // art evidence lane: appraisal marks need visible sales
    for (const it of items || []) {
      if (it.tier !== "art") continue;
      laneOf("art-evidence").eligible.add(it.name);
      if (it.sales30 == null) continue; // unknown ≠ thin — never fabricate
      if (it.sales30 >= R.artMinSales30) laneOf("art-evidence").corroborated.add(it.name);
      else raise({ name: it.name, lane: "art-evidence", severity: "watch",
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
      raise({ name: "(market)", lane: "staleness", severity: "alert", dev: r3(steamFresh / steamExpected),
        detail: "only " + steamFresh + "/" + steamExpected + " items have a fresh steam quote — possible venue loss" });
    }
    // venue lane: third-venue corroboration (see the header note). FLAG-ONLY
    // like every other lane — a divergence here never removes a mark, never
    // reroutes the index and never touches a fixing. That is not politeness:
    // third venues are THINNER than Steam, so auto-rejection would let an
    // attacker knock honest marks out of the index by moving the cheaper
    // market. Detection is published; consumers decide their own halt rules.
    //
    // WEAK-TIER SINCE 2026-07-27: these venues publish ASKS, which cost
    // nothing to post, so an attacker pumping steam can list matching asks on
    // every one of them for free. Agreement here is therefore NOT counted as
    // corroboration anywhere in the summary — the row publishes `checked` (how
    // many marks the venue was actually gated against) and `agreed` (how many
    // of those did not diverge) so the evidence is visible, not silently
    // dropped, and `counts:false` says plainly that it buys no coverage.
    // Divergence is unaffected: the watch/alert thresholds and every flag
    // below are exactly as they were.
    const vRoster = opts.venues || [];
    const vEligible = (items || []).filter((it) => it.tier !== "art" && it.steamPrice > 0);
    const vCheckedItems = new Set(), vDivergedItems = new Set();
    let venuesAnswered = 0;
    const venueReport = [];
    for (const it of vEligible) laneOf("venue").eligible.add(it.name);
    for (const v of vRoster) {
      const row = { id: v.id, label: v.label || v.id, kind: v.kind || null, ccy: v.ccy || null,
        mode: v.mode || null, status: "unavailable", reason: v.reason || null,
        strength: R.lanes.venue.strength, counts: R.lanes.venue.counts,
        checked: "0/" + vEligible.length, agreed: null, medianRatio: null, watch: 0, alert: 0,
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
      row.checked = pairs.length + "/" + vEligible.length;
      if (pairs.length < R.venueMinQuotes) {
        // agreed stays null: a venue that was never gated on evaluated no
        // agreement, and "0/0" would read as "nothing agreed"
        // too few names to trust a cross-sectional median — publish the
        // coverage, raise nothing (the ratioMinDays discipline)
        row.status = pairs.length ? "insufficient" : "no-quotes";
        row.reason = row.reason || (pairs.length + " fresh quotes, below venueMinQuotes "
          + R.venueMinQuotes + " — coverage published, no flags raised");
        venueReport.push(row);
        continue;
      }
      row.status = "ok";
      // only a venue that actually got EVALUATED enters the checked set —
      // quotes a venue held but could not be gated on stay in its own row.
      // (Checked is NOT corroborated: see the weak-tier note above.)
      for (const p of pairs) vCheckedItems.add(p.it.name);
      const vMed = medianOf(pairs.map((p) => p.lr));
      row.medianRatio = r3(Math.exp(vMed));
      let diverged = 0;
      for (const p of pairs) {
        const e = p.lr - vMed;
        const mult = p.it.cat === "case" ? 1 : R.venueUniqueMult;
        if (Math.abs(e) < R.venueDevWatch * mult) continue;
        const sev = Math.abs(e) >= R.venueDevAlert * mult ? "alert" : "watch";
        if (sev === "alert") row.alert++; else row.watch++;
        diverged++;
        vDivergedItems.add(p.it.name);
        raise({ name: p.it.name, lane: "venue", venue: v.id, severity: sev,
          dev: r3(e), ratio: r3(Math.exp(p.lr)), venueMedianRatio: row.medianRatio,
          steamPrice: p.it.steamPrice, venuePrice: p.q.price,
          detail: (e < 0 ? "steam-rich" : "steam-lean") + " vs " + (v.label || v.id)
            + " (" + (v.kind || "quote") + " " + p.q.price + " vs steam " + p.it.steamPrice
            + " = " + r3(Math.exp(p.lr)) + "×, venue median " + row.medianRatio + "×)" });
      }
      row.agreed = (pairs.length - diverged) + "/" + pairs.length;
      venueReport.push(row);
    }

    // ── venue-book lane: third-venue standing BIDS (medium tier) ───────────
    // The venue lane above reads ASKS, which cost nothing to post and so buy
    // no corroboration. The SAME public read carries the best standing BUY
    // order, and a bid is a different animal: it is money offered, exposed to
    // being hit. That earns the medium tier — the same tier as the steam book
    // lane, with one property the steam book lane cannot have: the capital is
    // INDEPENDENT of the venue being checked. Steam's order book and steam's
    // price are one venue, so an attacker who can wash the mark can post the
    // supporting bids too. A BUFF bid is somebody else's yuan.
    //
    // MEDIAN-RELATIVE, like the venue lane and for the same reason: BUFF sits
    // at a structural discount to steam that moves with FX and sentiment, so
    // a level test would flag the whole market whenever the discount shifted.
    // The gate is each item's bid/mark ratio against the DAY'S median ratio.
    // CASE-ONLY, like the book lane — buy orders on unique items target
    // specific floats and patterns and sit legitimately far from a bucketed
    // steam median (the 2026-07-26 lesson: a $42 Redline mark against a $197
    // variant bid, six false alerts). Thresholds are PROVISIONAL and wide.
    const vbEligible = (items || []).filter((it) => it.tier !== "art" && it.cat === "case" && it.steamPrice > 0);
    for (const it of vbEligible) laneOf("venue-book").eligible.add(it.name);
    const vbReport = [];
    for (const v of vRoster) {
      const row = { id: v.id, label: v.label || v.id, status: "unavailable",
        strength: R.lanes["venue-book"].strength, counts: R.lanes["venue-book"].counts,
        provisional: !!R.vbookProvisional,
        checked: "0/" + vbEligible.length, corroborated: null, medianRatio: null,
        watch: 0, alert: 0, reason: v.ok ? null : (v.reason || "venue unavailable") };
      if (!v.ok) { vbReport.push(row); continue; }
      const pairs = [];
      for (const it of vbEligible) {
        const q = it.venues ? it.venues[v.id] : null;
        // a venue that publishes no bid is not a failure of this lane — it
        // simply is not a bid venue. Absence is coverage, never agreement.
        if (!q || !(q.bid > 0)) continue;
        if (now && q.t != null && now - q.t > R.vbookMaxAgeH * 3600000) continue;
        // one buy order is a person, not a book
        if (q.bidQty != null && q.bidQty < R.vbookMinOrders) continue;
        pairs.push({ it: it, q: q, lr: Math.log(q.bid / it.steamPrice) });
      }
      row.checked = pairs.length + "/" + vbEligible.length;
      if (pairs.length < R.vbookMinQuotes) {
        row.status = pairs.length ? "insufficient" : "no-bids";
        row.reason = row.reason || (pairs.length + " fresh bid books, below vbookMinQuotes "
          + R.vbookMinQuotes + " — coverage published, nothing corroborated, no flags raised");
        vbReport.push(row);
        continue;
      }
      row.status = "ok";
      const vbMed = medianOf(pairs.map((p) => p.lr));
      row.medianRatio = r3(Math.exp(vbMed));
      let diverged = 0;
      for (const p of pairs) {
        const e = p.lr - vbMed;
        if (Math.abs(e) < R.vbookDevWatch) {
          // corroborated: independent capital stands where the mark says it should
          laneOf("venue-book").corroborated.add(p.it.name);
          continue;
        }
        const sev = Math.abs(e) >= R.vbookDevAlert ? "alert" : "watch";
        if (sev === "alert") row.alert++; else row.watch++;
        diverged++;
        raise({ name: p.it.name, lane: "venue-book", venue: v.id, severity: sev,
          dev: r3(e), ratio: r3(Math.exp(p.lr)), venueMedianRatio: row.medianRatio,
          steamPrice: p.it.steamPrice, venueBid: p.q.bid, bidOrders: p.q.bidQty,
          detail: (e < 0 ? "bid support fell away under the mark" : "bid support stands unusually high under the mark")
            + " on " + (v.label || v.id) + " (best bid " + p.q.bid + " vs steam " + p.it.steamPrice
            + " = " + r3(Math.exp(p.lr)) + "×, venue median " + row.medianRatio + "×, "
            + (p.q.bidQty != null ? p.q.bidQty + " standing buy orders" : "order count unknown") + ")" });
      }
      row.corroborated = (pairs.length - diverged) + "/" + pairs.length;
      vbReport.push(row);
    }

    // ── coverage BY EVIDENCE TIER ──────────────────────────────────────────
    // The whole point of the 2026-07-27 revision: never add weak agreement to
    // strong agreement as one number. Each tier reports the DISTINCT marks its
    // lanes actually covered, over the union of names those lanes were
    // eligible for. The weak tier reports its coverage too — as `checked` /
    // `agreed`, with counted:false and countedItems:0, so it is visible and
    // unmistakably not corroboration.
    const cnt = (lane) => (cover[lane]
      ? cover[lane].corroborated.size + "/" + cover[lane].eligible.size : "0/0");
    const tier = (strength) => {
      const lanes = Object.keys(R.lanes).filter((k) => R.lanes[k].strength === strength && R.lanes[k].counts);
      const el = new Set(), co = new Set(), byLane = {};
      for (const k of lanes) {
        byLane[k] = cnt(k);
        if (!cover[k]) continue;
        cover[k].eligible.forEach((n) => el.add(n));
        cover[k].corroborated.forEach((n) => co.add(n));
      }
      return { counted: true, lanes: lanes, items: co.size + "/" + el.size, byLane: byLane };
    };
    const corroboration = {
      note: "grouped by how hard the evidence is to FAKE (INTEG_RULES.lanes). Tiers are never summed: "
        + "one strong-corroborated mark is not interchangeable with one weak-corroborated mark.",
      strong: tier("strong"),
      medium: tier("medium"),
      weak: {
        counted: false, countedItems: 0, lanes: ["venue"],
        checked: vCheckedItems.size + "/" + vEligible.length,
        agreed: (vCheckedItems.size - vDivergedItems.size) + "/" + vCheckedItems.size,
        venuesAnswered: venuesAnswered + "/" + vRoster.length,
        why: R.lanes.venue.asymmetry,
      },
    };
    return {
      version: R.version, revision: R.revision, t: now, rules: R,
      flags: flags, venues: venueReport, venueBook: vbReport, volume: volReport,
      summary: {
        itemsAssessed: (items || []).length,
        // per-lane strings (unchanged keys — the home rail and older readers
        // consume these); the tiered block below is the honest aggregate
        ratioCorroborated: cnt("ratio"),
        volumeCorroborated: cnt("volume"),
        bookCorroborated: cnt("book"),
        venueBookCorroborated: cnt("venue-book"),
        steamFresh: steamFresh + "/" + steamExpected,
        artEvidenced: cnt("art-evidence"),
        // WEAK tier: how many marks a third venue was gated against, and how
        // many venues answered at all. `venueChecked` replaced the old
        // `venueCorroborated` key deliberately — ask agreement is not
        // corroboration and the key name said otherwise.
        venueChecked: vCheckedItems.size + "/" + vEligible.length,
        venuesAnswered: venuesAnswered + "/" + vRoster.length,
        corroboration: corroboration,
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
