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
  return CAT_BY_NAME.get(name) || (/\b(Case|Package)$/.test(name) ? "case" : name.startsWith("★") ? "knife" : "skin");
}

async function collect(opts) {
  opts = opts || {};
  const root = opts.root || __dirname;
  const dataDir = path.join(root, "data");
  const names = opts.names || (readJson(path.join(root, "watchlist.json"), { items: [] }).items || []);
  fs.mkdirSync(path.join(dataDir, "history"), { recursive: true });
  const manifest = { generatedAt: Date.now(), items: [], errors: [] };
  const marketItems = [];
  let steamOk = 0;

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

    let quote = null, sales = null;
    try {
      const po = await M.steamPriceOverview(name, A);
      if (po) {
        quote = { t: po.t, price: po.price, lowest: po.lowest, vol: po.vol };
        appendIfNew({ t: po.t, src: "steam", price: po.price, lowest: po.lowest, vol: po.vol });
        steamOk++;
      } else manifest.errors.push(name + ": no steam quote (unknown item, or too rare for a median)");
    } catch (e) { manifest.errors.push(name + ": " + String(e.message || e)); }
    try {
      sales = await M.skinportSalesHistory(name);
      if (sales && sales.last24h && sales.last24h.median != null)
        appendIfNew({ t: Date.now(), src: "skinport", price: sales.last24h.median, vol: sales.last24h.volume });
    } catch (e) { /* skinport is optional garnish */ }

    if (!quote) { // serve the last stored quote so one bad run never blanks the site
      const last = [...lines].reverse().find((l) => l.src === "steam");
      if (last) quote = { t: last.t, price: last.price, lowest: last.lowest != null ? last.lowest : null, vol: last.vol != null ? last.vol : null };
    }
    const imported = readJson(path.join(dataDir, "import", s + ".json"), null);
    const series = A.assembleSeries(imported && imported.rows, lines);
    const an = A.analyze(series.daily);
    const cat = catOf(name);
    marketItems.push({ name, cat, daily: series.daily, skinportDaily: series.skinportDaily });
    manifest.items.push({
      name, slug: s, cat,
      quote, skinport: sales, imported: !!imported,
      days: an.days, latest: an.latest,
      mom1: A.momentum(series.daily, 1), mom7: an.mom7, mom30: an.mom30,
      vol24h: quote ? quote.vol : null,
      spark: series.daily.slice(-14).map((d) => d.price),
      verdict: an.signal.verdict, score: an.signal.score,
    });
  }

  // market overview: the Lab Case Index + cash ratio + total volume, plus
  // the CS2 live player count (appended raw per run, daily-bucketed here)
  manifest.market = A.marketOverview(marketItems);
  const playersFile = path.join(dataDir, "market.jsonl");
  try {
    const p = await M.steamPlayers();
    if (p != null) fs.appendFileSync(playersFile, JSON.stringify({ t: Date.now(), players: p }) + "\n");
  } catch (e) { /* players are garnish — never fail the run over them */ }
  const playersByDay = new Map();
  for (const ln of readLines(playersFile)) {
    if (ln.players == null) continue;
    const day = A.dayKey(ln.t);
    playersByDay.set(day, Math.max(playersByDay.get(day) || 0, ln.players));
  }
  for (const s of manifest.market.series) if (playersByDay.has(s.day)) s.players = playersByDay.get(s.day);
  if (manifest.market.today) {
    let latest = null;
    for (const ln of readLines(playersFile)) if (ln.players != null) latest = ln.players;
    manifest.market.today.players = latest;
  }

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
