#!/usr/bin/env node
// backtest.js — reconstruct the Skindex through history (OFFLINE STUDY).
//
// Runs the EXACT shipped index code (analytics.js marketOverview — no
// reimplementation, no fork) over Steam's own daily aggregates fetched by
// backfill.js, producing backtest/result.json for backtest.html.
//
// Variants isolate each SMLX protection by overriding the EXPORTED
// INDEX_RULES object (restored in finally — the only production-code-free
// way to counterfactual the shipped math):
//   smlx5       adoption pushed before history start, so the 30d+first-of-
//               month seasoning applies to EVERY case launch — exactly what
//               the live rule does for future listings. THE reference run.
//   noSeason    adoption pushed past today → every launch included from day
//               one, launch-hype collapse and all (why SMLX-2 seasons).
//   noClamp     clampLog → ∞ (why SMLX-3/5 winsorize).
//   equalWeight weightMinObs → ∞ → equal weights (why SMLX-4 weights).
//
// NOT the live index: the live series starts at adoption and is never
// backfilled; this is a validation artifact. Marks differ slightly by
// construction (Steam's own price_median vs the collector's 4-sample cron
// medians), so live values will not exactly equal the backtest going
// forward — documented on the report page.
"use strict";
const fs = require("fs");
const path = require("path");
const A = require("./analytics.js");

const HIST = path.join(__dirname, "backtest", "history");
const OUT = path.join(__dirname, "backtest", "result.json");

function withRules(overrides, fn) {
  const R = A.INDEX_RULES, saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = R[k]; R[k] = overrides[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) R[k] = saved[k]; }
}

const r2 = (v) => Math.round(v * 100) / 100;
const pct = (v) => Math.round(v * 1000) / 10; // fraction → % with 1dp

function stats(series) {
  const pts = series.filter((s) => s.caseIdx != null);
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const spanDays = Math.max(1, (last.t - first.t) / 86400000);
  const rets = [];
  for (let i = 1; i < pts.length; i++) rets.push(Math.log(pts[i].caseIdx / pts[i - 1].caseIdx));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length);
  let peak = pts[0].caseIdx, peakDay = pts[0].day, dd = 0, ddPeakDay = null, ddTroughDay = null;
  for (const p of pts) {
    if (p.caseIdx > peak) { peak = p.caseIdx; peakDay = p.day; }
    const d = p.caseIdx / peak - 1;
    if (d < dd) { dd = d; ddPeakDay = peakDay; ddTroughDay = p.day; }
  }
  let best = { day: null, ret: -Infinity }, worst = { day: null, ret: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const r = pts[i].caseIdx / pts[i - 1].caseIdx - 1;
    if (r > best.ret) best = { day: pts[i].day, ret: r };
    if (r < worst.ret) worst = { day: pts[i].day, ret: r };
  }
  return {
    days: pts.length, firstDay: first.day, lastDay: last.day,
    endLevel: r2(last.caseIdx),
    totalReturnPct: pct(last.caseIdx / first.caseIdx - 1),
    cagrPct: pct(Math.pow(last.caseIdx / first.caseIdx, 365 / spanDays) - 1),
    annVolPct: pct(sd * Math.sqrt(365)),
    maxDrawdownPct: pct(dd), maxDrawdownPeak: ddPeakDay, maxDrawdownTrough: ddTroughDay,
    bestDay: { day: best.day, pct: pct(best.ret) }, worstDay: { day: worst.day, pct: pct(worst.ret) },
  };
}

// items: [{name, cat, tier, daily, skinportDaily, artDaily}] — pure, probe-testable.
function computeBacktest(items) {
  const VARIANTS = {
    smlx6: { label: "SMLX-6 (as shipped, seasoning always-on)", rules: { adoption: "2000-01-01" } },
    noSeason: { label: "No seasoning (every launch from day 1)", rules: { adoption: "2099-12-31" } },
    noClamp: { label: "No winsorization clamp", rules: { adoption: "2000-01-01", clampLog: 1e9 } },
    equalWeight: { label: "Equal weights (no volume weighting)", rules: { adoption: "2000-01-01", weightMinObs: 1e9 } },
  };
  const runs = {};
  let weights = null;
  for (const key of Object.keys(VARIANTS)) {
    const v = VARIANTS[key];
    const mo = withRules(v.rules, () => A.marketOverview(items));
    runs[key] = mo.series.map((s) => ({ day: s.day, t: s.t, caseIdx: s.caseIdx }));
    if (key === "smlx6") weights = mo.weights;
  }
  // clamp engagement: smlx5 vs noClamp daily-return divergence (both seasoned
  // + weighted, so the difference IS the clamp)
  const byDay = (run) => new Map(run.filter((s) => s.caseIdx != null).map((s) => [s.day, s.caseIdx]));
  const dS = byDay(runs.smlx6), dN = byDay(runs.noClamp);
  const days = [...dS.keys()].sort();
  const clampEvents = [];
  let engaged = 0, compared = 0;
  for (let i = 1; i < days.length; i++) {
    const a0 = dS.get(days[i - 1]), a1 = dS.get(days[i]);
    const b0 = dN.get(days[i - 1]), b1 = dN.get(days[i]);
    if (!(a0 > 0 && a1 > 0 && b0 > 0 && b1 > 0)) continue;
    compared++;
    const absorbed = Math.log(b1 / b0) - Math.log(a1 / a0);
    if (Math.abs(absorbed) > 1e-9) {
      engaged++;
      clampEvents.push({ day: days[i], indexRetPct: pct(a1 / a0 - 1), noClampRetPct: pct(b1 / b0 - 1),
        absorbedPct: pct(Math.exp(absorbed) - 1) });
    }
  }
  clampEvents.sort((x, y) => Math.abs(y.absorbedPct) - Math.abs(x.absorbedPct));
  // top 30d moves on the reference run (non-overlapping)
  const pts = runs.smlx6.filter((s) => s.caseIdx != null);
  const windows = [];
  for (let i = 30; i < pts.length; i++)
    windows.push({ from: pts[i - 30].day, to: pts[i].day, movePct: pct(pts[i].caseIdx / pts[i - 30].caseIdx - 1) });
  const pick = (dir, n) => {
    const sorted = windows.slice().sort((x, y) => dir * (y.movePct - x.movePct));
    const out = [];
    for (const w of sorted) {
      if (out.length >= n) break;
      if (out.some((o) => !(w.to < o.from || w.from > o.to))) continue; // overlap
      out.push(w);
    }
    return out;
  };
  // event windows (dates that are certain; moves are measured, not asserted)
  const EVENTS = [
    { label: "CS2 announcement", day: "2023-03-22" },
    { label: "CS2 release", day: "2023-09-27" },
    { label: "Trade Protection update month (July 2025)", day: "2025-07-01", spanDays: 31 },
  ];
  const idxOnOrBefore = (day) => { let v = null; for (const p of pts) { if (p.day > day) break; v = p; } return v; };
  const idxOnOrAfter = (day) => { for (const p of pts) if (p.day >= day) return p; return null; };
  const events = [];
  for (const e of EVENTS) {
    const pre = idxOnOrBefore(e.day);
    const postDay = new Date(A.dayT ? A.dayT(e.day) : Date.parse(e.day));
    postDay.setUTCDate(postDay.getUTCDate() + (e.spanDays || 30));
    const post = idxOnOrAfter(postDay.toISOString().slice(0, 10));
    if (pre && post) events.push({ label: e.label, day: e.day,
      pre: r2(pre.caseIdx), post: r2(post.caseIdx), movePct: pct(post.caseIdx / pre.caseIdx - 1) });
  }
  // weight snapshot (reference run, current month)
  const wTop = weights && weights.case
    ? Object.entries(weights.case).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, w]) => ({ name: n, w: w }))
    : [];
  const capped = weights && weights.case
    ? Object.values(weights.case).filter((w) => Math.abs(w - 0.10) < 1e-6).length : 0;
  return {
    variants: Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, {
      label: VARIANTS[k].label,
      stats: stats(runs[k]),
      series: runs[k].filter((s) => s.caseIdx != null).map((s) => [s.day, r2(s.caseIdx)]),
    }])),
    clamp: { engagedDays: engaged, comparedDays: compared,
      ratePct: compared ? pct(engaged / compared) : null, topAbsorbed: clampEvents.slice(0, 15) },
    topMoves: { up: pick(1, 3), down: pick(-1, 3) },
    events: events,
    weights: { top: wTop, cappedAtTen: capped },
  };
}

function loadItems() {
  // backtest/history also holds skins/knives for the ITEM-DETAIL deep
  // charts — the reconstruction is the CASE index, so filter by category
  // (catOf is the same classifier the collector uses)
  const { catOf } = require("./collect.js");
  const items = [];
  for (const f of fs.readdirSync(HIST).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(HIST, f), "utf8"));
    if (catOf(j.name) !== "case") continue;
    // Steam serves recent rows sub-daily → bucket exactly like the import
    // path (median price per UTC day, per-interval volumes summed)
    const daily = A.toDaily(j.rows.map((r) => ({ t: r[0], price: r[1], vol: r[2] })), { volMode: "sum" });
    items.push({ name: j.name, cat: "case", tier: null, daily: daily, skinportDaily: [], artDaily: [] });
  }
  return items;
}

if (require.main === module) {
  const items = loadItems();
  if (!items.length) { console.error("[backtest] no history files — run backfill.js first"); process.exit(1); }
  const t0 = Date.now();
  const result = computeBacktest(items);
  const out = Object.assign({
    generatedAt: Date.now(),
    source: "Steam daily aggregates (price_median + purchases), SSR listing pages, logged-out",
    itemCount: items.length,
  }, result);
  fs.writeFileSync(OUT, JSON.stringify(out));
  const st = result.variants.smlx6.stats;
  console.log("[backtest] " + items.length + " cases, " + st.days + " index days ("
    + st.firstDay + " → " + st.lastDay + ") in " + (Date.now() - t0) + "ms");
  console.log("[backtest] SMLX-5: level " + st.endLevel + " | total " + st.totalReturnPct
    + "% | CAGR " + st.cagrPct + "% | vol " + st.annVolPct + "% | maxDD " + st.maxDrawdownPct + "%");
  for (const k of ["noSeason", "noClamp", "equalWeight"]) {
    const s = result.variants[k].stats;
    console.log("[backtest] " + k + ": level " + (s ? s.endLevel : "—") + " | total " + (s ? s.totalReturnPct : "—") + "%");
  }
  console.log("[backtest] clamp engaged " + result.clamp.engagedDays + "/" + result.clamp.comparedDays + " days");
}

module.exports = { computeBacktest, withRules };
