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

  function median(vals) {
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
  //   caseIdx   — the Lab Case Index: geometric mean of each CASE's price
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
  // has no volume by construction → always equal-weight. The clamp median
  // stays UNWEIGHTED (a weighted clamp center would let heavy names steer
  // it). Net effect on the attack surface: influence is proportional to
  // real traded dollars, so the cheapest concentrated attack must buy
  // ≥ targetMove/clampLog of total index WEIGHT — there is no thin-name
  // cheap corner anymore.
  const INDEX_RULES = { version: "SMLX-4", adoption: "2026-07-25", seasoningDays: 30, clampLog: 0.05,
    weightWindowDays: 60, weightMinObs: 5, weightCap: 0.10 };
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
          includedFrom: includedFromDay(src[0].day), carry: isArt });
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
    const levels = { case: [], liq: [], art: [] };
    for (const key of ["case", "liq", "art"]) {
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
        const contrib = []; // [member, log-return]
        for (const m of fam[key]) {
          if (prev < m.includedFrom) continue; // both days must be post-inclusion
          const p0 = m.priceBy.get(prev), p1 = m.priceBy.get(day);
          if (p0 > 0 && p1 > 0) contrib.push([m, Math.log(p1 / p0)]);
        }
        if (contrib.length) {
          const med = median(contrib.map((c) => c[1])); // clamp center stays UNWEIGHTED
          const cl = INDEX_RULES.clampLog;
          const wm = monthWeights(key, day.slice(0, 7));
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
    } : null;
    return { series: series, today: today, rules: INDEX_RULES, weights: weightsOut };
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

  return {
    parseMoney: parseMoney, parseCount: parseCount, dayKey: dayKey, median: median, toDaily: toDaily,
    marketOverview: marketOverview, includedFromDay: includedFromDay, INDEX_RULES: INDEX_RULES,
    cashAdjustedIndex: cashAdjustedIndex, corrDaily: corrDaily,
    assembleSeries: assembleSeries, mergeDaily: mergeDaily, round2: round2, sma: sma, smaTrack: smaTrack,
    ema: ema, rsi: rsi, logReturns: logReturns, volAnnualized: volAnnualized,
    maxDrawdown: maxDrawdown, currentDrawdown: currentDrawdown,
    trendSlope: trendSlope, momentum: momentum, liquidity: liquidity,
    netProceeds: netProceeds, signal: signal, analyze: analyze, FEES: FEES,
  };
});
