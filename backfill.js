#!/usr/bin/env node
// backfill.js — fetch full price history for the case basket (BACKTEST ONLY).
//
// Pulls each case's complete daily history (Steam's own price_median +
// purchases aggregates, embedded logged-out in the SSR listing page — see
// steamPriceHistoryPublic) into backtest/history/<slug>.json.
//
// STRICT SEPARATION: these files feed backtest.js and NOTHING else. Never
// copy them into data/import/ — the collector merges import files into the
// LIVE index, and a silent multi-year backfill would rebase the published
// series and every fixing (a methodology event, not a data update).
//
// Idempotent: items with an existing file are skipped (--refresh refetches).
// Politeness: one listing page per item through market.js's 3.5s Steam gap.
"use strict";
const fs = require("fs");
const path = require("path");
const M = require("./market.js");
const { slug } = require("./server.js");
const { catOf } = require("./collect.js");

const OUT = path.join(__dirname, "backtest", "history");

async function backfill() {
  const wl = JSON.parse(fs.readFileSync(path.join(__dirname, "watchlist.json"), "utf8"));
  const artSet = new Set(wl.art || []);
  const cases = (wl.items || []).filter((n) => catOf(n) === "case" && !artSet.has(n));
  const refresh = process.argv.includes("--refresh");
  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0, skipped = 0, failed = 0;
  for (const name of cases) {
    const f = path.join(OUT, slug(name) + ".json");
    if (!refresh && fs.existsSync(f)) { skipped++; continue; }
    try {
      const rows = await M.steamPriceHistoryPublic(name);
      if (!rows) { console.log("[backfill] no history block: " + name); failed++; continue; }
      // compact storage: [t(ms), price, vol] triples
      fs.writeFileSync(f, JSON.stringify({ name: name, fetched: Date.now(),
        cols: ["t", "price", "vol"], rows: rows.map((r) => [r.t, r.price, r.vol]) }));
      console.log("[backfill] " + name + ": " + rows.length + " days");
      ok++;
    } catch (e) { console.log("[backfill] FAIL " + name + ": " + e.message); failed++; }
  }
  console.log("[backfill] done — " + ok + " fetched, " + skipped + " already present, " + failed + " failed");
  // macro history for the home-chart overlays (players since 2012, BTC since
  // 2010) — one-shot like the case histories; the live series continues from
  // our own collector samples. Committed to backtest/macro.json.
  const macroFile = path.join(__dirname, "backtest", "macro.json");
  if (refresh || !fs.existsSync(macroFile)) {
    const macro = { fetched: Date.now(), players: null, btc: null };
    try { macro.players = (await M.steamchartsMonthly()).map((r) => [r.day, r.players]); }
    catch (e) { console.log("[backfill] steamcharts: " + e.message); }
    try { macro.btc = (await M.btcHistoryAll()).map((r) => [r.day, r.usd]); }
    catch (e) { console.log("[backfill] btc history: " + e.message); }
    if (macro.players || macro.btc) {
      fs.writeFileSync(macroFile, JSON.stringify(macro));
      console.log("[backfill] macro.json: " + (macro.players ? macro.players.length + " player months" : "no players")
        + ", " + (macro.btc ? macro.btc.length + " btc points" : "no btc"));
    }
  }
  return { ok, skipped, failed, total: cases.length };
}

if (require.main === module) {
  backfill().then((r) => process.exit(r.failed && !r.ok && !r.skipped ? 1 : 0))
    .catch((e) => { console.error("[backfill] fatal:", e); process.exit(1); });
}

module.exports = { backfill };
