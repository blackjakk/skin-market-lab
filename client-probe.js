#!/usr/bin/env node
// client-probe.js — Skin Market Lab dashboard, end-to-end in a real
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
  ok(/LAB CASE INDEX/.test(stripTxt) && /CS2 PLAYERS/.test(stripTxt) && /CASH RATIO/.test(stripTxt),
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
    fs.writeFileSync(path.join(SROOT, "watchlist.json"), JSON.stringify({ items: [NAME, "Fracture Case"] }));
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
    ok(rows.length === 2, "static data mode boots read-only on the market home (" + rows.length + " rows)");
    ok(/read-only/.test(await pageD.textContent("#netStatus")), "netStatus says read-only + data via GitHub");
    ok(/LAB CASE INDEX/.test(await pageD.textContent("#itemView")), "market strip renders from the committed manifest");
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

  await browser.close();
  await inst.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log("\n" + (fail ? fail + " FAILURE(S)" : "ALL PASS (" + pass + " checks)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); process.exit(1); });
