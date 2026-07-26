// ─── skins/market.js — CS skin marketplace data sources (Node only) ────────
// Zero-dependency fetch layer for the skin tracker. Every network call goes
// through `transport(url, headers)` which the probe REPLACES with a fixture
// (setTransport) — so tests never touch the internet and CI stays hermetic.
//
// Sources (all normalized to USD):
//   Steam priceoverview — live lowest/median price + trailing-24h volume.
//     Public, no auth. ~1 req / 3.5s politeness gap enforced here.
//   Steam pricehistory  — full multi-year daily history. Requires a logged-in
//     Steam cookie (env STEAM_COOKIE="steamLoginSecure=..."); without it the
//     endpoint 400s and we simply skip bootstrap.
//   Skinport /v1/items  — full item dump (min/median prices) for search +
//     cross-market compare. Public but brotli-only and rate-limited hard
//     (8 req / 5 min) → cached on disk, TTL 30 min.
//   Skinport /v1/sales/history — realized-sale aggregates (24h/7d/30d/90d).
"use strict";
const https = require("https");
const zlib = require("zlib");

const APP_ID = 730; // Counter-Strike 2
const UA = "hashmark-heroes-skin-tracker/1.0 (personal research tool)";

// ── transport (injectable) ─────────────────────────────────────────────────
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({
        "User-Agent": UA,
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "br, gzip",
      }, headers || {}),
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let body = Buffer.concat(chunks);
        try {
          const enc = String(res.headers["content-encoding"] || "");
          if (enc.includes("br")) body = zlib.brotliDecompressSync(body);
          else if (enc.includes("gzip")) body = zlib.gunzipSync(body);
          else if (enc.includes("deflate")) body = zlib.inflateSync(body);
        } catch (e) { return reject(new Error("decompress: " + e.message)); }
        resolve({ status: res.statusCode, body: body.toString("utf8") });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

let transport = httpGet;
function setTransport(fn) { transport = fn || httpGet; }

// ── politeness gap per host (Steam bans hot loops) ─────────────────────────
const lastHit = new Map();
const GAPS = { "steamcommunity.com": 3500, "api.skinport.com": 2000 };
async function polite(url, headers) {
  const host = new URL(url).host;
  const gap = GAPS[host] || 0;
  const wait = (lastHit.get(host) || 0) + gap - Date.now();
  if (wait > 0 && transport === httpGet) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
  return transport(url, headers);
}

function enc(name) { return encodeURIComponent(name); }

// ── Steam ──────────────────────────────────────────────────────────────────
// → { t, price (median), lowest, vol } | null on failure
async function steamPriceOverview(name, A) {
  const url = "https://steamcommunity.com/market/priceoverview/?appid=" + APP_ID +
    "&currency=1&market_hash_name=" + enc(name);
  const res = await polite(url);
  if (res.status !== 200) throw new Error("steam priceoverview HTTP " + res.status);
  const j = JSON.parse(res.body);
  if (!j || !j.success) return null;
  const price = A.parseMoney(j.median_price != null ? j.median_price : j.lowest_price);
  if (price == null) return null;
  return {
    t: Date.now(), price: price,
    lowest: A.parseMoney(j.lowest_price),
    vol: j.volume != null ? A.parseCount(j.volume) : null,
  };
}

// ── Steam order book (the SECOND read path — INTEG-1 corroboration) ────────
// Wash trades can fake the last-sale median (priceoverview), but the STANDING
// order book is committed capital: faking it means posting real buy/sell
// orders that can get filled. Reading both paths forces a manipulator to move
// them consistently. The histogram endpoint needs Steam's internal item_nameid
// (NOT the market_hash_name) — scraped once from the public listing page and
// cached forever (data/steam-nameids.json).
//
// TRAPS (learned from the live payload shape — keep these):
//   highest_buy_order / lowest_sell_order are STRING CENTS ("5342" = $53.42);
//   buy_order_graph / sell_order_graph rows are [price_DOLLARS, CUMULATIVE
//   qty, label] — dollars, not cents, and cumulative, not per-level.
async function steamItemNameId(name) {
  const url = "https://steamcommunity.com/market/listings/" + APP_ID + "/" + enc(name);
  const res = await polite(url);
  if (res.status !== 200) throw new Error("steam listing page HTTP " + res.status);
  const m = /Market_LoadOrderSpread\(\s*(\d+)\s*\)/.exec(res.body) || /item_nameid=(\d+)/.exec(res.body);
  return m ? Number(m[1]) : null;
}

// → { t, bid, ask, mid, spreadPct, bidQty5, askQty5, bidUsd5, askUsd5 } | null
// Depth = cumulative units within ±5% of mid; usd ≈ qty × mid (approximation,
// published as surveillance evidence — never a settlement input).
async function steamOrderBook(nameId) {
  const url = "https://steamcommunity.com/market/itemordershistogram?country=US&language=english" +
    "&currency=1&item_nameid=" + nameId + "&two_factor=0";
  const res = await polite(url);
  if (res.status !== 200) throw new Error("steam histogram HTTP " + res.status);
  const j = JSON.parse(res.body);
  if (!j || j.success !== 1) return null;
  const cents = (v) => { const n = parseInt(v, 10); return isFinite(n) && n > 0 ? n / 100 : null; };
  const bid = cents(j.highest_buy_order), ask = cents(j.lowest_sell_order);
  if (bid == null && ask == null) return null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid != null ? bid : ask);
  const depth = (graph, side) => {
    if (!Array.isArray(graph)) return null;
    let q = null;
    for (const row of graph) {
      if (!Array.isArray(row) || !isFinite(row[0]) || !isFinite(row[1])) continue;
      const inRange = side === "buy" ? row[0] >= mid * 0.95 : row[0] <= mid * 1.05;
      if (inRange) q = Math.max(q || 0, row[1]); // cumulative → deepest in-range row wins
    }
    return q;
  };
  const bidQty5 = depth(j.buy_order_graph, "buy"), askQty5 = depth(j.sell_order_graph, "sell");
  return {
    t: Date.now(), bid: bid, ask: ask, mid: Math.round(mid * 100) / 100,
    spreadPct: bid != null && ask != null && mid > 0 ? Math.round(((ask - bid) / mid) * 1000) / 10 : null,
    bidQty5: bidQty5, askQty5: askQty5,
    bidUsd5: bidQty5 != null ? Math.round(bidQty5 * mid) : null,
    askUsd5: askQty5 != null ? Math.round(askQty5 * mid) : null,
  };
}

// "Dec 06 2013 01: +0" → ms epoch (UTC)
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseSteamDate(s) {
  const m = /^(\w{3}) (\d{2}) (\d{4}) (\d{2}):/.exec(String(s));
  if (!m || !(m[1] in MONTHS)) return null;
  return Date.UTC(Number(m[3]), MONTHS[m[1]], Number(m[2]), Number(m[4]));
}

// Rows: [dateStr, price, "volume"] — the shape Steam's pricehistory endpoint
// returns AND the shape a user can paste from their own logged-in browser.
function normalizeHistoryRows(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows.slice(0, 40000) : []) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const t = parseSteamDate(r[0]);
    const price = Number(r[1]);
    const vol = r.length > 2 ? Number(r[2]) : null;
    if (t == null || !isFinite(price) || price <= 0) continue;
    out.push({ t: t, price: price, vol: isFinite(vol) ? vol : null });
  }
  return out;
}

// Full history — needs STEAM_COOKIE. → [{t,price,vol}] | null when no cookie.
async function steamPriceHistory(name, cookie) {
  if (!cookie) return null;
  const url = "https://steamcommunity.com/market/pricehistory/?appid=" + APP_ID +
    "&market_hash_name=" + enc(name);
  const res = await polite(url, { Cookie: cookie });
  if (res.status !== 200) throw new Error("steam pricehistory HTTP " + res.status + " (cookie expired?)");
  const j = JSON.parse(res.body);
  if (!j || !j.success || !Array.isArray(j.prices)) return null;
  return normalizeHistoryRows(j.prices);
}

// ── Skinport ───────────────────────────────────────────────────────────────
// Full dump → [{name, min, median?, mean, max, qty}] (USD)
async function skinportItems() {
  const url = "https://api.skinport.com/v1/items?app_id=" + APP_ID + "&currency=USD&tradable=0";
  const res = await polite(url);
  if (res.status !== 200) throw new Error("skinport items HTTP " + res.status);
  const arr = JSON.parse(res.body);
  if (!Array.isArray(arr)) throw new Error("skinport items: bad payload");
  return arr.map((i) => ({
    name: i.market_hash_name,
    min: numOrNull(i.min_price),
    mean: numOrNull(i.mean_price),
    median: numOrNull(i.median_price),
    max: numOrNull(i.max_price),
    qty: numOrNull(i.quantity),
  })).filter((i) => typeof i.name === "string" && i.name);
}

// Realized-sale aggregates → {last24h,last7d,last30d,last90d:{min,max,avg,median,volume}}
async function skinportSalesHistory(name) {
  const url = "https://api.skinport.com/v1/sales/history?app_id=" + APP_ID +
    "&currency=USD&market_hash_name=" + enc(name);
  const res = await polite(url);
  if (res.status !== 200) throw new Error("skinport history HTTP " + res.status);
  const arr = JSON.parse(res.body);
  const it = Array.isArray(arr) ? arr.find((x) => x && x.market_hash_name === name) || arr[0] : null;
  if (!it) return null;
  // Skinport reports ZEROS (not nulls) for windows with no sales — and a
  // $0 price is never a real mark, so zero prices map to null (volume 0 is
  // a legitimate count and stays).
  const pz = (v) => { const n = numOrNull(v); return n ? n : null; };
  const pick = (o) => (o ? { min: pz(o.min), max: pz(o.max), avg: pz(o.avg), median: pz(o.median), volume: numOrNull(o.volume) } : null);
  return {
    last24h: pick(it.last_24_hours), last7d: pick(it.last_7_days),
    last30d: pick(it.last_30_days), last90d: pick(it.last_90_days),
  };
}

function numOrNull(v) { const n = Number(v); return isFinite(n) ? n : null; }

// ── Crypto benchmarks (the speculative-liquidity tide) ─────────────────────
// BTC = the risk-appetite benchmark, ETH = the degen beta. Stablecoins move
// the actual cash-out volume but are pegged — useless for correlation.
async function cryptoPrices() {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd";
  const res = await polite(url);
  if (res.status !== 200) throw new Error("coingecko HTTP " + res.status);
  const j = JSON.parse(res.body);
  return {
    btc: j && j.bitcoin ? numOrNull(j.bitcoin.usd) : null,
    eth: j && j.ethereum ? numOrNull(j.ethereum.usd) : null,
  };
}

// ── Steam live player count (the market's demand fundamental) ──────────────
async function steamPlayers() {
  const url = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=" + APP_ID;
  const res = await polite(url);
  if (res.status !== 200) throw new Error("steam players HTTP " + res.status);
  const j = JSON.parse(res.body);
  return j && j.response && j.response.result === 1 ? numOrNull(j.response.player_count) : null;
}

module.exports = {
  APP_ID, setTransport, httpGet,
  steamPriceOverview, steamPriceHistory, parseSteamDate, normalizeHistoryRows,
  steamItemNameId, steamOrderBook,
  skinportItems, skinportSalesHistory, steamPlayers, cryptoPrices,
};
