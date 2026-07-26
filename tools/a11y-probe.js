#!/usr/bin/env node
// tools/a11y-probe.js — accessibility regression gate for the dashboard.
//
// Hermetic: serves this repo statically (the GitHub Pages scenario — the app
// boots read-only from the committed data/; tracker discovery on :8790 is
// route-aborted for determinism) and drives real headless Chromium with real
// key events. Encodes the accessibility end-state contract:
//   - responsive layout: no horizontal document scroll on any audited path
//   - visible keyboard focus (rows, search options, DS buttons)
//   - keyboard-operable table sort (+ aria-sort)
//   - import-modal focus trap + focus restore on close
//   - search dropdown: Escape kills stale results (Enter must not navigate)
//   - WCAG 2.1 contrast computed on live getComputedStyle values
//   - coarse-pointer target sizes on the phone layout
//   - semantics batch: roles / labels / landmarks / skip link / titles
//   - focus restored after an innerHTML re-render (range chips)
//   - zero uncaught page errors across every context
//
//   node tools/a11y-probe.js        (also: npm run probe:a11y)
//
// Prints one line per check (`ok N - name` / `FAIL N - name: detail`) in
// check order; exits 0 only when every check passes.
"use strict";
const PW_LIB = process.env.PLAYWRIGHT_LIB || "/opt/node22/lib/node_modules/playwright";
const { chromium } = require(PW_LIB);
const http = require("http");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const PORTS = [5470, 5471, 5472, 5473, 5474, 5475, 5476, 5477, 5478, 5479];
const T0 = Date.now();

// ── check ledger (buffered; printed sorted so output is diff-stable) ───────
const results = [];
function put(n, name, ok, detail) {
  if (results.some((r) => r.n === n)) throw new Error("duplicate check " + n);
  results.push({ n, name, ok: !!ok, detail: detail || "" });
}

// ── static server (client-probe's makeStatic pattern, repo root) ───────────
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".jsonl": "text/plain" };
const makeStatic = () => http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const f = path.join(ROOT, url === "/" ? "index.html" : path.normalize(url).replace(/^([.][.][/\\])+/, ""));
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(buf);
  });
});
function listenFree() {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      if (i >= PORTS.length) return reject(new Error("no free port in " + PORTS[0] + "-" + PORTS[PORTS.length - 1]));
      const srv = makeStatic();
      srv.once("error", () => tryPort(i + 1));
      srv.listen(PORTS[i], () => resolve({ srv, port: PORTS[i] }));
    };
    tryPort(0);
  });
}

// ── WCAG 2.1 contrast on computed color strings ────────────────────────────
function parseColor(s) {
  s = String(s == null ? "" : s).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split("").map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); return [p[0], p[1], p[2]]; }
  return null;
}
function relLum(rgb) {
  const c = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) return 0;
  const la = relLum(ca), lb = relLum(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const r2 = (x) => Math.round(x * 100) / 100;

// ── page helpers ───────────────────────────────────────────────────────────
const pageErrors = [];
async function newPage(ctx, label, vp) {
  const page = await ctx.newPage();
  if (vp) await page.setViewportSize(vp);
  page.on("pageerror", (e) => pageErrors.push(label + ": " + String(e).split("\n")[0]));
  return page;
}
const guard = (ctx) => ctx.route(/^https?:\/\/(localhost|127\.0\.0\.1):8790\//, (r) => r.abort());
const docW = (page) => page.evaluate(() => document.scrollingElement.scrollWidth);
async function gotoHome(page, base) {
  await page.goto(base + "/", { waitUntil: "networkidle" });
  // static read-only mode + the fully-settled home render (backtest overlay
  // chips present ⇒ the last fire-and-forget re-render already happened)
  await page.waitForFunction(() =>
    /read-only/.test(document.getElementById("netStatus").textContent) &&
    !!document.querySelector("tr.mrow") &&
    !!document.querySelector("[data-ir]") &&
    !!document.querySelector("[data-ov]"), { timeout: 15000 });
}
async function activeInfo(page) {
  return page.evaluate(() => {
    const a = document.activeElement || document.body;
    const cs = getComputedStyle(a);
    const attr = (k) => (a.getAttribute ? a.getAttribute(k) : null);
    return {
      tag: a.tagName, id: a.id || "",
      cls: typeof a.className === "string" ? a.className : "",
      mrow: !!(a.matches && a.matches("tr.mrow")),
      srRow: !!(a.matches && a.matches(".sr-row")),
      thbtn: !!(a.matches && a.matches(".thbtn")),
      dataIr: attr("data-ir"), dataK: attr("data-k"),
      inModal: !!(a.closest && a.closest(".modal")),
      skipLink: !!(a.matches && a.matches('a.skip-link[href="#mktPanel"]')),
      outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth,
    };
  });
}
const ringOk = (i) => i && i.outlineStyle !== "none" && parseFloat(i.outlineWidth) >= 2;
const ringStr = (i) => (i ? i.outlineStyle + " " + i.outlineWidth : "n/a");
const who = (i) => (i ? i.tag + (i.id ? "#" + i.id : "") + (i.cls ? "." + String(i.cls).trim().split(/\s+/).join(".") : "") : "?");
async function typeSearch(page) {
  await page.click("#searchBox");
  await page.keyboard.type("case", { delay: 25 });
  await page.waitForSelector("#searchResults.open button.sr-row", { timeout: 8000 });
}

(async () => {
  const { srv, port } = await listenFree();
  const BASE = "http://localhost:" + port;
  const browser = await chromium.launch({ headless: true });
  const desk = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await guard(desk);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await guard(phone);

  // ═══ desktop: main page — sweep @1360, DOM/contrast batch, focus walk ════
  const d1 = await newPage(desk, "home@1360");
  await gotoHome(d1, BASE);
  const w1360 = await docW(d1);
  put(3, "home @1360: no horizontal document scroll", w1360 <= 1361, "scrollWidth=" + w1360);

  const dom = await d1.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    const root = cs(document.documentElement);
    const tok = (k) => root.getPropertyValue(k).trim();
    const lb = document.querySelector(".ds-tile .ds-tile-lb") || document.querySelector(".tile .lb");
    const lq = document.getElementById("lotQty");
    const ns = document.getElementById("netStatus");
    const it = document.getElementById("importText");
    const sparks = Array.from(document.querySelectorAll("canvas.spark"));
    const nms = Array.from(document.querySelectorAll("table.mkt td.nm"));
    const irs = Array.from(document.querySelectorAll("[data-ir]"));
    const ovs = Array.from(document.querySelectorAll("[data-ov]"));
    return {
      tokMuted: tok("--text-muted"), tokS1: tok("--surface-1"), tokS2: tok("--surface-2"), tokVol: tok("--vol-bar"),
      tileLb: lb ? cs(lb).color : null,
      tileBg: lb ? cs(lb.closest(".ds-tile") || lb.closest(".tile")).backgroundColor : null,
      inputBorder: lq ? cs(lq).borderTopColor : null,
      panelBg: lq ? cs(lq.closest(".panel")).backgroundColor : null,
      netRole: ns ? ns.getAttribute("role") : null,
      importLabel: it ? it.getAttribute("aria-label") : null,
      importDesc: it ? it.getAttribute("aria-describedby") : null,
      sparkCount: sparks.length,
      sparkHidden: sparks.length > 0 && sparks.every((c) => c.getAttribute("aria-hidden") === "true"),
      nmCount: nms.length,
      nmTitled: nms.length > 0 && nms.every((td) => td.getAttribute("title")),
      landmarks: !!(document.querySelector("header") && document.querySelector("main") && document.querySelector("aside")),
      irPressed: irs.length > 0 && irs.every((b) => b.getAttribute("aria-pressed") != null),
      ovPressed: ovs.length > 0 && ovs.every((b) => b.getAttribute("aria-pressed") != null),
    };
  });
  const c16 = contrast(dom.tileLb, dom.tileBg);
  const c17 = contrast(dom.tokMuted, dom.tokS2);
  const c18 = contrast(dom.inputBorder, dom.panelBg);
  const c19 = contrast(dom.tokVol, dom.tokS1);
  put(16, "contrast: tile label vs tile background >= 4.5", c16 >= 4.5, r2(c16) + ":1 (" + dom.tileLb + " on " + dom.tileBg + ")");
  put(17, "contrast: --text-muted vs --surface-2 >= 4.5", c17 >= 4.5, r2(c17) + ":1 (" + dom.tokMuted + " on " + dom.tokS2 + ")");
  put(18, "contrast: input border (#lotQty) vs panel >= 3", c18 >= 3, r2(c18) + ":1 (" + dom.inputBorder + " on " + dom.panelBg + ")");
  put(19, "contrast: --vol-bar vs --surface-1 >= 3", c19 >= 3, r2(c19) + ":1 (" + dom.tokVol + " on " + dom.tokS1 + ")");
  put(23, "#netStatus has role=status", dom.netRole === "status", "role=" + dom.netRole);
  put(26, "#importText has aria-label + aria-describedby=importErr",
    !!dom.importLabel && dom.importDesc === "importErr",
    "aria-label=" + JSON.stringify(dom.importLabel) + " aria-describedby=" + JSON.stringify(dom.importDesc));
  put(28, "spark canvases are aria-hidden", dom.sparkCount > 0 && dom.sparkHidden,
    dom.sparkCount + " canvas.spark, all aria-hidden=" + dom.sparkHidden);
  put(30, "market td.nm carries a title attribute", dom.nmCount > 0 && dom.nmTitled,
    dom.nmCount + " td.nm, all titled=" + dom.nmTitled);
  put(34, "regression guard: index.html landmarks + [data-ir]/[data-ov] aria-pressed",
    dom.landmarks && dom.irPressed && dom.ovPressed,
    "landmarks=" + dom.landmarks + " ir=" + dom.irPressed + " ov=" + dom.ovPressed);

  // real-Tab walk: DS button ring (guard) on the way, then the first market row
  let homeBtnInfo = null, mrowInfo = null, mrowStop = -1;
  for (let i = 1; i <= 45; i++) {
    await d1.keyboard.press("Tab");
    const info = await activeInfo(d1);
    if (!homeBtnInfo && info.id === "homeBtn") homeBtnInfo = info;
    if (info.mrow) { mrowInfo = info; mrowStop = i; break; }
  }
  put(9, "Tab to tr.mrow shows a >=2px focus outline", ringOk(mrowInfo),
    mrowInfo ? "stop " + mrowStop + ", outline " + ringStr(mrowInfo) : "no tr.mrow reached in 45 Tabs");
  put(33, "regression guard: DS button (#homeBtn) keeps its >=2px focus ring", ringOk(homeBtnInfo),
    "outline " + ringStr(homeBtnInfo));
  await d1.close();

  // ═══ desktop: skip link (needs a virgin tab state) ═══════════════════════
  const d2 = await newPage(desk, "home@skiplink");
  await gotoHome(d2, BASE);
  await d2.keyboard.press("Tab");
  const first = await activeInfo(d2);
  if (!first.skipLink) {
    put(29, "skip link is the first Tab stop and Enter jumps to #mktPanel", false,
      "first Tab stop = " + who(first) + " (no a.skip-link[href=\"#mktPanel\"])");
  } else {
    await d2.keyboard.press("Enter");
    await d2.waitForTimeout(250);
    const landed = await d2.evaluate(() => location.hash === "#mktPanel" || (document.activeElement && document.activeElement.id === "mktPanel"));
    put(29, "skip link is the first Tab stop and Enter jumps to #mktPanel", landed,
      landed ? "" : "Enter did not move to #mktPanel");
  }
  await d2.close();

  // ═══ desktop: keyboard sort ══════════════════════════════════════════════
  const d3 = await newPage(desk, "home@sort");
  await gotoHome(d3, BASE);
  const rowOrder = (p) => p.$$eval("table.mkt tbody tr td.nm", (els) => els.map((e) => e.textContent).join("|"));
  if (!(await d3.$(".thbtn"))) {
    put(11, "keyboard sort: Tab reaches a .thbtn and Enter re-sorts the table", false,
      "no .thbtn in the DOM (sort headers are not buttons)");
    put(12, "active sort column exposes aria-sort on its th", false, "no .thbtn to activate");
  } else {
    const before = await rowOrder(d3);
    let thInfo = null;
    for (let i = 1; i <= 45; i++) {
      await d3.keyboard.press("Tab");
      const info = await activeInfo(d3);
      if (info.thbtn) { thInfo = info; break; }
    }
    if (!thInfo) {
      put(11, "keyboard sort: Tab reaches a .thbtn and Enter re-sorts the table", false, ".thbtn exists but was not reached in 45 Tabs");
      put(12, "active sort column exposes aria-sort on its th", false, ".thbtn never focused");
    } else {
      await d3.keyboard.press("Enter");
      await d3.waitForTimeout(300);
      const after = await rowOrder(d3);
      put(11, "keyboard sort: Tab reaches a .thbtn and Enter re-sorts the table", before !== after,
        before !== after ? "sorted by data-k=" + thInfo.dataK : "Enter on .thbtn[data-k=" + thInfo.dataK + "] did not change row order");
      const aria = await d3.evaluate(() => {
        const list = Array.from(document.querySelectorAll("th[aria-sort]"));
        return { count: list.length, k: list[0] ? list[0].getAttribute("data-k") : null, v: list[0] ? list[0].getAttribute("aria-sort") : null };
      });
      put(12, "active sort column exposes aria-sort on its th",
        aria.count === 1 && aria.k === thInfo.dataK && /^(ascending|descending)$/.test(String(aria.v)),
        aria.count === 0 ? "no th[aria-sort] after keyboard sort" : "th[data-k=" + aria.k + "] aria-sort=" + aria.v + " (x" + aria.count + ")");
    }
  }
  await d3.close();

  // ═══ desktop: search option focus ring ═══════════════════════════════════
  const d4 = await newPage(desk, "home@search-ring");
  await gotoHome(d4, BASE);
  await typeSearch(d4);
  await d4.keyboard.press("Tab");
  const srInfo = await activeInfo(d4);
  put(10, "Tab to .sr-row search option shows a >=2px focus outline", srInfo.srRow && ringOk(srInfo),
    srInfo.srRow ? "outline " + ringStr(srInfo) : "Tab landed on " + who(srInfo) + " (not .sr-row)");
  await d4.close();

  // ═══ desktop: stale search results — Esc then Enter must not navigate ════
  const d5 = await newPage(desk, "home@stale-enter");
  await gotoHome(d5, BASE);
  await typeSearch(d5);
  await d5.keyboard.press("Escape");
  await d5.waitForTimeout(120);
  const closed = await d5.evaluate(() => !document.getElementById("searchResults").classList.contains("open"));
  await d5.keyboard.press("Enter");
  const navigated = await d5.waitForSelector("#backBtn", { timeout: 1800 }).then(() => true).catch(() => false);
  put(15, "search: Esc dismisses dropdown, then Enter does not navigate", closed && !navigated,
    !closed ? "Esc did not close the dropdown" : navigated ? "Enter navigated to the item view on stale results" : "");
  await d5.close();

  // ═══ desktop: focus restored after a range-chip re-render ════════════════
  const d6 = await newPage(desk, "home@chip-restore");
  await gotoHome(d6, BASE);
  let chipInfo = null;
  for (let i = 1; i <= 30; i++) {
    await d6.keyboard.press("Tab");
    const info = await activeInfo(d6);
    if (info.dataIr) { chipInfo = info; break; }
  }
  if (!chipInfo) {
    put(31, "focus restored to the [data-ir] chip after Enter re-render", false, "no [data-ir] chip reached in 30 Tabs");
  } else {
    await d6.keyboard.press("Enter");
    await d6.waitForTimeout(300);
    const back = await d6.evaluate((ir) => {
      const a = document.activeElement;
      return { ok: !!(a && a.matches && a.matches('[data-ir="' + ir + '"]')), tag: a ? a.tagName : "?", id: a && a.id || "" };
    }, chipInfo.dataIr);
    put(31, "focus restored to the [data-ir] chip after Enter re-render", back.ok,
      back.ok ? 'chip [data-ir="' + chipInfo.dataIr + '"]' : 'active after re-render = ' + back.tag + (back.id ? "#" + back.id : "") + ' (expected [data-ir="' + chipInfo.dataIr + '"])');
  }
  await d6.close();

  // ═══ desktop: import modal — trap + restore ══════════════════════════════
  // Static mode has no #importBtn, so the opener is #searchBox: focus it,
  // then open via the app's own openImport() when exposed (falling back to
  // replicating its exact DOM effect on trees that keep it module-private).
  const d7 = await newPage(desk, "home@modal");
  await gotoHome(d7, BASE);
  await d7.click("#searchBox");
  await d7.evaluate(() => {
    if (typeof window.openImport === "function") { window.openImport(); return; }
    const $ = (id) => document.getElementById(id);
    $("importText").value = ""; $("importErr").textContent = "";
    $("importModal").classList.add("open"); $("importText").focus();
  });
  await d7.waitForSelector("#importModal.open", { timeout: 2000 });
  let escaped = null;
  for (let i = 1; i <= 6; i++) {
    await d7.keyboard.press("Tab");
    const info = await activeInfo(d7);
    if (!info.inModal && !escaped) escaped = "Tab " + i + " left the dialog to " + who(info);
  }
  put(13, "import modal: 6 Tabs stay inside .modal (focus trap)", !escaped, escaped || "");
  await d7.keyboard.press("Escape");
  const modalClosed = await d7.waitForFunction(() => !document.getElementById("importModal").classList.contains("open"), { timeout: 2000 })
    .then(() => true).catch(() => false);
  await d7.waitForTimeout(120);
  const afterEsc = await activeInfo(d7);
  put(14, "import modal: Esc closes and focus returns to the opener (#searchBox)",
    modalClosed && afterEsc.id === "searchBox",
    !modalClosed ? "modal did not close on Esc" : "focus after close = " + who(afterEsc));
  await d7.close();

  // ═══ desktop: item view — [data-r] chips expose pressed state ════════════
  const d8 = await newPage(desk, "item@1360");
  await gotoHome(d8, BASE);
  await d8.evaluate(() => document.querySelector("table.mkt tr.mrow").click());
  await d8.waitForSelector("#backBtn", { timeout: 8000 });
  const rchips = await d8.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("[data-r]"));
    return {
      n: chips.length,
      all: chips.length > 0 && chips.every((c) => c.getAttribute("aria-pressed") != null),
      on: chips.filter((c) => c.getAttribute("aria-pressed") === "true").length,
    };
  });
  put(22, "item range chips [data-r] carry aria-pressed", rchips.all && rchips.on === 1,
    rchips.n + " chips, aria-pressed on all=" + rchips.all + ", pressed-true count=" + rchips.on);
  await d8.close();

  // ═══ desktop: narrower windows ═══════════════════════════════════════════
  const d768 = await newPage(desk, "home@768", { width: 768, height: 1024 });
  await gotoHome(d768, BASE);
  const w768 = await docW(d768);
  put(2, "home @768: no horizontal document scroll", w768 <= 769, "scrollWidth=" + w768);
  await d768.close();

  const d1000 = await newPage(desk, "home@1000x800", { width: 1000, height: 800 });
  await gotoHome(d1000, BASE);
  const w1000 = await docW(d1000);
  put(7, "home @1000x800: no horizontal document scroll", w1000 <= 1001, "scrollWidth=" + w1000);
  await d1000.close();

  // ═══ desktop: methodology + backtest semantics ═══════════════════════════
  const dM = await newPage(desk, "methodology@1360");
  await dM.goto(BASE + "/methodology.html", { waitUntil: "networkidle" });
  await dM.waitForFunction(() => /\$/.test(document.getElementById("budgetOut").textContent), { timeout: 10000 });
  const meth = await dM.evaluate(() => {
    const vo = document.getElementById("verifyOut");
    const t = document.querySelector("#budgetOut table.ds-spec-table");
    const ths = t ? Array.from(t.querySelectorAll("th")) : [];
    return {
      verifyRole: vo ? vo.getAttribute("role") : null,
      hasMain: !!document.querySelector("main"), hasNav: !!document.querySelector("nav"),
      hasTable: !!t, wrapped: !!(t && t.closest(".ds-scroll-x")),
      scoped: ths.length > 0 && ths.every((h) => h.getAttribute("scope") === "col"),
    };
  });
  put(24, "methodology: #verifyOut role=status + <main> + <nav> landmarks",
    meth.verifyRole === "status" && meth.hasMain && meth.hasNav,
    "role=" + meth.verifyRole + " main=" + meth.hasMain + " nav=" + meth.hasNav);
  await dM.close();

  const dB = await newPage(desk, "backtest@1360");
  await dB.goto(BASE + "/backtest.html", { waitUntil: "networkidle" });
  await dB.waitForFunction(() => !!document.querySelector("#variantTable table"), { timeout: 10000 });
  const back = await dB.evaluate(() => {
    const c = document.getElementById("mainChart");
    const t = document.querySelector("#variantTable table.ds-spec-table");
    const ths = t ? Array.from(t.querySelectorAll("th")) : [];
    return {
      role: c ? c.getAttribute("role") : null, label: c ? c.getAttribute("aria-label") : null,
      hasTable: !!t, wrapped: !!(t && t.closest(".ds-scroll-x")),
      scoped: ths.length > 0 && ths.every((h) => h.getAttribute("scope") === "col"),
    };
  });
  put(25, "backtest: #mainChart has role=img + descriptive aria-label",
    back.role === "img" && !!back.label && back.label.length >= 15,
    "role=" + back.role + " aria-label=" + (back.label ? JSON.stringify(back.label.slice(0, 40) + (back.label.length > 40 ? "…" : "")) : "null"));
  put(27, "spec tables: .ds-scroll-x wrapper + th[scope=col] (methodology + backtest)",
    meth.hasTable && meth.wrapped && meth.scoped && back.hasTable && back.wrapped && back.scoped,
    "methodology wrapped=" + meth.wrapped + " scoped=" + meth.scoped + "; backtest wrapped=" + back.wrapped + " scoped=" + back.scoped);
  await dB.close();

  // ═══ phone (coarse pointer): sweeps, target sizes, real tap ══════════════
  const p1 = await newPage(phone, "home@390");
  await gotoHome(p1, BASE);
  const w390 = await docW(p1);
  put(1, "home @390: no horizontal document scroll", w390 <= 391, "scrollWidth=" + w390);

  const sizes = await p1.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    const hs = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis)
      .map((el) => Math.round(el.getBoundingClientRect().height * 10) / 10);
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      toggles: hs(".ds-toggle"), chips: hs("[data-ir]"), primary: hs(".ds-btn.primary"),
    };
  });
  const minOf = (a) => (a.length ? Math.min.apply(null, a) : 0);
  put(20, "coarse pointer: .ds-toggle + range chips >= 32px tall",
    sizes.coarse && sizes.toggles.length > 0 && sizes.chips.length > 0 && minOf(sizes.toggles) >= 32 && minOf(sizes.chips) >= 32,
    "coarse=" + sizes.coarse + " minToggle=" + minOf(sizes.toggles) + "px minChip=" + minOf(sizes.chips) + "px");
  put(21, "coarse pointer: primary .ds-btn >= 40px tall",
    sizes.coarse && sizes.primary.length > 0 && minOf(sizes.primary) >= 40,
    "coarse=" + sizes.coarse + " minPrimary=" + minOf(sizes.primary) + "px");

  let tapped = false;
  try {
    await p1.click("table.mkt tr.mrow", { timeout: 4000 });
    tapped = await p1.waitForSelector("#backBtn", { timeout: 6000 }).then(() => true).catch(() => false);
  } catch (e) { tapped = false; }
  put(8, "trusted click lands on a market row @390 (opens item view)", tapped,
    tapped ? "" : "trusted click did not open the item view (intercepted or timed out)");

  if (!(await p1.$("#backBtn"))) { // enter the item view synthetically for the sweep
    await p1.evaluate(() => document.querySelector("table.mkt tr.mrow").click());
    await p1.waitForSelector("#backBtn", { timeout: 8000 });
  }
  await p1.waitForSelector("#chart", { timeout: 8000 });
  await p1.waitForTimeout(350);
  const wItem = await docW(p1);
  put(4, "item view @390: no horizontal document scroll", wItem <= 391, "scrollWidth=" + wItem);
  await p1.close();

  const p2 = await newPage(phone, "methodology@390");
  await p2.goto(BASE + "/methodology.html", { waitUntil: "networkidle" });
  await p2.waitForFunction(() => /\$/.test(document.getElementById("budgetOut").textContent), { timeout: 10000 });
  await p2.waitForTimeout(200);
  const wMeth = await docW(p2);
  put(5, "methodology @390: no horizontal document scroll", wMeth <= 391, "scrollWidth=" + wMeth);
  await p2.close();

  const p3 = await newPage(phone, "backtest@390");
  await p3.goto(BASE + "/backtest.html", { waitUntil: "networkidle" });
  await p3.waitForFunction(() => !!document.querySelector("#variantTable table"), { timeout: 10000 });
  await p3.waitForTimeout(200);
  const wBack = await docW(p3);
  put(6, "backtest @390: no horizontal document scroll", wBack <= 391, "scrollWidth=" + wBack);
  await p3.close();

  // ═══ page errors, wrap up ════════════════════════════════════════════════
  put(32, "zero uncaught page errors across all contexts", pageErrors.length === 0,
    pageErrors.length ? pageErrors.slice(0, 3).join(" | ") : "");

  await browser.close();
  srv.close();

  results.sort((a, b) => a.n - b.n);
  let failCount = 0;
  for (const r of results) {
    if (r.ok) console.log("ok " + r.n + " - " + r.name);
    else { failCount++; console.log("FAIL " + r.n + " - " + r.name + (r.detail ? ": " + r.detail : "")); }
  }
  console.log(failCount ? failCount + " FAILURE(S) (" + results.length + " checks)" : "ALL PASS (" + results.length + " checks)");
  console.error("runtime " + Math.round((Date.now() - T0) / 1000) + "s");
  process.exit(failCount ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); process.exit(1); });
