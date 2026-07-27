#!/usr/bin/env node
// client-probe.js — Skindex dashboard, end-to-end in a real
// browser. Hermetic: the tracker server runs IN-PROCESS with a fixture
// transport (no internet), pre-seeded with 120 days of history; Chromium
// then drives the actual UI: watchlist → item view → stat tiles → canvas
// chart actually painted → crosshair tooltip → portfolio lot add → P/L.
// Screenshot written to /tmp/skin_lab.png for visual QA.
//
//   node client-probe.js
"use strict";
const PW_LIB = process.env.PLAYWRIGHT_LIB || "/opt/node22/lib/node_modules/playwright";
const { chromium } = require(PW_LIB);
const os = require("os");
const path = require("path");
const fs = require("fs");
const M = require(path.join(__dirname, "market.js"));
const { startServer } = require(path.join(__dirname, "server.js"));

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ FAIL " + label); } };
const D = 86400000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n) => (n < 10 ? "0" + n : "" + n);
const steamDateStr = (t) => { const d = new Date(t); return MON[d.getUTCMonth()] + " " + p2(d.getUTCDate()) + " " + d.getUTCFullYear() + " " + p2(d.getUTCHours()) + ": +0"; };

M.setTransport(async (url) => {
  if (url.includes("/market/priceoverview/"))
    return { status: 200, body: JSON.stringify({ success: true, lowest_price: "$41.90", volume: "63", median_price: "$43.25" }) };
  if (url.includes("/market/listings/")) // SSR page with the embedded order book
    return { status: 200, body: '<html>window.SSR.loaderData = "{\\"amtMaxBuyOrder\\":4200,\\"amtMinSellOrder\\":4400,' +
      '\\"cBuyOrders\\":25,\\"cSellOrders\\":19,\\"rgCompactBuyOrders\\":[4200,5,4100,20],' +
      '\\"rgCompactSellOrders\\":[4400,4,4500,15]}"</html>' };
  if (url.includes("api.skinport.com/v1/items"))
    return { status: 200, body: JSON.stringify([{ market_hash_name: "AK-47 | Redline (Field-Tested)", min_price: 38.2, mean_price: 41, max_price: 90, quantity: 420 }]) };
  if (url.includes("api.steampowered.com/ISteamUserStats")) {
    return { status: 200, body: JSON.stringify({ response: { player_count: 1534000, result: 1 } }) };
  }
  if (url.includes("api.coingecko.com")) {
    return { status: 200, body: JSON.stringify({ bitcoin: { usd: 60000 }, ethereum: { usd: 1800 } }) };
  }
  if (url.includes("api.skinport.com/v1/sales/history")) {
    const agg = { min: 35, max: 48, avg: 40.1, median: 39.5, volume: 34 };
    return { status: 200, body: JSON.stringify([{ market_hash_name: "AK-47 | Redline (Field-Tested)", last_24_hours: agg, last_7_days: agg, last_30_days: agg, last_90_days: agg }]) };
  }
  return { status: 404, body: "" };
});

(async () => {
  const PORT = 5392;
  const DATA = path.join(os.tmpdir(), "hh-skin-client-probe-" + Date.now());
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "watchlist.json"), "[]"); // suppress first-boot seeding — this scenario controls its own list
  const inst = startServer({ port: PORT, dataDir: DATA, snapHours: 0, steamCookie: "" });
  await new Promise((r) => inst.server.once("listening", r));
  const NAME = "AK-47 | Redline (Field-Tested)";
  const api = async (p, body) => (await fetch("http://localhost:" + PORT + p, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined)).json();

  // seed: watch + 120-day wavy uptrend + one live snapshot
  await api("/api/skins/watch", { name: NAME });
  const now = Date.now();
  const paste = Array.from({ length: 120 }, (_, i) =>
    [steamDateStr(now - (120 - i) * D), 30 * Math.exp(0.003 * i) * (1 + 0.05 * Math.sin(i / 6)), "" + (40 + (i % 20))]);
  await api("/api/skins/import", { name: NAME, prices: paste });
  await api("/api/skins/refresh", { name: NAME });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://localhost:" + PORT + "/", { waitUntil: "networkidle" });

  await page.waitForSelector(".mrow", { timeout: 8000 });
  ok(true, "dashboard boots on the market home; ranked table renders");
  ok((await page.textContent('.mrow:has-text("Redline")')).includes("$43.25"), "table row shows the live snapshot price");
  const stripTxt = await page.textContent("#itemView");
  ok(/SKINDEX/.test(stripTxt) && /CS2 PLAYERS/.test(stripTxt) && /CASH RATIO/.test(stripTxt),
    "market strip present (index / cash ratio / players)");
  ok(/VS BITCOIN/.test(stripTxt), "BTC correlation tile present (measuring until 10 paired days)");
  ok(/CN \/ US ACTIVITY/.test(stripTxt), "CN/US activity tile present (regional demand mix)");
  ok(/LIQUIDS INDEX/.test(stripTxt) && /ART INDEX/.test(stripTxt), "liquids + art index tiles present");
  await page.screenshot({ path: "/tmp/skin_lab_home.png", fullPage: true });
  console.log("  📸 /tmp/skin_lab_home.png");

  await page.click('.mrow:has-text("Redline")');
  await page.waitForSelector("#chart");
  ok(!!(await page.$("#backBtn")), "item view opens from the table with a ← Market back button");
  const painted = await page.evaluate(() => {
    const cv = document.getElementById("chart");
    const ctx = cv.getContext("2d");
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0;
    for (let i = 3; i < img.length; i += 40) if (img[i] > 0) lit++;
    return lit;
  });
  ok(painted > 500, "canvas chart actually painted (" + painted + " sampled px)");

  const tiles = await page.$$eval(".tile .lb", (els) => els.map((e) => e.textContent));
  ok(tiles.some((t) => /30D/.test(t)) && tiles.some((t) => /RSI/.test(t)) && tiles.some((t) => /VOLATILITY/.test(t)),
    "stat tiles present (momentum / RSI / volatility)");
  const badge = await page.textContent(".sigBadge");
  ok(/BUY|HOLD|SELL/.test(badge), "signal verdict badge renders (" + badge.trim().split("\n").pop() + ")");
  ok((await page.$$eval(".sigReasons li", (els) => els.length)) > 0, "signal reasons itemized in UI");
  ok((await page.textContent("#itemView")).includes("Skinport"), "cross-market compare visible");

  // crosshair tooltip
  const box = await (await page.$("#chart")).boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + 100);
  await page.waitForSelector("#tooltip", { state: "visible", timeout: 4000 });
  const tip = await page.textContent("#tooltip");
  ok(/Steam/.test(tip) && /\$\d/.test(tip), "crosshair tooltip shows dated price row");
  ok(/SMA 7/.test(tip), "tooltip includes SMA overlay values");

  // range switch redraws
  await page.click(".ranges .btn[data-r='ALL']");
  await page.waitForTimeout(200);
  ok(await page.$eval(".ranges .btn[data-r='ALL']", (b) => b.classList.contains("on")), "range switch (ALL) takes");

  // portfolio flow through the real form
  await page.fill("#lotQty", "2");
  await page.fill("#lotCost", "30");
  await page.click("#lotForm button[type=submit]");
  await page.waitForSelector("table.pf td", { timeout: 4000 });
  const pfTxt = await page.textContent("#pfTotals");
  ok(/COST BASIS/.test(pfTxt) && /\$60\.00/.test(pfTxt), "portfolio cost basis folds ($60.00)");
  ok(/P\/L AFTER FEES/.test(pfTxt), "P/L tile present (fee-adjusted)");

  // data table view (accessibility fallback)
  ok((await page.$$eval("details.dataTable table.dt tr", (els) => els.length)) > 10, "data table view present under the chart");

  ok(errors.length === 0, "zero uncaught page errors" + (errors.length ? " — " + errors[0] : ""));

  await page.screenshot({ path: "/tmp/skin_lab.png", fullPage: true });
  console.log("  📸 /tmp/skin_lab.png");

  // ── static-host mode (the GitHub Pages scenario) ─────────────────────────
  // The dashboard is served by a bare file server with NO api; it must
  // DISCOVER the tracker cross-origin (saved address → CORS) and, with no
  // tracker anywhere, render the setup panel instead of a broken page.
  const http = require("http");
  const MIME2 = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".jsonl": "text/plain" };
  // Serves the repo's dashboard files; /data/* comes from dataDir when given,
  // 404 otherwise — so each scenario controls whether collected data "exists"
  // regardless of what's sitting in the working tree.
  const makeStatic = (port, dataDir) => http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    let f;
    // Fracture Case stays a DAY-0 item in the static scenario (no deep
    // backfill served) so the warm-up/fallback honesty path keeps a real
    // test; Redline's deep file is served → tests the deep-history chart.
    if (url.startsWith("/backtest/history/") && /Fracture/i.test(url)) { res.writeHead(404); return res.end(); }
    if (url.startsWith("/data/")) {
      if (!dataDir) { res.writeHead(404); return res.end(); }
      f = path.join(dataDir, path.normalize(url.slice("/data/".length)).replace(/^([.][.][/\\])+/, ""));
    } else {
      f = path.join(__dirname, url === "/" ? "index.html" : path.normalize(url).replace(/^([.][.][/\\])+/, ""));
    }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": MIME2[path.extname(f)] || "application/octet-stream" });
      res.end(buf);
    });
  }).listen(port);
  const stat = makeStatic(5393, null);
  const ctxB = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctxB.addInitScript(() => localStorage.setItem("skinlab_api", "http://localhost:" + 5392));
  const pageB = await ctxB.newPage();
  await pageB.goto("http://localhost:5393/", { waitUntil: "networkidle" });
  await pageB.waitForSelector(".mrow", { timeout: 8000 });
  ok(true, "static-host page discovers the tracker cross-origin (saved address + CORS)");
  ok((await pageB.textContent("#netStatus")).includes("5392"), "netStatus names the discovered tracker");
  await ctxB.close();

  // no tracker anywhere → setup panel (needs 8790 free to be deterministic:
  // occupy it with a dummy that fails health, skip if a real tracker owns it)
  let dummy = null;
  const free8790 = await new Promise((r) => {
    dummy = http.createServer((q, s) => { s.writeHead(404); s.end(); });
    dummy.once("error", () => r(false));
    dummy.listen(8790, () => r(true));
  });
  if (free8790) {
    const ctxC = await browser.newContext();
    const pageC = await ctxC.newPage();
    await pageC.goto("http://localhost:5393/", { waitUntil: "networkidle" });
    await pageC.waitForSelector("#retryBtn", { timeout: 10000 });
    ok((await pageC.textContent("#itemView")).includes("npm start"), "no tracker + no data → setup panel with run instructions");
    await ctxC.close();

    // ── static DATA mode (the real Pages experience) ───────────────────────
    // No tracker anywhere, but the collector's committed files exist → the
    // page must boot read-only from them: movers list, charts, fallback
    // tiles, GitHub actions links, localStorage portfolio.
    const { collect } = require("./collect.js");
    const SROOT = path.join(os.tmpdir(), "hh-skin-staticdata-" + Date.now());
    fs.mkdirSync(path.join(SROOT, "data", "import"), { recursive: true });
    fs.writeFileSync(path.join(SROOT, "watchlist.json"), JSON.stringify({ items: [NAME, "Fracture Case", "Kilowatt Case"] }));
    const { slug } = require(path.join(__dirname, "server.js"));
    const impRows = Array.from({ length: 120 }, (_, i) =>
      ({ t: Date.now() - (120 - i) * D, price: 30 * Math.exp(0.003 * i) * (1 + 0.05 * Math.sin(i / 6)), vol: 40 + (i % 20) }));
    fs.writeFileSync(path.join(SROOT, "data", "import", slug(NAME) + ".json"), JSON.stringify({ t: Date.now(), source: "probe", rows: impRows }));
    await collect({ root: SROOT });
    const statD = makeStatic(5394, path.join(SROOT, "data"));
    const ctxD = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const pageD = await ctxD.newPage();
    const errorsD = [];
    pageD.on("pageerror", (e) => errorsD.push(String(e)));
    await pageD.goto("http://localhost:5394/", { waitUntil: "networkidle" });
    await pageD.waitForSelector(".mrow", { timeout: 10000 });
    const rows = await pageD.$$eval(".mrow .nm", (els) => els.map((e) => e.textContent));
    ok(rows.length === 3, "static data mode boots read-only on the market home (" + rows.length + " rows)");
    ok(/read-only/.test(await pageD.textContent("#netStatus")), "netStatus says read-only + data via GitHub");
    ok(/SKINDEX/.test(await pageD.textContent("#itemView")), "market strip renders from the committed manifest");
    // the 12-year backtest reconstruction overlays the home chart (rebased,
    // dashed, with range chips) — served from the repo's committed result.json
    await pageD.waitForFunction(() => {
      const l = document.querySelector(".idxLegend");
      return l && /reconstruction/.test(l.textContent);
    }, { timeout: 8000 });
    await pageD.click('[data-ir="1Y"]');
    await pageD.waitForFunction(() => {
      const b = document.querySelector('[data-ir="1Y"]');
      return b && b.classList.contains("on");
    }, { timeout: 6000 });
    const idxPainted = await pageD.evaluate(() => {
      const cv = document.getElementById("idxChart");
      if (!cv) return 0;
      const img = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0;
      for (let i = 3; i < img.length; i += 40) if (img[i] > 0) lit++;
      return lit;
    });
    ok(idxPainted > 200, "home chart overlays the 12-year reconstruction with working range chips (" + idxPainted + " px)");
    // comparison overlays: CS players + BTC toggles (macro.json served from
    // the repo) — toggling off must repaint and flip aria-pressed
    const ovOn = await pageD.$eval('[data-ov="players"]', (b) => b.classList.contains("on"));
    await pageD.click('[data-ov="players"]');
    await pageD.waitForFunction(() => {
      const b = document.querySelector('[data-ov="players"]');
      return b && b.getAttribute("aria-pressed") === "false";
    }, { timeout: 6000 });
    ok(ovOn && !(await pageD.$eval('[data-ov="players"]', (b) => b.classList.contains("on")))
      && (await pageD.$("[data-ov='btc']")) != null,
      "CS players + BTC comparison overlays render as toggles (players default-on, toggles off live)");
    await pageD.click('[data-ov="players"]'); // back on for the screenshot
    await pageD.click('[data-ir="ALL"]');

    // ── ADDITIVE (home information hierarchy): hero / lens / rail / tabs ────
    // The home page leads with ONE object — the Skindex hero, its chart living
    // inside the card — with trust status in a permanent rail, and the market
    // table split into segments. These assert the hierarchy exists and, more
    // importantly, that the lens RE-READS THE SAME NUMBER rather than swapping
    // in a different basket, and that every segment tab is honest about what
    // it holds. Fixture: 3 tracked items = 2 cases + 1 skin + 0 art.
    const heroTxt = await pageD.textContent(".ds-hero");
    ok((await pageD.$(".ds-hero-row > .ds-hero")) != null &&
       (await pageD.$(".ds-hero-row > .ds-rail")) != null && /SKINDEX/.test(heroTxt),
      "home leads with a SKINDEX hero card and a status rail beside it");
    ok((await pageD.$(".ds-hero .ds-hero-chart #idxChart")) != null,
      "the index chart lives INSIDE the hero card (its own background), not in a separate panel");
    const railTxt = await pageD.textContent(".ds-rail");
    ok(/MARK INTEGRITY/.test(railTxt) && /COLLECTOR/.test(railTxt) &&
       /FIXING ACCRUAL/.test(railTxt) && /WITNESS/.test(railTxt),
      "status rail carries mark integrity, collector recency, fixing accrual and the witness verdict");
    ok(await pageD.$eval(".ds-rail", (el) =>
        el.querySelectorAll("button, a, input, select, textarea, [tabindex]").length === 0),
      "status rail is read-only — it never competes for the keyboard");
    // The clean-state coverage line is a CONTRACT, not cosmetics: the rail is
    // the surface most people read, so it must report coverage by evidence
    // TIER. Ask agreement is free to buy — if it ever reappears here as
    // "corroborated", the rail is overstating how well-evidenced the marks
    // are, which is exactly what the 2026-07-27 revision removed.
    ok(/strong \d+\/\d+ · medium \d+\/\d+ corroborated/.test(railTxt) &&
       !/venue .*corroborated/.test(railTxt),
      "clean-state rail reports coverage by evidence tier (strong realized sales / medium standing bids) and never counts ask agreement");
    // The lens: one number, two readings (published index vs cash-adjusted).
    // BOTH branches are contracts. A host whose series carries no cash ratio
    // must not render a dead control — it degrades to the wallet reading and
    // drops the segment entirely; a host that has one must re-read the SAME
    // number rather than swap in a different basket.
    const walletLevel = await pageD.textContent(".ds-hero-val");
    if ((await pageD.$("[data-lens]")) == null) {
      ok(/Steam wallet marks/.test(await pageD.textContent(".ds-hero-sub")) && walletLevel !== "",
        "no cash-ratio series → the hero drops the lens control instead of offering a dead one (wallet " + walletLevel + ")");
    } else {
      ok(await pageD.$eval('[data-lens="wallet"]', (b) =>
          b.getAttribute("aria-pressed") === "true" && b.classList.contains("on")),
        "hero lens defaults to the published wallet-$ Skindex");
      await pageD.click('[data-lens="real"]');
      await pageD.waitForFunction(() => {
        const b = document.querySelector('[data-lens="real"]');
        return b && b.getAttribute("aria-pressed") === "true";
      }, { timeout: 6000 });
      const realLevel = await pageD.textContent(".ds-hero-val");
      ok(/cash-adjusted/.test(await pageD.textContent(".ds-hero-sub")) &&
         /cash-adjusted real \$/.test(await pageD.$eval("#idxChart", (cv) => cv.getAttribute("aria-label"))) &&
         realLevel !== "—",
        "real-$ lens re-reads the same index through the cash ratio (" + walletLevel + " → " + realLevel + ")");
      await pageD.click('[data-lens="wallet"]');
      await pageD.waitForFunction(() =>
        document.querySelector('[data-lens="wallet"]').getAttribute("aria-pressed") === "true", { timeout: 6000 });
      ok((await pageD.textContent(".ds-hero-val")) === walletLevel, "the lens round-trips back to the wallet-$ level");
    }
    // segment tabs over the one table
    const tabState = await pageD.$$eval("[data-mt]", (els) => els.map((e) =>
      e.dataset.mt + ":" + e.getAttribute("role") + ":" + e.getAttribute("aria-selected") + ":" + e.getAttribute("tabindex")));
    ok(tabState.join(" ") === "all:tab:true:0 case:tab:false:-1 liquid:tab:false:-1 art:tab:false:-1",
      "market tabs are a real tablist with roving tabindex, one tab stop (" + tabState.join(" ") + ")");
    ok(await pageD.$eval("#mktTabPanel", (el) => el.getAttribute("role") === "tabpanel" &&
        el.getAttribute("aria-labelledby") === "mtab-all"),
      "the market table sits in a tabpanel labelled by the active tab");
    await pageD.click('[data-mt="case"]');
    await pageD.waitForFunction(() => document.querySelectorAll("tr.mrow").length === 2, { timeout: 6000 });
    ok((await pageD.$$eval("tr.mrow .nm", (els) => els.map((e) => e.textContent))).every((n) => /Case/.test(n)),
      "the Cases tab filters the table to the case family (2 of the 3 fixture rows)");
    await pageD.click('[data-mt="art"]');
    await pageD.waitForTimeout(350);
    ok((await pageD.$$eval("tr.mrow", (els) => els.length)) === 0 &&
       /No tracked items in this segment/.test(await pageD.textContent("#mktTabPanel")),
      "an empty segment says so in words instead of rendering a blank table");
    await pageD.click('[data-mt="all"]'); // restore: the checks below click a Redline row
    await pageD.waitForFunction(() => document.querySelectorAll("tr.mrow").length === 3, { timeout: 6000 });
    ok((await pageD.$$eval(".ds-tiles.secondary .ds-tile-lb", (els) => els.map((e) => e.textContent)))
        .join("|").includes("CS2 PLAYERS"),
      "the demoted metrics survive the rework in a quieter secondary row");

    await pageD.screenshot({ path: "/tmp/skin_lab_static.png", fullPage: true });
    console.log("  📸 /tmp/skin_lab_static.png");
    await pageD.click('.mrow:has-text("Redline")');
    await pageD.waitForSelector("#chart");
    const paintedD = await pageD.evaluate(() => {
      const cv = document.getElementById("chart");
      const img = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0;
      for (let i = 3; i < img.length; i += 40) if (img[i] > 0) lit++;
      return lit;
    });
    ok(paintedD > 500, "chart painted from committed jsonl + import (" + paintedD + " px)");
    await pageD.click("#backBtn");
    await pageD.waitForSelector("table.mkt", { timeout: 6000 });
    await pageD.click('.mrow:has-text("Kilowatt")');
    await pageD.waitForSelector(".sigCard", { timeout: 8000 });
    await pageD.waitForFunction(() => /backfilled Steam daily aggregates/.test(document.getElementById("itemView").textContent), { timeout: 8000 });
    const deepPx = await pageD.evaluate(() => {
      const cv = document.getElementById("chart");
      const img = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0;
      for (let i = 3; i < img.length; i += 40) if (img[i] > 0) lit++;
      return lit;
    });
    ok(deepPx > 500 && !/day \d+ of 30/.test(await pageD.textContent("#itemView")),
      "case detail chart shows YEARS of deep history with disclosure, no warm-up chip (" + deepPx + " px)");
    await pageD.click("#backBtn");
    await pageD.waitForSelector("table.mkt", { timeout: 6000 });
    await pageD.click('.mrow:has-text("Redline")');
    await pageD.waitForSelector(".sigCard", { timeout: 8000 });
    ok((await pageD.$$eval("a.btn", (els) => els.map((a) => a.href).join(" "))).includes("watchlist.json"),
      "read-only actions link to editing watchlist.json on GitHub");
    // the 1-day item leans on skinport aggregates + warm-up honesty
    await pageD.click("#backBtn");
    await pageD.waitForSelector("table.mkt", { timeout: 6000 });
    ok(true, "← Market returns to the ranked table");
    await pageD.click('.mrow:has-text("Fracture Case")');
    await pageD.waitForSelector(".warmup", { timeout: 6000 });
    ok((await pageD.textContent("#itemView")).includes("SOLD*"), "day-0 momentum tiles fall back to skinport sale medians");
    ok(/day 1 of 30/.test(await pageD.textContent(".warmup")), "warm-up chip is honest about short history");
    // back to home: settlement panel + methodology verification
    await pageD.click("#backBtn");
    await pageD.waitForSelector("table.mkt", { timeout: 6000 });
    ok(/SETTLEMENT FIXINGS/.test(await pageD.textContent("#itemView"))
      && (await pageD.$$eval("a", (as) => as.some((a) => /methodology\.html$/.test(a.href)))),
      "settlement panel on home links to the methodology page");
    // methodology page: budget renders + in-browser hash verification
    await pageD.goto("http://localhost:5394/methodology.html", { waitUntil: "networkidle" });
    await pageD.waitForFunction(() => /\$/.test(document.getElementById("budgetOut").textContent), { timeout: 8000 });
    ok(/Move SETTLE-CASE-7D 1%/.test(await pageD.textContent("#budgetOut")), "methodology page renders the live manipulation budget");
    const integTxt = await pageD.textContent("#integOut");
    ok(/INTEG-1/.test(integTxt) && /NO FLAGS/.test(integTxt),
      "methodology page renders the INTEG-1 integrity state (clean fixture → NO FLAGS)");
    await pageD.click("#verifyBtn");
    await pageD.waitForFunction(() => /VERIFIED|MISMATCH/.test(document.getElementById("verifyOut").textContent), { timeout: 8000 });
    const verTxt = await pageD.textContent("#verifyOut");
    ok(/✓ VERIFIED/.test(verTxt) && !/✗/.test(verTxt), "in-browser re-derivation VERIFIES the published fixing hashes");
    await pageD.goBack({ waitUntil: "networkidle" });
    await pageD.waitForSelector(".mrow", { timeout: 8000 });
    // localStorage portfolio (back on home after the methodology round-trip)
    await pageD.click('.mrow:has-text("Redline")');
    await pageD.waitForSelector(".sigCard");
    await pageD.fill("#lotQty", "2");
    await pageD.fill("#lotCost", "30");
    await pageD.click("#lotForm button[type=submit]");
    await pageD.waitForSelector("table.pf td", { timeout: 4000 });
    ok(/\$60\.00/.test(await pageD.textContent("#pfTotals")), "portfolio works serverless (localStorage lots, fee-adjusted)");
    ok(errorsD.length === 0, "static mode: zero uncaught page errors" + (errorsD.length ? " — " + errorsD[0] : ""));
    await ctxD.close();
    statD.close();
    fs.rmSync(SROOT, { recursive: true, force: true });
    dummy.close();
  } else { console.log("  ~ static-mode checks skipped (a real tracker owns :8790)"); }
  stat.close();

  // ── ADDITIVE (lane S3): Steam inventory panel, static-mode paste flow ─────
  // Self-contained scenario on the S3 port range (5510-5519) with its own
  // collected root, so it runs whether or not :8790 is free. Tracker
  // discovery is route-aborted (the a11y-probe guard) so the page is
  // deterministically in STATIC mode: no server, no CORS reads of
  // steamcommunity.com — the user pastes the public inventory JSON and the
  // whole valuation + reconstruction runs in the browser.
  //
  // PRIVACY: the fixture SteamID64 is obviously fake (76561190000000001) and
  // is never persisted by the UI — only {t,value,count} snapshots are.
  //
  // HAND-COMPUTED EXPECTATIONS (the fixture transport quotes every item at a
  // median of $43.25, which is what the collector records):
  //   Redline: two assets on c1_0 (an identical stack → ONE row, qty 2) plus
  //     one on c1_5 (same market_hash_name, different instanceid = a different
  //     float, so the parse keeps it as its OWN row). inventoryValue collapses
  //     by NAME → a single Redline line at qty 3          → $129.75
  //   Fracture ×1                                          → $43.25
  //   "Dreams & Nightmares Case" ×1 — NOT in the watchlist → UNPRICED (no
  //     fabricated price, no contribution to value)
  //   one asset (classid zz) has NO description → DROPPED, never named
  //   total = $173.00, count = 5 UNITS over 3 distinct names.
  //   pricedCount/unpricedCount are UNIT counts summing to count: 4 priced
  //   units (3 Redline + 1 Fracture) + 1 unpriced unit = 5.
  //   Fracture's collected history jsonl is DELETED after collect (and the
  //   static server already 404s its backtest deep file), so it is priced but
  //   has NO usable history → reconstruction coverage = 129.75/173.00 = 75%.
  const IROOT = path.join(os.tmpdir(), "hh-skin-inv-" + Date.now());
  {
    const { collect } = require("./collect.js");
    const { slug } = require(path.join(__dirname, "server.js"));
    fs.mkdirSync(path.join(IROOT, "data", "import"), { recursive: true });
    fs.writeFileSync(path.join(IROOT, "watchlist.json"), JSON.stringify({ items: [NAME, "Fracture Case"] }));
    const impRows = Array.from({ length: 120 }, (_, i) =>
      ({ t: Date.now() - (120 - i) * D, price: 30 * Math.exp(0.003 * i) * (1 + 0.05 * Math.sin(i / 6)), vol: 40 + (i % 20) }));
    fs.writeFileSync(path.join(IROOT, "data", "import", slug(NAME) + ".json"), JSON.stringify({ t: Date.now(), source: "probe", rows: impRows }));
    await collect({ root: IROOT });
    // priced-but-no-history case: drop Fracture's collected marks AFTER the
    // manifest was written, so it keeps a quote but loses every history source
    fs.rmSync(path.join(IROOT, "data", "history", slug("Fracture Case") + ".jsonl"), { force: true });

    const statI = makeStatic(5510, path.join(IROOT, "data"));
    const ctxI = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctxI.route(/^https?:\/\/(localhost|127\.0\.0\.1):8790\//, (r) => r.abort());
    const pageI = await ctxI.newPage();
    const errorsI = [];
    pageI.on("pageerror", (e) => errorsI.push(String(e)));
    await pageI.goto("http://localhost:5510/", { waitUntil: "networkidle" });
    await pageI.waitForSelector(".mrow", { timeout: 10000 });

    ok(/no sign-in, no password, no API key/i.test(await pageI.textContent("#invPanel")),
      "inventory panel states the no-sign-in / no-API-key reassurance in plain English");

    // primary action on a static host routes to the paste flow with the exact
    // public inventory URL prefilled from the entered SteamID64
    await pageI.fill("#invInput", "76561190000000001");
    await pageI.click("#invGo");
    await pageI.waitForSelector("#invPasteModal.open", { timeout: 4000 });
    const pasteUrl = await pageI.textContent("#invPasteUrl");
    ok(/76561190000000001\/730\/2/.test(pasteUrl) && /steamcommunity\.com\/inventory/.test(pasteUrl),
      "paste modal prefills the public inventory URL for the entered SteamID64");
    ok(await pageI.evaluate(() => document.activeElement && document.activeElement.id === "invPasteText"),
      "paste modal moves focus into the textarea on open");

    // Esc closes the dialog and hands the keyboard back to the opener
    await pageI.keyboard.press("Escape");
    await pageI.waitForFunction(() => !document.getElementById("invPasteModal").classList.contains("open"), { timeout: 4000 });
    ok(await pageI.evaluate(() => document.activeElement && document.activeElement.id === "invGo"),
      "paste modal: Esc closes and focus returns to the opener (#invGo)");

    const INV_FIXTURE = JSON.stringify({
      assets: [
        { appid: 730, contextid: "2", assetid: "1", classid: "c1", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "2", classid: "c1", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "3", classid: "c2", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "4", classid: "c3", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "5", classid: "zz", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "6", classid: "c1", instanceid: "5", amount: "1" },
      ],
      descriptions: [
        { classid: "c1", instanceid: "0", market_hash_name: NAME, marketable: 1, tradable: 1 },
        { classid: "c1", instanceid: "5", market_hash_name: NAME, marketable: 1, tradable: 0 },
        { classid: "c2", instanceid: "0", market_hash_name: "Fracture Case", marketable: 1, tradable: 1 },
        { classid: "c3", instanceid: "0", market_hash_name: "Dreams & Nightmares Case", marketable: 1, tradable: 0 },
      ],
      total_inventory_count: 6,
    });
    await pageI.click("#invPasteBtn");
    await pageI.waitForSelector("#invPasteModal.open", { timeout: 4000 });
    await pageI.fill("#invPasteText", "not json at all");
    await pageI.click("#invPasteGo");
    ok(/valid JSON/i.test(await pageI.textContent("#invPasteErr")) &&
      await pageI.evaluate(() => document.getElementById("invPasteModal").classList.contains("open")),
      "bad paste reports a plain-English error inline and keeps the dialog open");
    await pageI.fill("#invPasteText", INV_FIXTURE);
    await pageI.click("#invPasteGo");
    await pageI.waitForSelector("#invTotals .ds-tile", { timeout: 10000 });

    const totalsTxt = await pageI.textContent("#invTotals");
    ok(/INVENTORY VALUE/.test(totalsTxt) && /\$173\.00/.test(totalsTxt) && /5 items · 3 distinct names/.test(totalsTxt),
      "inventory value tile folds the pasted holdings ($173.00 = 5 units over 3 distinct names; the description-less asset is dropped)");
    // the parse layer keys by classid_instanceid (c1_0 qty 2 + c1_5 qty 1),
    // so a by-name collapse is what turns those into ONE qty-3 Redline row
    const nameRows = await pageI.$$eval("#invTable .ds-spec-table tbody tr",
      (els) => els.map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim())));
    ok(nameRows.length === 3 && nameRows.filter((r) => /Redline/.test(r[0])).length === 1 &&
      nameRows.find((r) => /Redline/.test(r[0]))[1] === "3",
      "holdings collapse BY NAME: two instanceids of one skin render as a single qty-3 row, not two lines");
    ok(nameRows.some((r) => r[0] === "AK-47 | Redline (Field-Tested)"),
      "holdings table keeps the FULL market_hash_name (the wear suffix is a different item)");
    // priced/unpriced are UNIT counts that sum to the inventory's unit count
    ok(/PRICED/.test(totalsTxt) && /4 \/ 5/.test(totalsTxt) && /1 not in the tracked set/.test(totalsTxt),
      "priced tile counts UNITS and sums to the total (4 / 5); the untracked unit is reported, never guessed");
    ok(/SINCE FIRST LOAD/.test(totalsTxt) && /VS SKINDEX/.test(totalsTxt),
      "since-first-load and VS SKINDEX tiles render");

    const invPainted = await pageI.evaluate(() => {
      const cv = document.getElementById("invChart");
      if (!cv || cv.closest("#invChartWrap").hidden) return 0;
      const img = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0;
      for (let i = 3; i < img.length; i += 40) if (img[i] > 0) lit++;
      return lit;
    });
    ok(invPainted > 200, "inventory value-over-time canvas actually painted (" + invPainted + " sampled px)");
    // the label describes EVERY plotted series (here: the reconstruction
    // alone — one recorded load is not a line yet); the two-series form is
    // pinned in the F2 block below
    ok(await pageI.$eval("#invChart", (cv) => cv.getAttribute("role") === "img" &&
      /Inventory value over time, 1 series\. Reconstructed value: \$/.test(cv.getAttribute("aria-label") || "") &&
      /px$/.test(cv.style.width)),
      "inventory chart is role=img with a descriptive aria-label and a pinned style.width");
    ok((await pageI.$$eval("#invChartTable details.dataTable table.dt tr", (els) => els.length)) > 2,
      "keyboard-reachable <details> data table accompanies the inventory chart");
    // table.dt's 520px floor is sized for the wide item view — in the 330px
    // sidebar it hid the Value column behind a horizontal scroll
    await pageI.$eval("#invChartTable details.dataTable", (d) => { d.open = true; });
    const dtFit = await pageI.evaluate(() => {
      const box = document.querySelector("#invChartTable details.dataTable .scroll");
      const tb = box.querySelector("table.dt");
      const lastCell = tb.rows[1] && tb.rows[1].cells[1];
      return { fits: tb.scrollWidth <= box.clientWidth + 1, valueText: lastCell && lastCell.textContent.trim() };
    });
    ok(dtFit.fits && /^\$/.test(dtFit.valueText || ""),
      "the inventory data table fits the sidebar — the value column is visible without scrolling (" + dtFit.valueText + ")");

    const tblTxt = await pageI.textContent("#invTable");
    ok(/Redline/.test(tblTxt) && /unpriced/.test(tblTxt) && (await pageI.$("#invTable .ds-scroll-x")) != null,
      "top-holdings table lists holdings (unpriced names labelled, not priced) inside a scroll wrapper");
    ok(/Reconstruction covers 75% of current value/.test(await pageI.textContent("#invHint")) &&
      /1 of 3 names have usable price history/.test(await pageI.textContent("#invHint")),
      "reconstruction coverage is stated as a share of CURRENT VALUE (75% — the priced-but-no-history name is excluded)");
    ok(await pageI.$eval("#invHint", (el) => el.getAttribute("role") === "status"),
      "inventory status line is an aria-live status region");

    // the input shares .lotForm's styling, which had only Chromium's
    // `outline:auto` default (1px near-black = invisible on the dark surface)
    await pageI.focus("#invInput");
    const invRing = await pageI.evaluate(() => {
      const cs = getComputedStyle(document.getElementById("invInput"));
      return { w: parseFloat(cs.outlineWidth) || 0, style: cs.outlineStyle };
    });
    ok(invRing.w >= 2 && invRing.style !== "none",
      "#invInput carries the house >=2px focus ring (" + invRing.w + "px " + invRing.style + ")");

    // only the RESULT containers re-render, and the sole focusable inside
    // them is the data table's <summary> — its open state and focus must
    // survive. A programmatic click does not move focus in Chromium, so the
    // summary is still focused while the panel rebuilds.
    await pageI.$eval("#invChartTable details.dataTable", (d) => { d.open = true; d.querySelector("summary").focus(); });
    await pageI.evaluate((v) => {
      document.getElementById("invPasteText").value = v;
      document.getElementById("invPasteGo").click();
    }, INV_FIXTURE);
    await pageI.waitForTimeout(1200);
    const carried = await pageI.evaluate(() => {
      const d = document.querySelector("#invChartTable details.dataTable");
      return { open: !!(d && d.open), tag: document.activeElement.tagName.toLowerCase(),
        inTable: !!(document.activeElement.closest && document.activeElement.closest("#invChartTable")) };
    });
    ok(carried.open && carried.tag === "summary" && carried.inTable,
      "data table open state + focus survive the panel re-render (never dumped to <body>)");

    const snaps = await pageI.evaluate(() => JSON.parse(localStorage.getItem("skinlab_inv_v1") || "[]"));
    ok(snaps.length === 1 && snaps[0].value === 173 && snaps[0].count === 5,
      "static mode records a {t,value,count} snapshot in localStorage (" + JSON.stringify(snaps[0] || null) + ")");
    // re-loading inside the 10-minute window must UPDATE the snapshot, not append
    await pageI.click("#invPasteBtn");
    await pageI.waitForSelector("#invPasteModal.open", { timeout: 4000 });
    await pageI.fill("#invPasteText", INV_FIXTURE);
    await pageI.click("#invPasteGo");
    await pageI.waitForFunction(() => /173\.00/.test(document.getElementById("invTotals").textContent), { timeout: 8000 });
    const snaps2 = await pageI.evaluate(() => JSON.parse(localStorage.getItem("skinlab_inv_v1") || "[]"));
    ok(snaps2.length === 1, "a second load inside 10 minutes dedupes into one snapshot (" + snaps2.length + ")");

    await pageI.screenshot({ path: "/tmp/skin_lab_inventory.png", fullPage: true });
    console.log("  📸 /tmp/skin_lab_inventory.png");

    // the loaded panel must not blow the page out on a phone
    await pageI.setViewportSize({ width: 390, height: 844 });
    await pageI.waitForTimeout(400);
    const wInv = await pageI.evaluate(() => document.scrollingElement.scrollWidth);
    ok(wInv <= 391, "inventory panel: no horizontal page scroll at 390px (scrollWidth=" + wInv + ")");
    ok(errorsI.length === 0, "inventory flow: zero uncaught page errors" + (errorsI.length ? " — " + errorsI[0] : ""));

    await ctxI.close();
    statI.close();
    fs.rmSync(IROOT, { recursive: true, force: true });
  }

  // ── ADDITIVE (F2): failed loads, the static SteamID64 dead-end, series
  //    identity, chart/table honesty ───────────────────────────────────────
  // Six defects an adversarial review found in the inventory flow, each with
  // a check that goes RED without its fix (verified by reverting each fix in
  // turn). Own ports 5520-5529, own collected roots.
  //
  // 1) LIVE MODE, on the tracker `page` already booted above: a load that
  //    FAILS must leave the error in the panel's status region — it used to
  //    render while busy was still true, so the region announced "Reading
  //    your inventory…" for good and the only surface was an 8s toast.
  //    The privacy copy must also be true HERE: in live mode the SteamID is
  //    POSTed to the tracker and written to its local-data/.
  {
    const privLive = await page.textContent("#invPrivacy");
    ok(!/stays in this browser/i.test(privLive) && /tracker/i.test(privLive) && /local-data/i.test(privLive),
      "live mode: the privacy line says where the SteamID actually goes (the tracker + its local-data), not \"stays in this browser\"");

    // 76561190000000002 resolves (17 digits, no lookup needed) but the
    // fixture transport serves no inventory for it → a real failed first load
    await page.fill("#invInput", "76561190000000002");
    await page.click("#invGo");
    await page.waitForFunction(() => {
      const h = document.getElementById("invHint").textContent;
      return h && !/Reading your inventory/.test(h) && /Couldn't load/.test(h);
    }, { timeout: 15000 }).catch(() => {});
    const failHint = (await page.textContent("#invHint")) || "";
    const failToast = (await page.textContent("#toast")) || "";
    const failBusy = await page.$eval("#invPanel", (el) => el.getAttribute("aria-busy"));
    ok(!/Reading your inventory/.test(failHint) && /Couldn't load that inventory/.test(failHint) &&
      failToast.length > 0 && failHint.includes(failToast.trim()) && failBusy === "false",
      "a failed load leaves the ERROR in the panel (never a permanent \"Reading your inventory…\"), aria-busy=false — " +
      JSON.stringify(failHint.slice(0, 60)));
    ok(/Load inventory again/.test(failHint) && /Paste JSON/.test(failHint),
      "the failure state says what to do next (retry, or paste the JSON yourself)");

    // a LIVE paste must carry the profile, or the tracker keys the snapshot
    // by composition instead of attaching it to the user's real value line
    const posted = [];
    const spy = (r) => { if (r.method() === "POST" && r.url().includes("/api/skins/inventory")) posted.push(r.postData() || ""); };
    page.on("request", spy);
    await page.fill("#invInput", "76561190000000001");
    await page.click("#invPasteBtn");
    await page.waitForSelector("#invPasteModal.open", { timeout: 4000 });
    await page.fill("#invPasteText", JSON.stringify({
      assets: [{ appid: 730, contextid: "2", assetid: "1", classid: "c1", instanceid: "0", amount: "1" }],
      descriptions: [{ classid: "c1", instanceid: "0", market_hash_name: NAME, marketable: 1, tradable: 1 }],
      total_inventory_count: 1,
    }));
    await page.click("#invPasteGo");
    await page.waitForSelector("#invTotals .ds-tile", { timeout: 12000 });
    ok(posted.some((b) => /"paste"/.test(b) && /"profile":"76561190000000001"/.test(b)),
      "a live-mode paste sends the profile with it, so the tracker files it under the user's own identity");

    // and the privacy control actually withdraws it: the tracker's stored
    // SteamID + value series are gone after 🧹 Forget
    ok(await page.$eval("#invForgetRow", (el) => !!el.getClientRects().length), "the 🧹 Forget control is offered once something is stored");
    page.once("dialog", (d) => d.dismiss());
    await page.click("#invForget");
    await page.waitForTimeout(400);
    const survived = await (await fetch("http://localhost:" + PORT + "/api/skins/inventory/series")).json();
    ok((survived.series || []).length > 0 && !!(await page.$("#invTotals .ds-tile")),
      "cancelling the confirm erases NOTHING (tracker series intact, report still on screen)");
    page.once("dialog", (d) => d.accept());
    await page.click("#invForget");
    // a wait that THROWS would abort the run — let the assertion report instead
    await page.waitForFunction(() => !document.querySelector("#invTotals .ds-tile"), { timeout: 8000 }).catch(() => {});
    const afterForget = await (await fetch("http://localhost:" + PORT + "/api/skins/inventory/series")).json();
    const forgetToast = await page.textContent("#toast");
    ok((afterForget.series || []).length === 0 && /off the tracker/.test(forgetToast) &&
      (await page.evaluate(() => localStorage.getItem("skinlab_inv_v1"))) == null,
      "🧹 Forget erases the tracker's stored inventory AND this browser's loads, and says so");
    page.off("request", spy);
  }

  // 2-6) STATIC MODE — its own collected root + static host on 5520.
  const JROOT = path.join(os.tmpdir(), "hh-skin-inv-f2-" + Date.now());
  {
    const { collect } = require("./collect.js");
    const { slug } = require(path.join(__dirname, "server.js"));
    fs.mkdirSync(path.join(JROOT, "data", "import"), { recursive: true });
    fs.writeFileSync(path.join(JROOT, "watchlist.json"), JSON.stringify({ items: [NAME, "Fracture Case"] }));
    const impFor = (base) => Array.from({ length: 120 }, (_, i) =>
      ({ t: Date.now() - (120 - i) * D, price: base * Math.exp(0.003 * i) * (1 + 0.05 * Math.sin(i / 6)), vol: 40 + (i % 20) }));
    fs.writeFileSync(path.join(JROOT, "data", "import", slug(NAME) + ".json"), JSON.stringify({ t: Date.now(), source: "probe", rows: impFor(30) }));
    // the CASE needs deep history too, or the published caseIdx is null on
    // every day and benchmarkGrowth (hence the whole VS SKINDEX tile) is
    // legitimately "—" — this scenario is about what the tile SAYS
    fs.writeFileSync(path.join(JROOT, "data", "import", slug("Fracture Case") + ".json"), JSON.stringify({ t: Date.now(), source: "probe", rows: impFor(2) }));
    await collect({ root: JROOT });

    const statJ = makeStatic(5520, path.join(JROOT, "data"));
    const ctxJ = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctxJ.route(/^https?:\/\/(localhost|127\.0\.0\.1):8790\//, (r) => r.abort());
    // a settable clock skew: the 10-minute snapshot dedupe means "a second,
    // later load" can only be exercised by moving time forward
    await ctxJ.addInitScript(() => {
      const realNow = Date.now;
      window.__skew = 0;
      Date.now = function () { return realNow() + (window.__skew || 0); };
    });
    const pageJ = await ctxJ.newPage();
    const errorsJ = [];
    pageJ.on("pageerror", (e) => errorsJ.push(String(e)));
    await pageJ.goto("http://localhost:5520/", { waitUntil: "networkidle" });
    await pageJ.waitForSelector(".mrow", { timeout: 10000 });

    ok(/stays in this browser/i.test(await pageJ.textContent("#invPrivacy")) &&
      /price history of the skins you own/i.test(await pageJ.textContent("#invPrivacy")),
      "static mode: the privacy line keeps the true \"stays in this browser\" promise and discloses the per-holding history reads");

    // 2) the static dead-end: a vanity name (and the field's OWN placeholder
    //    used to be one) must never yield a URL Steam 404s
    const ph = await pageJ.$eval("#invInput", (el) => el.getAttribute("placeholder") || "");
    ok(/\/profiles\//.test(ph) && !/\/id\//.test(ph),
      "the profile field's placeholder shows the form that works on a static host (" + ph + ")");
    await pageJ.fill("#invInput", "steamcommunity.com/id/yourname");
    await pageJ.click("#invGo");
    await pageJ.waitForSelector("#invPasteModal.open", { timeout: 4000 });
    const vanity = await pageJ.evaluate(() => ({
      url: document.getElementById("invPasteUrl").textContent,
      urlHidden: document.getElementById("invPasteUrl").hidden,
      help: document.getElementById("invPasteIdHelp").textContent,
      helpShown: !!document.getElementById("invPasteIdHelp").getClientRects().length,
      modal: document.querySelector("#invPasteModal .modal").textContent,
    }));
    ok(!/YOUR_STEAMID64/.test(vanity.modal) && vanity.urlHidden && !vanity.url.trim() &&
      vanity.helpShown && /SteamID64/.test(vanity.help) && /profiles/.test(vanity.help),
      "a vanity name opens the paste modal with SteamID64 GUIDANCE, never a placeholder URL that 404s");
    await pageJ.keyboard.press("Escape");
    await pageJ.waitForFunction(() => !document.getElementById("invPasteModal").classList.contains("open"), { timeout: 4000 });
    // ...and a real id still prefills the working address, with the help gone
    await pageJ.fill("#invInput", "76561190000000001");
    await pageJ.click("#invGo");
    await pageJ.waitForSelector("#invPasteModal.open", { timeout: 4000 });
    const withId = await pageJ.evaluate(() => ({
      url: document.getElementById("invPasteUrl").textContent,
      urlShown: !!document.getElementById("invPasteUrl").getClientRects().length,
      helpHidden: document.getElementById("invPasteIdHelp").hidden,
    }));
    ok(withId.urlShown && /76561190000000001\/730\/2/.test(withId.url) && withId.helpHidden,
      "a 17-digit SteamID64 still prefills the real inventory URL (guidance hidden)");
    await pageJ.keyboard.press("Escape");
    await pageJ.waitForFunction(() => !document.getElementById("invPasteModal").classList.contains("open"), { timeout: 4000 });

    const FIX_A = JSON.stringify({
      assets: [
        { appid: 730, contextid: "2", assetid: "1", classid: "c1", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "2", classid: "c1", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "3", classid: "c2", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "4", classid: "c3", instanceid: "0", amount: "1" },
        { appid: 730, contextid: "2", assetid: "6", classid: "c1", instanceid: "5", amount: "1" },
      ],
      descriptions: [
        { classid: "c1", instanceid: "0", market_hash_name: NAME, marketable: 1, tradable: 1 },
        { classid: "c1", instanceid: "5", market_hash_name: NAME, marketable: 1, tradable: 0 },
        { classid: "c2", instanceid: "0", market_hash_name: "Fracture Case", marketable: 1, tradable: 1 },
        { classid: "c3", instanceid: "0", market_hash_name: "Dreams & Nightmares Case", marketable: 1, tradable: 0 },
      ],
      total_inventory_count: 5,
    });
    // same person, ONE holding sold: 5 units → 4, $173.00 → $129.75
    const FIX_A_SOLD = JSON.stringify(Object.assign(JSON.parse(FIX_A), {
      assets: JSON.parse(FIX_A).assets.filter((a) => a.classid !== "c2"), total_inventory_count: 4 }));
    // a DIFFERENT person: one Fracture Case, $43.25
    const FIX_B = JSON.stringify({
      assets: [{ appid: 730, contextid: "2", assetid: "9", classid: "c2", instanceid: "0", amount: "1" }],
      descriptions: [{ classid: "c2", instanceid: "0", market_hash_name: "Fracture Case", marketable: 1, tradable: 1 }],
      total_inventory_count: 1,
    });
    // every paste changes the tiles (value, or the since-first-load line), so
    // "the totals text moved and the panel is idle again" is the settle signal
    const pasteAs = async (profile, json) => {
      const prev = await pageJ.textContent("#invTotals");
      await pageJ.fill("#invInput", profile);
      await pageJ.click("#invPasteBtn");
      await pageJ.waitForSelector("#invPasteModal.open", { timeout: 4000 });
      await pageJ.fill("#invPasteText", json);
      await pageJ.click("#invPasteGo");
      await pageJ.waitForFunction((p) => {
        const el = document.getElementById("invTotals");
        return el && el.querySelectorAll(".ds-tile").length > 0 && el.textContent !== p &&
          document.getElementById("invPanel").getAttribute("aria-busy") === "false";
      }, prev, { timeout: 20000 });
      return pageJ.textContent("#invTotals");
    };

    const totA = await pasteAs("76561190000000001", FIX_A);
    ok(/\$173\.00/.test(totA) && /first load — the line starts here/.test(totA),
      "inventory A loads and starts its own value line");
    // 6) the alpha window is TRIMMED to where both legs are like-for-like —
    //    the tile must say WHICH window it measured
    const alphaSub = await pageJ.$eval("#invTotals", (el) => {
      const t = Array.from(el.querySelectorAll(".ds-tile")).find((x) => /VS SKINDEX/.test(x.textContent));
      return t ? t.querySelector(".ds-tile-sub").textContent : "";
    });
    ok(/\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/.test(alphaSub),
      "VS SKINDEX discloses the measured window (from → to), not just a day count — " + JSON.stringify(alphaSub));

    // 3) a SECOND, DIFFERENT inventory must start its own line — three days
    //    later, so the 10-minute dedupe cannot mask it
    await pageJ.evaluate(() => { window.__skew = 3 * 86400000; });
    const totB = await pasteAs("76561190000000999", FIX_B);
    ok(/\$43\.25/.test(totB) && /first load — the line starts here/.test(totB) && !/-75\.0%/.test(totB),
      "a different inventory starts a FRESH line — no cross-inventory P/L (" +
      (totB.match(/SINCE FIRST LOAD[^·]*/) || [""])[0].trim().slice(0, 60) + ")");
    const buckets = await pageJ.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem("skinlab_inv_v1") || "[]");
      return { n: rows.length, scopes: Array.from(new Set(rows.map((r) => r.inv || ""))),
        raw: JSON.stringify(rows) };
    });
    ok(buckets.n === 2 && buckets.scopes.length === 2 &&
      !/7656119000000/.test(buckets.raw) && buckets.raw.indexOf("\"inv\"") > 0,
      "both loads are stored, scoped by a ONE-WAY digest — the SteamID itself never reaches localStorage");

    // 4) same person, changed holdings: a value move across a changed basket
    //    is not a return, and must not be printed as one
    await pageJ.evaluate(() => { window.__skew = 6 * 86400000; });
    const totSold = await pasteAs("76561190000000001", FIX_A_SOLD);
    ok(/the holdings changed \(5 → 4 items\)/.test(totSold) && /not a return/.test(totSold) &&
      !/-25\.0% over/.test(totSold),
      "a changed basket is reported as a value change, never as a % return");
    // a SWAP is the case identity + unit count cannot see: same 5 units, one
    // name traded for another, same total — only the composition signature
    // separates "the market moved" from "I changed what I hold"
    const FIX_A_SWAP = JSON.stringify(Object.assign(JSON.parse(FIX_A), {
      descriptions: JSON.parse(FIX_A).descriptions.map((d) => d.classid === "c3"
        ? Object.assign({}, d, { market_hash_name: "Kilowatt Case" }) : d) }));
    await pageJ.evaluate(() => { window.__skew = 8 * 86400000; });
    await pasteAs("76561190000000001", FIX_A_SWAP);
    // read the SINCE FIRST LOAD tile itself — "0.0% over" also appears in the
    // alpha tile, so a whole-panel regex would be testing the wrong sentence
    const swapSub = await pageJ.$eval("#invTotals", (el) => {
      const t = Array.from(el.querySelectorAll(".ds-tile")).find((x) => /SINCE FIRST LOAD/.test(x.textContent));
      return t ? t.querySelector(".ds-tile-sub").textContent : "";
    });
    ok(/the holdings changed \(different items\)/.test(swapSub) && !/% over/.test(swapSub),
      "the same unit count with DIFFERENT items is caught by the composition signature, not read as a flat return — " +
      JSON.stringify(swapSub.slice(0, 80)));

    // 5) chart + data table with BOTH series plotted. Record a load 300 days
    //    ago (before the reconstruction starts), then the same holdings
    //    today — same line either way, id-less or not.
    await pageJ.evaluate(() => { window.__skew = -300 * 86400000; });
    await pasteAs("", FIX_A);
    await pageJ.evaluate(() => { window.__skew = 6 * 86400000; });
    await pasteAs("", FIX_A);
    const chart = await pageJ.evaluate(() => ({
      label: document.getElementById("invChart").getAttribute("aria-label") || "",
      days: Array.from(document.querySelectorAll("#invChartTable table.dt tr td:first-child"))
        .map((td) => td.textContent.replace("†", "")),
    }));
    const ordered = chart.days.every((d, i) => i === 0 || chart.days[i - 1] <= d);
    ok(chart.days.length > 2 && ordered,
      "the chart's data table is chronological — a recorded load older than the reconstruction sorts FIRST (" +
      chart.days.slice(0, 3).join(", ") + " … " + chart.days.slice(-1) + ")");
    ok(/2 series/.test(chart.label) && /Reconstructed value:/.test(chart.label) &&
      chart.label.includes("Recorded loads: $173.00 on " + chart.days[0]),
      "the chart aria-label describes BOTH plotted series, with the recorded line's real range — " +
      JSON.stringify(chart.label.slice(0, 90)));

    // 8) an oversized paste is CAPPED in the browser too (5000 assets), and
    //    the note names the real cause instead of blaming Steam
    const BIG = JSON.stringify({
      assets: Array.from({ length: 5003 }, (_, i) => ({ appid: 730, contextid: "2", assetid: String(i + 1),
        classid: "c1", instanceid: "0", amount: "1" })),
      descriptions: [{ classid: "c1", instanceid: "0", market_hash_name: NAME, marketable: 1, tradable: 1 }],
      total_inventory_count: 5003,
    });
    await pageJ.evaluate(() => { window.__skew = 9 * 86400000; });
    const totBig = await pasteAs("76561190000000001", BIG);
    ok(/5000 items/.test(totBig) && /Only the first 5000 items in that paste were read/.test(await pageJ.textContent("#invHint")),
      "a 5003-asset paste is capped at 5000 in the browser, and the note names the cap (not \"Steam truncated it\")");

    // 9) 🧹 Forget — the withdraw control, static half
    const beforeForget = await pageJ.evaluate(() => (localStorage.getItem("skinlab_inv_v1") || "").length);
    pageJ.once("dialog", (d) => d.dismiss());
    await pageJ.click("#invForget");
    await pageJ.waitForTimeout(300);
    ok(beforeForget > 0 && (await pageJ.evaluate(() => (localStorage.getItem("skinlab_inv_v1") || "").length)) === beforeForget,
      "static mode: cancelling the 🧹 Forget confirm keeps every recorded load");
    pageJ.once("dialog", (d) => d.accept());
    await pageJ.click("#invForget");
    await pageJ.waitForFunction(() => !document.querySelector("#invTotals .ds-tile"), { timeout: 8000 }).catch(() => {});
    const forgotten = await pageJ.evaluate(() => ({
      raw: localStorage.getItem("skinlab_inv_v1"),
      hint: document.getElementById("invHint").textContent,
      rowShown: !!document.getElementById("invForgetRow").getClientRects().length,
      toast: document.getElementById("toast").textContent,
    }));
    ok(forgotten.raw == null && /erased from this browser/.test(forgotten.toast) &&
      /Load your inventory to value it/.test(forgotten.hint) && !forgotten.rowShown,
      "static mode: 🧹 Forget clears the stored loads and the panel, and the control retires itself");

    await pageJ.screenshot({ path: "/tmp/skin_lab_inventory_f2.png", fullPage: true });
    console.log("  📸 /tmp/skin_lab_inventory_f2.png");
    ok(errorsJ.length === 0, "F2 inventory flow: zero uncaught page errors" + (errorsJ.length ? " — " + errorsJ[0] : ""));
    await ctxJ.close();
    statJ.close();
    fs.rmSync(JROOT, { recursive: true, force: true });
  }

  // 7) IDEMPOTENCE: the per-load history cap (60 names) must not make the
  //    SAME paste answer differently on the second click. 61 tracked names,
  //    pasted twice.
  const KROOT = path.join(os.tmpdir(), "hh-skin-inv-f2cap-" + Date.now());
  {
    const { collect } = require("./collect.js");
    const CAP_NAMES = Array.from({ length: 61 }, (_, i) => "Probe Case " + (i + 1));
    fs.mkdirSync(path.join(KROOT, "data"), { recursive: true });
    fs.writeFileSync(path.join(KROOT, "watchlist.json"), JSON.stringify({ items: CAP_NAMES }));
    await collect({ root: KROOT });
    const statK = makeStatic(5521, path.join(KROOT, "data"));
    const ctxK = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctxK.route(/^https?:\/\/(localhost|127\.0\.0\.1):8790\//, (r) => r.abort());
    await ctxK.addInitScript(() => {
      const realNow = Date.now;
      window.__skew = 0;
      Date.now = function () { return realNow() + (window.__skew || 0); };
    });
    const pageK = await ctxK.newPage();
    await pageK.goto("http://localhost:5521/", { waitUntil: "networkidle" });
    await pageK.waitForSelector(".mrow", { timeout: 15000 });
    const CAP_FIXTURE = JSON.stringify({
      assets: CAP_NAMES.map((n, i) => ({ appid: 730, contextid: "2", assetid: String(i + 1),
        classid: "k" + i, instanceid: "0", amount: "1" })),
      descriptions: CAP_NAMES.map((n, i) => ({ classid: "k" + i, instanceid: "0",
        market_hash_name: n, marketable: 1, tradable: 1 })),
      total_inventory_count: 61,
    });
    const capLoad = async () => {
      const prev = await pageK.textContent("#invTotals");
      await pageK.click("#invPasteBtn");
      await pageK.waitForSelector("#invPasteModal.open", { timeout: 4000 });
      await pageK.fill("#invPasteText", CAP_FIXTURE);
      await pageK.click("#invPasteGo");
      await pageK.waitForFunction((p) => {
        const el = document.getElementById("invTotals");
        return el && el.querySelectorAll(".ds-tile").length > 0 && el.textContent !== p &&
          document.getElementById("invPanel").getAttribute("aria-busy") === "false";
      }, prev, { timeout: 40000 });
      const hint = await pageK.textContent("#invHint");
      return { hint: hint, cov: (hint.match(/Reconstruction covers [^·]+·[^·]+·/) || [""])[0] };
    };
    const cap1 = await capLoad();
    await pageK.evaluate(() => { window.__skew = 86400000; });
    const cap2 = await capLoad();
    ok(cap1.cov && cap1.cov === cap2.cov,
      "the same paste yields the SAME coverage on a second load (over-cap names are negative-cached, not re-fetched) — " +
      JSON.stringify((cap1.cov.match(/\d+ of \d+ names/) || [""])[0] + " vs " + (cap2.cov.match(/\d+ of \d+ names/) || [""])[0]));
    ok(/Price history is read for at most 60 holdings/.test(cap1.hint) && /counted as having none/.test(cap1.hint),
      "the browser-side history cap is disclosed instead of silently under-covering");
    await ctxK.close();
    statK.close();
    fs.rmSync(KROOT, { recursive: true, force: true });
  }

  await browser.close();
  await inst.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log("\n" + (fail ? fail + " FAILURE(S)" : "ALL PASS (" + pass + " checks)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); process.exit(1); });
