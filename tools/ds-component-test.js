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
  ok(DS.specTable({ head: ["H"], rows: [["x"]] })
       .startsWith('<div class="ds-scroll-x"><table class="ds-spec-table">') &&
     DS.specTable({ head: ["H"], rows: [["x"]] }).endsWith("</table></div>"),
    "DS.specTable wraps its table in a .ds-scroll-x overflow container");
  ok(DS.specTable({ head: ["A", "<B>"], rows: [] }).includes('<th scope="col">A</th>') &&
     DS.specTable({ head: ["A", "<B>"], rows: [] }).includes('<th scope="col">&lt;B&gt;</th>'),
    "DS.specTable header cells carry scope=\"col\" (labels still escaped)");
  ok(DS.toggle({ label: "T", on: true, data: { ov: "btc" } }).includes('aria-pressed="true"') &&
     DS.toggle({ label: "T", on: false, data: { ov: "btc" } }).includes('data-ov="btc"'),
    "DS.toggle emits aria-pressed state + data-* hooks");
  ok(DS.hint("plain & <text>").includes("plain &amp; &lt;text&gt;"), "DS.hint(string) escapes");

  // ── home-hierarchy factories (hero / segmented / tabs / status rail) ────
  console.log("home-hierarchy factory pins:");
  ok(["hero", "segmented", "tabs", "tabPanel", "tabsKeyNav", "statusRail"]
      .every((k) => typeof DS[k] === "function"),
    "UMD node export exposes the 6 home-hierarchy API functions");
  ok(DS.hero({ eyebrow: "<b>", value: "<i>", delta: "+1%", sub: "<s>" }).includes("&lt;b&gt;") &&
     DS.hero({ eyebrow: "E", value: "<i>", delta: "+1%" }).includes("&lt;i&gt;") &&
     DS.hero({ eyebrow: "E", value: "v", delta: "+1%", deltaTone: "up" }).includes('class="ds-hero-delta up"'),
    "DS.hero escapes eyebrow/value/sub and applies the delta tone class");
  ok(DS.hero({ eyebrow: "E", value: "v", chart: "<canvas id=c></canvas>" })
       .includes('<div class="ds-hero-chart"><canvas id=c></canvas></div>') &&
     DS.hero({ eyebrow: "E", value: "v", foot: "<b>f</b>" }).includes('<div class="ds-hero-foot"><b>f</b></div>'),
    "DS.hero chart/foot are TRUSTED slots rendered verbatim");
  ok(DS.hero({ eyebrow: "E", value: "v", labelId: "hx" }).startsWith('<section class="ds-hero" aria-labelledby="hx">') &&
     DS.hero({ eyebrow: "E", value: "v", labelId: "hx" }).includes('<div class="ds-hero-eyebrow" id="hx">'),
    "DS.hero labelId names the section via its own eyebrow");
  ok(DS.segmented({ label: "L", active: "a", dataKey: "lens",
       options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] })
       .startsWith('<div class="ds-seg" role="group" aria-label="L">') &&
     DS.segmented({ active: "a", dataKey: "lens", options: [{ value: "a", label: "A" }] })
       .includes('class="ds-seg-btn on" data-lens="a" aria-pressed="true"'),
    "DS.segmented emits role=group + data-<key> + .on/aria-pressed together");
  ok(DS.segmented({ active: "a", options: [{ value: "b", label: "B" }] }).includes('aria-pressed="false"') &&
     !DS.segmented({ active: "a", options: [{ value: "b", label: "B" }] }).includes("ds-seg-btn on"),
    "DS.segmented inactive option: aria-pressed=false and no .on");
  const TB = DS.tabs({ label: "Seg", active: "all", dataKey: "mt", idPrefix: "mtab", panelId: "mp",
    tabs: [{ value: "all", label: "All", count: 64 }, { value: "art", label: "<b>", count: 9, title: "grails" }] });
  ok(TB.startsWith('<div class="ds-tabs" role="tablist" aria-label="Seg">') &&
     TB.includes('role="tab" id="mtab-all"') && TB.includes('aria-controls="mp"'),
    "DS.tabs emits a role=tablist of role=tab buttons with ids + aria-controls");
  ok(TB.includes('aria-selected="true" tabindex="0"') && TB.includes('aria-selected="false" tabindex="-1"'),
    "DS.tabs uses ROVING tabindex (active 0, rest −1) — the bar is ONE tab stop");
  ok(TB.includes('<span class="ds-tab-n">64</span>') && TB.includes('title="grails"') && TB.includes("&lt;b&gt;"),
    "DS.tabs renders counts + titles and escapes tab labels");
  ok(DS.tabPanel({ id: "mp", labelledBy: "mtab-all", body: "<b>t</b>" }) ===
      '<div class="ds-tabpanel" id="mp" role="tabpanel" aria-labelledby="mtab-all"><b>t</b></div>',
    "DS.tabPanel exact shape (role=tabpanel + aria-labelledby, TRUSTED body)");
  ok(DS.statusRail({ title: "S", rows: [{ label: "<l>", value: "<v>", sub: "<s>", tone: "good" }] })
       .includes("&lt;l&gt;") &&
     DS.statusRail({ rows: [{ label: "L", value: "V", tone: "good" }] }).includes('class="ds-rail-row good"'),
    "DS.statusRail escapes label/value/sub and applies the tone class");
  ok(!/<button|tabindex|<a /.test(DS.statusRail({ title: "S",
       rows: [{ label: "L", value: "V", sub: "s" }, { label: "L2", value: "V2" }] })),
    "DS.statusRail is READ-ONLY by contract (emits no focusable control)");

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
  ok((await txt("#g-tiles .ds-tile .ds-tile-lb")) === "SKINDEX", "tile label text");
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
  ok((await cs("#g-btns .ds-btn.primary", "color")) === "rgb(222, 155, 53)", "primary button → --ds-accent (CS2 orange, DESIGN.md)");
  ok((await cs("#g-btns .ds-btn.danger", "color")) === "rgb(230, 103, 103)", "danger button → --ds-bad");
  ok((await cs("#g-btns .ds-btn.compact", "fontSize")) === "11.5px" &&
     (await cs("#g-btns .ds-btn.compact", "paddingTop")) === "4px",
    "compact button → --ds-fs-lbl + tight padding");
  ok((await cs("#g-btns .ds-btn[disabled]", "opacity")) === "0.45", "disabled button dims to .45");
  ok((await cs("#g-btns .ds-btn.on", "borderTopColor")) === "rgb(222, 155, 53)", "on button → accent border");

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
  ok((await cs("#g-legend .ds-legend-item .ds-sw", "backgroundColor")) === "rgb(75, 105, 255)",
    "legend swatch resolves var(--ds-series-price) (mil-spec, DESIGN.md)");
  ok(await page.$("#g-legend .ds-legend-item a") !== null, "legend TRUSTED html slot renders a real link");

  // panel / hint / warmup
  ok(await page.$eval("#g-tiles", (el) => el.classList.contains("ds-panel")), "DS.panel emits .ds-panel + attrs id");
  ok(/TILES/.test(await txt("#g-tiles .ds-panel-h")), "panel title renders in .ds-panel-h");
  ok((await cs("#g-tiles", "backgroundColor")) === "rgb(21, 22, 26)", "panel surface = --ds-surface-1");
  ok((await cs("#g-hints .ds-hint", "color")) === "rgb(135, 138, 148)",
    "hint text = --ds-text-muted (#878a94, the ≥4.5:1 contrast value)");
  ok((await cs("#g-warmup", "borderTopColor")) === "rgb(222, 155, 53)", "warmup pill = accent border");

  // badges
  console.log("badges / spec table / chartbox:");
  ok((await cs("#g-badges .ds-badge.good", "color")) === "rgb(63, 174, 106)", "badge tone good");
  ok((await cs("#g-badges .ds-badge.bad", "color")) === "rgb(230, 103, 103)", "badge tone bad");
  ok((await cs("#g-badges .ds-badge:not(.good):not(.bad)", "color")) === "rgb(154, 160, 166)",
    "badge default tone = --ds-neutral");
  ok(await count("#g-badges .ds-badge.card") === 2, "badge card variant renders (sigBadge scale)");
  ok((await txt("#g-badges .ds-badge.card .ds-badge-v")) === "+34", "badge card big value slot");

  // spec table
  ok(await page.$("#g-spec .ds-scroll-x > .ds-spec-table") !== null,
    "specTable renders inside its .ds-scroll-x wrapper");
  ok((await cs("#g-spec .ds-scroll-x", "overflowX")) === "auto",
    ".ds-scroll-x wrapper scrolls horizontally (overflow-x: auto)");
  ok(await page.$$eval("#g-spec .ds-spec-table thead th",
      (els) => els.length > 0 && els.every((th) => th.getAttribute("scope") === "col")),
    "rendered spec-table header cells all carry scope=col");
  ok(await count("#g-spec .ds-spec-table thead th") === 4, "specTable head renders 4 columns");
  ok(await count("#g-spec .ds-spec-table tbody tr") === 3, "specTable renders 3 rows");
  ok(await page.$eval("#g-spec .ds-spec-table", (el) =>
      el.textContent.includes("<script>alert('xss')</script>") && el.querySelector("script") === null),
    "specTable plain cell renders the attacker string as TEXT (no script element)");
  ok(await page.$("#g-spec .ds-spec-table td b") !== null, "specTable { html } trusted cell renders markup");

  // ── hero + segmented + rail (the home hierarchy, live) ────────────────
  console.log("home hierarchy (hero / segmented / tabs / rail):");
  ok(await page.$("#g-hero .ds-hero-row > .ds-hero") !== null &&
     await page.$("#g-hero .ds-hero-row > .ds-rail") !== null,
    "hero + status rail render side by side in .ds-hero-row");
  ok((await cs("#g-hero .ds-hero-row", "display")) === "grid", ".ds-hero-row is a CSS grid");
  ok((await cs("#g-hero .ds-hero-val", "fontSize")) === "40px", "hero level pins --ds-fs-hero (40px)");
  ok((await cs("#g-hero .ds-hero", "borderRadius")) === "16px", "hero pins --ds-radius-xl (16px)");
  ok((await cs("#g-hero .ds-hero", "padding")) === "24px", "hero pins --ds-space-6 (24px, the one generous step)");
  ok((await cs("#g-hero .ds-hero", "overflow")) === "hidden",
    "hero clips its bled chart to the card radius (overflow: hidden)");
  ok((await cs("#g-hero .ds-hero-delta.up", "color")) === "rgb(63, 174, 106)",
    "hero delta tone up → --ds-good");
  // the bleed IS the "chart as the card's background" contract: the chart
  // block is exactly 2 × --ds-space-6 wider than the hero's content box, and
  // the card still never overflows its own border box (overflow: hidden).
  const bleed = await page.$eval("#g-hero .ds-hero-chart", (el) => {
    const hero = el.closest(".ds-hero");
    const pad = parseFloat(getComputedStyle(hero).paddingLeft);
    return { chart: el.clientWidth, content: hero.clientWidth - 2 * pad, pad: pad, hero: hero.clientWidth };
  });
  ok(bleed.chart === bleed.content + 2 * bleed.pad && bleed.chart <= bleed.hero,
    "hero chart bleeds to both card edges without overflowing it (" +
      bleed.content + " content + 2×" + bleed.pad + " = " + bleed.chart + "px)");
  const heroPainted = await page.$eval("#g-hero-chart", (cv) => {
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  ok(heroPainted > 100, "hero chart canvas actually painted (" + heroPainted + " px)");

  const SEG_W = '#g-hero [data-lens="wallet"]', SEG_R = '#g-hero [data-lens="real"]';
  ok(await page.$eval(SEG_W, (el) => el.tagName === "BUTTON" && el.getAttribute("aria-pressed") === "true" && el.classList.contains("on")),
    "active segment is a real <button> with aria-pressed=true + .on");
  ok((await cs(SEG_W, "color")) === "rgb(222, 155, 53)", "active segment uses --ds-accent as TEXT (never a fill)");
  ok(await page.$eval("#g-hero .ds-seg", (el) => el.getAttribute("role") === "group" && !!el.getAttribute("aria-label")),
    "segmented control is a labelled role=group");
  await page.click(SEG_R);
  ok(await page.$eval(SEG_R, (el) => el.getAttribute("aria-pressed") === "true" && el.classList.contains("on")) &&
     await page.$eval(SEG_W, (el) => el.getAttribute("aria-pressed") === "false" && !el.classList.contains("on")),
    "segment click moves aria-pressed AND .on to the new lens");
  ok((await txt("#g-hero .ds-hero-val")) === "118.3" && /cash-adjusted/.test(await txt("#g-hero .ds-hero-sub")),
    "the lens re-reads the SAME number (level + sub follow the segment)");
  ok(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-lens") === "real"),
    "focus is restored to the activated segment across the re-render");
  await page.click(SEG_W);
  ok((await txt("#g-hero .ds-hero-val")) === "100.7", "the lens round-trips back to wallet $");

  ok(await page.$$eval("#g-hero .ds-rail-row", (els) => els.length === 5), "status rail renders one row per status");
  ok((await cs("#g-hero .ds-rail-row.good .ds-rail-v", "color")) === "rgb(63, 174, 106)", "rail tone good → --ds-good");
  ok((await cs("#g-hero .ds-rail-row.warn .ds-rail-v", "color")) === "rgb(222, 155, 53)", "rail tone warn → --ds-accent");
  ok(await page.$$eval("#g-hero .ds-rail", (els) =>
      els.every((r) => r.querySelectorAll('button, a, input, select, textarea, [tabindex]').length === 0)),
    "status rail contains NO focusable control (the read-only contract holds in the DOM)");
  ok(await page.$eval("#g-hero .ds-rail-row.bad", (el) =>
      el.querySelector(".ds-rail-v").textContent === "<script>alert('xss')</script>" &&
      el.querySelector("script") === null && el.querySelector("img") === null),
    "status rail renders attacker strings as TEXT in value and sub");

  // ── tabs (the ARIA tablist contract, end to end) ───────────────────────
  ok(await page.$eval('#g-tabs [role="tablist"]', (el) => !!el.getAttribute("aria-label")) &&
     await page.$$eval("#g-tabs [data-mt]", (els) => els.length === 4 && els.every((e) => e.getAttribute("role") === "tab")),
    "tab bar is a labelled tablist of four role=tab buttons");
  ok(await page.$$eval("#g-tabs [data-mt]", (els) => els.map((e) => e.getAttribute("tabindex")).join(",") === "0,-1,-1,-1"),
    "roving tabindex in the DOM: four tabs, ONE tab stop");
  ok(await page.$eval("#g-tabpanel", (el) => el.getAttribute("role") === "tabpanel" &&
      el.getAttribute("aria-labelledby") === "g-mtab-all"),
    "tabpanel is labelled by the ACTIVE tab id");
  await page.focus('#g-tabs [data-mt="all"]');
  await page.keyboard.press("ArrowRight");
  ok(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-mt") === "case"),
    "ArrowRight moves tab focus (DS.tabsKeyNav)");
  ok(await page.$eval('#g-tabs [data-mt="case"]', (el) => el.getAttribute("aria-selected") === "true") &&
     await page.$eval('#g-tabs [data-mt="all"]', (el) => el.getAttribute("aria-selected") === "false"),
    "arrow movement ACTIVATES (aria-selected follows focus)");
  ok((await txt("#g-tab-out")) === "case" &&
     await page.$eval("#g-tabpanel", (el) => el.getAttribute("aria-labelledby") === "g-mtab-case"),
    "the panel body + aria-labelledby track the selected tab");
  await page.keyboard.press("End");
  ok(await page.evaluate(() => document.activeElement.getAttribute("data-mt") === "art"), "End jumps to the last tab");
  await page.keyboard.press("Home");
  ok(await page.evaluate(() => document.activeElement.getAttribute("data-mt") === "all"), "Home jumps to the first tab");
  await page.keyboard.press("ArrowLeft");
  ok(await page.evaluate(() => document.activeElement.getAttribute("data-mt") === "art"),
    "ArrowLeft wraps from the first tab to the last");
  await page.click('#g-tabs [data-mt="all"]');

  // ── secondary (demoted) tile scale ────────────────────────────────────
  ok((await cs("#g-secondary .ds-tiles.secondary .ds-tile-v", "fontSize")) === "13px",
    "secondary tiles pin --ds-fs-sec (13px) — demoted below the 17px tile scale");
  ok((await cs("#g-secondary .ds-tile", "backgroundColor")) === "rgb(28, 30, 36)",
    "secondary tiles keep the --ds-surface-2 backing (contrast floors unchanged)");

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
  ok(await page.evaluate(() => document.title) === "Design System Gallery — Skindex",
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
