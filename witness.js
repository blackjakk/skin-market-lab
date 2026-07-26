#!/usr/bin/env node
// witness.js — independent verification of a Skin Market Lab publisher.
//
// The primary's hashes prove its fixings were computed correctly FROM its
// committed data; a WITNESS is what proves the data and the publication
// deserve that trust. Anyone can be one: fork the repo, enable Actions, and
// witness.yml re-runs this every 6h against the canonical Pages site — a
// divergence fails the workflow (red CI + GitHub's failure email = the
// alarm). No key, no config. Full design: TRUST_ARCHITECTURE.md.
//
// Three checks, strongest first:
//   1. FULL RE-DERIVATION (byte-exact): fetch watchlist + every history
//      jsonl + import file, rebuild every item with the collector's OWN
//      assembleMarketItem, run marketOverview, and compare every published
//      day's index fields + the published weights.
//   2. FIXING HASHES (byte-exact): computeAll over the published series;
//      canonical SHA-256 must equal every published hash; methodology
//      stamps must agree with this checkout.
//   3. INDEPENDENT OBSERVATION (tolerance): sample a rotating subset of
//      items live from Steam and compare against the primary's marks —
//      |log dev| ≤ 0.12 passes; the alarm needs ≥2 divergent names in one
//      run (single-name drift between sampling instants is noise; a
//      systematic gap is fabrication). Fetch failures are never lies.
//
// Output: data/witness.json. Exit 0 = ATTESTED, 1 = MISMATCH/UNREACHABLE.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const A = require("./analytics.js");
const S = require("./settlement.js");
const M = require("./market.js");
const { assembleMarketItem } = require("./collect.js");
const { slug } = require("./server.js");

const OBS_BAND_LOG = 0.12;  // per-name pass band vs the primary's mark
const OBS_ALARM_MIN = 2;    // divergent names in one run that trip the alarm

async function witness(opts) {
  opts = opts || {};
  const primary = (opts.primary || process.env.PRIMARY || "https://blackjakk.github.io/skin-market-lab").replace(/\/+$/, "");
  // read(rel) → text | null (404). opts.read overrides for hermetic probes.
  const read = opts.read || (async (rel) => {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await M.httpGet(primary + "/" + rel);
        if (r.status === 200) return r.body;
        if (r.status === 404) return null;
        lastErr = new Error("HTTP " + r.status);
      } catch (e) { lastErr = e; }
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
    throw new Error("unreachable " + rel + ": " + (lastErr ? lastErr.message : "?"));
  });
  const jr = async (rel) => { const t = await read(rel); return t == null ? null : JSON.parse(t); };
  const out = { t: Date.now(), primary: primary, methodology: S.METHODOLOGY, checks: {}, reasons: [] };
  const flag = (r) => out.reasons.push(r);

  let wl, idx, set;
  try {
    wl = await jr("watchlist.json");
    idx = await jr("data/index.json");
    set = await jr("data/settlement.json");
  } catch (e) {
    out.verdict = "UNREACHABLE";
    flag(e.message);
    return out;
  }
  if (!wl || !idx || !set || !idx.market) {
    out.verdict = "UNREACHABLE";
    flag("primary is missing watchlist.json / data/index.json / data/settlement.json");
    return out;
  }

  // ── 1 · full re-derivation from the committed raw files ─────────────────
  const artSet = new Set(wl.art || []);
  const items = [];
  for (const name of wl.items || []) {
    const s = slug(name);
    const linesTxt = await read("data/history/" + s + ".jsonl");
    const lines = (linesTxt || "").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let imported = null;
    try { imported = await jr("data/import/" + s + ".json"); } catch (e) { /* unreachable import = treat as none */ }
    items.push(assembleMarketItem(name, artSet.has(name) ? "art" : null, lines, imported));
  }
  const mkt = A.marketOverview(items);
  const pub = idx.market.series || [];
  const mine = new Map(mkt.series.map((r) => [r.day, r]));
  const eq = (a, b) => (a == null && b == null) || a === b;
  let mismatchedDays = 0;
  for (const p of pub) {
    const m = mine.get(p.day);
    if (!m || !eq(m.caseIdx, p.caseIdx) || !eq(m.liqIdx, p.liqIdx)
      || !eq(m.artIdx, p.artIdx) || !eq(m.cashRatio, p.cashRatio)) mismatchedDays++;
  }
  out.checks.series = { publishedDays: pub.length, rederivedDays: mkt.series.length, mismatchedDays: mismatchedDays };
  if (!pub.length) flag("primary publishes an empty market series");
  if (mismatchedDays) flag(mismatchedDays + " published day(s) do not re-derive from the committed history files");
  out.checks.weightsMatch = JSON.stringify(mkt.weights) === JSON.stringify(idx.market.weights);
  if (!out.checks.weightsMatch) flag("published index weights do not re-derive (the manipulation budget is priced on these)");

  // ── 2 · fixing hashes, byte-exact over the published series ─────────────
  const detail = S.computeAll(pub);
  out.checks.fixings = {};
  for (const nm of Object.keys(detail)) {
    const h = crypto.createHash("sha256").update(S.canonical(detail[nm])).digest("hex");
    const p = set.latest && set.latest.fixings && set.latest.fixings[nm];
    const okF = !!p && p.hash === h && eq(p.value, detail[nm].value);
    out.checks.fixings[nm] = okF;
    if (!okF) flag("fixing " + nm + " does not re-derive (hash/value mismatch)");
  }
  const stamp = set.latest && set.latest.methodology;
  out.checks.methodology = stamp === S.METHODOLOGY;
  if (!out.checks.methodology) flag("methodology stamp mismatch: primary says " + stamp + ", this checkout is " + S.METHODOLOGY);

  // ── 3 · independent observation of a rotating sample ────────────────────
  const obsN = opts.obsN != null ? opts.obsN : Number(process.env.WITNESS_OBS || 6);
  const eligible = (idx.items || []).filter((i) => i.tier !== "art" && i.quote && i.quote.price > 0);
  const start = eligible.length ? Math.floor(Date.now() / 21600000) % eligible.length : 0;
  const sample = Array.from({ length: Math.min(obsN, eligible.length) },
    (_, k) => eligible[(start + k) % eligible.length]);
  const obs = [];
  let obsBad = 0;
  for (const it of sample) {
    try {
      const po = await M.steamPriceOverview(it.name, A);
      if (!po || !(po.price > 0)) { obs.push({ name: it.name, primary: it.quote.price, witnessed: null, ok: null }); continue; }
      const dev = Math.log(po.price / it.quote.price);
      const okO = Math.abs(dev) <= OBS_BAND_LOG;
      if (!okO) obsBad++;
      obs.push({ name: it.name, primary: it.quote.price, witnessed: po.price, devLog: Math.round(dev * 1000) / 1000, ok: okO });
    } catch (e) { obs.push({ name: it.name, error: String(e.message || e) }); }
  }
  out.checks.observations = obs;
  if (obsBad >= OBS_ALARM_MIN)
    flag(obsBad + " independently sampled prices diverge >" + Math.round(OBS_BAND_LOG * 100) + "% from the primary's marks");

  out.verdict = out.reasons.length ? "MISMATCH" : "ATTESTED";
  return out;
}

if (require.main === module) {
  witness().then((w) => {
    const outFile = process.env.WITNESS_OUT || path.join(__dirname, "data", "witness.json");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(w, null, 1));
    console.log("[witness] " + w.verdict + " — " + w.primary);
    if (w.checks.series) console.log("[witness] series: " + w.checks.series.publishedDays + " published day(s), "
      + w.checks.series.mismatchedDays + " mismatched");
    for (const r of w.reasons) console.log("[witness] REASON: " + r);
    process.exit(w.verdict === "ATTESTED" ? 0 : 1);
  }).catch((e) => { console.error("[witness] fatal:", e); process.exit(1); });
}

module.exports = { witness };
