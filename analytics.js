// ─── skins/analytics.js — CS skin market analytics (pure functions) ────────
// Shared by skins/server.js (Node require) and skins/index.html (browser
// global `SkinAnalytics`). NO side effects, NO network, NO Math.random —
// every function is deterministic on its inputs, so the probe can pin exact
// values. All prices are USD numbers; all timestamps are ms epoch (UTC).
//
// Series shapes:
//   point  = { t, price, vol }            one observation (vol may be null)
//   daily  = { day:"YYYY-MM-DD", t, price, vol }   one bucket per UTC day
//
// NOT FINANCIAL ADVICE: signal() is a transparent heuristic — every point of
// its score is itemized in `reasons` so the user can judge the inputs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SkinAnalytics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── money parsing ────────────────────────────────────────────────────────
  // Steam returns localized strings ("$43.80", "43,80€", "1,234.56 USD").
  function parseMoney(s) {
    if (typeof s === "number") return isFinite(s) ? s : null;
    if (typeof s !== "string") return null;
    let t = s.replace(/[^0-9.,-]/g, "");
    if (!t) return null;
    const lastDot = t.lastIndexOf("."), lastCom = t.lastIndexOf(",");
    if (lastCom > lastDot) {
      // Trailing comma group of exactly 3 digits reads as a THOUSANDS
      // separator ("31,263" = 31263); any other width is an EU decimal
      // ("43,80" = 43.80). Steam's en-US volume strings hit the first case.
      if (t.length - lastCom - 1 === 3) t = t.replace(/[.,]/g, "");
      else t = t.replace(/\./g, "").replace(",", ".");
    } else {
      t = t.replace(/,/g, "");
    }
    const v = parseFloat(t);
    return isFinite(v) ? v : null;
  }

  // Unit counts (sales volume): digits only, never a decimal.
  function parseCount(s) {
    if (typeof s === "number") return isFinite(s) ? Math.round(s) : null;
    if (typeof s !== "string") return null;
    const t = s.replace(/[^0-9]/g, "");
    return t ? parseInt(t, 10) : null;
  }

  function dayKey(t) {
    const d = new Date(t);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
  }

  // Display-layer deep-history merge (item view ONLY — never the index).
  // Backtest-fetched rows may extend an item's series strictly BEFORE its
  // first collected/imported day: they never override a collected mark, and
  // they must never reach marketOverview/the collector — the live index
  // starts at its adoption date and is never backfilled (a silent rebase
  // would change every fixing). Returns the merged base-rows array to pass
  // as assembleSeries' imported side.
  function deepHistoryBase(deepRows, importRows, snapRows) {
    let firstT = Infinity;
    for (const r of importRows || []) if (r && r.t < firstT) firstT = r.t;
    for (const r of snapRows || []) if (r && r.t < firstT) firstT = r.t;
    const cutDay = isFinite(firstT) ? dayKey(firstT) : null;
    return (deepRows || []).filter((r) => r && (!cutDay || dayKey(r.t) < cutDay))
      .concat(importRows || []);
  }

  function median(vals) {
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Weight-weighted median of [value, weight] pairs. Reduces EXACTLY to the
  // plain median when all weights are equal (so equal-weight paths are
  // unchanged): the value where cumulative weight reaches half the total; if
  // the partition falls exactly between two values, their average.
  function weightedMedian(pairs) {
    if (!pairs.length) return null;
    const s = pairs.slice().sort((a, b) => a[0] - b[0]);
    const W = s.reduce((a, p) => a + p[1], 0);
    if (!(W > 0)) return median(s.map((p) => p[0]));
    const half = W / 2;
    let cum = 0;
    for (let i = 0; i < s.length; i++) {
      cum += s[i][1];
      if (Math.abs(cum - half) <= 1e-12) return (s[i][0] + (i + 1 < s.length ? s[i + 1][0] : s[i][0])) / 2;
      if (cum > half) return s[i][0];
    }
    return s[s.length - 1][0];
  }

  // ── daily bucketing ──────────────────────────────────────────────────────
  // points → one bucket per UTC day. price = median of the day's readings.
  // volMode:
  //   "sum" — entries are per-interval sales counts (Steam price history:
  //           old rows daily, recent rows hourly → summing is correct)
  //   "max" — entries are trailing-24h readings (priceoverview snapshots:
  //           summing would double-count; max is the best daily estimate)
  function toDaily(points, opts) {
    const volMode = (opts && opts.volMode) || "sum";
    const buckets = new Map();
    for (const p of points || []) {
      if (!p || !isFinite(p.t) || !isFinite(p.price) || p.price <= 0) continue;
      const k = dayKey(p.t);
      let b = buckets.get(k);
      if (!b) { b = { day: k, t: 0, prices: [], vol: null }; buckets.set(k, b); }
      b.t = Math.max(b.t, p.t);
      b.prices.push(p.price);
      const v = p.vol == null ? null : Number(p.vol);
      if (v != null && isFinite(v)) {
        if (b.vol == null) b.vol = v;
        else b.vol = volMode === "max" ? Math.max(b.vol, v) : b.vol + v;
      }
    }
    return Array.from(buckets.values())
      .map((b) => ({ day: b.day, t: b.t, price: round2(median(b.prices)), vol: b.vol }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // One canonical assembly from raw stored records → chartable series.
  // Used IDENTICALLY by the tracker server, the Actions collector, and the
  // browser's static mode — so every surface derives the same numbers.
  //   importRows: [{t,price,vol}] from a Steam pricehistory import (per-
  //               interval volumes → summed per day)
  //   snapLines:  [{t,src:"steam"|"skinport",price,vol,...}] snapshot log
  //               (trailing-24h volumes → max per day)
  // Import wins day collisions (richer, official medians).
  function assembleSeries(importRows, snapLines) {
    const importDaily = toDaily(importRows || [], { volMode: "sum" });
    const snaps = (snapLines || []).filter((s) => s && isFinite(s.t));
    const steamDaily = toDaily(snaps.filter((s) => s.src === "steam"), { volMode: "max" });
    const skinportDaily = toDaily(snaps.filter((s) => s.src === "skinport"), { volMode: "max" });
    return { daily: mergeDaily(importDaily, steamDaily), skinportDaily: skinportDaily };
  }

  // Merge daily series; on a day collision the EARLIER argument wins
  // (call as mergeDaily(richSource, fallbackSource)).
  function mergeDaily(primary, secondary) {
    const seen = new Map();
    for (const d of primary || []) seen.set(d.day, d);
    for (const d of secondary || []) if (!seen.has(d.day)) seen.set(d.day, d);
    return Array.from(seen.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }

  // ── indicators ───────────────────────────────────────────────────────────
  function sma(vals, n) {
    if (!vals.length || n <= 0) return null;
    const w = vals.slice(-n);
    return w.reduce((a, b) => a + b, 0) / w.length;
  }

  // Full SMA overlay track (null until n points exist) — for charting.
  function smaTrack(vals, n) {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(vals, n) {
    if (vals.length < n || n <= 0) return null;
    const k = 2 / (n + 1);
    let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n; // SMA seed
    for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
    return e;
  }

  // Wilder RSI. All-gains series → 100; all-losses → 0.
  function rsi(vals, n) {
    n = n || 14;
    if (vals.length < n + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = vals[i] - vals[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    for (let i = n + 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1];
      gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
      loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  function logReturns(prices) {
    const out = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > 0 && prices[i - 1] > 0) out.push(Math.log(prices[i] / prices[i - 1]));
    }
    return out;
  }

  // Annualized volatility (σ of daily log returns × √365), as a FRACTION
  // (0.5 = 50%/yr). Constant series → 0.
  function volAnnualized(prices) {
    const r = logReturns(prices);
    if (r.length < 2) return null;
    const mu = r.reduce((a, b) => a + b, 0) / r.length;
    const varr = r.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (r.length - 1);
    return Math.sqrt(varr) * Math.sqrt(365);
  }

  // Max peak-to-trough drawdown over the series, as a FRACTION of the peak.
  function maxDrawdown(prices) {
    let peak = -Infinity, dd = 0, peakIdx = -1, curPeakIdx = -1, troughIdx = -1;
    for (let i = 0; i < prices.length; i++) {
      if (prices[i] > peak) { peak = prices[i]; curPeakIdx = i; }
      const d = (peak - prices[i]) / peak;
      if (d > dd) { dd = d; peakIdx = curPeakIdx; troughIdx = i; }
    }
    return { dd: dd, peakIdx: peakIdx, troughIdx: troughIdx };
  }

  // Drawdown from the ALL-TIME peak to the LATEST price.
  function currentDrawdown(prices) {
    if (!prices.length) return null;
    const peak = Math.max.apply(null, prices);
    return (peak - prices[prices.length - 1]) / peak;
  }

  // OLS slope of log(price) on day index over the trailing window →
  // fractional %/day (0.01 = +1%/day). Needs ≥5 points.
  function trendSlope(daily, windowDays) {
    const w = daily.slice(-(windowDays || 30)).filter((d) => d.price > 0);
    if (w.length < 5) return null;
    const n = w.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const y = Math.log(w[i].price);
      sx += i; sy += y; sxx += i * i; sxy += i * y;
    }
    const denom = n * sxx - sx * sx;
    if (!denom) return null;
    const b = (n * sxy - sx * sy) / denom; // log-units per day
    return Math.exp(b) - 1;
  }

  // % change vs the closest daily point at least `days` before the latest.
  function momentum(daily, days) {
    if (daily.length < 2) return null;
    const last = daily[daily.length - 1];
    const cutoff = last.t - days * 86400000;
    let base = null;
    for (let i = daily.length - 2; i >= 0; i--) {
      base = daily[i];
      if (daily[i].t <= cutoff) break;
    }
    if (!base || base.price <= 0) return null;
    return (last.price - base.price) / base.price;
  }

  // Median daily units sold over the trailing window (null-vol days skipped).
  function liquidity(daily, windowDays) {
    const w = daily.slice(-(windowDays || 30)).map((d) => d.vol).filter((v) => v != null);
    return w.length ? median(w) : null;
  }

  // ── marketplace fees ─────────────────────────────────────────────────────
  // Steam: buyer pays P, seller receives P/1.15 (5% Steam + 10% CS), and the
  // proceeds are WALLET-LOCKED (never cash). Skinport: ~12% seller fee, cash.
  const FEES = { steam: { div: 1.15, cash: false }, skinport: { rate: 0.12, cash: true } };
  function netProceeds(price, market) {
    if (price == null || !isFinite(price)) return null;
    if (market === "steam") return round2(price / FEES.steam.div);
    if (market === "skinport") return round2(price * (1 - FEES.skinport.rate));
    return null;
  }

  // ── composite signal ─────────────────────────────────────────────────────
  // Transparent additive score in roughly [-100, 100]; every contribution is
  // pushed to `reasons`. A heuristic to organize the numbers — not advice.
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function signal(m) {
    // m = { mom7, mom30, slope30, rsi14, curDD, vol30, liq30 } (nullables)
    let score = 0;
    const reasons = [];
    const add = (pts, why) => { score += pts; reasons.push((pts >= 0 ? "+" : "") + Math.round(pts) + " " + why); };
    if (m.mom30 != null) add(clamp(m.mom30 * 100, -30, 30) * 1.1, "30d momentum " + pct(m.mom30));
    if (m.slope30 != null) add(clamp(m.slope30 * 100 * 300, -25, 25) / 10, "30d trend " + pct(m.slope30) + "/day");
    if (m.rsi14 != null) {
      if (m.rsi14 >= 75) add(-15, "RSI " + Math.round(m.rsi14) + " overbought");
      else if (m.rsi14 <= 30) add(12, "RSI " + Math.round(m.rsi14) + " oversold");
    }
    if (m.curDD != null && m.curDD > 0.25 && m.mom7 != null && m.mom7 > 0)
      add(10, "recovering, " + pct(m.curDD) + " below peak");
    if (m.curDD != null && m.curDD < 0.03 && m.rsi14 != null && m.rsi14 > 70)
      add(-8, "at highs and hot");
    if (m.vol30 != null && m.vol30 > 1.0) add(-10, "high volatility " + pct(m.vol30) + "/yr");
    if (m.liq30 != null && m.liq30 < 3) { score *= 0.6; reasons.push("×0.6 illiquid (~" + m.liq30 + "/day)"); }
    score = clamp(score, -100, 100);
    const verdict = score >= 30 ? "STRONG BUY" : score >= 12 ? "BUY"
      : score > -12 ? "HOLD" : score > -30 ? "SELL" : "STRONG SELL";
    return { score: Math.round(score), verdict: verdict, reasons: reasons };
  }
  function pct(v) { return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%"; }

  // ── full report over a daily series ──────────────────────────────────────
  function analyze(daily) {
    const prices = daily.map((d) => d.price);
    const last = daily.length ? daily[daily.length - 1] : null;
    const m = {
      days: daily.length,
      latest: last ? last.price : null,
      latestDay: last ? last.day : null,
      sma7: round2(sma(prices, 7)),
      sma30: round2(sma(prices, 30)),
      mom7: momentum(daily, 7),
      mom30: momentum(daily, 30),
      mom90: momentum(daily, 90),
      slope30: trendSlope(daily, 30),
      rsi14: rsi(prices.slice(-90), 14),
      vol30: volAnnualized(prices.slice(-31)),
      curDD: currentDrawdown(prices),
      maxDD: maxDrawdown(prices).dd,
      liq30: liquidity(daily, 30),
    };
    m.signal = signal(m);
    return m;
  }

  // ── market overview (the CoinGecko-style header numbers) ─────────────────
  // items: [{name, cat, daily, skinportDaily}] (daily from assembleSeries).
  // Returns { series:[{day,t,caseIdx,cashRatio,volTotal}], today:{...} }.
  //   caseIdx   — the Skindex: geometric mean of each CASE's price
  //               relative to its own first recorded day, ×100. Cases are
  //               the market's commodity layer — this is the "S&P of skins".
  //               (Known limit: an item added later enters at rel=1, which
  //               slightly dilutes the level; fine for a personal index.)
  //   cashRatio — median (third-party realized price ÷ steam price) across
  //               items with both legs that day. ~0.7–0.85 is normal; rising
  //               toward 1 = strong real-money demand.
  //   volTotal  — total steam units sold/day across the tracked set.
  // ── SMLX-2 index construction: CHAINED daily returns ─────────────────────
  // Items bucket into three families:
  //   case — cat "case" (commodity layer; live Steam marks)
  //   liq  — everything else with real Steam liquidity (≥5 median sold/day)
  //   art  — tier:"art" grails, marked to artDaily (Skinport 30d medians,
  //          carried forward — appraisal-style)
  // Each family's index CHAINS: the day's return is the mean of log-returns
  // of constituents present (and included) on BOTH days, cumulated from 100.
  // WINSORIZED (SMLX-3): each constituent's deviation from the day's
  // cross-sectional MEDIAN return is clamped to ±clampLog (±0.05 ≈ ±5%) —
  // market-wide moves pass through in full (the median moves with them),
  // while a single-name outlier, honest or manipulated, has bounded
  // influence. Constituent changes are return-neutral at entry/exit — no
  // level jump to front-run. New listings (first mark after the adoption
  // date) season for 30 days, then enter on the FIRST DAY OF THE NEXT
  // CALENDAR MONTH; the founding cohort is grandfathered.
  // VOLUME-WEIGHTED (SMLX-4): case/liq family returns are a WEIGHTED mean —
  // weight = each name's MEDIAN daily dollar volume (price×units) over the
  // weightWindowDays ending on the LAST DAY OF THE PRIOR MONTH, normalized
  // and capped at weightCap (excess redistributed pro-rata; effective cap
  // is max(weightCap, 1/N) so small baskets stay feasible). Weights
  // rebalance MONTHLY and are fully lagged, so today's trading can never
  // move today's weights; the 60d MEDIAN means gaming a weight up needs
  // ~30+ days of sustained wash volume, paying fees the whole way — priced
  // by the budget model. Names without weightMinObs observations in the
  // window take the MEDIAN weight of observed names (absence is neutral);
  // a month with no observed names (index inception) is equal-weight. Art
  // has no volume by construction → always equal-weight. Net effect on the
  // attack surface: influence is proportional to real traded dollars, so
  // the cheapest concentrated attack must buy ≥ targetMove/clampLog of
  // total index WEIGHT — there is no thin-name cheap corner.
  // WEIGHTED-MEDIAN CLAMP CENTER (SMLX-5): the clamp is centered on the
  // WEIGHT-weighted median of the day's returns, not the unweighted one.
  // SMLX-4's unweighted center was a one-name-one-vote election: an attacker
  // holding a COUNT majority of thin names could pump them, drag the median
  // to the fake consensus (so the pump sits AT the center, unclamped), and
  // the clamp would then drag honest names TOWARD the fake move. Weighting
  // the center means seizing it costs a >50% WEIGHT coalition — real traded
  // dollars, the same expensive resource, priced by the budget's
  // centerCapture model. Under equal weights the weighted median reduces
  // EXACTLY to the plain median, so the inception month and all
  // equal-weight fallbacks are unchanged. A single name (capped at
  // weightCap 0.10) can never be >50% → no one name controls the center.
  // SMLX-6 — THE BACKTEST RELEASE (both rules found by reconstructing
  // 2013-2026 from Steam's own daily aggregates, not by live data):
  // 1. MARK-QUALITY FLOORS (CASE family only): (a) a constituent
  //    contributes a return only when BOTH day marks are ≥ minPrice
  //    ($0.25) — at penny prices one $0.01 tick is a 30-50% "return"
  //    (pure quantization noise; at $0.25 a tick is ≤4%, inside clamp
  //    scale); (b) a day's return applies only with ≥ minContributors (3)
  //    names, else the level CARRIES — on 1-2 name days the mover IS the
  //    weighted median, so the clamp can't fire and raw single-name moves
  //    pass through (the backtest's penny era showed -50% days ratcheting
  //    the index to zero this way). Art (appraisal marks, single-grail
  //    days normal) and liq (informational, not a fixing input) exempt.
  // 2. SEASONING 30d → 365d: the case lifecycle is the commodity-contango
  //    structure — measured decay: ann. log-return −1590% months 0-3,
  //    −36% months 3-12, then the SIGN FLIPS (+7% yr 2, +41% yr 4+; drop
  //    pool exit ≈ year one). 30d seasoning admitted cases mid-decay,
  //    and volume weights concentrate on exactly those high-volume new
  //    names → a structural short-tilt that compounded to −95% over the
  //    backtest while equal-weight gained +2000%. At 365d the tilt is
  //    gone (volume-weighted 4,446 vs equal 5,488 over 12y) and the
  //    weighted/equal choice is back to a manipulation-resistance
  //    decision, not a return bias. An item's supply-decay phase belongs
  //    to the item, not the market.
  // Today's live basket (42 grandfathered cases, all > $0.25, all
  // contributing) is unaffected — these rules change no current published
  // value; they close degenerate regimes and future-listing bias.
  const INDEX_RULES = { version: "SMLX-6", adoption: "2026-07-25", seasoningDays: 365, clampLog: 0.05,
    weightWindowDays: 60, weightMinObs: 5, weightCap: 0.10,
    minPrice: 0.25, minContributors: 3 };
  // ── SMLX-7 DRAFT PREVIEW (ADDITIVE — the shipped SMLX-6 fields above are
  // byte-identical; this subobject only DESCRIBES the preview). `marketIdx`
  // applies the EXACT SMLX-6 construction — chaining, ±clampLog
  // winsorization about the WEIGHT-weighted-median center, lagged monthly
  // volume weights capped at weightCap, 365d seasoning, and the
  // minPrice/minContributors mark-quality floors — over the COMBINED
  // case + liquids universe (the same self-gating liquids set liqIdx uses;
  // art stays out: appraisal marks). It is published for observation only
  // and is NOT in the settlement catalog: no fixing reads it, nothing
  // hashes it, and it carries the label below everywhere it surfaces.
  // Params are load-time copies of the SMLX-6 fields (one build can never
  // drift); centerToleranceLog is preview-only — the corroboration band
  // for |steam clamp center − Skinport realized-cash center| in log space
  // (see the centerCheck block in marketOverview: flag-only today).
  INDEX_RULES.marketPreview = {
    label: "SMLX-7 draft preview — NOT a settlement input",
    universe: "case+liq",
    seasoningDays: INDEX_RULES.seasoningDays, clampLog: INDEX_RULES.clampLog,
    weightWindowDays: INDEX_RULES.weightWindowDays, weightMinObs: INDEX_RULES.weightMinObs,
    weightCap: INDEX_RULES.weightCap, minPrice: INDEX_RULES.minPrice,
    minContributors: INDEX_RULES.minContributors,
    centerToleranceLog: 0.03,
  };
  function dayT(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  function includedFromDay(firstDay) {
    if (firstDay <= INDEX_RULES.adoption) return firstDay; // founding cohort
    const el = dayT(firstDay) + INDEX_RULES.seasoningDays * 86400000;
    const d = new Date(el);
    const inc = d.getUTCDate() === 1 ? el : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return dayKey(inc);
  }
  function marketOverview(items) {
    const dayRec = new Map();
    const rec = (day, t) => {
      let r = dayRec.get(day);
      if (!r) { r = { day: day, t: t || dayT(day), ratios: [], vol: 0, sawVol: false }; dayRec.set(day, r); }
      if (t) r.t = Math.max(r.t, t);
      return r;
    };
    const fam = { case: [], liq: [], art: [] };
    for (const it of items || []) {
      const daily = it.daily || [];
      const isArt = it.tier === "art";
      const key = isArt ? "art" : it.cat === "case" ? "case" : liquidity(daily, 30) >= 5 ? "liq" : null;
      const spBy = new Map((it.skinportDaily || []).map((d) => [d.day, d.price]));
      for (const d of daily) {
        const r = rec(d.day, d.t);
        if (d.vol != null) { r.vol += d.vol; r.sawVol = true; }
        const sp = spBy.get(d.day);
        if (sp != null && d.price > 0) r.ratios.push(sp / d.price);
      }
      if (isArt) for (const d of it.artDaily || []) rec(d.day, d.t);
      const src = isArt ? (it.artDaily || []) : daily;
      if (key && src.length) {
        const priceBy = new Map(src.filter((d) => d.price > 0).map((d) => [d.day, d.price]));
        const dvBy = new Map(src.filter((d) => d.price > 0 && d.vol != null && isFinite(d.vol))
          .map((d) => [d.day, d.price * d.vol]));
        if (priceBy.size) fam[key].push({ name: it.name, priceBy: priceBy, dvBy: dvBy,
          includedFrom: includedFromDay(src[0].day), carry: isArt,
          // Skinport realized-cash marks (day → price) — feeds ONLY the
          // SMLX-7 center-corroboration observation lane; no index level
          // reads these (art is excluded: it MARKS to skinport already).
          cashBy: isArt ? null : spBy });
      }
    }
    const days = Array.from(dayRec.keys()).sort();
    // art marks carry forward between observations (appraisal semantics)
    for (const m of fam.art) if (m.carry) {
      let last = null;
      const filled = new Map();
      for (const day of days) {
        const p = m.priceBy.get(day);
        if (p != null) last = p;
        if (last != null) filled.set(day, last);
      }
      m.priceBy = filled;
    }
    // SMLX-7 draft preview universe: the case family + the liquids family,
    // COMBINED (same member objects — inclusion calendars are identical;
    // monthWeights("mkt", …) recomputes weights over the union, so the cap
    // and the median-fallback see the full basket). Art stays out.
    fam.mkt = fam.case.concat(fam.liq);
    // SMLX-4 weights: per family, per calendar month — median daily $volume
    // over the window ending on the LAST DAY OF THE PRIOR MONTH, normalized,
    // capped at max(weightCap, 1/N) with pro-rata redistribution. Returns
    // null → equal weight (inception month, or a family with no volume: art).
    const wCache = new Map();
    function monthWeights(key, monthKey) {
      const ck = key + "|" + monthKey;
      if (wCache.has(ck)) return wCache.get(ck);
      const members = fam[key];
      let out = null;
      if (members.length) {
        const wEnd = Date.UTC(+monthKey.slice(0, 4), +monthKey.slice(5, 7) - 1, 1) - 86400000;
        const startKey = dayKey(wEnd - (INDEX_RULES.weightWindowDays - 1) * 86400000);
        const endKey = dayKey(wEnd);
        const raw = members.map((m) => {
          const dvs = [];
          for (const e of m.dvBy) if (e[0] >= startKey && e[0] <= endKey) dvs.push(e[1]);
          return dvs.length >= INDEX_RULES.weightMinObs ? median(dvs) : null;
        });
        const obs = raw.filter((v) => v != null);
        if (obs.length) {
          const fb = median(obs); // unobserved names take the median weight — neutral
          let w = raw.map((v) => (v != null ? v : fb));
          const total = w.reduce((a, b) => a + b, 0);
          if (total > 0) {
            w = w.map((v) => v / total);
            const cap = Math.max(INDEX_RULES.weightCap, 1 / members.length);
            for (let it = 0; it < 30; it++) {
              const over = w.map((v) => v > cap + 1e-12);
              if (!over.some(Boolean)) break;
              let excess = 0, freeSum = 0;
              w = w.map((v, j) => { if (over[j]) { excess += v - cap; return cap; } freeSum += v; return v; });
              if (freeSum <= 0) break;
              w = w.map((v, j) => (over[j] ? v : v + (v / freeSum) * excess));
            }
            out = new Map(members.map((m, j) => [m, w[j]]));
          }
        }
      }
      wCache.set(ck, out);
      return out;
    }
    const levels = { case: [], liq: [], art: [], mkt: [] };
    for (const key of ["case", "liq", "art", "mkt"]) {
      let level = null;
      for (let k = 0; k < days.length; k++) {
        const day = days[k];
        if (level == null) {
          const hasData = fam[key].some((m) => day >= m.includedFrom && m.priceBy.get(day) != null);
          if (hasData) level = 100;
          levels[key].push(level);
          continue;
        }
        const prev = days[k - 1];
        // SMLX-6 mark-quality floors: the settlement family, plus the
        // SMLX-7 combined preview (it rehearses the full settlement-grade
        // ruleset — floors included — per its published spec). liq/art
        // paths are byte-identical to pre-preview behavior.
        const strict = key === "case" || key === "mkt";
        const floor = strict ? INDEX_RULES.minPrice : 0;
        const contrib = []; // [member, log-return]
        for (const m of fam[key]) {
          if (prev < m.includedFrom) continue; // both days must be post-inclusion
          const p0 = m.priceBy.get(prev), p1 = m.priceBy.get(day);
          if (p0 > 0 && p1 > 0 && p0 >= floor && p1 >= floor) contrib.push([m, Math.log(p1 / p0)]);
        }
        if (contrib.length && (!strict || contrib.length >= INDEX_RULES.minContributors)) {
          const cl = INDEX_RULES.clampLog;
          const wm = monthWeights(key, day.slice(0, 7));
          // clamp center = WEIGHT-weighted median (SMLX-5): seizing the center
          // now costs a >50% weight coalition, not a count majority of thin
          // names (equal weights → reduces to the plain median, paths unchanged)
          const med = weightedMedian(contrib.map((c) => [c[1], wm ? wm.get(c[0]) : 1]));
          let wsum = 0, acc = 0, eqAcc = 0;
          for (const c of contrib) {
            const adjR = med + Math.max(-cl, Math.min(cl, c[1] - med));
            const w = wm ? wm.get(c[0]) : 1;
            wsum += w; acc += w * adjR; eqAcc += adjR;
          }
          level = level * Math.exp(wsum > 0 ? acc / wsum : eqAcc / contrib.length);
        }
        levels[key].push(level); // no overlap → level carries unchanged
      }
    }
    // publish the CURRENT month's weights per weighted family (audit surface;
    // the budget model consumes these so attack cost is priced on the real
    // weights, not an assumption)
    const weightsOut = { case: null, liq: null };
    if (days.length) for (const key of ["case", "liq"]) {
      if (!fam[key].length) continue;
      const wm = monthWeights(key, days[days.length - 1].slice(0, 7));
      const o = {};
      for (const m of fam[key]) o[m.name] = Math.round((wm ? wm.get(m) : 1 / fam[key].length) * 1e6) / 1e6;
      weightsOut[key] = o;
    }
    const series = days.map((day, k) => {
      const r = dayRec.get(day);
      return {
        day: day, t: r.t,
        caseIdx: levels.case[k] != null ? round2(levels.case[k]) : null,
        liqIdx: levels.liq[k] != null ? round2(levels.liq[k]) : null,
        artIdx: levels.art[k] != null ? round2(levels.art[k]) : null,
        cashRatio: r.ratios.length ? Math.round(median(r.ratios) * 1000) / 1000 : null,
        volTotal: r.sawVol ? r.vol : null,
        // ADDITIVE (SMLX-7 draft preview — NOT a settlement input): the
        // combined case+liquids index under the exact SMLX-6 rules. Key is
        // appended so every pre-existing key keeps its position/bytes.
        marketIdx: levels.mkt[k] != null ? round2(levels.mkt[k]) : null,
      };
    });
    const idx = series.filter((s) => s.caseIdx != null);
    const last = idx.length ? idx[idx.length - 1] : null;
    const prev = idx.length > 1 ? idx[idx.length - 2] : null;
    let back7 = null;
    if (last) for (let i = idx.length - 2; i >= 0; i--) { back7 = idx[i]; if (last.t - idx[i].t >= 7 * 86400000) break; }
    if (back7 && last.t - back7.t < 5 * 86400000) back7 = null; // too shallow to call it "7d"
    const lastNonNull = (k) => { for (let i = series.length - 1; i >= 0; i--) if (series[i][k] != null) return series[i][k]; return null; };
    // today exists whenever ANY series data exists — the cash ratio, volume,
    // and player count don't depend on cases being tracked
    const today = series.length ? {
      day: series[series.length - 1].day,
      caseIdx: last ? last.caseIdx : null,
      idx1: last && prev ? last.caseIdx / prev.caseIdx - 1 : null,
      idx7: last && back7 && back7 !== last ? last.caseIdx / back7.caseIdx - 1 : null,
      liqIdx: lastNonNull("liqIdx"), artIdx: lastNonNull("artIdx"),
      cashRatio: lastNonNull("cashRatio"), volTotal: lastNonNull("volTotal"),
      marketIdx: lastNonNull("marketIdx"), // SMLX-7 draft preview — NOT a settlement input
    } : null;
    // ── SMLX-7 CENTER-CORROBORATION LANE (observation phase, flag-only) ────
    // Per day, the clamp center the combined-universe preview actually used
    // (WEIGHT-weighted median of the steam-mark log-returns) is corroborated
    // against the center implied by Skinport REALIZED-CASH returns — the
    // SAME weighted-median construction, same lagged monthly weights, over
    // the names with sales data on both days (≥ minContributors names on
    // each side, ≥ minPrice marks, post-inclusion — else the day is not an
    // observation). |steamCenter − cashCenter| > centerToleranceLog (0.03
    // log) publishes a flag row in the INTEG-1 shape (flag, NEVER reject —
    // rejection would hand the thin venue a lever, same reasoning as
    // assessIntegrity). This is the observation phase for the future SMLX-7
    // hardening (the center must corroborate or the day carries); the
    // running counts of days observed vs days the rule WOULD have bound are
    // published per collector run so the hardening decision is evidence-
    // based. Note what the ratio lane CANNOT see and this lane CAN: a
    // market-wide steam pump moves every name's ratio together and slips
    // the cross-sectional gate — but it drags the steam CENTER off the cash
    // center, which is exactly the divergence measured here.
    // BACKTEST SCOPE GUARD: backfill/backtest stay CASE-only — there is no
    // committed deep history for liquids, and a partial backfill would bias
    // any reconstruction. The preview index + this flag lane + the
    // would-have-bound stats ARE the SMLX-7 observation evidence.
    const ccTol = INDEX_RULES.marketPreview.centerToleranceLog;
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const ccBound = [];
    let ccObserved = 0, ccLatest = null;
    for (let k = 1; k < days.length; k++) {
      const day = days[k], prev = days[k - 1];
      const wm = monthWeights("mkt", day.slice(0, 7));
      const steamC = [], cashC = [];
      for (const m of fam.mkt) {
        if (prev < m.includedFrom) continue;
        const w = wm ? wm.get(m) : 1;
        const p0 = m.priceBy.get(prev), p1 = m.priceBy.get(day);
        if (p0 > 0 && p1 > 0 && p0 >= INDEX_RULES.minPrice && p1 >= INDEX_RULES.minPrice)
          steamC.push([Math.log(p1 / p0), w]);
        const c0 = m.cashBy ? m.cashBy.get(prev) : null, c1 = m.cashBy ? m.cashBy.get(day) : null;
        if (c0 > 0 && c1 > 0 && c0 >= INDEX_RULES.minPrice && c1 >= INDEX_RULES.minPrice)
          cashC.push([Math.log(c1 / c0), w]);
      }
      if (steamC.length < INDEX_RULES.minContributors || cashC.length < INDEX_RULES.minContributors) continue;
      const sc = weightedMedian(steamC), cc = weightedMedian(cashC);
      const dev = sc - cc;
      ccObserved++;
      ccLatest = { day: day, steamCenter: r4(sc), cashCenter: r4(cc), devLog: r4(dev),
        wouldBind: Math.abs(dev) > ccTol };
      if (ccLatest.wouldBind) ccBound.push({ day: day, steamCenter: r4(sc), cashCenter: r4(cc), devLog: r4(dev) });
    }
    // flag rows carry the current state (latest observed day), INTEG-1 shape;
    // the full bound-day history rides in boundDays for the evidence trail
    const ccFlags = [];
    if (ccLatest && ccLatest.wouldBind) ccFlags.push({
      name: "(market)", lane: "center", severity: "watch", dev: ccLatest.devLog,
      detail: "day " + ccLatest.day + ": steam clamp center " + ccLatest.steamCenter
        + " vs Skinport realized-cash center " + ccLatest.cashCenter
        + " (|log dev| > " + ccTol + ") — SMLX-7 observation phase: the center must corroborate"
        + " or the day carries; flag-only today, no fixing computation changes",
    });
    // current-month combined-universe weights: the capture-economics input
    // for the market index (kMin/weightNeeded/cost wiring happens in the
    // settlement budget at integration — settlement.js is not touched here;
    // per-name latest/vol24h already ride on the manifest items)
    const mktWeights = {};
    if (days.length && fam.mkt.length) {
      const wmNow = monthWeights("mkt", days[days.length - 1].slice(0, 7));
      for (const m of fam.mkt) mktWeights[m.name] = Math.round((wmNow ? wmNow.get(m) : 1 / fam.mkt.length) * 1e6) / 1e6;
    }
    const marketPreview = {
      label: INDEX_RULES.marketPreview.label,
      universe: { members: fam.mkt.length, caseMembers: fam.case.length, liqMembers: fam.liq.length },
      weights: mktWeights,
      centerCheck: {
        toleranceLog: ccTol,
        note: "observation phase for the future SMLX-7 hardening: the clamp center must corroborate"
          + " against Skinport realized-cash returns or the day carries. Flag-only (INTEG-1"
          + " discipline) — flags change no fixing computation.",
        stats: { daysObserved: ccObserved, daysWouldBind: ccBound.length },
        latest: ccLatest,
        boundDays: ccBound,
        flags: ccFlags,
      },
    };
    return { series: series, today: today, rules: INDEX_RULES, weights: weightsOut,
      marketPreview: marketPreview };
  }

  // ── slosh detection (measured, not vibed) ────────────────────────────────
  // Cash-adjusted index: caseIdx × (cashRatio / base ratio) — the basket's
  // value in REAL dollars rather than wallet dollars. When it diverges below
  // the wallet index, that's wallet inflation / exit pressure, not real
  // appreciation. Ratio gaps carry the last known value forward.
  function cashAdjustedIndex(series) {
    let baseRatio = null, lastRatio = null;
    const out = [];
    for (const s of series || []) {
      if (s.cashRatio != null) lastRatio = s.cashRatio;
      if (s.caseIdx == null || lastRatio == null) continue;
      if (baseRatio == null) baseRatio = lastRatio;
      out.push({ day: s.day, t: s.t, cashIdx: round2(s.caseIdx * lastRatio / baseRatio) });
    }
    return out;
  }

  // Pearson correlation of day-over-day log returns between two keys of the
  // market series (e.g. "caseIdx" vs "btc") over a trailing window.
  // Needs ≥10 paired returns to say anything — below that returns null.
  function corrDaily(series, keyA, keyB, windowDays) {
    const pts = (series || []).filter((s) => s[keyA] != null && s[keyB] != null && s[keyA] > 0 && s[keyB] > 0);
    const w = pts.slice(-((windowDays == null ? 30 : windowDays) + 1));
    const ra = [], rb = [];
    for (let i = 1; i < w.length; i++) {
      ra.push(Math.log(w[i][keyA] / w[i - 1][keyA]));
      rb.push(Math.log(w[i][keyB] / w[i - 1][keyB]));
    }
    const n = ra.length;
    if (n < 10) return { corr: null, n: n };
    const ma = ra.reduce((a, b) => a + b, 0) / n, mb = rb.reduce((a, b) => a + b, 0) / n;
    let sab = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      const da = ra[i] - ma, db = rb[i] - mb;
      sab += da * db; sa += da * da; sb += db * db;
    }
    if (!sa || !sb) return { corr: null, n: n };
    return { corr: Math.round(sab / Math.sqrt(sa * sb) * 100) / 100, n: n };
  }

  // ── BTC session-attribution gauge (the CN/US ACTIVITY sibling for the
  // macro benchmark). Each inter-sample BTC return is attributed to the
  // trading session it ENDED in — Asia/China daytime (UTC end-hour 1–9,
  // ≈ 09:00–18:00 Beijing) vs US daytime (UTC end-hour 14–22, ≈ 09:00–18:00
  // ET) — and trailing-window log-returns cumulate per bucket. Needs the 3h
  // collector cadence to populate (6h gaps span sessions and are skipped);
  // the gauge accrues until `minDays` distinct UTC days have BOTH buckets
  // sampled. DISPLAY-ONLY (a home tile) — never an index or fixing input.
  function btcSessionSplit(readings, opts) {
    opts = opts || {};
    const windowDays = opts.windowDays || 30, minDays = opts.minDays || 5;
    const rows = (readings || []).filter((r) => r && r.t != null && r.btc > 0)
      .sort((a, b) => a.t - b.t);
    const cutoff = rows.length ? rows[rows.length - 1].t - windowDays * 86400000 : 0;
    let asia = 0, us = 0, aN = 0, uN = 0;
    const dayBoth = new Map();
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      if (cur.t < cutoff) continue;
      const gapH = (cur.t - prev.t) / 3600000;
      if (gapH <= 0 || gapH > 5) continue;    // needs adjacent 3h samples
      const end = new Date(cur.t);
      const h = end.getUTCHours();
      const day = end.toISOString().slice(0, 10);
      const r = Math.log(cur.btc / prev.btc);
      const d = dayBoth.get(day) || { a: false, u: false };
      if (h >= 1 && h < 10) { asia += r; aN++; d.a = true; }
      else if (h >= 14 && h < 23) { us += r; uN++; d.u = true; }
      dayBoth.set(day, d);
    }
    let days = 0;
    for (const v of dayBoth.values()) if (v.a && v.u) days++;
    const pct = (x) => Math.round((Math.exp(x) - 1) * 1000) / 10;
    return { asiaPct: aN ? pct(asia) : null, usPct: uN ? pct(us) : null,
      pairsAsia: aN, pairsUs: uN, days: days, minDays: minDays,
      windowDays: windowDays, ready: days >= minDays && aN > 0 && uN > 0 };
  }

  // ── Steam inventory join (CANONICAL, shared) ─────────────────────────────
  // assets × descriptions → holdings. Lives HERE (the UMD module) so the
  // Node fetch path (market.js delegates to this) and the browser paste path
  // run ONE implementation — the assembleSeries rule: never fork raw→
  // structured assembly per surface. Pure: no network, no clock, no RNG.
  // NOTE: rows are keyed by classid_instanceid, so an inventory CAN carry
  // several rows sharing one market_hash_name (different floats/stickers);
  // inventoryValue() aggregates them by name, which is where value is summed.
  function parseSteamInventory(payload, steamid64, max) {
    let p = payload;
    if (typeof p === "string") {
      try { p = JSON.parse(p); }
      catch (e) { throw new Error("that does not look like Steam inventory JSON — copy the whole page, starting with {"); }
    }
    if (!p || typeof p !== "object")
      throw new Error("that does not look like Steam inventory JSON — copy the whole page, starting with {");
    const assets = Array.isArray(p.assets) ? p.assets : [];
    const descs = Array.isArray(p.descriptions) ? p.descriptions : [];
    const empty = p.success === 1 || p.success === true || Number(p.total_inventory_count) === 0;
    if (!assets.length && !empty)
      throw new Error("Steam did not return an inventory for that profile — it may be private, hidden, or empty");
    const byKey = new Map();
    for (const d of descs) {
      if (!d) continue;
      const k = String(d.classid) + "_" + String(d.instanceid);
      if (!byKey.has(k)) byKey.set(k, d);
    }
    const rows = new Map();
    let count = 0;
    for (const a of assets) {
      if (!a) continue;
      const d = byKey.get(String(a.classid) + "_" + String(a.instanceid));
      if (!d || typeof d.market_hash_name !== "string" || !d.market_hash_name) continue; // never invent a name
      const n = Number(a.amount);
      const qty = isFinite(n) && n > 0 ? Math.round(n) : 1;
      const k = String(a.classid) + "_" + String(a.instanceid);
      const cur = rows.get(k);
      if (cur) cur.qty += qty;   // duplicate stack of the SAME item → one row, qty summed
      else rows.set(k, { name: d.market_hash_name, qty: qty,
        marketable: !!Number(d.marketable), tradable: !!Number(d.tradable) });
      count += qty;
    }
    const declared = Number(p.total_inventory_count);
    return {
      steamid64: String(steamid64 == null ? "" : steamid64),
      count: count,
      items: Array.from(rows.values()),
      truncated: Boolean(p.more_items) || (isFinite(declared) && declared > assets.length) ||
        (max > 0 && assets.length >= max),
    };
  }

  // ── benchmark-relative portfolio (the "did you beat the Skindex" number) ──
  // entries = [{ t, cost }] — one per lot, t = acquisition time, cost = the
  // lot's cost basis. For each entry the benchmark factor is
  // (latest index level ÷ the level on the lot's day, nearest EARLIER index
  // day; lots predating the index clamp to its first day). Returns the
  // COST-WEIGHTED factor — the growth the same money would have had in the
  // index over the same holding periods — plus coverage (entries without a
  // usable timestamp are excluded, never given a fabricated date).
  // Display-only: alpha = portfolio return − (factor − 1).
  function benchmarkGrowth(entries, series, key) {
    key = key || "caseIdx";
    const days = (series || []).filter((s) => s && s[key] != null && isFinite(s[key]) && s[key] > 0);
    const total = (entries || []).length;
    if (!days.length || !total) return { factor: null, idxPct: null, covered: 0, total: total };
    const last = days[days.length - 1][key];
    let wSum = 0, wg = 0, covered = 0;
    for (const e of entries) {
      if (!e || e.t == null || !(e.cost > 0)) continue;
      const day = dayKey(e.t);
      let lvl = days[0][key];                       // pre-index lots clamp to inception
      for (const d of days) { if (d.day <= day) lvl = d[key]; else break; }
      wSum += e.cost; wg += e.cost * (last / lvl); covered++;
    }
    if (!wSum) return { factor: null, idxPct: null, covered: 0, total: total };
    const factor = wg / wSum;
    return { factor: factor, idxPct: Math.round((factor - 1) * 1000) / 10,
      covered: covered, total: total };
  }

  // ── inventory analytics (DISPLAY layer — never an index or fixing input) ─
  // Pure: no clock, no network, no randomness. `items` are the merged rows
  // market.js's steamInventory returns ({name, qty, ...}); anything else on
  // the row is ignored. Holdings are aggregated BY NAME first (two Steam
  // rows can share a market_hash_name — e.g. the same skin with and without
  // stickers — and a portfolio table that lists a name twice reads as a bug).
  // NEVER fabricate a price or a day: a name we cannot price is reported as
  // unpriced, a day nobody has a mark for is simply not in the series.
  function invHoldings(items) {
    const by = new Map();
    for (const it of items || []) {
      if (!it) continue;
      const name = typeof it.name === "string" ? it.name.trim() : "";
      if (!name) continue;
      const q = it.qty == null ? 1 : Number(it.qty);
      if (!isFinite(q) || q <= 0) continue;
      by.set(name, (by.get(name) || 0) + q);
    }
    return by;
  }

  // priceOf(name) → number|null (a live/current price). Returns
  // { total, pricedCount, unpricedCount, rows } with rows one-per-NAME sorted
  // by value desc (unpriced rows last, then name asc — a total order, so the
  // output is byte-stable). pricedCount/unpricedCount are UNITS, not names,
  // so they sum to the inventory's item count.
  function inventoryValue(items, priceOf) {
    const px = typeof priceOf === "function" ? priceOf : function () { return null; };
    const rows = [];
    let total = 0, pricedCount = 0, unpricedCount = 0;
    for (const e of invHoldings(items)) {
      const name = e[0], qty = e[1];
      const raw = px(name);
      const price = typeof raw === "number" && isFinite(raw) && raw > 0 ? raw : null;
      if (price == null) {
        unpricedCount += qty;
        rows.push({ name: name, qty: qty, price: null, value: null });
        continue;
      }
      const value = round2(price * qty);
      total += value;
      pricedCount += qty;
      rows.push({ name: name, qty: qty, price: price, value: value });
    }
    rows.sort(function (a, b) {
      const av = a.value == null ? -1 : a.value, bv = b.value == null ? -1 : b.value;
      if (av !== bv) return bv - av;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return { total: round2(total), pricedCount: pricedCount,
      unpricedCount: unpricedCount, rows: rows };
  }

  // Rows a caller may hand us as history: {day:"YYYY-MM-DD", price} or the
  // collected/backtest shape {t, price}. Bad rows and non-positive prices are
  // dropped (never repaired); a repeated day keeps the LAST row given.
  function invHistoryMarks(rows) {
    if (!Array.isArray(rows)) return [];
    const byDay = new Map();
    for (const r of rows) {
      if (!r) continue;
      const day = typeof r.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.day) ? r.day
        : (r.t != null && isFinite(r.t) ? dayKey(r.t) : null);
      const price = Number(r.price);
      if (day == null || !isFinite(price) || price <= 0) continue;
      byDay.set(day, price);
    }
    return Array.from(byDay.entries())
      .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; })
      .map(function (e) { return { day: e[0], price: e[1] }; });
  }

  // What TODAY's holdings would have been worth on each past day — the
  // inventory's "performance" line. historyOf(name) → [{day, price}] | null;
  // opts.priceOf(name) → number|null supplies today's price for coverage.
  //
  // SEMANTICS (easy to get subtly wrong — this is the contract):
  //  · today's QUANTITIES are held fixed and valued at each past day's price
  //    (a like-for-like basket, not a trade ledger);
  //  · the day axis is the UNION of the days that actually appear in the
  //    items' own histories — no day is invented, none is interpolated;
  //  · a day sums ONLY the items with a mark ON or BEFORE it, so an item
  //    enters the line on its own first mark and contributes nothing earlier;
  //  · within one item's series the last known mark carries forward across
  //    gaps; it NEVER carries across items (one item's price can never stand
  //    in for another's).
  // coveragePct = the share of today's total VALUE (not of the item count)
  // that has usable history, rounded to 0.1 — the honesty number the UI must
  // show beside the chart. Each name is valued with the SAME price on both
  // sides of that ratio (opts.priceOf, else its own last mark), so it is a
  // true share. Without opts.priceOf, names with no history have no value at
  // all and coverage is measured over the reconstructable holdings only (it
  // will read high) — callers that have prices should always pass them.
  function inventoryReconstruction(items, historyOf, opts) {
    opts = opts || {};
    const hist = typeof historyOf === "function" ? historyOf : function () { return null; };
    const px = typeof opts.priceOf === "function" ? opts.priceOf : null;
    const held = [];                 // items WITH history: { qty, marks }
    const daySet = new Set();
    let pricedNames = 0, totalNames = 0, covered = 0, todayTotal = 0;
    for (const e of invHoldings(items)) {
      const name = e[0], qty = e[1];
      totalNames++;
      const marks = invHistoryMarks(hist(name));
      let today = null;
      if (px) {
        const p = px(name);
        if (typeof p === "number" && isFinite(p) && p > 0) today = p;
      }
      if (today == null && marks.length) today = marks[marks.length - 1].price;
      const worth = today == null ? 0 : today * qty;
      todayTotal += worth;
      if (!marks.length) continue;
      pricedNames++;
      covered += worth;
      held.push({ qty: qty, marks: marks });
      for (const m of marks) daySet.add(m.day);
    }
    const axis = Array.from(daySet).sort();
    const cursor = held.map(function () { return -1; });
    const days = [];
    for (const day of axis) {
      let v = 0;
      for (let i = 0; i < held.length; i++) {
        const marks = held[i].marks;
        let k = cursor[i];
        while (k + 1 < marks.length && marks[k + 1].day <= day) k++;
        cursor[i] = k;
        if (k >= 0) v += marks[k].price * held[i].qty;   // carry-forward, within this item only
      }
      days.push({ day: day, value: round2(v) });
    }
    return {
      days: days,
      coveragePct: todayTotal > 0 ? Math.round((covered / todayTotal) * 1000) / 10 : 0,
      pricedNames: pricedNames, totalNames: totalNames,
    };
  }

  return {
    parseMoney: parseMoney, parseCount: parseCount, dayKey: dayKey, median: median, toDaily: toDaily,
    marketOverview: marketOverview, includedFromDay: includedFromDay, INDEX_RULES: INDEX_RULES,
    deepHistoryBase: deepHistoryBase,
    cashAdjustedIndex: cashAdjustedIndex, corrDaily: corrDaily, btcSessionSplit: btcSessionSplit,
    benchmarkGrowth: benchmarkGrowth, parseSteamInventory: parseSteamInventory,
    inventoryValue: inventoryValue, inventoryReconstruction: inventoryReconstruction,
    assembleSeries: assembleSeries, mergeDaily: mergeDaily, round2: round2, sma: sma, smaTrack: smaTrack,
    ema: ema, rsi: rsi, logReturns: logReturns, volAnnualized: volAnnualized,
    maxDrawdown: maxDrawdown, currentDrawdown: currentDrawdown,
    trendSlope: trendSlope, momentum: momentum, liquidity: liquidity,
    netProceeds: netProceeds, signal: signal, analyze: analyze, FEES: FEES,
  };
});
