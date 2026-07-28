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
//   Steam profile page + inventory JSON — the user's OWN holdings. PUBLIC,
//     no sign-in of any kind (see the "Steam profile + inventory" section
//     below for the endpoints and why OpenID is neither used nor needed).
"use strict";
const https = require("https");
const A = require("./analytics.js");
const zlib = require("zlib");

const APP_ID = 730; // Counter-Strike 2
const UA = "hashmark-heroes-skin-tracker/1.0 (personal research tool)";

// ── transport (injectable) ─────────────────────────────────────────────────
// Follows up to 3 redirect hops: Steam 302s market listing pages to an
// internal canonical URL (found live 2026-07-26 — "Fracture Case" →
// /listings/730/G18DA243004), so a non-following client can never scrape
// the nameid.
function httpGet(url, headers, hops) {
  hops = hops || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({
        "User-Agent": UA,
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "br, gzip",
      }, headers || {}),
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && hops < 3) {
        res.resume(); // drain — then chase the redirect
        return resolve(httpGet(new URL(res.headers.location, url).href, headers, hops + 1));
      }
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
const GAPS = { "steamcommunity.com": 3500, "api.skinport.com": 2000,
  // third-venue corroboration hosts. The two dump venues are read ONCE per
  // collector run (one request covers every tracked name), so a long gap
  // costs nothing and guarantees we never hammer them; buff.163.com is a
  // PER-ITEM read and was measured 429-ing at a ~0.9s cadence (2026-07-27),
  // so it gets Steam's own 3.5s gap plus a small per-run budget.
  "api.waxpeer.com": 15000, "market.csgo.com": 15000, "buff.163.com": 3500 };
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
// them consistently.
//
// SOURCE (found live 2026-07-26): Steam's market listing pages are now a
// server-side-rendered React app — the legacy Market_LoadOrderSpread(nameid)
// inline script and the item_nameid are GONE from the HTML, and the old
// itemordershistogram flow is unreachable without them. But the SSR
// hydration payload (window.SSR.loaderData) embeds a react-query cache
// keyed ["market","orderbook",730,<name>] containing the COMPLETE book:
//   amtMaxBuyOrder / amtMinSellOrder — best bid/ask in INTEGER CENTS
//   rgCompactBuyOrders / rgCompactSellOrders — flat [cents, qty, ...] pairs,
//     PER-LEVEL quantities (not cumulative — sum within a range for depth)
//   cBuyOrders / cSellOrders — total units resting on each side
// One public request per item, no id, no auth. The payload is nested-escaped
// JSON; stripping every backslash first makes the keys plain-regexable (the
// fields are all numeric — nothing inside them can contain a backslash).
// The same payload also embeds the FULL multi-year price history logged-out
// (the "prices" query) — a future no-cookie backfill path.
// → { t, bid, ask, mid, spreadPct, bidQty5, askQty5, bidUsd5, askUsd5,
//     cBuy, cSell } | null. Depth = units within ±5% of mid; usd ≈ qty×mid
// (approximation, published as surveillance evidence — never a settlement
// input). Requires the redirect-following transport (listing URLs 302 to a
// canonical internal code URL).
async function steamOrderBook(name) {
  const url = "https://steamcommunity.com/market/listings/" + APP_ID + "/" + enc(name);
  const res = await polite(url);
  if (res.status !== 200) throw new Error("steam listing page HTTP " + res.status);
  const s = res.body.replace(/\\/g, "");
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  const bidC = num(/"amtMaxBuyOrder":(\d+)/), askC = num(/"amtMinSellOrder":(\d+)/);
  if (bidC == null && askC == null) return null;
  const bid = bidC != null && bidC > 0 ? bidC / 100 : null;
  const ask = askC != null && askC > 0 ? askC / 100 : null;
  if (bid == null && ask == null) return null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid != null ? bid : ask);
  const levels = (re) => {
    const m = re.exec(s);
    if (!m) return null;
    const a = m[1].split(",").map(Number);
    const out = [];
    for (let i = 0; i + 1 < a.length; i += 2) if (isFinite(a[i]) && isFinite(a[i + 1])) out.push([a[i] / 100, a[i + 1]]);
    return out;
  };
  const buys = levels(/"rgCompactBuyOrders":\[([\d,]*)\]/);
  const sells = levels(/"rgCompactSellOrders":\[([\d,]*)\]/);
  const depth = (lv, side) => lv == null ? null : lv.reduce((q, l) =>
    q + ((side === "buy" ? l[0] >= mid * 0.95 : l[0] <= mid * 1.05) ? l[1] : 0), 0);
  const bidQty5 = depth(buys, "buy"), askQty5 = depth(sells, "sell");
  return {
    t: Date.now(), bid: bid, ask: ask, mid: Math.round(mid * 100) / 100,
    spreadPct: bid != null && ask != null && mid > 0 ? Math.round(((ask - bid) / mid) * 1000) / 10 : null,
    bidQty5: bidQty5, askQty5: askQty5,
    bidUsd5: bidQty5 != null ? Math.round(bidQty5 * mid) : null,
    askUsd5: askQty5 != null ? Math.round(askQty5 * mid) : null,
    cBuy: num(/"cBuyOrders":(\d+)/), cSell: num(/"cSellOrders":(\d+)/),
  };
}

// ── Full price history, LOGGED-OUT (same SSR payload as the book) ──────────
// The listing page's react-query cache also embeds the item's COMPLETE daily
// price history: {"ecurrency":1,"prices":[{time(SECONDS),price_median($),
// purchases(units)},...]} back to release — data the old pricehistory
// endpoint only served to logged-in cookies. Powers the backtest
// (backfill.js); NOT wired into the live index (a backfill would rebase the
// published series — a methodology event).
// → [{t(ms), price, vol}] | null when the payload lacks a history block.
async function steamPriceHistoryPublic(name) {
  const url = "https://steamcommunity.com/market/listings/" + APP_ID + "/" + enc(name);
  const res = await polite(url);
  if (res.status !== 200) throw new Error("steam listing page HTTP " + res.status);
  const s = res.body.replace(/\\/g, "");
  const m = /"ecurrency":1,"prices":\[([^\]]*)\]/.exec(s);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse("[" + m[1] + "]"); } catch (e) { return null; }
  const out = [];
  for (const r of arr) {
    if (!r || !isFinite(r.time) || !(r.price_median > 0)) continue;
    out.push({ t: r.time * 1000, price: r.price_median,
      vol: isFinite(r.purchases) ? r.purchases : null });
  }
  return out.length ? out : null;
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

// ── Steam profile + inventory ("load my inventory") ───────────────────────
// NO SIGN-IN, NO PASSWORD, NO API KEY, NO OpenID. Both endpoints are public:
//
//   PROFILE   https://steamcommunity.com/id/<vanity>
//     A vanity name is not an id. The page ships an inline bootstrap object
//     `g_rgProfileData = {...,"steamid":"<17 digits>",...}` — one public HTML
//     read turns vanity → SteamID64, so we never need the Web API key that
//     ISteamUser/ResolveVanityURL would demand.
//   INVENTORY https://steamcommunity.com/inventory/<steamid64>/730/2
//               ?l=english&count=5000
//     CS2 = appid 730, context 2. Returns plain JSON for any profile whose
//     inventory privacy is Public — logged out, no cookie. Two failure codes
//     matter and both get plain-English messages: 403 = private/hidden,
//     429 = IP rate-limited.
//     Payload: `assets` [{classid, instanceid, amount}] × `descriptions`
//     [{classid, instanceid, market_hash_name, marketable, tradable}] joined
//     on classid+"_"+instanceid (assets carry the counts, descriptions carry
//     the names — Steam de-duplicates the heavy half).
//
// WHY NOT STEAM OpenID: it would only PROVE identity, which buys a personal
// analytics tool nothing (the data we read is public either way), and it
// REQUIRES a server-side callback URL — impossible on the static GitHub
// Pages build, where the user instead pastes the same inventory JSON. So the
// entire feature's input is: a profile URL, a vanity name, or a SteamID64.
//
// PRIVACY: a SteamID is personal data — it goes to steamcommunity.com and
// nowhere else, is never committed, and never reaches any third party.
// RATE LIMITS: inventory reads are IP-limited, so they ride polite() (3.5s
// per-host gap) and the CALLER must cache them (≥10 min TTL, a cached read
// must never re-fetch). Like every other fetcher here this layer keeps no
// cache of its own — storage belongs to the server.
const STEAMID64_RE = /^\d{17}$/;
const VANITY_RE = /^[A-Za-z0-9_.-]{2,64}$/;

// input → { steamid64, vanity|null, source } where source is one of
// "steamid64" (17 digits given directly), "profile-url" (.../profiles/<id>),
// "vanity-url" (.../id/<name>) or "vanity" (a bare name). Only the two vanity
// forms cost a network read. Throws Error with a plain-English message.
async function resolveSteamProfile(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) throw new Error("enter a Steam profile URL, vanity name, or SteamID64");
  if (STEAMID64_RE.test(raw)) return { steamid64: raw, vanity: null, source: "steamid64" };
  const mProf = /\/profiles\/(\d{17})(?:[/?#]|$)/.exec(raw);
  if (mProf) return { steamid64: mProf[1], vanity: null, source: "profile-url" };
  const mVan = /\/id\/([A-Za-z0-9_.-]{2,64})(?:[/?#]|$)/.exec(raw);
  if (mVan) return resolveVanity(mVan[1], "vanity-url");
  if (VANITY_RE.test(raw)) return resolveVanity(raw, "vanity");
  if (/steamcommunity\.com/i.test(raw))
    throw new Error("that Steam link is not a profile — use the address that looks like " +
      "steamcommunity.com/id/<name> or steamcommunity.com/profiles/<17 digits>");
  throw new Error("could not read a Steam profile from that — paste your profile URL, " +
    "your vanity name, or your 17-digit SteamID64");
}

// Vanity → SteamID64 by scraping g_rgProfileData off the public profile page.
async function resolveVanity(vanity, source) {
  const res = await polite("https://steamcommunity.com/id/" + enc(vanity));
  if (res.status === 429)
    throw new Error("Steam is rate-limiting profile lookups — try again in a few minutes");
  if (res.status === 404)
    throw new Error('no Steam profile found for "' + vanity + '" — check the spelling');
  if (res.status !== 200)
    throw new Error("could not reach the Steam profile page (HTTP " + res.status +
      ") — try again in a few minutes");
  const body = String(res.body || "");
  // Scope the search to the bootstrap object: a bare "steamid" scrape over
  // the whole page could pick up somebody else's id (friends, comments).
  const at = body.indexOf("g_rgProfileData");
  const m = at >= 0 ? /"steamid"\s*:\s*"(\d{17})"/.exec(body.slice(at, at + 4000)) : null;
  if (!m) {
    if (/could not be found/i.test(body))
      throw new Error('no Steam profile found for "' + vanity + '" — check the spelling');
    throw new Error("could not read the SteamID out of that profile page — " +
      "paste your 17-digit SteamID64 instead");
  }
  return { steamid64: m[1], vanity: vanity, source: source };
}

// → { steamid64, count, items: [{name, qty, marketable, tradable}], truncated }
// count = total UNITS parsed (qty summed), not the number of distinct names.
// opts.count caps the assets Steam returns (default/max 5000).
async function steamInventory(steamid64, opts) {
  opts = opts || {};
  const id = String(steamid64 == null ? "" : steamid64).trim();
  if (!STEAMID64_RE.test(id))
    throw new Error("that is not a 17-digit SteamID64 — resolve the profile first");
  const max = Math.max(1, Math.min(5000, Math.round(Number(opts.count) || 5000)));
  const res = await polite("https://steamcommunity.com/inventory/" + id + "/" + APP_ID +
    "/2?l=english&count=" + max);
  if (res.status === 403)
    throw new Error("inventory is private or hidden — set it to Public in Steam privacy settings");
  if (res.status === 429)
    throw new Error("Steam is rate-limiting inventory reads — try again in a few minutes");
  if (res.status === 404)
    throw new Error("no CS2 inventory found for that profile — check the SteamID or profile URL");
  if (res.status !== 200)
    throw new Error("Steam inventory read failed (HTTP " + res.status + ") — try again in a few minutes");
  let payload;
  try { payload = JSON.parse(res.body); }
  catch (e) { throw new Error("Steam returned an unreadable inventory response — try again in a few minutes"); }
  return parseSteamInventory(payload, id, max);
}

// The assets×descriptions join, split out so the STATIC/paste path (the user
// pastes the same JSON out of their own browser) parses byte-identically to
// the fetched one. Pure — no network, no clock.
function parseSteamInventory(payload, steamid64, max) {
  // Delegates to the CANONICAL implementation in analytics.js (UMD) so the
  // fetched path and the browser's paste path can never drift apart.
  return A.parseSteamInventory(payload, steamid64, max);
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

// ── THIRD-VENUE CORROBORATION (INTEG-1 `venue` lane) ───────────────────────
// Every mark in this project is single-venue at source (Steam). INTEG-1
// already corroborates it against Skinport realized sales and Steam's own
// standing order book; this layer adds INDEPENDENT venues, so faking a mark
// means moving several unrelated markets in the same direction at the same
// time instead of one.
//
// PLUGGABLE BY DESIGN — the lane takes any number of venues. An adapter is:
//
//   id         stable short id; published in every flag and coverage row
//   label      human label for the report/UI
//   ccy        currency of `price` AFTER the adapter's own normalization
//   kind       what the number MEANS — "ask" = cheapest standing offer
//   needsAuth  true when the venue cannot be read at all without a credential
//   available()          → { ok, mode, reason }   pure, NO network
//   quotes(names, opts)  → { t, quotes: { name: { price, t, source, … } } }
//   quote(name, opts)    → { price, t, source } | null   (sugar over quotes)
//
// `quotes` (batch) is the contract, not `quote`: the venues that answer
// without a key answer with ONE full dump, and looping 60 names through a
// per-item endpoint is exactly the rate-limit hazard the Skinport lane
// already taught us. `quote` exists for callers that want one name.
//
// WHAT WAS VERIFIED LIVE FROM THIS ENVIRONMENT, 2026-07-27 (the standing
// "never dark-ship a fetcher you cannot live-verify" rule):
//   market.csgo.com /api/v2/prices/USD.json  200, 27,341 items, prices are
//     decimal STRINGS in USD, `volume` = listing count. 56/56 tracked names
//     matched. Three rapid repeats: no 429.
//   api.waxpeer.com /v1/prices?game=csgo&minified=1  200, 21,889 items,
//     `min` is an INTEGER in 1/1000 USD (Fracture Case 503 = $0.503, which
//     market.csgo priced $0.500 independently), `count` = listing count.
//     56/56 matched. Three rapid repeats: no 429.
//   buff.163.com — the goods LIST/search endpoint answers
//     {"code":"Login Required"} logged out, but /api/market/goods/info
//     ?game=csgo&goods_id=<id> answers {"code":"OK"} PUBLICLY with
//     market_hash_name, sell_min_price/buy_max_price (CNY) and the
//     steam_price/steam_price_cny pair. So BUFF is readable without a
//     cookie ONCE the goods_id is known; only name→id discovery needs one.
//     Measured 429s at a ~0.9s request cadence — hence the 3.5s gap.
// The dump venues' published rate limits are NOT documented anywhere we
// could reach, so the politeness above is deliberately conservative.
//
// PRICE SEMANTICS: all three publish a LOWEST ASK, not a realized sale.
// That is fine for corroboration and is published as `kind:"ask"` — but it
// is why the lane is median-relative (see settlement.js): asks sit at a
// structural discount to Steam (measured ~0.66× on 2026-07-27, because
// Steam proceeds are wallet-locked), and a level comparison would flag the
// entire market every single day.

// Waxpeer public price dump → { name: { price(USD), qty } }. `min` is an
// integer in 1/1000 USD; 0/absent means nothing is listed (never a $0 mark).
async function waxpeerPrices() {
  const url = "https://api.waxpeer.com/v1/prices?game=csgo&minified=1";
  const res = await polite(url);
  if (res.status !== 200) throw new Error("waxpeer prices HTTP " + res.status);
  const j = JSON.parse(res.body);
  if (!j || j.success !== true || !Array.isArray(j.items)) throw new Error("waxpeer prices: bad payload");
  const out = {};
  for (const it of j.items) {
    if (!it || typeof it.name !== "string" || !it.name) continue;
    const m = numOrNull(it.min);
    if (m == null || m <= 0) continue;
    out[it.name] = { price: Math.round(m) / 1000, qty: numOrNull(it.count) };
  }
  return out;
}

// market.csgo.com (TM Market) public price dump → { name: { price(USD), qty } }
// `price` is a decimal STRING, `volume` a count STRING — both parsed here.
async function marketCsgoPrices() {
  const url = "https://market.csgo.com/api/v2/prices/USD.json";
  const res = await polite(url);
  if (res.status !== 200) throw new Error("market.csgo prices HTTP " + res.status);
  const j = JSON.parse(res.body);
  if (!j || j.success !== true || !Array.isArray(j.items)) throw new Error("market.csgo prices: bad payload");
  if (j.currency != null && String(j.currency).toUpperCase() !== "USD")
    throw new Error("market.csgo prices: currency is " + j.currency + ", not USD"); // never silently mis-scale
  const out = {};
  for (const it of j.items) {
    if (!it || typeof it.market_hash_name !== "string" || !it.market_hash_name) continue;
    const p = numOrNull(it.price);
    if (p == null || p <= 0) continue;
    out[it.market_hash_name] = { price: p, qty: numOrNull(it.volume) };
  }
  return out;
}

// BUFF163 single-item read — PUBLIC, no cookie (verified live 2026-07-27).
// → { ok, code, goodsId, name, ask, bid, sellNum, buyNum, fxCnyPerUsd } — all
// prices in CNY. `name` is BUFF's own market_hash_name and the CALLER MUST
// check it against the name it asked for: goods ids come from an untrusted
// map, and a wrong id must fail to corroborate rather than corroborate the
// wrong item.
//
// fxCnyPerUsd is derived from goods_info.steam_price_cny ÷ steam_price. Those
// are the SAME number in two currencies, so their ratio is a pure exchange
// rate and carries no price signal from BUFF's cached copy of Steam — the
// corroboration can never become circular. (It is also only used for the
// PUBLISHED usd value: the lane's math is scale-free, so FX cancels.)
async function buffGoodsInfo(goodsId) {
  const url = "https://buff.163.com/api/market/goods/info?game=csgo&goods_id=" + enc(String(goodsId));
  const res = await polite(url);
  if (res.status === 429) return { ok: false, code: "rate-limited", retry: false };
  if (res.status !== 200) throw new Error("buff goods info HTTP " + res.status);
  let j;
  try { j = JSON.parse(res.body); } catch (e) { throw new Error("buff goods info: unreadable payload"); }
  if (!j || j.code !== "OK" || !j.data) return { ok: false, code: (j && j.code) || "bad payload" };
  const d = j.data, gi = d.goods_info || {};
  const ask = numOrNull(d.sell_min_price), bid = numOrNull(d.buy_max_price);
  const su = numOrNull(gi.steam_price), sc = numOrNull(gi.steam_price_cny);
  return {
    ok: true, code: "OK", goodsId: numOrNull(d.id),
    name: typeof d.market_hash_name === "string" ? d.market_hash_name : null,
    ask: ask != null && ask > 0 ? ask : null,
    bid: bid != null && bid > 0 ? bid : null,
    sellNum: numOrNull(d.sell_num), buyNum: numOrNull(d.buy_num),
    fxCnyPerUsd: su != null && su > 0 && sc != null && sc > 0 ? sc / su : null,
  };
}

// BUFF163 name → goods_id. THE ONE COOKIE-GATED CALL (BUFF_COOKIE), gating
// the discovery step exactly the way STEAM_COOKIE gates the history
// bootstrap: no cookie → returns null and the caller simply has one fewer
// id. NOT live-verifiable from here (we hold no BUFF session), so it is
// deliberately fail-closed: an exact market_hash_name match or nothing, and
// every id it returns is re-verified against the PUBLIC goods/info read
// before a single quote is used. If BUFF changes this payload the lane loses
// coverage — it can never gain a wrong number.
async function buffResolveGoodsId(name, cookie) {
  if (!cookie) return null;
  const url = "https://buff.163.com/api/market/goods?game=csgo&page_num=1&search=" + enc(name);
  const res = await polite(url, { Cookie: cookie, Referer: "https://buff.163.com/market/csgo" });
  if (res.status !== 200) throw new Error("buff goods search HTTP " + res.status);
  let j;
  try { j = JSON.parse(res.body); } catch (e) { throw new Error("buff goods search: unreadable payload"); }
  if (!j || j.code !== "OK" || !j.data || !Array.isArray(j.data.items)) return null;
  for (const it of j.data.items) {
    if (it && it.market_hash_name === name) { const id = numOrNull(it.id); if (id) return id; }
  }
  return null;
}

// Wraps a spec into the full adapter contract (adds the quote() sugar).
function makeVenueAdapter(spec) {
  return Object.assign({
    async quote(name, opts) {
      const got = await this.quotes([name], opts);
      const q = got && got.quotes ? got.quotes[name] : null;
      return q ? { price: q.price, t: q.t, source: q.source } : null;
    },
  }, spec);
}

// One dump-venue adapter (market.csgo / waxpeer): credential-free, one
// request per run, every tracked name in the answer.
function dumpVenueAdapter(id, label, source, fetchAll) {
  return makeVenueAdapter({
    id: id, label: label, ccy: "USD", kind: "ask", needsAuth: false,
    available() { return { ok: true, mode: "public", reason: null }; },
    async quotes(names, opts) {
      const all = await fetchAll();
      const t = Date.now();
      const quotes = {};
      for (const n of names || []) {
        const row = all[n];
        if (!row || !(row.price > 0)) continue;
        quotes[n] = { price: row.price, t: t, source: source, qty: row.qty != null ? row.qty : null };
      }
      return { t: t, quotes: quotes, meta: { universe: Object.keys(all).length } };
    },
  });
}

// BUFF163 adapter. TWO MODES, both fail-safe:
//   "auth"   BUFF_COOKIE present → missing goods_ids are resolved through
//            the cookie-gated search, then read on the PUBLIC endpoint.
//   "public" no cookie but a goods_id map was supplied → reads the public
//            endpoint for the ids it already knows; discovers nothing new.
// Neither → { ok:false, reason:"not configured" }: the lane reports the
// venue unavailable and the collector run is completely unaffected.
//
// THE COOKIE IS NEVER stored, never logged, never returned in any structure
// that reaches published data — it is read from the environment here and
// only ever leaves as a request header.
function buff163Adapter(cookie, defaults) {
  defaults = defaults || {};
  const hasCookie = !!cookie;
  return makeVenueAdapter({
    id: "buff163", label: "BUFF163 (NetEase)", ccy: "USD", kind: "ask", needsAuth: false,
    available() {
      const ids = defaults.ids || {};
      if (hasCookie) return { ok: true, mode: "auth", reason: null };
      // `_`-prefixed keys are the map file's own documentation, not ids — a
      // map holding only a note is NOT a configured venue
      if (Object.keys(ids).some((k) => k[0] !== "_" && ids[k])) return { ok: true, mode: "public", reason: null };
      return { ok: false, mode: null,
        reason: "not configured — set BUFF_COOKIE, or supply a verified goods_id map" };
    },
    async quotes(names, opts) {
      opts = opts || {};
      const ids = opts.ids || defaults.ids || {};
      const budget = opts.budget != null ? opts.budget : (defaults.budget != null ? defaults.budget : 8);
      const onResolve = typeof opts.onResolve === "function" ? opts.onResolve : null;
      const quotes = {};
      const meta = { mode: hasCookie ? "auth" : "public", read: 0, resolved: 0, rateLimited: false, fx: null };
      const fxs = [];
      // `budget` bounds EVERY request this adapter makes — discovery included.
      // Discovery is per-item too, so counting only the reads would let a run
      // with an empty id map fire one search per tracked name (55 requests at
      // a 3.5s gap) with no cap at all. Resolved ids persist, so a run that
      // spends its whole budget discovering simply reads them the next time.
      let spent = 0;
      for (const n of names || []) {
        if (spent >= budget || meta.rateLimited) break;
        if (typeof n !== "string" || !n || n[0] === "_") continue;
        let id = numOrNull(ids[n]);
        if (!id && hasCookie) {
          spent++;
          try {
            id = await buffResolveGoodsId(n, cookie);
            if (id) { meta.resolved++; if (onResolve) onResolve(n, id); }
          } catch (e) { /* discovery is best-effort — never fails the lane */ }
        }
        if (!id) continue;
        if (spent >= budget) break;
        spent++;
        let info = null;
        try { info = await buffGoodsInfo(id); }
        catch (e) { continue; }                       // one bad item, not a dead lane
        if (!info || !info.ok) { if (info && info.code === "rate-limited") meta.rateLimited = true; continue; }
        meta.read++;
        // the id map is UNTRUSTED: a quote is used only when BUFF's own
        // market_hash_name is the name we asked about
        if (info.name !== n) continue;
        if (!(info.ask > 0) || !(info.fxCnyPerUsd > 0)) continue;
        fxs.push(info.fxCnyPerUsd);
        // `bid` is the SAME public read, converted — goods/info carries the
        // best standing BUY order alongside the ask and we were already
        // fetching it. It feeds the venue-book lane (INTEG-1, medium tier):
        // a bid is committed capital that can be hit, unlike an ask, which
        // is free to post. No extra request, no new credential.
        quotes[n] = { price: Math.round((info.ask / info.fxCnyPerUsd) * 1e4) / 1e4, t: Date.now(),
          source: "buff163:goods/info", ccyNative: "CNY", priceNative: info.ask,
          bid: info.bid > 0 ? Math.round((info.bid / info.fxCnyPerUsd) * 1e4) / 1e4 : null,
          bidNative: info.bid, qty: info.sellNum, bidQty: info.buyNum,
          fxCnyPerUsd: Math.round(info.fxCnyPerUsd * 1e4) / 1e4 };
      }
      if (fxs.length) { fxs.sort((a, b) => a - b); meta.fx = Math.round(fxs[fxs.length >> 1] * 1e4) / 1e4; }
      return { t: Date.now(), quotes: quotes, meta: meta };
    },
  });
}

// The registry — the whole pluggable point. Add a venue here and the lane,
// the coverage report and the flags pick it up with no other change.
//   opts.env   environment bag (BUFF_COOKIE lives here)
//   opts.buff  { ids, budget } for the BUFF adapter
function venueAdapters(opts) {
  opts = opts || {};
  const env = opts.env || {};
  return [
    dumpVenueAdapter("market.csgo", "TM Market (market.csgo.com)", "market.csgo:prices/USD", marketCsgoPrices),
    dumpVenueAdapter("waxpeer", "Waxpeer", "waxpeer:v1/prices", waxpeerPrices),
    buff163Adapter(env.BUFF_COOKIE || "", opts.buff || {}),
  ];
}

// ── Historical macro backfills (one-shot, backtest/macro.json) ─────────────
// CS players monthly averages back to July 2012 — steamcharts.com HTML
// (verified live 2026-07-26: 168 monthly rows). One fetch, committed once;
// the LIVE series continues from our own market.jsonl samples.
// → [{day:"YYYY-MM-01", players}] ascending | throws on shape change.
const FULL_MONTHS = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };
async function steamchartsMonthly() {
  const res = await polite("https://steamcharts.com/app/" + APP_ID);
  if (res.status !== 200) throw new Error("steamcharts HTTP " + res.status);
  const out = [];
  for (const m of res.body.matchAll(/<td class="month-cell[^"]*">\s*([A-Za-z]+) (\d{4})\s*<\/td>\s*<td[^>]*>\s*([\d.]+)/g)) {
    if (!(m[1] in FULL_MONTHS)) continue;
    out.push({ day: m[2] + "-" + String(FULL_MONTHS[m[1]] + 1).padStart(2, "0") + "-01",
      players: Math.round(Number(m[3])) });
  }
  if (!out.length) throw new Error("steamcharts: no monthly rows parsed (markup changed?)");
  return out.sort((a, b) => (a.day < b.day ? -1 : 1));
}

// BTC USD back to 2010 — blockchain.info charts API, keyless (CoinGecko's
// free tier caps history at 365d — verified 401 on days=max, don't retry it).
// ~4-day granularity on timespan=all; plenty for a comparison overlay.
// → [{day, usd}] ascending.
async function btcHistoryAll() {
  const res = await polite("https://api.blockchain.info/charts/market-price?timespan=all&format=json");
  if (res.status !== 200) throw new Error("blockchain.info HTTP " + res.status);
  const j = JSON.parse(res.body);
  if (!j || !Array.isArray(j.values)) throw new Error("blockchain.info: bad payload");
  return j.values.filter((v) => v && v.y > 0 && isFinite(v.x))
    .map((v) => ({ day: new Date(v.x * 1000).toISOString().slice(0, 10), usd: Math.round(v.y * 100) / 100 }));
}

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
  steamOrderBook, steamPriceHistoryPublic, steamchartsMonthly, btcHistoryAll,
  resolveSteamProfile, steamInventory, parseSteamInventory,
  skinportItems, skinportSalesHistory, steamPlayers, cryptoPrices,
  waxpeerPrices, marketCsgoPrices, buffGoodsInfo, buffResolveGoodsId, venueAdapters,
};
