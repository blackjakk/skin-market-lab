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
const crypto = require("crypto");
const A = require("./analytics.js");
const M = require("./market.js");
const S = require("./settlement.js");
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

// ONE canonical raw-inputs → market-item assembly, shared by the collector
// and the WITNESS (witness.js re-derives the published index from the
// committed files with THIS function — any fork of this logic would
// false-alarm every witness). lines = history jsonl records (parsed),
// imported = the data/import/<slug>.json object or null.
function assembleMarketItem(name, tier, lines, imported) {
  const series = A.assembleSeries(imported && imported.rows, lines);
  const artDaily = tier ? A.toDaily(lines.filter((l) => l.src === "skinport" && l.sp30 != null)
    .map((l) => ({ t: l.t, price: l.sp30 })), { volMode: "max" }) : [];
  return { name, cat: catOf(name), tier, daily: series.daily, skinportDaily: series.skinportDaily, artDaily };
}

// ── third-venue corroboration lane (INTEG-1 `venue`) ───────────────────────
// GARNISH, exactly like the players/crypto readings: every venue is wrapped
// so a failure costs coverage and nothing else — it can never fail a
// collector run, never blocks a snapshot, and never touches the index.
//
// Storage mirrors the book lane's discipline: readings live in
// data/venues.json and NEVER in the history jsonl (a stray src line would
// fold a third venue's ask into assembleSeries' daily marks and quietly
// change the published index). data/buff-ids.json is the goods_id map — an
// UNTRUSTED hint list, re-verified name-for-name on every read.
//
// → { roster: [...], quotes: Map(name → {venueId: {price,t}}) }
const VENUE_BUFF_BUDGET = 8; // per-item reads/run (buff.163.com 429s in bursts)
async function gatherVenueQuotes(opts) {
  const dataDir = opts.dataDir, names = opts.names || [];
  const storeFile = path.join(dataDir, "venues.json");
  const idsFile = path.join(dataDir, "buff-ids.json");
  const cursorFile = path.join(dataDir, "venue-cursor.json");
  const store = readJson(storeFile, {});
  const ids = readJson(idsFile, {});
  const cursor = readJson(cursorFile, { i: 0 }).i % Math.max(1, names.length || 1);
  // BUFF is read per item, so it rotates a small window like the book lane;
  // the dump venues answer for every name in one request.
  const buffWindow = Array.from({ length: Math.min(VENUE_BUFF_BUDGET, names.length) },
    (_, k) => names[(cursor + k) % names.length]);
  const roster = [], quotes = new Map();
  let idsDirty = false;
  const adapters = M.venueAdapters({
    env: opts.env || process.env,
    buff: { ids: ids, budget: VENUE_BUFF_BUDGET },
  });
  for (const ad of adapters) {
    const av = ad.available();
    const row = { id: ad.id, label: ad.label, kind: ad.kind, ccy: ad.ccy,
      ok: false, mode: av.mode || null, reason: av.reason || null, t: null };
    if (!av.ok) { roster.push(row); continue; } // not configured → unavailable, never agreement
    let got = null;
    try {
      got = await ad.quotes(ad.id === "buff163" ? buffWindow : names,
        { ids: ids, budget: VENUE_BUFF_BUDGET,
          onResolve: (n, id) => { ids[n] = id; idsDirty = true; } });
    } catch (e) { console.log("[collect] venue " + ad.id + ": " + String(e.message || e)); }
    const fresh = got && got.quotes ? Object.keys(got.quotes) : [];
    const prev = (store[ad.id] && store[ad.id].quotes) || {};
    if (fresh.length) {
      // MERGE, never replace: a rotating venue only refreshes part of the
      // map per run, and every quote carries its own `t` so the lane ages
      // each reading out individually (venueMaxAgeH).
      const merged = Object.assign({}, prev);
      for (const n of fresh) merged[slug(n)] = got.quotes[n];
      store[ad.id] = { t: got.t, ccy: ad.ccy, kind: ad.kind, mode: av.mode || null,
        meta: got.meta || null, quotes: merged };
      row.ok = true; row.t = got.t;
    } else if (Object.keys(prev).length) {
      // the venue did not answer this run: serve the STORED readings and say
      // so. They are not treated as fresh agreement — each one ages out on
      // its own timestamp inside the lane.
      row.ok = true; row.t = (store[ad.id] && store[ad.id].t) || null;
      row.reason = "no fresh answer this run — serving stored readings (each aged out by venueMaxAgeH)";
    } else {
      row.reason = row.reason || "venue did not answer and no stored reading exists";
    }
    roster.push(row);
  }
  for (const v of roster) {
    const st = store[v.id];
    if (!v.ok || !st || !st.quotes) continue;
    for (const name of names) {
      const q = st.quotes[slug(name)];
      if (!q || !(q.price > 0)) continue;
      let bag = quotes.get(name);
      if (!bag) { bag = {}; quotes.set(name, bag); }
      bag[v.id] = q;
    }
  }
  writeJson(storeFile, store);
  if (idsDirty) writeJson(idsFile, ids);
  if (names.length) writeJson(cursorFile, { i: (cursor + buffWindow.length) % names.length });
  return { roster: roster, quotes: quotes };
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

  // Order-book lane (INTEG-1 second read path): a rotating window of steam-
  // marked items gets a fresh book reading per run, extracted from the SSR
  // listing page's embedded react-query cache (one public request per item —
  // see steamOrderBook in market.js for the payload shape and its traps).
  // Book readings live in data/book.json — NEVER in the history jsonl, where
  // an extra src line would pollute assembleSeries' daily marks.
  const BOOK_BUDGET = 10;
  const bookFile = path.join(dataDir, "book.json");
  const bookStore = readJson(bookFile, {});
  const bookCursorFile = path.join(dataDir, "book-cursor.json");
  const steamNames = names.filter((n) => !artSet.has(n)); // grail asks are cap-distorted — book lane is for steam-marked families
  const bCursor = readJson(bookCursorFile, { i: 0 }).i % Math.max(1, steamNames.length || 1);
  const bookSet = new Set(Array.from({ length: Math.min(BOOK_BUDGET, steamNames.length) },
    (_, k) => steamNames[(bCursor + k) % steamNames.length]));
  const integItems = [];

  // third-venue corroboration readings (INTEG-1 venue lane). Gathered before
  // the snapshot loop so every item can carry its venue evidence; wrapped so
  // the whole layer degrades to "no venues answered" without touching a
  // single published number.
  let venueRoster = [], venueQuotes = new Map();
  try {
    const vg = await gatherVenueQuotes({ dataDir, names: steamNames, env: opts.env || process.env });
    venueRoster = vg.roster; venueQuotes = vg.quotes;
  } catch (e) { console.log("[collect] venue lane: " + String(e.message || e)); }

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
    if (bookSet.has(name)) {
      try {
        const book = await M.steamOrderBook(name);
        if (book) bookStore[s] = book;
      } catch (e) { console.log("[collect] book " + name + ": " + e.message); }
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
    const mi = assembleMarketItem(name, tier, lines, imported);
    const an = A.analyze(mi.daily);
    const cat = mi.cat;
    const m30latest = (sales && sales.last30d && sales.last30d.median) || null;
    marketItems.push(mi);
    // per-item daily (skinport realized ÷ steam) ratios feed the INTEG-1
    // ratio lane — each item corroborated against its OWN baseline
    const spByDay = new Map(mi.skinportDaily.map((d) => [d.day, d.price]));
    const ratioDays = mi.daily
      .filter((d) => d.price > 0 && spByDay.get(d.day) > 0)
      .map((d) => ({ day: d.day, r: spByDay.get(d.day) / d.price }));
    integItems.push({
      name, cat, tier,
      steamPrice: quote ? quote.price : null, quoteT: quote ? quote.t : null,
      salesT: salesStore[s] ? salesStore[s].t : null,
      sales30: sales && sales.last30d ? sales.last30d.volume : null,
      ratioDays, book: bookStore[s] || null,
      // INTEG-1 volume lane (strong evidence: realized sold-per-day). Reads
      // the SAME assembled daily series the index reads — no extra fetch, no
      // new store, nothing persisted: the lane is a pure read of published
      // marks, so it cannot introduce a new input to anything.
      volDays: mi.daily.map((d) => ({ day: d.day, price: d.price, vol: d.vol })),
      venues: venueQuotes.get(name) || null,
    });
    // DISPLAY-ONLY spark backfill (the item-view deepHistoryBase discipline):
    // when collected history is under 14 days, committed deep closes extend
    // the sparkline strictly BEFORE the first collected day. mi.daily — the
    // analytics/index input — never sees deep data.
    let sparkDaily = mi.daily;
    if (mi.daily.length < 14) {
      const deep = readJson(path.join(root, "backtest", "history", s + ".json"), null);
      if (deep && Array.isArray(deep.rows) && deep.rows.length) {
        const deepRows = deep.rows.map((r) => ({ t: r[0], price: r[1], vol: r[2] }));
        const steamLines = lines.filter((l) => l.src === "steam");
        const base = A.deepHistoryBase(deepRows, imported && imported.rows, steamLines);
        sparkDaily = A.assembleSeries(base, steamLines).daily;
      }
    }
    const rowLatest = an.latest != null ? an.latest : m30latest;
    manifest.items.push({
      name, slug: s, cat, tier,
      quote, skinport: sales, imported: !!imported,
      days: an.days, latest: rowLatest,
      mom1: A.momentum(mi.daily, 1), mom7: an.mom7, mom30: an.mom30,
      vol24h: quote ? quote.vol : null,
      dvol: rowLatest != null && quote && quote.vol != null ? Math.round(rowLatest * quote.vol) : null,
      spark: sparkDaily.slice(-14).map((d) => d.price),
      verdict: an.signal.verdict, score: an.signal.score,
      book: bookStore[s] || null,
      // third-venue evidence rides alongside the book reading. Display/
      // surveillance only — manipulationBudget reads cat/tier/latest/vol24h/
      // weight/skinport and never this field.
      venues: venueQuotes.get(name) || null,
    });
  }
  writeJson(bookFile, bookStore);
  if (steamNames.length) writeJson(bookCursorFile, { i: (bCursor + Math.min(BOOK_BUDGET, steamNames.length)) % steamNames.length });

  // market overview: the Skindex + cash ratio + total volume, plus
  // per-run macro readings (CS2 players, BTC/ETH — the correlation
  // benchmarks) appended raw to market.jsonl and daily-bucketed here
  manifest.market = A.marketOverview(marketItems);
  // attach each name's published index weight (SMLX-4/5) so the manipulation
  // budget prices the attack on the real weights and the site can show them
  const wCase = (manifest.market.weights && manifest.market.weights.case) || {};
  const wLiq = (manifest.market.weights && manifest.market.weights.liq) || {};
  for (const it of manifest.items) {
    const w = wCase[it.name] != null ? wCase[it.name] : wLiq[it.name];
    if (w != null) it.weight = w;
  }
  // INTEG-1 mark integrity: cross-venue ratio + order-book + art-evidence +
  // staleness surveillance. FLAG-ONLY — never removes a mark (see the
  // assessIntegrity comment for why auto-rejection would be a new attack lever)
  manifest.market.integrity = S.assessIntegrity(integItems, { now: Date.now(), venues: venueRoster });
  // SMLX-7 center-corroboration lane (observation phase, flag-only):
  // computed by marketOverview (analytics owns the weighted-median
  // construction) and merged here as an ADDITIVE lane in the INTEG report —
  // assessIntegrity's own lanes are untouched, flags still never remove a
  // mark or reroute the index, and the running observed/would-bind counts
  // publish per run (they ride into settlement.json's integrity block and
  // settlements.jsonl below, so the SMLX-7 hardening decision has a
  // committed evidence trail).
  const ccM = manifest.market.marketPreview && manifest.market.marketPreview.centerCheck;
  if (ccM) {
    const integM = manifest.market.integrity;
    integM.flags = integM.flags.concat(ccM.flags || []);
    integM.summary.watch = integM.flags.filter((f) => f.severity === "watch").length;
    integM.summary.alert = integM.flags.filter((f) => f.severity === "alert").length;
    integM.summary.centerCorroborated = (ccM.stats.daysObserved - ccM.stats.daysWouldBind)
      + "/" + ccM.stats.daysObserved;
    integM.summary.centerDaysWouldBind = ccM.stats.daysWouldBind;
  }
  if (manifest.market.integrity.flags.length)
    console.log("[collect] INTEGRITY FLAGS: " + manifest.market.integrity.flags
      .map((f) => f.severity + " " + f.lane + " " + f.name).join("; "));

  // VENUE MIX (observation only): Steam's own sold-per-day counts against
  // Skinport's realized-sale counts over the same trailing 30 days, per item
  // and folded to the basket. Reads the DEEP committed pricehistory for the
  // Steam side — the same display-only source the sparkline backfill uses,
  // and for the same reason: mi.daily (the analytics/index input) never sees
  // deep data, so this cannot reach a published level, weight or hash. It is
  // a FLOOR, not a market-share estimate (analytics.venueMix explains why).
  try {
    const vmEntries = manifest.items.map((it) => {
      const deep = readJson(path.join(root, "backtest", "history", it.slug + ".json"), null);
      const st = salesStore[it.slug];
      return {
        name: it.name, slug: it.slug, cat: it.cat, tier: it.tier, price: it.latest,
        steamRows: deep && Array.isArray(deep.rows) ? deep.rows : [],
        sp: st ? st.data : null, spAsOf: st ? st.t : null,
      };
    });
    manifest.market.venueMix = A.venueMix(vmEntries, { now: Date.now() });
    const vb = manifest.market.venueMix.basket;
    console.log("[collect] venue mix: off-steam floor " + vb.unitSharePct + "% of units / "
      + vb.dollarSharePct + "% of dollars over " + manifest.market.venueMix.coverage.paired
      + " paired items");
  } catch (e) { console.log("[collect] venue mix: " + String(e.message || e)); }

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
    // BTC session split (CN/US sibling for the benchmark): attributed from
    // the per-run readings this same file accumulates. Display-only.
    btcSessions: A.btcSessionSplit(readLines(macroFile)),
  });

  // settlement fixings (SMLX-5): computed from the published series and
  // hashed — the auditable, re-derivable marks a dated instrument would
  // settle against. Appended every run; readers take last-per-day.
  const detail = S.computeAll(manifest.market.series);
  const integ = manifest.market.integrity;
  const fix = { t: Date.now(), day: A.dayKey(Date.now()), methodology: S.METHODOLOGY, fixings: {},
    budget: S.manipulationBudget(manifest.items,
      { marketWeights: manifest.market.marketPreview && manifest.market.marketPreview.weights }),
    perpmark: S.perpMark(manifest.market.series),
    integrity: integ ? { version: integ.version, summary: integ.summary, flags: integ.flags,
      venues: integ.venues || [] } : null };
  for (const name of Object.keys(detail)) {
    const f = detail[name];
    fix.fixings[name] = { value: f.value, accruing: f.accruing || null,
      hash: crypto.createHash("sha256").update(S.canonical(f)).digest("hex") };
  }
  manifest.market.settlement = fix;
  writeJson(path.join(dataDir, "settlement.json"), { latest: fix, detail: detail });
  fs.appendFileSync(path.join(dataDir, "settlements.jsonl"), JSON.stringify(fix) + "\n");

  writeJson(cursorFile, { i: names.length ? (cursor + SALES_BUDGET) % names.length : 0 });
  writeJson(salesStoreFile, salesStore);
  fs.writeFileSync(path.join(dataDir, "index.json"), JSON.stringify(manifest));

  // ── the Skindex public embed JSON (STABLE API — README "Embed the Skindex").
  // Contract: within v:1 fields are never renamed or removed, only added.
  // Everything here is a copy of already-published numbers — no new math.
  const t0 = manifest.market.today || {};
  const ser = manifest.market.series || [];
  const prevIdx = ser.length >= 2 ? ser[ser.length - 2].caseIdx : null;
  const chg24hPct = t0.caseIdx != null && prevIdx > 0
    ? Math.round((t0.caseIdx / prevIdx - 1) * 1000) / 10 : null;
  writeJson(path.join(dataDir, "skindex.json"), {
    v: 1, name: "Skindex", methodology: S.METHODOLOGY,
    updatedAt: new Date(manifest.generatedAt || Date.now()).toISOString(),
    day: fix.day,
    level: t0.caseIdx != null ? t0.caseIdx : null,
    chg24hPct: chg24hPct,
    cashRatio: t0.cashRatio != null ? t0.cashRatio : null,
    liquidsIdx: t0.liqIdx != null ? t0.liqIdx : null,
    artIdx: t0.artIdx != null ? t0.artIdx : null,
    players: t0.players != null ? t0.players : null,
    fixings: fix.fixings,
    links: {
      site: "https://blackjakk.github.io/skin-market-lab/",
      methodology: "https://blackjakk.github.io/skin-market-lab/methodology.html",
      data: "https://raw.githubusercontent.com/blackjakk/skin-market-lab/main/data/",
    },
    terms: "Free to embed with attribution ('Skindex' + link). A measurement, not financial advice; not an offer of any instrument.",
  });
  // shields.io endpoint format → ![Skindex](https://img.shields.io/endpoint?url=…/data/badge.json)
  writeJson(path.join(dataDir, "badge.json"), {
    schemaVersion: 1, label: "Skindex",
    message: t0.caseIdx != null
      ? t0.caseIdx.toFixed(1) + (chg24hPct != null ? " (" + (chg24hPct > 0 ? "+" : "") + chg24hPct + "% 24h)" : "")
      : "accruing",
    color: chg24hPct == null ? "lightgrey" : chg24hPct > 0 ? "brightgreen" : chg24hPct < 0 ? "red" : "lightgrey",
  });
  return { manifest, steamOk, total: names.length };
}

if (require.main === module) {
  collect().then((r) => {
    console.log("[collect] " + r.steamOk + "/" + r.total + " items snapshotted"
      + (r.manifest.errors.length ? "; errors: " + r.manifest.errors.join(" | ") : ""));
    process.exit(r.total > 0 && r.steamOk === 0 ? 1 : 0);
  }).catch((e) => { console.error("[collect] fatal:", e); process.exit(1); });
}

module.exports = { collect, assembleMarketItem, catOf, gatherVenueQuotes };
