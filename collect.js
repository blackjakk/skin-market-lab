#!/usr/bin/env node
// collect.js — the hosted data collector.
//
// Snapshots every item in watchlist.json (Steam quote + Skinport realized-
// sale aggregates), appends to data/history/<slug>.jsonl, and writes
// data/index.json — a precomputed manifest (quote + analytics summary per
// item) so the static dashboard paints the whole watchlist with ONE fetch.
// data/import/<slug>.json files (committed Steam history backfills) merge
// into the analytics exactly like the tracker's imports.
//
// Runs on GitHub Actions every 6h (collect.yml) and commits the result —
// that's what makes the dashboard LINK self-sufficient: history accrues on
// GitHub's clock, not on anyone's laptop. Also runs locally: node collect.js
//
// Exit code: 0 if at least one item snapshotted (partial failures are noted
// in index.json errors[]), 1 only when EVERY steam fetch failed.
"use strict";
const fs = require("fs");
const path = require("path");
const A = require("./analytics.js");
const M = require("./market.js");
const { slug } = require("./server.js");

const DEDUPE_MS = 30 * 60 * 1000; // same guard as the tracker

function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }
function readLines(f) {
  const out = [];
  try {
    for (const ln of fs.readFileSync(f, "utf8").split("\n")) {
      if (!ln.trim()) continue;
      try { out.push(JSON.parse(ln)); } catch { /* torn line — skip */ }
    }
  } catch { /* no file yet */ }
  return out;
}

const CAT_BY_NAME = (() => {
  const m = new Map();
  for (const s of (readJson(path.join(__dirname, "seed.json"), { items: [] }).items || [])) m.set(s.name, s.cat);
  return m;
})();
function catOf(name) {
  if (/^Sticker \|/.test(name)) return "sticker";
  return CAT_BY_NAME.get(name) || (/\b(Case|Package)$/.test(name) ? "case" : name.startsWith("★") ? "knife" : "skin");
}

async function collect(opts) {
  opts = opts || {};
  const root = opts.root || __dirname;
  const dataDir = path.join(root, "data");
  const wl = readJson(path.join(root, "watchlist.json"), { items: [] });
  const names = opts.names || (wl.items || []);
  const artSet = new Set(opts.art || wl.art || []);
  fs.mkdirSync(path.join(dataDir, "history"), { recursive: true });
  const manifest = { generatedAt: Date.now(), items: [], errors: [] };
  const marketItems = [];
  let steamOk = 0;

  // Skinport's sales endpoint allows only 8 requests per 5 minutes, so each
  // run refreshes a rotating window of 8 items (cursor persisted) and every
  // item keeps serving its last stored aggregates until its turn comes
  // round (~2 days at 4 runs/day — fine for 24h/7d/30d windows).
  const SALES_BUDGET = 8;
  const salesStoreFile = path.join(dataDir, "sales.json");
  const salesStore = readJson(salesStoreFile, {});
  const cursorFile = path.join(dataDir, "skinport-cursor.json");
  const cursor = readJson(cursorFile, { i: 0 }).i % Math.max(1, names.length);
  const fetchSet = new Set(Array.from({ length: Math.min(SALES_BUDGET, names.length) },
    (_, k) => names[(cursor + k) % names.length]));

  for (const name of names) {
    const s = slug(name);
    const hf = path.join(dataDir, "history", s + ".jsonl");
    const lines = readLines(hf);
    const appendIfNew = (snap) => {
      const last = [...lines].reverse().find((l) => l.src === snap.src);
      if (last && snap.t - last.t < DEDUPE_MS) return false;
      lines.push(snap);
      fs.appendFileSync(hf, JSON.stringify(snap) + "\n");
      return true;
    };

    const tier = artSet.has(name) ? "art" : null;
    let quote = null, noQuote = false;
    try {
      const po = await M.steamPriceOverview(name, A);
      if (po) {
        quote = { t: po.t, price: po.price, lowest: po.lowest, vol: po.vol };
        appendIfNew({ t: po.t, src: "steam", price: po.price, lowest: po.lowest, vol: po.vol });
        steamOk++;
      } else noQuote = true;
    } catch (e) { manifest.errors.push(name + ": " + String(e.message || e)); }
    if (fetchSet.has(name)) {
      try {
        const fresh = await M.skinportSalesHistory(name);
        if (fresh) {
          salesStore[s] = { t: Date.now(), data: fresh };
          const m24 = (fresh.last24h && fresh.last24h.median) || null;
          const m30 = (fresh.last30d && fresh.last30d.median) || null;
          if (m24 != null || m30 != null)
            appendIfNew({ t: Date.now(), src: "skinport", price: m24 != null ? m24 : m30,
              vol: fresh.last24h ? fresh.last24h.volume : null, sp30: m30 });
        }
      } catch (e) { console.log("[collect] skinport " + name + ": " + e.message); }
    }
    const sales = salesStore[s] ? salesStore[s].data : null;
    // art grails (and anything above the ~$1,800 steam listing cap) have NO
    // steam quote by nature — only flag items with no data from EITHER side
    if (noQuote && tier !== "art" && !sales)
      manifest.errors.push(name + ": no steam quote (unknown item, or too rare for a median)");

    if (!quote) { // serve the last stored quote so one bad run never blanks the site
      const last = [...lines].reverse().find((l) => l.src === "steam");
      if (last) quote = { t: last.t, price: last.price, lowest: last.lowest != null ? last.lowest : null, vol: last.vol != null ? last.vol : null };
    }
    const imported = readJson(path.join(dataDir, "import", s + ".json"), null);
    const series = A.assembleSeries(imported && imported.rows, lines);
    const an = A.analyze(series.daily);
    const cat = catOf(name);
    const artDaily = tier ? A.toDaily(lines.filter((l) => l.src === "skinport" && l.sp30 != null)
      .map((l) => ({ t: l.t, price: l.sp30 })), { volMode: "max" }) : [];
    const m30latest = (sales && sales.last30d && sales.last30d.median) || null;
    marketItems.push({ name, cat, tier, daily: series.daily, skinportDaily: series.skinportDaily, artDaily });
    manifest.items.push({
      name, slug: s, cat, tier,
      quote, skinport: sales, imported: !!imported,
      days: an.days, latest: an.latest != null ? an.latest : m30latest,
      mom1: A.momentum(series.daily, 1), mom7: an.mom7, mom30: an.mom30,
      vol24h: quote ? quote.vol : null,
      spark: series.daily.slice(-14).map((d) => d.price),
      verdict: an.signal.verdict, score: an.signal.score,
    });
  }

  // market overview: the Lab Case Index + cash ratio + total volume, plus
  // per-run macro readings (CS2 players, BTC/ETH — the correlation
  // benchmarks) appended raw to market.jsonl and daily-bucketed here
  manifest.market = A.marketOverview(marketItems);
  const macroFile = path.join(dataDir, "market.jsonl");
  const reading = { t: Date.now() };
  try { const p = await M.steamPlayers(); if (p != null) reading.players = p; }
  catch (e) { /* garnish — never fail the run */ }
  try { const c = await M.cryptoPrices(); if (c.btc != null) reading.btc = c.btc; if (c.eth != null) reading.eth = c.eth; }
  catch (e) { /* garnish */ }
  if (reading.players != null || reading.btc != null)
    fs.appendFileSync(macroFile, JSON.stringify(reading) + "\n");
  const byDay = new Map();
  let latest = {};
  for (const ln of readLines(macroFile)) {
    const day = A.dayKey(ln.t);
    let r = byDay.get(day);
    if (!r) { r = {}; byDay.set(day, r); }
    if (ln.players != null) {
      r.players = Math.max(r.players || 0, ln.players);
      // CN/US activity gauge: the cron samples 11:17 UTC (≈19:17 Beijing,
      // China's evening peak) and 23:17 UTC (US evening). The ratio of the
      // two daily peaks is a crude regional-demand-mix proxy.
      const h = new Date(ln.t).getUTCHours();
      if (h >= 10 && h <= 15) r.cn = Math.max(r.cn || 0, ln.players);
      if (h >= 22 || h <= 3) r.us = Math.max(r.us || 0, ln.players);
    }
    if (ln.btc != null) r.btc = ln.btc;   // last reading of the day wins
    if (ln.eth != null) r.eth = ln.eth;
    latest = Object.assign(latest, { players: ln.players != null ? ln.players : latest.players, btc: ln.btc != null ? ln.btc : latest.btc, eth: ln.eth != null ? ln.eth : latest.eth });
  }
  for (const s of manifest.market.series) {
    const r = byDay.get(s.day);
    if (r) {
      if (r.players != null) s.players = r.players;
      if (r.btc != null) s.btc = r.btc;
      if (r.eth != null) s.eth = r.eth;
      if (r.cn && r.us) s.cnus = Math.round(r.cn / r.us * 100) / 100;
    }
  }
  for (let i = manifest.market.series.length - 1; i >= 0; i--) {
    if (manifest.market.series[i].cnus != null) { latest.cnus = manifest.market.series[i].cnus; break; }
  }
  if (manifest.market.today) Object.assign(manifest.market.today, {
    players: latest.players != null ? latest.players : null,
    btc: latest.btc != null ? latest.btc : null,
    eth: latest.eth != null ? latest.eth : null,
    cnus: latest.cnus != null ? latest.cnus : null,
  });

  writeJson(cursorFile, { i: names.length ? (cursor + SALES_BUDGET) % names.length : 0 });
  writeJson(salesStoreFile, salesStore);
  fs.writeFileSync(path.join(dataDir, "index.json"), JSON.stringify(manifest));
  return { manifest, steamOk, total: names.length };
}

if (require.main === module) {
  collect().then((r) => {
    console.log("[collect] " + r.steamOk + "/" + r.total + " items snapshotted"
      + (r.manifest.errors.length ? "; errors: " + r.manifest.errors.join(" | ") : ""));
    process.exit(r.total > 0 && r.steamOk === 0 ? 1 : 0);
  }).catch((e) => { console.error("[collect] fatal:", e); process.exit(1); });
}

module.exports = { collect };
