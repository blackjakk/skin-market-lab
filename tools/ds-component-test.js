#!/usr/bin/env node
// tools/ds-component-test.js — Design System component test, real Chromium.
// Serves the repo root statically (port 5410, the client-probe makeStatic
// pattern), opens design-system/gallery.html, and asserts every DS factory
// renders, escapes attacker strings as text, and behaves: toggle aria-pressed
// + class flips, DS.keyActivate on click / Enter / Space, range-chip active
// state, tile tones, badge tones, spec-table trusted vs escaped cells — with
// zero page errors and zero console errors.
//
//   node tools/ds-component-test.js
"use strict";
const PW_LIB = process.env.PLAYWRIGHT_LIB || "/opt/node22/lib/node_modules/playwright";
const { chromium } = require(PW_LIB);
const http = require("http");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const PORT = 5410;
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ FAIL " + label); } };

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".md": "text/plain; charset=utf-8" };
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const f = path.join(ROOT, url === "/" ? "index.html" : path.normalize(url).replace(/^([.][.][/\\])+/, ""));
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT);

(async () => {
  // ── node-side factory pins (UMD require path + exact string shapes) ─────
  const DS = require(path.join(ROOT, "design-system", "ds.js"));
  console.log("ds.js factory pins (node require):");
  ok(["esc", "cx", "attrs", "tile", "tiles", "chip", "toggle", "btn", "rangeChips",
      "legendItem", "panel", "hint", "badge", "specTable", "keyActivate"]
      .every((k) => typeof DS[k] === "function"),
    "UMD node export exposes all 15 API functions");
  ok(DS.esc('<a b="c">&\'') === "&lt;a b=&quot;c&quot;&gt;&amp;&#39;", "DS.esc escapes & < > \" '");
  ok(DS.cx("a", null, false, "b", undefined, "c") === "a b c", "DS.cx joins truthy class parts");
  ok(DS.attrs({ id: "x", "data-k": 'v"w', gone: null, off: false, disabled: true }) ===
      ' id="x" data-k="v&quot;w" disabled',
    "DS.attrs escapes values, skips null/false, bare-renders true");
  ok(DS.tile({ label: "L", value: "<i>", tone: "up" }).includes("&lt;i&gt;") &&
     DS.tile({ label: "L", value: "v", tone: "up" }).includes('class="ds-tile up"'),
    "DS.tile escapes value text and applies the tone class");
  ok(DS.badge({ label: "B", tone: "good" }) === '<span class="ds-badge good">B</span>',
    "DS.badge exact shape (tone class, escaped label)");
  ok(DS.rangeChips({ ranges: ["1Y", "ALL"], active: "ALL", dataKey: "ir" }).includes('data-ir="1Y"') &&
     DS.rangeChips({ ranges: ["1Y", "ALL"], active: "ALL", dataKey: "ir" })
       .includes('class="ds-btn compact on" data-ir="ALL" aria-pressed="true"'),
    "DS.rangeChips emits data-<key> hooks + .on/aria-pressed on the active chip");
  ok(DS.specTable({ head: ["H"], rows: [["<x>"], [{ html: "<b>t</b>" }]] }).includes("&lt;x&gt;") &&
     DS.specTable({ head: ["H"], rows: [[{ html: "<b>t</b>" }]] }).includes("<b>t</b>"),
    "DS.specTable escapes plain cells, passes { html } cells through TRUSTED");
  ok(DS.toggle({ label: "T", on: true, data: { ov: "btc" } }).includes('aria-pressed="true"') &&
     DS.toggle({ label: "T", on: false, data: { ov: "btc" } }).includes('data-ov="btc"'),
    "DS.toggle emits aria-pressed state + data-* hooks");
  ok(DS.hint("plain & <text>").includes("plain &amp; &lt;text&gt;"), "DS.hint(string) escapes");

  // ── browser side ────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1700 } });
  const pageErrors = [], consoleErrors = [], dialogs = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) consoleErrors.push(m.text());
  });
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.goto("http://localhost:" + PORT + "/design-system/gallery.html", { waitUntil: "networkidle" });
  await page.waitForSelector("#g-tiles .ds-tile", { timeout: 8000 });
  console.log("gallery renders:");
  ok(true, "gallery.html loads and renders tiles");

  const cs = (sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el)[p], prop);
  const txt = (sel) => page.textContent(sel);
  const count = (sel) => page.$$eval(sel, (els) => els.length);

  // tiles
  ok(await count("#g-tiles .ds-tile") === 6, "DS.tile renders (6 tiles in the strip)");
  ok((await txt("#g-tiles .ds-tile .ds-tile-lb")) === "LAB CASE INDEX", "tile label text");
  ok((await txt("#g-tiles .ds-tile .ds-tile-v")) === "112.4", "tile value text");
  ok(/\+1\.2% 24h/.test(await txt("#g-tiles .ds-tile .ds-tile-sub")), "tile sub renders");
  ok((await cs("#g-tiles .ds-tiles", "display")) === "grid", "DS.tiles wrapper is a CSS grid");
  ok(await page.$("#g-tiles .ds-tiles.strip") !== null, "tiles strip variant class applied");
  ok((await cs("#g-tiles .ds-tile.up .ds-tile-v", "color")) === "rgb(63, 174, 106)",
    "tile tone up → --ds-good value color");
  ok((await cs("#g-tiles .ds-tile.dn .ds-tile-v", "color")) === "rgb(230, 103, 103)",
    "tile tone dn → --ds-bad value color");
  ok(await page.$("#g-tiles .ds-tile.good") !== null && await page.$("#g-tiles .ds-tile.bad") !== null,
    "tile tones good + bad render");
  ok((await cs("#g-tiles .ds-tile.big .ds-tile-v", "fontSize")) === "20px",
    "tile cls 'big' → --ds-fs-val-lg (doc-page scale)");

  // chips
  console.log("chips / toggles / buttons:");
  ok(await page.$eval("#g-chips .ds-chip:not(.interactive)", (el) => el.tagName) === "SPAN",
    "inert chip is a <span>");
  ok(await page.$eval("#g-chips .ds-chip.interactive", (el) => el.tagName) === "BUTTON",
    "interactive chip is a real <button>");
  ok((await cs("#g-chips .ds-chip.interactive", "cursor")) === "pointer", "interactive chip cursor: pointer");
  await page.click("#g-chips .ds-chip.interactive");
  ok((await txt("#g-chip-out")) === "AK-47 | Redline (Field-Tested)",
    "interactive chip data-* hook + addEventListener binding fires");

  // toggles: aria-pressed + .on move together; swatch dims off state
  const T_ON = '#g-toggles .ds-toggle[data-ov="players"]', T_OFF = '#g-toggles .ds-toggle[data-ov="btc"]';
  ok(await page.$eval(T_ON, (el) => el.getAttribute("aria-pressed") === "true" && el.classList.contains("on")),
    "on-toggle renders aria-pressed=true + .on");
  ok(await page.$eval(T_OFF, (el) => el.getAttribute("aria-pressed") === "false" && !el.classList.contains("on")),
    "off-toggle renders aria-pressed=false, no .on");
  ok((await cs(T_OFF + " .ds-sw", "opacity")) === "0.35", "off-toggle swatch dimmed to .35 (CSS off aria-pressed)");
  await page.click(T_OFF);
  ok(await page.$eval(T_OFF, (el) => el.getAttribute("aria-pressed") === "true" && el.classList.contains("on")),
    "toggle click flips aria-pressed AND the .on class");
  ok((await cs(T_OFF + " .ds-sw", "opacity")) === "1", "toggle click restores swatch opacity to 1");
  await page.click(T_OFF);
  ok(await page.$eval(T_OFF, (el) => el.getAttribute("aria-pressed") === "false" && !el.classList.contains("on")),
    "second click reverts the toggle (state round-trips)");

  // buttons
  ok(await count("#g-btns .ds-btn") === 6, "DS.btn renders all 6 variants");
  ok((await cs("#g-btns .ds-btn.primary", "color")) === "rgb(212, 175, 55)", "primary button → --ds-accent");
  ok((await cs("#g-btns .ds-btn.danger", "color")) === "rgb(230, 103, 103)", "danger button → --ds-bad");
  ok((await cs("#g-btns .ds-btn.compact", "fontSize")) === "11.5px" &&
     (await cs("#g-btns .ds-btn.compact", "paddingTop")) === "4px",
    "compact button → --ds-fs-lbl + tight padding");
  ok((await cs("#g-btns .ds-btn[disabled]", "opacity")) === "0.45", "disabled button dims to .45");
  ok((await cs("#g-btns .ds-btn.on", "borderTopColor")) === "rgb(212, 175, 55)", "on button → accent border");

  // range chips
  console.log("range chips:");
  ok(await count("#g-range .ds-range .ds-btn") === 3, "DS.rangeChips renders a 3-chip row");
  ok(await page.$eval('#g-range [data-ir="ALL"]', (el) => el.classList.contains("on") && el.getAttribute("aria-pressed") === "true"),
    "active range chip carries .on + aria-pressed=true");
  ok(await page.$eval('#g-range [data-ir="1Y"]', (el) => !el.classList.contains("on")),
    "inactive range chip has no .on");
  await page.click('#g-range [data-ir="1Y"]');
  ok(await page.$eval('#g-range [data-ir="1Y"]', (el) => el.classList.contains("on") && el.getAttribute("aria-pressed") === "true") &&
     await page.$eval('#g-range [data-ir="ALL"]', (el) => !el.classList.contains("on")),
    "clicking a range chip moves the active state (consumer re-render pattern)");

  // keyActivate: click, Enter, Space (real keyboard events)
  console.log("keyActivate:");
  await page.click('#g-activate .g-mrow[data-name="Kilowatt Case"]');
  ok((await txt("#g-activate-count")) === "1" && (await txt("#g-activate-last")) === "Kilowatt Case",
    "DS.keyActivate fires on click");
  await page.focus('#g-activate .g-mrow[data-name="Fracture Case"]');
  await page.keyboard.press("Enter");
  ok((await txt("#g-activate-count")) === "2" && (await txt("#g-activate-last")) === "Fracture Case",
    "DS.keyActivate fires on Enter");
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.keyboard.press(" ");
  ok((await txt("#g-activate-count")) === "3", "DS.keyActivate fires on Space");
  ok((await page.evaluate(() => window.scrollY)) === scrollBefore,
    "Space is preventDefault-ed (page did not scroll)");
  ok((await txt("#g-activate-count")) === "3", "exactly one activation per event (no double-fire)");

  // legend
  console.log("legend / panel / hint / warmup:");
  ok(await count("#g-legend .ds-legend-item") === 3 && await count("#g-legend .ds-sw") === 3,
    "DS.legendItem renders 3 entries with swatches");
  ok((await cs("#g-legend .ds-legend-item .ds-sw", "backgroundColor")) === "rgb(57, 135, 229)",
    "legend swatch resolves var(--ds-series-price)");
  ok(await page.$("#g-legend .ds-legend-item a") !== null, "legend TRUSTED html slot renders a real link");

  // panel / hint / warmup
  ok(await page.$eval("#g-tiles", (el) => el.classList.contains("ds-panel")), "DS.panel emits .ds-panel + attrs id");
  ok(/TILES/.test(await txt("#g-tiles .ds-panel-h")), "panel title renders in .ds-panel-h");
  ok((await cs("#g-tiles", "backgroundColor")) === "rgb(21, 22, 26)", "panel surface = --ds-surface-1");
  ok((await cs("#g-hints .ds-hint", "color")) === "rgb(124, 127, 136)", "hint text = --ds-text-muted");
  ok((await cs("#g-warmup", "borderTopColor")) === "rgb(212, 175, 55)", "warmup pill = accent border");

  // badges
  console.log("badges / spec table / chartbox:");
  ok((await cs("#g-badges .ds-badge.good", "color")) === "rgb(63, 174, 106)", "badge tone good");
  ok((await cs("#g-badges .ds-badge.bad", "color")) === "rgb(230, 103, 103)", "badge tone bad");
  ok((await cs("#g-badges .ds-badge:not(.good):not(.bad)", "color")) === "rgb(154, 160, 166)",
    "badge default tone = --ds-neutral");
  ok(await count("#g-badges .ds-badge.card") === 2, "badge card variant renders (sigBadge scale)");
  ok((await txt("#g-badges .ds-badge.card .ds-badge-v")) === "+34", "badge card big value slot");

  // spec table
  ok(await count("#g-spec .ds-spec-table thead th") === 4, "specTable head renders 4 columns");
  ok(await count("#g-spec .ds-spec-table tbody tr") === 3, "specTable renders 3 rows");
  ok(await page.$eval("#g-spec .ds-spec-table", (el) =>
      el.textContent.includes("<script>alert('xss')</script>") && el.querySelector("script") === null),
    "specTable plain cell renders the attacker string as TEXT (no script element)");
  ok(await page.$("#g-spec .ds-spec-table td b") !== null, "specTable { html } trusted cell renders markup");

  // chartbox
  ok(await page.$("#g-chartbox .ds-chartbox canvas") !== null, "chartbox renders its canvas");
  const painted = await page.$eval("#g-chart", (cv) => {
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  ok(painted > 100, "chartbox canvas actually painted (" + painted + " px)");

  // escaping demo — attacker strings in plain fields never execute
  console.log("escape-by-default:");
  ok(await page.$eval("#g-esc .g-esc-tile .ds-tile-lb", (el) =>
      el.textContent === "<script>alert('xss')</script>" && el.querySelector("script") === null),
    "tile label with <script> renders as literal text");
  ok(await page.$eval("#g-esc .g-esc-tile .ds-tile-v", (el) => el.querySelector("img") === null),
    "tile value with <img onerror> injects no element");
  ok(await page.evaluate(() => document.title) === "Design System Gallery — Skin Market Lab",
    "onerror payload never ran (document.title untouched)");
  ok(dialogs.length === 0, "no dialog fired (script text never executed)");
  ok(await page.$("#g-trusted") !== null, "TRUSTED html slot renders intentional markup");

  ok(pageErrors.length === 0, "zero page errors" + (pageErrors.length ? " — " + pageErrors.join(" | ") : ""));
  ok(consoleErrors.length === 0, "zero console errors" + (consoleErrors.length ? " — " + consoleErrors.join(" | ") : ""));

  await browser.close();
  server.close();
  console.log("\n" + (fail ? fail + " FAILURE(S)" : "ALL PASS (" + pass + " checks)"));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); server.close(); process.exit(1); });
