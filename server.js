// ─── server.js — CS skin market tracker (server + dashboard host) ──────────
// Plain Node, zero dependencies.
//
// What it is: a personal market-research tracker for Counter-Strike skins.
// It records price snapshots for a watchlist over time (JSONL on disk, so
// history ACCRUES the longer it runs), optionally bootstraps full multi-year
// history from Steam (login cookie) or a pasted pricehistory blob, and serves
// a dashboard (index.html) with charts, indicators, and portfolio P/L.
//
// Run:    npm start  (= node server.js [port], default 8790)
//         STEAM_COOKIE="steamLoginSecure=..."        unlocks full-history bootstrap
//         SKIN_DATA=/path                            private data dir (default ./local-data)
//         SKIN_SNAP_HOURS=6                          auto-snapshot cadence (0 = off)
// Test:   npm run probe                             (hermetic — fixture transport)
//
// API (all JSON, USD):
//   GET  /api/skins/health
//   GET  /api/skins/search?q=redline      universe = cached Skinport dump ∪ seed list
//   GET  /api/skins/watchlist             names + latest quote + signal verdict
//   POST /api/skins/watch                 {name, remove?}
//   GET  /api/skins/item?name=            daily series + analytics + cross-market compare
//   POST /api/skins/refresh               {name?} snapshot now (omit name = whole watchlist)
//   POST /api/skins/bootstrap             {name} full Steam history via STEAM_COOKIE
//   POST /api/skins/import                {name, prices:[[dateStr,price,vol],...]} paste-in
//   GET  /api/skins/portfolio             lots valued at latest, net of sell fees
//   POST /api/skins/lot                   {name, qty, unitCost, note?} | {remove:id}
//   GET  /api/skins/inventory?profile=    Steam inventory valued + reconstructed
//   POST /api/skins/inventory             {profile} force refresh | {paste} raw JSON
//   GET  /api/skins/inventory/series      snapshot series [{t,value,count}]
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const A = require("./analytics.js");
const M = require("./market.js");
const S = require("./settlement.js");

const ROOT = __dirname; // static root = the repo itself — the dashboard ships beside the server
const SNAP_DEDUPE_MS = 30 * 60 * 1000;      // skip snapshots <30min apart per source
const SALES_TTL_MS = 6 * 3600 * 1000;       // skinport per-item aggregates cache
const DUMP_TTL_MS = 12 * 3600 * 1000;       // skinport full-dump cache
// Steam IP-rate-limits inventory reads, so a fetched inventory is cached and a
// cached read makes NO network call at all (not even the vanity resolve).
const INV_TTL_MS = 10 * 60 * 1000;          // inventory fetch cache (contract: ≥10 min)
const INV_SNAP_DEDUPE_MS = 10 * 60 * 1000;  // one snapshot POINT per 10 min (collapsed on READ)
// A real 5000-asset Steam page is single-digit MB. The old 32 MB ceiling let
// one paste block this single-threaded server for seconds (parse → value →
// reconstruct → sort → stringify are all synchronous); INV_PASTE_MAX_ASSETS
// bounds the WORK regardless of how the bytes arrive.
const INV_BODY_MAX = 8 * 1024 * 1024;
const INV_PASTE_MAX_ASSETS = 5000;          // the same cap the Steam fetcher asks for

function slug(name) {
  const h = crypto.createHash("sha1").update(name).digest("hex").slice(0, 8);
  return name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) + "-" + h;
}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }

// ── inventory errors: plain English, never a stack trace ───────────────────
// Every inventory failure carries the status the user's situation deserves:
//   400 the input can't be used (no profile given, unparseable paste)
//   403 the profile EXISTS but its inventory is private/hidden
//   404 no such profile / no CS2 inventory on it
//   429 Steam is rate-limiting us     502 anything upstream broke
// 403 vs 404 is a real distinction, not pedantry: the user's next action is
// completely different (flip a Steam privacy setting vs fix a mistyped
// profile), so a client can branch on the status instead of string-matching
// the message.
function invErr(status, message) { const e = new Error(message); e.httpStatus = status; return e; }
// A resolve that failed means we have no profile — default 404, not 502.
function invResolveStatus(msg) {
  const m = String(msg || "").toLowerCase();
  if (/rate.?limit|429|too many/.test(m)) return 429;
  if (/http \d|timeout|timed out|network|econn|socket|unreachable|dns/.test(m)) return 502;
  return 404;
}
// A fetch that failed is upstream by default — unless Steam told us why.
function invFetchStatus(msg) {
  const m = String(msg || "").toLowerCase();
  if (/rate.?limit|429|too many/.test(m)) return 429;
  if (/private|hidden|not public/.test(m)) return 403;
  if (/not found|no such|does ?n[o']t exist|404/.test(m)) return 404;
  return 502;
}

// Steam's public inventory payload → the frozen steamInventory shape
// { steamid64, count, items:[{name,qty,marketable,tradable}], truncated }.
// assets carry ownership, descriptions carry the item — they join on
// classid+"_"+instanceid; duplicate stacks of one name sum into qty and the
// market_hash_name is the key everything else prices on. This is the PASTE
// path (a hosted static page can't fetch steamcommunity.com — same idiom as
// the price-history paste import).
//
// The CANONICAL join is the data layer's `parseSteamInventory` — the very
// function its fetcher uses — so a PASTED inventory parses byte-identically
// to a FETCHED one; invParsePaste() below delegates to it whenever it is
// present. What follows is the standalone FALLBACK for a tracker whose
// market.js predates it, kept behaviour-identical on purpose.
function parseInventoryPayload(raw) {
  let j = raw;
  if (typeof j === "string") {
    try { j = JSON.parse(j); } catch (e) {
      throw invErr(400, "that paste isn't valid JSON — open the inventory URL in your browser and copy the WHOLE page");
    }
  }
  if (!j || typeof j !== "object" || Array.isArray(j))
    throw invErr(400, "that paste isn't a Steam inventory payload (expected a JSON object)");
  const assets = Array.isArray(j.assets) ? j.assets : null;
  const descs = Array.isArray(j.descriptions) ? j.descriptions : null;
  if (!assets || !descs)
    throw invErr(400, "that JSON has no assets/descriptions — copy the whole response from " +
      "https://steamcommunity.com/inventory/<steamid64>/730/2?l=english&count=5000 (if it says {\"success\":false} your inventory is private)");
  const byKey = new Map();
  for (const d of descs) if (d) byKey.set(String(d.classid) + "_" + String(d.instanceid), d);
  const byName = new Map();
  let unknown = 0, capped = false;
  for (let ai = 0; ai < assets.length; ai++) {
    if (ai >= INV_PASTE_MAX_ASSETS) { capped = true; break; }  // bound the work, don't just flag it
    const a = assets[ai];
    const d = a ? byKey.get(String(a.classid) + "_" + String(a.instanceid)) : null;
    const name = d && typeof d.market_hash_name === "string" ? d.market_hash_name : null;
    if (!name) { unknown++; continue; }
    // clamped at both ends: "1e9" in a hand-edited paste must never reach the
    // valuation (and from there the append-only snapshot series)
    const qty = Math.max(1, Math.min(INV_PASTE_MAX_ASSETS, Math.round(Number(a.amount) || 1)));
    const row = byName.get(name);
    if (row) row.qty += qty;
    else byName.set(name, { name: name, qty: qty, marketable: !!Number(d.marketable), tradable: !!Number(d.tradable) });
  }
  const items = Array.from(byName.values());
  if (!items.length)
    throw invErr(400, unknown
      ? "none of the " + unknown + " items in that JSON matched a description — select ALL of the inventory page and copy it whole"
      : "no CS2 items found in that paste — check you copied the 730/2 inventory");
  return {
    steamid64: j.steamid64 != null ? String(j.steamid64) : null,
    count: items.reduce((a, i) => a + i.qty, 0),
    items: items,
    truncated: capped || !!(j.more_items || j.last_assetid),
    truncatedBy: capped ? "cap" : (j.more_items || j.last_assetid) ? "more_items" : null,
    unknown: unknown,
  };
}

function startServer(opts) {
  opts = opts || {};
  const PORT = opts.port != null ? opts.port : Number(process.argv[2] || process.env.SKIN_PORT || 8790);
  // Private per-machine data. NOTE: ./data is the COMMITTED collector output
  // (public, read by the static dashboard) — the tracker's own snapshots,
  // caches, and portfolio live in ./local-data (gitignored).
  const DATA = opts.dataDir || process.env.SKIN_DATA || path.join(__dirname, "local-data");
  const COOKIE = opts.steamCookie != null ? opts.steamCookie : (process.env.STEAM_COOKIE || "");
  const SNAP_HOURS = opts.snapHours != null ? opts.snapHours
    : (process.env.SKIN_SNAP_HOURS != null ? Number(process.env.SKIN_SNAP_HOURS) : 6);
  fs.mkdirSync(path.join(DATA, "history"), { recursive: true });
  fs.mkdirSync(path.join(DATA, "import"), { recursive: true });
  fs.mkdirSync(path.join(DATA, "cache"), { recursive: true });

  // ── state (loaded fresh per instance — probe restarts must re-read disk) ──
  const wlFile = path.join(DATA, "watchlist.json");
  const pfFile = path.join(DATA, "portfolio.json");
  let watchlist = readJson(wlFile, null);
  if (!watchlist) {
    // first boot: seed the private watchlist from the repo's committed one,
    // so the dashboard opens populated instead of empty
    watchlist = (readJson(path.join(ROOT, "watchlist.json"), { items: [] }).items || []).slice();
    if (watchlist.length) writeJson(wlFile, watchlist);
  }
  let portfolio = readJson(pfFile, null) || [];
  const histCache = new Map(); // slug → parsed snapshot lines

  const seed = readJson(path.join(__dirname, "seed.json"), { items: [] }).items;

  function histFile(name) { return path.join(DATA, "history", slug(name) + ".jsonl"); }
  function importFile(name) { return path.join(DATA, "import", slug(name) + ".json"); }

  function snaps(name) {
    const key = slug(name);
    if (!histCache.has(key)) {
      const lines = [];
      try {
        for (const ln of fs.readFileSync(histFile(name), "utf8").split("\n")) {
          if (!ln.trim()) continue;
          try { lines.push(JSON.parse(ln)); } catch { /* torn line — skip, keep the rest */ }
        }
      } catch { /* no file yet */ }
      histCache.set(key, lines);
    }
    return histCache.get(key);
  }
  function appendSnap(name, snap) {
    const list = snaps(name);
    const last = [...list].reverse().find((s) => s.src === snap.src);
    if (last && snap.t - last.t < SNAP_DEDUPE_MS) return false;
    list.push(snap);
    fs.mkdirSync(path.dirname(histFile(name)), { recursive: true });
    fs.appendFileSync(histFile(name), JSON.stringify(snap) + "\n");
    return true;
  }

  // ── series assembly (canonical, shared with collector + browser) ─────────
  function dailyFor(name) {
    const imported = readJson(importFile(name), null);
    return A.assembleSeries(imported && imported.rows, snaps(name)).daily;
  }
  function skinportDaily(name) {
    return A.assembleSeries(null, snaps(name)).skinportDaily;
  }
  function latestSteam(name) {
    const s = snaps(name).filter((x) => x.src === "steam");
    return s.length ? s[s.length - 1] : null;
  }

  // ── skinport caches ──────────────────────────────────────────────────────
  const dumpFile = path.join(DATA, "cache", "skinport-items.json");
  function dumpCached() { return readJson(dumpFile, null); }
  async function refreshDumpIfStale() {
    const c = dumpCached();
    if (c && Date.now() - c.t < DUMP_TTL_MS) return c;
    try {
      const items = await M.skinportItems();
      const rec = { t: Date.now(), items };
      writeJson(dumpFile, rec);
      return rec;
    } catch (e) { return c; } // keep stale on failure
  }
  function salesFile(name) { return path.join(DATA, "cache", "skinport-sales-" + slug(name) + ".json"); }
  async function salesFor(name, allowFetch) {
    const c = readJson(salesFile(name), null);
    if (c && Date.now() - c.t < SALES_TTL_MS) return c.data;
    if (!allowFetch) return c ? c.data : null;
    try {
      const data = await M.skinportSalesHistory(name);
      writeJson(salesFile(name), { t: Date.now(), data });
      return data;
    } catch (e) { return c ? c.data : null; }
  }

  // ── snapshotting ─────────────────────────────────────────────────────────
  async function snapshotOne(name) {
    const out = { name, ok: false };
    try {
      const po = await M.steamPriceOverview(name, A);
      if (po) {
        out.appended = appendSnap(name, { t: po.t, src: "steam", price: po.price, lowest: po.lowest, vol: po.vol });
        out.steam = po; out.ok = true;
      } else out.error = "steam: item not found";
    } catch (e) { out.error = String(e.message || e); }
    try {
      const sales = await salesFor(name, true);
      const m24 = (sales && sales.last24h && sales.last24h.median) || null;
      const m30 = (sales && sales.last30d && sales.last30d.median) || null;
      if (m24 != null || m30 != null) {
        appendSnap(name, { t: Date.now(), src: "skinport", price: m24 != null ? m24 : m30,
          vol: sales.last24h ? sales.last24h.volume : null, sp30: m30 });
      }
      out.skinport = sales || null;
    } catch (e) { /* skinport optional */ }
    return out;
  }
  async function snapshotAll() {
    const results = [];
    for (const name of watchlist) results.push(await snapshotOne(name));
    return results;
  }

  let snapTimer = null;
  if (SNAP_HOURS > 0) {
    snapTimer = setInterval(() => {
      const newest = Math.max(0, ...watchlist.map((n) => { const l = latestSteam(n); return l ? l.t : 0; }));
      if (Date.now() - newest >= SNAP_HOURS * 3600 * 1000) snapshotAll().catch(() => {});
    }, 15 * 60 * 1000);
    snapTimer.unref();
  }

  // ── item report ──────────────────────────────────────────────────────────
  async function itemReport(name, allowFetch) {
    // DISPLAY-ONLY deep history: backtest/history extends the item series
    // strictly before its first collected/imported day (deepHistoryBase).
    // NEVER route this into dailyFor/marketReport — the live index and its
    // fixings start at adoption and are never backfilled.
    const deep = readJson(path.join(ROOT, "backtest", "history", slug(name) + ".json"), null);
    const deepRows = deep && Array.isArray(deep.rows)
      ? deep.rows.map((r) => ({ t: r[0], price: r[1], vol: r[2] })) : null;
    const imported = readJson(importFile(name), null);
    const snapRows = snaps(name);
    const base = A.deepHistoryBase(deepRows, imported && imported.rows, snapRows);
    const daily = A.assembleSeries(base, snapRows).daily;
    const deepDays = deepRows ? base.length - ((imported && imported.rows) ? imported.rows.length : 0) : 0;
    const analytics = A.analyze(daily);
    const last = latestSteam(name);
    const sales = await salesFor(name, false);
    const dump = dumpCached();
    const dumpRow = dump ? (dump.items || []).find((i) => i.name === name) : null;
    const steamGross = last ? last.price : analytics.latest;
    const spMedian = (sales && sales.last24h && sales.last24h.median)
      || (sales && sales.last7d && sales.last7d.median) || null;
    return {
      name,
      daily,
      skinportDaily: skinportDaily(name),
      analytics,
      snapshots: snapRows.length,
      imported: !!imported,
      deepDays: deepDays,
      watched: watchlist.includes(name),
      quote: last ? { t: last.t, price: last.price, lowest: last.lowest, vol: last.vol } : null,
      skinport: { sales: sales || null, ask: dumpRow ? dumpRow.min : null, qty: dumpRow ? dumpRow.qty : null },
      compare: {
        steam: { gross: steamGross, net: A.netProceeds(steamGross, "steam"), cash: false },
        skinport: { gross: spMedian, net: A.netProceeds(spMedian, "skinport"), cash: true },
      },
    };
  }

  const artSet = new Set(readJson(path.join(ROOT, "watchlist.json"), {}).art || []);
  function catOf(name) {
    if (/^Sticker \|/.test(name)) return "sticker";
    const s = seed.find((x) => x.name === name);
    if (s && s.cat) return s.cat;
    return /\b(Case|Package)$/.test(name) ? "case" : name.startsWith("★") ? "knife" : "skin";
  }
  function artDailyFor(name) {
    return A.toDaily(snaps(name).filter((l) => l.src === "skinport" && l.sp30 != null)
      .map((l) => ({ t: l.t, price: l.sp30 })), { volMode: "max" });
  }
  function watchSummary() {
    return watchlist.map((name) => {
      const daily = dailyFor(name);
      const an = A.analyze(daily);
      const last = latestSteam(name);
      // DISPLAY-ONLY spark backfill (mirrors the collector + itemReport's
      // deepHistoryBase discipline): deep closes fill the 14d sparkline when
      // collected history is short; `daily` itself never sees deep data.
      let sparkDaily = daily;
      if (daily.length < 14) {
        const deep = readJson(path.join(ROOT, "backtest", "history", slug(name) + ".json"), null);
        if (deep && Array.isArray(deep.rows) && deep.rows.length) {
          const deepRows = deep.rows.map((r) => ({ t: r[0], price: r[1], vol: r[2] }));
          const snapRows = snaps(name);
          const base = A.deepHistoryBase(deepRows, null, snapRows);
          sparkDaily = A.assembleSeries(base, snapRows).daily;
        }
      }
      const rowLatest = last ? last.price : an.latest;
      return {
        name,
        cat: catOf(name),
        tier: artSet.has(name) ? "art" : null,
        latest: rowLatest,
        vol24h: last ? last.vol : null,
        dvol: rowLatest != null && last && last.vol != null ? Math.round(rowLatest * last.vol) : null,
        t: last ? last.t : null,
        days: an.days,
        mom1: A.momentum(daily, 1), mom7: an.mom7, mom30: an.mom30,
        spark: sparkDaily.slice(-14).map((d) => d.price),
        verdict: an.signal.verdict, score: an.signal.score,
      };
    });
  }

  // market overview (Skindex / cash ratio / volume / players) —
  // same shared math the collector publishes for the static site
  // the watchlist as marketOverview's input — ONE builder, so the inventory
  // benchmark below reads the very same index the market report publishes
  function marketItems() {
    return watchlist.map((name) => {
      const imported = readJson(importFile(name), null);
      const s = A.assembleSeries(imported && imported.rows, snaps(name));
      const tier = artSet.has(name) ? "art" : null;
      return { name, cat: catOf(name), tier, daily: s.daily, skinportDaily: s.skinportDaily,
        artDaily: tier ? artDailyFor(name) : [] };
    });
  }
  async function marketReport() {
    const items = marketItems();
    const mkt = A.marketOverview(items);
    // INTEG-1 parity (assessIntegrity — one function, all surfaces): the live
    // tracker feeds the lanes it has — ratio + volume + staleness; the book and
    // sales-evidence lanes are collector-fed, so coverage strings honestly read
    // 0/n. Venue quotes are collector-fed too, so the WEAK tier reports 0/0
    // here rather than implying agreement.
    mkt.integrity = S.assessIntegrity(items.map((it) => {
      const spBy = new Map(it.skinportDaily.map((d) => [d.day, d.price]));
      const last = latestSteam(it.name);
      return {
        name: it.name, cat: it.cat, tier: it.tier,
        steamPrice: last ? last.price : null, quoteT: last ? last.t : null,
        salesT: null, sales30: null, book: null,
        ratioDays: it.daily.filter((d) => d.price > 0 && spBy.get(d.day) > 0)
          .map((d) => ({ day: d.day, r: spBy.get(d.day) / d.price })),
        // volume lane (strong tier): the tracker already assembles this exact
        // daily series for the index, so the lane runs on the live surface too
        volDays: it.daily.map((d) => ({ day: d.day, price: d.price, vol: d.vol })),
      };
    }), { now: Date.now() });
    const pf = path.join(DATA, "cache", "macro.json");
    let rec = readJson(pf, null);
    if (!rec || Date.now() - rec.t > 30 * 60 * 1000) {
      const next = { t: Date.now() };
      try { next.players = await M.steamPlayers(); } catch (e) { if (rec) next.players = rec.players; }
      try { const c = await M.cryptoPrices(); next.btc = c.btc; next.eth = c.eth; }
      catch (e) { if (rec) { next.btc = rec.btc; next.eth = rec.eth; } }
      rec = next;
      writeJson(pf, rec);
    }
    if (mkt.today && rec) {
      if (rec.players != null) mkt.today.players = rec.players;
      if (rec.btc != null) mkt.today.btc = rec.btc;
      if (rec.eth != null) mkt.today.eth = rec.eth;
    }
    // settlement fixings — live-mode parity with the collector (budget is
    // case-side only here; the collector's version carries sales coverage)
    const detail = S.computeAll(mkt.series);
    const wCase = (mkt.weights && mkt.weights.case) || {};
    const wLiq = (mkt.weights && mkt.weights.liq) || {};
    const budgetItems = watchlist.map((name) => {
      const last = latestSteam(name);
      return { cat: catOf(name), tier: artSet.has(name) ? "art" : null,
        latest: last ? last.price : null, vol24h: last ? last.vol : null,
        weight: wCase[name] != null ? wCase[name] : (wLiq[name] != null ? wLiq[name] : null),
        skinport: null };
    });
    const fix = { t: Date.now(), day: A.dayKey(Date.now()), methodology: S.METHODOLOGY, fixings: {}, budget: S.manipulationBudget(budgetItems) };
    for (const name of Object.keys(detail)) {
      const f = detail[name];
      fix.fixings[name] = { value: f.value, accruing: f.accruing || null,
        hash: crypto.createHash("sha256").update(S.canonical(f)).digest("hex") };
    }
    mkt.settlement = fix;
    return mkt;
  }

  function portfolioReport() {
    const lots = portfolio.map((lot) => {
      const last = latestSteam(lot.name);
      const daily = dailyFor(lot.name);
      const latest = last ? last.price : (daily.length ? daily[daily.length - 1].price : null);
      const cost = A.round2(lot.qty * lot.unitCost);
      const gross = latest != null ? A.round2(lot.qty * latest) : null;
      const netSteam = latest != null ? A.round2(lot.qty * A.netProceeds(latest, "steam")) : null;
      const netSkinport = latest != null ? A.round2(lot.qty * A.netProceeds(latest, "skinport")) : null;
      return Object.assign({}, lot, {
        latest, cost, gross, netSteam, netSkinport,
        pl: netSteam != null ? A.round2(netSteam - cost) : null,
        plPct: netSteam != null && cost > 0 ? A.round2((netSteam - cost) / cost * 100) : null,
      });
    });
    const sum = (k) => A.round2(lots.reduce((a, l) => a + (l[k] || 0), 0));
    return { lots, totals: { cost: sum("cost"), gross: sum("gross"), netSteam: sum("netSteam"), netSkinport: sum("netSkinport"), pl: sum("pl") } };
  }

  // ── Steam inventory ("load my inventory, chart its performance") ─────────
  // NO SIGN-IN: CS2 inventories are PUBLIC JSON, so all we ever need is a
  // profile URL / vanity name / SteamID64. Steam OpenID would only prove
  // identity (useless for a personal analytics tool) and needs a callback URL
  // the static Pages build can't have.
  //
  // DETERMINISM FIREWALL: this whole section is a DISPLAY/analytics layer,
  // exactly like the item-view deep history. Nothing here feeds dailyFor,
  // marketReport, the collector's published series, a fixing, or a hash — it
  // only READS them.
  // PRIVACY: a SteamID is personal data. It is stored under local-data/
  // (gitignored) and sent nowhere but Steam.
  const invFile = path.join(DATA, "inventory.json");
  const invSeriesFile = path.join(DATA, "inventory.jsonl");

  function invState() { const s = readJson(invFile, null); return s && typeof s === "object" ? s : {}; }

  // append-only {t,value,count,id,sig} — one line per load.
  //
  // IDENTITY (adversarial review): a value-over-time line is only meaningful
  // for ONE inventory. The field accepts any profile URL, so loading a second
  // profile used to EXTEND the same line — the panel then reported a delta and
  // an alpha across two different people's holdings ("SINCE FIRST LOAD −75%"
  // because the other person owns less). Every snapshot now carries who it
  // describes (`id` = the resolved SteamID64) and WHAT it describes (`sig` = a
  // digest of the name×qty composition), and a series joins like with like:
  //   · a resolved inventory keys on its SteamID64;
  //   · a paste with no id keys on its COMPOSITION — two different people's
  //     anonymous pastes can never share a line (the id is the binding we
  //     would normally use, and we simply do not have it);
  //   · rows written before this fix carry neither and share the legacy ""
  //     bucket — an honest one-time restart, disclosed in the report note,
  //     never a silent re-attribution.
  // `sig` also lets a consumer see that the BASKET changed between two points
  // (buying an item is not a return), which identity alone cannot express.
  function invSnapSig(rows) {
    // FNV-1a over "name×qty" in the rows' own (already total-ordered) order —
    // a fingerprint, not a secret: it never leaves the tracker's own answers
    // and cannot be turned back into an inventory.
    let h = 0x811c9dc5;
    const s = (rows || []).map((r) => r.name + "×" + r.qty).sort().join("|");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function invSnapKey(steamid64, sig) {
    const id = steamid64 == null ? "" : String(steamid64).trim();
    if (id) return "id:" + id;
    return sig ? "sig:" + sig : "";
  }
  function invSeriesRaw() {
    const out = [];
    try {
      for (const ln of fs.readFileSync(invSeriesFile, "utf8").split("\n")) {
        if (!ln.trim()) continue;
        try {
          const r = JSON.parse(ln);
          if (r && isFinite(r.t)) out.push({ t: r.t, value: r.value, count: r.count,
            id: r.id == null ? "" : String(r.id), sig: r.sig == null ? null : String(r.sig),
            legacy: r.id == null && r.sig == null });
        } catch { /* torn line — skip, keep the rest */ }
      }
    } catch { /* no file yet */ }
    return out.sort((a, b) => a.t - b.t);
  }
  // One point per 10-minute window, NEWEST wins. The file stays append-only
  // (nothing is ever rewritten or dropped on disk) and the collapse happens on
  // READ — the browser's localStorage series already kept the newest value in
  // the window while the server kept the FIRST and silently discarded the
  // correction, so the two surfaces printed different lines from the same
  // loads. Newest wins on both now: a re-read is a better reading of the same
  // moment, not a second moment.
  function invCollapse(list) {
    const out = [];
    for (const r of list) {
      const prev = out.length ? out[out.length - 1] : null;
      if (prev && r.t - prev.t < INV_SNAP_DEDUPE_MS) out[out.length - 1] = r;
      else out.push(r);
    }
    return out;
  }
  function invSeries(key) {
    const k = key == null ? "" : String(key);
    const mine = invSeriesRaw().filter((r) => invSnapKey(r.id, r.sig) === k);
    // the id never rides back out on the wire — the caller already knows whose
    // inventory it asked for, and a series is display data
    return invCollapse(mine).map((r) => ({ t: r.t, value: r.value, count: r.count, sig: r.sig }));
  }
  function invLegacyCount() { return invSeriesRaw().filter((r) => r.legacy).length; }
  function invAppendSnap(snap) {
    fs.mkdirSync(path.dirname(invSeriesFile), { recursive: true });
    fs.appendFileSync(invSeriesFile, JSON.stringify(snap) + "\n");
    return true;
  }

  // slugs we hold marks for — ONE readdir instead of a stat per inventory item
  // (a 5000-item inventory would otherwise be 5000 misses).
  function trackedSlugs() {
    const set = new Set();
    for (const [dir, ext] of [["history", ".jsonl"], ["import", ".json"]]) {
      try {
        for (const f of fs.readdirSync(path.join(DATA, dir)))
          if (f.endsWith(ext)) set.add(f.slice(0, -ext.length));
      } catch { /* dir may not exist yet */ }
    }
    return set;
  }
  function deepSlugs() {
    const set = new Set();
    try {
      for (const f of fs.readdirSync(path.join(ROOT, "backtest", "history")))
        if (f.endsWith(".json")) set.add(f.slice(0, -5));
    } catch { /* no committed deep history */ }
    return set;
  }

  // priceOf(name) → number|null. NEVER fabricates: an item we hold no mark for
  // and that isn't listed on Skinport comes back null and is reported unpriced.
  //   1. our own tracked marks (latest steam quote → merged daily close →
  //      skinport 30d median for grails above Steam's ~$1,800 listing cap)
  //   2. the cached Skinport universe dump (lowest ask, else median)
  //   3. null
  function invPricer() {
    const tracked = trackedSlugs();
    const dumpBy = new Map();
    const dump = dumpCached();
    if (dump) for (const i of dump.items || []) if (i && i.name) dumpBy.set(i.name, i);
    return function priceOf(name) {
      if (tracked.has(slug(name))) {
        const last = latestSteam(name);
        if (last && last.price > 0) return last.price;
        const d = dailyFor(name);
        if (d.length && d[d.length - 1].price > 0) return d[d.length - 1].price;
        const art = artDailyFor(name);
        if (art.length && art[art.length - 1].price > 0) return art[art.length - 1].price;
      }
      const row = dumpBy.get(name);
      if (row) {
        if (row.min > 0) return row.min;
        if (row.median > 0) return row.median;
      }
      return null;
    };
  }

  // historyOf(name) → [{day,price}] | null — the item's own collected series,
  // extended by the committed deep-history file exactly the way the item view
  // does it (deepHistoryBase: strictly BEFORE the first collected day, never
  // overriding a collected mark). Display-only, same as itemReport.
  function invHistorian() {
    const tracked = trackedSlugs();
    const deep = deepSlugs();
    return function historyOf(name) {
      const sg = slug(name);
      const hasDeep = deep.has(sg);
      if (!tracked.has(sg) && !hasDeep) return null;
      const deepJson = hasDeep ? readJson(path.join(ROOT, "backtest", "history", sg + ".json"), null) : null;
      const deepRows = deepJson && Array.isArray(deepJson.rows)
        ? deepJson.rows.map((r) => ({ t: r[0], price: r[1], vol: r[2] })) : null;
      const imported = readJson(importFile(name), null);
      const snapRows = snaps(name);
      const base = A.deepHistoryBase(deepRows, imported && imported.rows, snapRows);
      let daily = A.assembleSeries(base, snapRows).daily;
      if (!daily.length) daily = artDailyFor(name); // grails mark to skinport
      return daily.length ? daily.map((d) => ({ day: d.day, price: d.price })) : null;
    };
  }

  // alpha vs the Skindex over the reconstruction's own span. benchmarkGrowth
  // (the portfolio's number) does the index lookup: one "lot" = the
  // reconstruction's opening value on its opening day. The index series is
  // truncated at the reconstruction's last day so both legs measure the SAME
  // window; lots predating the index clamp to inception (documented there).
  // LIKE-FOR-LIKE alpha. Both legs must cover the same window over the same
  // basket, or the number is fiction: opening before the basket is whole
  // books an item ENTERING the reconstruction as a gain, and opening before
  // the index exists makes benchmarkGrowth clamp ITS leg to inception while
  // the inventory leg runs longer. spanDays is a DURATION, not a count of
  // marked days (sparse marks made a 2-year window print "3").
  function invBenchmark(recon) {
    if (!recon || !Array.isArray(recon.days) || recon.days.length < 2) return null;
    let series = [];
    try { series = A.marketOverview(marketItems()).series || []; } catch (e) { return null; }
    if (!series.length) return null;
    const from = [recon.fullFrom || recon.days[0].day, series[0].day].reduce((a, b) => (a > b ? a : b));
    const win = recon.days.filter((d) => d.day >= from);
    if (win.length < 2) return null;
    const first = win[0], last = win[win.length - 1];
    if (!(first.value > 0) || last.value == null) return null;
    const span = series.filter((s) => s && s.day <= last.day);
    if (!span.length) return null;
    const bg = A.benchmarkGrowth([{ t: Date.parse(first.day + "T00:00:00Z"), cost: first.value }], span);
    if (bg.idxPct == null) return null;
    const invPct = Math.round((last.value / first.value - 1) * 1000) / 10;
    return { idxPct: bg.idxPct, invPct: invPct,
      alpha: Math.round((invPct - bg.idxPct) * 10) / 10,
      spanDays: Math.max(0, Math.round(
        (Date.parse(last.day + "T00:00:00Z") - Date.parse(first.day + "T00:00:00Z")) / 86400000)),
      from: first.day, to: last.day };
  }

  // paste → inventory, through the SHARED join when market.js carries it (one
  // implementation for fetched and pasted alike), else the local fallback.
  function invParsePaste(raw) {
    if (typeof M.parseSteamInventory !== "function") return parseInventoryPayload(raw);
    let j = raw;
    if (typeof j === "string") {
      try { j = JSON.parse(j); } catch (e) {
        throw invErr(400, "that paste isn't valid JSON — open the inventory URL in your browser and copy the WHOLE page");
      }
    }
    let p;
    // the SAME cap the fetcher asks Steam for: a paste is unbounded user input
    // and this server is single-threaded
    try { p = M.parseSteamInventory(j, null, INV_PASTE_MAX_ASSETS); }
    catch (e) { throw e.httpStatus ? e : invErr(400, String((e && e.message) || e)); }
    if (!p || !Array.isArray(p.items) || !p.items.length)
      // "nothing joined" is a DIFFERENT user fix from "no CS2 items in here":
      // it means the descriptions half of the payload is missing
      throw invErr(400, p && p.unknown
        ? "none of the " + p.unknown + " items in that JSON matched a description — select ALL of the inventory page and copy it whole"
        : "no CS2 items found in that paste — check you copied the whole 730/2 inventory response");
    return p;
  }

  async function invResolve(raw) {
    if (typeof M.resolveSteamProfile === "function") {
      let r;
      try { r = await M.resolveSteamProfile(raw); }
      catch (e) { throw e.httpStatus ? e : invErr(invResolveStatus(e && e.message), String((e && e.message) || e)); }
      if (!r || !/^\d{17}$/.test(String(r.steamid64 || "")))
        throw invErr(404, "couldn't find a Steam profile for \"" + raw + "\" — check the URL, or paste your 17-digit SteamID64");
      return { steamid64: String(r.steamid64), vanity: r.vanity || null, source: r.source || "resolved" };
    }
    // graceful degradation when the data layer hasn't landed: a bare
    // SteamID64 needs no resolution at all
    if (/^\d{17}$/.test(raw)) return { steamid64: raw, vanity: null, source: "steamid64" };
    throw invErr(502, "this build can't look up profile names yet — paste your 17-digit SteamID64 instead");
  }
  async function invFetch(steamid64) {
    if (typeof M.steamInventory !== "function")
      throw invErr(502, "this build is missing the Steam inventory reader — update market.js and restart the tracker");
    let inv;
    try { inv = await M.steamInventory(steamid64, { appid: 730, count: 5000 }); }
    catch (e) { throw e.httpStatus ? e : invErr(invFetchStatus(e && e.message), String((e && e.message) || e)); }
    if (!inv || !Array.isArray(inv.items))
      throw invErr(502, "Steam returned no readable inventory for " + steamid64);
    return inv;
  }

  // INV_REPORT — the frozen shape, identical for live and pasted inventories.
  async function inventoryReport(input) {
    for (const fn of ["inventoryValue", "inventoryReconstruction"]) {
      if (typeof A[fn] !== "function")
        throw invErr(502, "this build is missing the inventory analytics (" + fn + ") — update analytics.js and restart the tracker");
    }
    const state = invState();
    const raw = input.profile != null ? String(input.profile).trim() : "";
    let inv, cached = false, fetchedAt = Date.now(), steamid64 = null, source = "steam";
    let profile = raw || state.profile || null;

    if (input.paste != null) {
      inv = invParsePaste(input.paste);
      source = "paste";
      steamid64 = /^\d{17}$/.test(raw) ? raw : (inv.steamid64 || null);
      profile = raw || steamid64 || "pasted inventory";
    } else {
      const c = state.cache;
      const fresh = c && c.items && Date.now() - c.t < INV_TTL_MS;
      // A CACHED READ MAKES NO NETWORK CALL — not even the vanity resolve, so
      // the cache genuinely shields Steam's IP rate limit.
      if (!input.force && fresh && (!raw || c.input === raw || c.steamid64 === raw)) {
        inv = { steamid64: c.steamid64, count: c.count, items: c.items, truncated: !!c.truncated };
        steamid64 = c.steamid64; profile = c.profile || profile; cached = true; fetchedAt = c.t;
      } else {
        if (!raw && !state.profile)
          throw invErr(400, "give me a Steam profile URL, vanity name, or 17-digit SteamID64 — no sign-in, no password, no API key, public inventory data only");
        const target = raw || state.profile;
        const resolved = await invResolve(target);
        steamid64 = resolved.steamid64;
        profile = target;
        if (!input.force && fresh && c.steamid64 === steamid64) {
          inv = { steamid64: c.steamid64, count: c.count, items: c.items, truncated: !!c.truncated };
          cached = true; fetchedAt = c.t;
        } else {
          inv = await invFetch(steamid64);
          fetchedAt = Date.now();
          // A payload whose assets joined NOTHING is a broken read, not an
          // empty inventory: Steam sent the assets half without the
          // descriptions half. Reported as a cheerful "$0 · 0 items" it
          // poisoned two things at once — the 10-minute cache (so the next
          // read repeated the lie) and the APPEND-ONLY snapshot series (a $0
          // point that nothing can delete). Refuse before either is written.
          if (!inv.items.length && inv.unknown > 0)
            throw invErr(502, inv.unknown + " assets came back with no matching description — " +
              "Steam served a partial payload. Try again in a minute.");
        }
      }
      // only a real Steam read refreshes the fetch cache — a paste is the
      // user's own copy of the data, not evidence about the live inventory
      if (!cached)
        state.cache = { t: fetchedAt, input: raw || profile, profile: profile, steamid64: steamid64,
          count: inv.count, items: inv.items, truncated: !!inv.truncated,
          truncatedBy: inv.truncatedBy || null, unknown: inv.unknown || 0 };
      else if (c) { inv.truncatedBy = c.truncatedBy || null; inv.unknown = c.unknown || 0; }
    }

    const priceOf = invPricer();
    const value = A.inventoryValue(inv.items, priceOf);
    const historyOf = invHistorian();
    let recon = A.inventoryReconstruction(inv.items, historyOf,
      { priceOf: priceOf, total: value.total, now: Date.now() });
    if (!recon || !Array.isArray(recon.days)) // frozen shape holds even if a name has no history at all
      recon = { days: [], coveragePct: 0, pricedNames: 0, totalNames: inv.items.length };
    const count = inv.count != null ? inv.count : inv.items.reduce((a, i) => a + (i.qty || 0), 0);
    // WHOSE line is this, and WHAT was in it (see invSnapKey): without both,
    // a second profile's holdings extended the first one's value line
    const sig = invSnapSig(value.rows);
    const seriesKey = invSnapKey(steamid64, sig);
    const legacyPoints = invLegacyCount();
    invAppendSnap({ t: Date.now(), value: value.total, count: count,
      id: steamid64 || "", sig: sig });

    const types = value.pricedCount + value.unpricedCount;
    const note = [
      "No sign-in, no password, no API key — public inventory data only.",
      cached ? "Cached read from " + Math.round((Date.now() - fetchedAt) / 60000) + " min ago (Steam rate-limits inventory reads, so they are cached for 10 minutes)."
        : source === "paste" ? "Read from pasted inventory JSON — nothing left this machine."
          : "Fresh read of the public Steam inventory.",
      "Priced " + value.pricedCount + " of " + types + " item types" +
        (value.unpricedCount ? " — " + value.unpricedCount + " have no tracked mark and no Skinport listing, so they are reported unpriced, never guessed." : "."),
      recon.days.length
        ? "Reconstruction covers " + recon.coveragePct + "% of today's value (" + recon.pricedNames + " of " + recon.totalNames + " names have usable history)."
        : "No usable price history behind these items yet — track them to start accruing one.",
      // ONE flag used to blame Steam's 5000-item page cap for all three
      // truncation causes — including a payload of eleven items
      inv.truncatedBy === "cap"
        ? "Only the first " + INV_PASTE_MAX_ASSETS + " items were read — this inventory is truncated."
        : inv.truncatedBy === "more_items"
          ? "Steam has more pages of this inventory — only the first is included."
          : inv.truncatedBy === "short_payload"
            ? "Steam returned fewer items than it declared — reload to try again."
            : inv.truncated ? "This inventory came back truncated — some items are missing." : "",
      inv.unknown ? inv.unknown + " assets had no matching description and were skipped." : "",
      // the identity fix restarts any line recorded before it existed — say
      // so rather than letting the chart look like the history was lost
      legacyPoints && seriesKey !== "" ? "Your value line starts here: " + legacyPoints +
        " earlier load" + (legacyPoints === 1 ? " was" : "s were") + " recorded before loads were tagged with a profile." : "",
    ].filter(Boolean).join(" ");

    // a paste without an id must NOT overwrite the last KNOWN profile (the
    // next "refresh" would have nothing resolvable to go back to)
    if (source !== "paste" || steamid64) { state.profile = profile; state.steamid64 = steamid64; }
    state.seriesKey = seriesKey;    // so GET …/series replays THIS inventory's line
    state.last = { t: Date.now(), profile: profile, steamid64: steamid64, source: source,
      count: count, total: value.total, coveragePct: recon.coveragePct };
    writeJson(invFile, state);

    return { steamid64: steamid64, profile: profile, fetchedAt: fetchedAt, cached: cached,
      count: count, value: value, recon: recon, series: invSeries(seriesKey),
      benchmark: invBenchmark(recon), note: note };
  }

  // ── search ───────────────────────────────────────────────────────────────
  function search(q) {
    q = String(q || "").trim().toLowerCase();
    const dump = dumpCached();
    const uni = new Map();
    for (const s of seed) uni.set(s.name, { name: s.name, cat: s.cat, price: null, qty: null });
    if (dump) for (const i of dump.items || []) {
      const prev = uni.get(i.name);
      uni.set(i.name, { name: i.name, cat: prev ? prev.cat : null, price: i.min, qty: i.qty });
    }
    const toks = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const it of uni.values()) {
      const lo = it.name.toLowerCase();
      if (toks.length && !toks.every((t) => lo.includes(t))) continue;
      let sc = 0;
      if (toks.length && lo.startsWith(toks[0])) sc += 100;
      sc += Math.min(50, (it.qty || 0) / 20);
      if (watchlist.includes(it.name)) sc += 5;
      scored.push([sc, it]);
    }
    scored.sort((a, b) => b[0] - a[0] || (a[1].name < b[1].name ? -1 : 1));
    return scored.slice(0, 25).map(([, it]) => Object.assign({ watched: watchlist.includes(it.name) }, it));
  }

  // ── CORS: an ALLOWLIST, never "*" ────────────────────────────────────────
  // This API answers with personal data — the portfolio's lots and cost
  // basis, and (since the inventory routes) a SteamID64 plus every item the
  // user owns. A wildcard ACAO let ANY page the user happened to have open
  // read all of it with a plain no-preflight GET, and let a simple
  // text/plain POST rewrite server state (CSRF) — reproduced end-to-end
  // before this fix. Allowed: the GitHub Pages origin the static dashboard
  // is served from, any localhost/127.0.0.1 port (the dashboard served by
  // this very tracker, or a dev copy), plus anything explicitly configured
  // in SKIN_ALLOW_ORIGIN. Everything else gets no ACAO header AND, because
  // omitting the header still lets the REQUEST run server-side, a 403
  // before any handler executes.
  const ALLOW_EXTRA = String(process.env.SKIN_ALLOW_ORIGIN || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  function corsOrigin(req) {
    const o = req.headers && req.headers.origin;
    if (!o) return null;                       // same-origin / curl / server-to-server
    if (ALLOW_EXTRA.indexOf(o) >= 0) return o;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o)) return o;
    if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(o)) return o;
    return null;
  }
  function corsAllowed(req) { return !(req.headers && req.headers.origin) || !!corsOrigin(req); }

  // ── http plumbing ────────────────────────────────────────────────────────
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    const head = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin",
    };
    // set per-request in the handler; absent → no ACAO → a foreign page
    // cannot read the response even if it somehow reached us
    if (res._allowOrigin) head["Access-Control-Allow-Origin"] = res._allowOrigin;
    res.writeHead(code, head);
    res.end(body);
  }
  // inventory failures answer in plain English with the right status — the
  // user reads this string, so it never carries a stack trace or a raw HTTP code
  function invFail(res, e) {
    const msg = String((e && e.message) || e || "inventory read failed");
    return sendJson(res, (e && e.httpStatus) || invFetchStatus(msg), { error: msg });
  }
  // OVER-CAP MUST STILL ANSWER IN WORDS: this used to req.destroy() in the
  // same tick it rejected, so the socket died before the handler could write
  // the plain-English 400 — the user got ECONNRESET ("network error") and the
  // message we wrote for them was unreachable code. Now the upload is PAUSED
  // (we stop reading, so nothing more is buffered — the cap still holds) and
  // the socket is closed only once the reply has actually gone out.
  function readBody(req, maxBytes, res) {
    const cap = maxBytes || 4 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let size = 0, over = false; const chunks = [];
      req.on("data", (c) => {
        if (over) return;
        size += c.length;
        if (size > cap) {
          over = true;
          req.pause();
          chunks.length = 0;                                   // drop what we buffered
          if (res) res.on("finish", () => { try { req.destroy(); } catch (e) { /* already gone */ } });
          reject(new Error("body too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (over) return;
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
        catch (e) { reject(new Error("bad json")); }
      });
      req.on("error", (e) => { if (!over) reject(e); });
    });
  }
  const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2" };
  function serveStatic(req, res, pathname) {
    if (pathname === "/") pathname = "/index.html";
    // /data (collector output) is public by design; the PRIVATE dir and
    // dotfiles are not.
    if (pathname.startsWith("/local-data/") || pathname.split("/").some((seg) => seg.startsWith(".")))
      { res.writeHead(403); res.end(); return; }
    const fp = path.join(ROOT, path.normalize(pathname).replace(/^([.][.][/\\])+/, ""));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    try {
      // Resolve the caller's origin ONCE per request. A foreign origin is
      // refused outright on the API surface: withholding the ACAO header
      // stops the page READING the answer, but the request would still have
      // RUN — which is how the CSRF write (a no-preflight text/plain POST
      // that repointed the stored profile) worked.
      res._allowOrigin = corsOrigin(req);
      if (p.indexOf("/api/") === 0 && !corsAllowed(req)) {
        return sendJson(res, 403, { error: "cross-origin request refused — this tracker only answers its own dashboard" });
      }
      if (req.method === "OPTIONS") {
        if (!res._allowOrigin) { res.writeHead(403); return res.end(); }
        res.writeHead(204, { "Access-Control-Allow-Origin": res._allowOrigin, "Vary": "Origin",
          "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
        return res.end();
      }
      if (p === "/api/skins/health") {
        return sendJson(res, 200, { ok: 1, watch: watchlist.length, lots: portfolio.length, port: PORT, steamCookie: !!COOKIE, snapHours: SNAP_HOURS, dumpCached: !!dumpCached() });
      }
      if (p === "/api/skins/search") return sendJson(res, 200, { results: search(u.searchParams.get("q")) });
      if (p === "/api/skins/watchlist") return sendJson(res, 200, { items: watchSummary() });
      if (p === "/api/skins/market") return sendJson(res, 200, await marketReport());
      if (p === "/api/skins/item") {
        const name = u.searchParams.get("name");
        if (!name) return sendJson(res, 400, { error: "name required" });
        return sendJson(res, 200, await itemReport(name));
      }
      if (p === "/api/skins/portfolio") return sendJson(res, 200, portfolioReport());
      if (p === "/api/skins/inventory/series") {
        const st = invState();
        // the LAST loaded inventory's own line (never every profile's points
        // concatenated) — pre-fix state has no key, so fall back to its id
        return sendJson(res, 200, { series: invSeries(st.seriesKey || invSnapKey(st.steamid64, null)) });
      }
      // The privacy control that makes the panel's copy honest: erase the
      // SteamID, the cached inventory and the whole recorded value series
      // from this machine. Without it the tracker keeps personal data with
      // no way to withdraw it. Destructive, so POST only.
      if (p === "/api/skins/inventory/forget") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to erase stored inventory data" });
        let points = 0;
        try { points = invSeriesRaw().length; } catch (e) { points = 0; }
        try { fs.unlinkSync(invSeriesFile); } catch (e) { /* already gone */ }
        try { fs.unlinkSync(invFile); } catch (e) { /* already gone */ }
        return sendJson(res, 200, { ok: 1, cleared: points,
          note: "stored SteamID, cached inventory and recorded value history erased from this tracker" });
      }
      if (p === "/api/skins/inventory" && req.method !== "POST") {
        try { return sendJson(res, 200, await inventoryReport({ profile: u.searchParams.get("profile") })); }
        catch (e) { return invFail(res, e); }
      }

      if (req.method !== "POST") { serveStatic(req, res, p); return; }
      let body;
      try { body = await readBody(req, p === "/api/skins/inventory" ? INV_BODY_MAX : 0, res); }
      catch (e) {
        return sendJson(res, 400, { error: /too large/.test(String(e && e.message))
          ? "that upload is too large — a Steam inventory paste is a few MB, this one is over " +
            Math.round(INV_BODY_MAX / (1024 * 1024)) + " MB"
          : "the request body wasn't valid JSON" });
      }

      if (p === "/api/skins/inventory") {
        // {profile} = force a fresh read · {paste} = raw inventory JSON
        try {
          return sendJson(res, 200, await inventoryReport({
            profile: body.profile, paste: body.paste != null ? body.paste : null,
            force: body.paste == null,
          }));
        } catch (e) { return invFail(res, e); }
      }

      if (p === "/api/skins/watch") {
        const name = String(body.name || "").slice(0, 200);
        if (!name) return sendJson(res, 400, { error: "name required" });
        if (body.remove) watchlist = watchlist.filter((n) => n !== name);
        else if (!watchlist.includes(name)) {
          if (watchlist.length >= 200) return sendJson(res, 400, { error: "watchlist cap (200)" });
          watchlist.push(name);
        }
        writeJson(wlFile, watchlist);
        return sendJson(res, 200, { ok: 1, watchlist });
      }
      if (p === "/api/skins/refresh") {
        refreshDumpIfStale().catch(() => {});
        const name = body.name ? String(body.name) : null;
        if (name) return sendJson(res, 200, { results: [await snapshotOne(name)] });
        return sendJson(res, 200, { results: await snapshotAll() });
      }
      if (p === "/api/skins/bootstrap") {
        const name = String(body.name || "");
        if (!name) return sendJson(res, 400, { error: "name required" });
        if (!COOKIE) return sendJson(res, 400, { error: "no STEAM_COOKIE configured — use Import (paste) instead" });
        try {
          const rows = await M.steamPriceHistory(name, COOKIE);
          if (!rows || !rows.length) return sendJson(res, 502, { error: "steam returned no history (cookie valid?)" });
          writeJson(importFile(name), { t: Date.now(), source: "steam-cookie", rows });
          histCache.delete(slug(name));
          return sendJson(res, 200, { ok: 1, rows: rows.length, daily: dailyFor(name).length });
        } catch (e) { return sendJson(res, 502, { error: String(e.message || e) }); }
      }
      if (p === "/api/skins/import") {
        const name = String(body.name || "");
        if (!name) return sendJson(res, 400, { error: "name required" });
        const rows = M.normalizeHistoryRows(body.prices);
        if (!rows.length) return sendJson(res, 400, { error: "no parseable rows — expected [[\"Dec 06 2013 01: +0\", 4.29, \"117\"], ...]" });
        writeJson(importFile(name), { t: Date.now(), source: "paste", rows });
        return sendJson(res, 200, { ok: 1, rows: rows.length, daily: dailyFor(name).length });
      }
      if (p === "/api/skins/lot") {
        if (body.remove) {
          portfolio = portfolio.filter((l) => l.id !== body.remove);
        } else {
          const name = String(body.name || "").slice(0, 200);
          const qty = Number(body.qty), unitCost = Number(body.unitCost);
          if (!name || !isFinite(qty) || qty <= 0 || !isFinite(unitCost) || unitCost < 0)
            return sendJson(res, 400, { error: "need name, qty>0, unitCost>=0" });
          if (portfolio.length >= 500) return sendJson(res, 400, { error: "portfolio cap (500)" });
          portfolio.push({ id: crypto.randomBytes(6).toString("hex"), name, qty, unitCost, note: String(body.note || "").slice(0, 200), addedAt: Date.now() });
        }
        writeJson(pfFile, portfolio);
        return sendJson(res, 200, portfolioReport());
      }
      return sendJson(res, 404, { error: "unknown endpoint" });
    } catch (e) {
      return sendJson(res, 500, { error: String((e && e.message) || e) });
    }
  });

  // Loopback by default: this is a personal tracker holding a SteamID, a
  // portfolio and an inventory, and it was binding 0.0.0.0 — reachable by
  // every device on the network. SKIN_HOST (or opts.host) re-opens it
  // deliberately for anyone who actually wants LAN access.
  server.listen(PORT, opts.host || process.env.SKIN_HOST || "127.0.0.1");
  return {
    server,
    port: PORT,
    dataDir: DATA,
    close() { if (snapTimer) clearInterval(snapTimer); return new Promise((r) => server.close(r)); },
  };
}

if (require.main === module) {
  const inst = startServer();
  console.log("[skins] tracker on http://localhost:" + inst.port + "  (data: " + inst.dataDir + ")");
  console.log("[skins] STEAM_COOKIE " + (process.env.STEAM_COOKIE ? "set — full-history bootstrap enabled" : "not set — use paste-import for history"));
}

module.exports = { startServer, slug, parseInventoryPayload };
