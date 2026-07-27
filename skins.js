// skins.js — Skindex client (vanilla JS, no build).
// Talks to skins/server.js; analytics math is shared via analytics.js
// (window.SkinAnalytics — the exact module the server runs).
"use strict";
(function () {
  const A = window.SkinAnalytics;
  const DS = window.DS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // series palette (kept in sync with skins.css — validated for the dark surface)
  const css = getComputedStyle(document.documentElement);
  const COL = {
    price: css.getPropertyValue("--series-price").trim() || "#4b69ff",
    sma7: css.getPropertyValue("--series-sma7").trim() || "#199e70",
    sma30: css.getPropertyValue("--series-sma30").trim() || "#8847ff",
    skinport: css.getPropertyValue("--series-skinport").trim() || "#caab05",
    vol: css.getPropertyValue("--vol-bar").trim() || "#4a4e5a",
    grid: "#23252d",
    // canvas text follows the CSS muted token (single source — A3-8);
    // crosshair lifted to 3:1+ on the chart surface (A3-7).
    text: css.getPropertyValue("--text-muted").trim() || "#878a94",
    cross: "#6a6e7a",
  };

  // mode: "live"   — a tracker server answers (full read/write)
  //       "static" — no tracker; reading the collector's committed data
  //                  files from this same static host (GitHub Pages)
  const state = { mode: "live", manifest: null, watch: [], market: null, selected: null, item: null,
    portfolio: null, range: "3M", hover: -1, view: "home", sort: { key: "vol24h", dir: -1 },
    backtest: null, idxRange: "ALL", macroHist: null, corrStudy: null,
    overlays: { players: true, btc: true },
    // Steam inventory panel (display layer only — never an index/fixing input).
    // `report` holds an INV_REPORT; the SteamID inside it stays in memory.
    inv: { report: null, busy: false, error: "" } };
  const RANGES = { "1M": 31, "3M": 92, "1Y": 366, "ALL": Infinity };

  // Where "edit the watchlist" and "run the collector" live on GitHub.
  // Derived from the Pages host (owner.github.io/repo) with a fallback.
  function ghRepo() {
    const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
    const seg = location.pathname.split("/").filter(Boolean)[0];
    if (m && seg) return { owner: m[1], repo: seg };
    return { owner: "blackjakk", repo: "skin-market-lab" };
  }
  const ghEditWatchlistUrl = () => { const g = ghRepo(); return "https://github.com/" + g.owner + "/" + g.repo + "/edit/main/watchlist.json"; };
  const ghRunCollectorUrl = () => { const g = ghRepo(); return "https://github.com/" + g.owner + "/" + g.repo + "/actions/workflows/collect.yml"; };

  // ── api ──────────────────────────────────────────────────────────────────
  // The dashboard also ships on a static host (GitHub Pages) where there is
  // no same-origin API — so the tracker address is DISCOVERED: same origin
  // first, then the last tracker that worked, then localhost. Browsers treat
  // http://localhost as a trustworthy origin, so the HTTPS Pages build may
  // call a local tracker directly (the API sends CORS headers for this).
  let API = "";
  function fetchTimeout(url, ms, opts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({ signal: ctl.signal }, opts || {})).finally(() => clearTimeout(t));
  }
  async function resolveApiBase() {
    const cands = [];
    if (location.protocol !== "file:") cands.push("");
    const saved = localStorage.getItem("skinlab_api");
    if (saved) cands.push(saved);
    cands.push("http://localhost:8790", "http://127.0.0.1:8790");
    for (const base of cands) {
      try {
        const r = await fetchTimeout(base + "/api/skins/health", 1600);
        if (r.ok && (await r.json()).ok === 1) {
          API = base;
          if (base) localStorage.setItem("skinlab_api", base);
          return true;
        }
      } catch (e) { /* next candidate */ }
    }
    return false;
  }
  async function api(p, body) {
    const r = await fetch(API + p, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
    return j;
  }

  let toastT = null;
  function toast(msg, bad) {
    const el = $("toast");
    // errors get assertive announcement + a longer read window; the role is
    // swapped BEFORE the write (so AT sees an alert insertion) and restored
    // to the resting role="status" on hide (A3-17).
    el.setAttribute("role", bad ? "alert" : "status");
    el.textContent = msg;
    el.className = bad ? "bad" : "";
    el.style.display = "block";
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.style.display = "none"; el.setAttribute("role", "status"); }, bad ? 8000 : 3500);
  }

  const fmt$ = (v) => v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (v, dp) => v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(dp == null ? 1 : dp) + "%";
  const cls = (v) => v == null ? "" : v > 0.0005 ? "up" : v < -0.0005 ? "dn" : "";
  const ago = (t) => {
    if (!t) return "never";
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "just now" : m < 60 ? m + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago";
  };

  // ── focus restore across innerHTML re-renders (A2-6) ─────────────────────
  // Every render path rebuilds #itemView (or #pfTable) via innerHTML, which
  // destroys the focused control and dumps keyboard users at <body>. Handlers
  // set pendingFocus (a selector, or a function returning an element) BEFORE
  // triggering a re-render; the renderers apply it at the end. "Not found"
  // keeps it pending — a transition may pass through an interim render (e.g.
  // search-pick re-renders home before the item view mounts the back button).
  let pendingFocus = null;
  function applyPendingFocus() {
    if (!pendingFocus) return;
    const t = typeof pendingFocus === "function" ? pendingFocus() : document.querySelector(pendingFocus);
    if (t && t.focus) { pendingFocus = null; t.focus(); }
  }
  const focusBack = () => $("backBtn"); // item-view entry target (A2-6)

  // ── market home (the CoinGecko-shaped landing) ───────────────────────────
  async function loadWatch() {
    if (state.mode === "static") {
      state.watch = state.manifest.items.map((m) => ({
        name: m.name, cat: m.cat || null, tier: m.tier || null,
        latest: m.quote ? m.quote.price : m.latest,
        vol24h: m.vol24h != null ? m.vol24h : (m.quote ? m.quote.vol : null),
        t: m.quote ? m.quote.t : null,
        days: m.days, mom1: m.mom1, mom7: m.mom7, mom30: m.mom30,
        spark: m.spark || [],
        verdict: m.verdict, score: m.score,
      }));
    } else {
      state.watch = (await api("/api/skins/watchlist")).items;
    }
    if (state.view === "home") renderHome();
  }
  async function loadMarket() {
    try {
      state.market = state.mode === "static" ? (state.manifest.market || null) : await api("/api/skins/market");
    } catch (e) { state.market = null; }
  }

  const fmtCompact = (v) => v == null ? "—"
    : v >= 1e6 ? (v / 1e6).toFixed(2) + "M"
    : v >= 1e4 ? Math.round(v / 1e3) + "k"
    : v >= 1e3 ? (v / 1e3).toFixed(1) + "k"
    : String(Math.round(v));

  const COLS = [
    { key: "name", label: "Item", num: false },
    { key: "latest", label: "Price", num: true },
    { key: "mom1", label: "24h", num: true },
    { key: "mom7", label: "7d", num: true },
    { key: "mom30", label: "30d", num: true },
    { key: "vol24h", label: "Sold 24h", num: true },
    { key: "dvol", label: "$/day", num: true },
    { key: "spark", label: "14d", num: false, nosort: true },
    { key: "score", label: "Signal", num: true },
  ];
  // dollar volume (units × price paid): rows publish `dvol` since 2026-07-27;
  // the fallback computes it client-side so pre-refresh manifests render too
  const dvolOf = (w) => w.dvol != null ? w.dvol
    : (w.latest != null && w.vol24h != null ? Math.round(w.latest * w.vol24h) : null);
  function sortedRows() {
    const { key, dir } = state.sort;
    return state.watch.slice().sort((a, b) => {
      const av = key === "dvol" ? dvolOf(a) : a[key], bv = key === "dvol" ? dvolOf(b) : b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;         // nulls sink regardless of direction
      if (bv == null) return -1;
      if (typeof av === "string") return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });
  }
  function renderHome() {
    state.view = "home";
    const t = state.market && state.market.today;
    const rows = sortedRows();
    const movers = state.watch.filter((w) => w.mom1 != null).sort((a, b) => b.mom1 - a.mom1);
    const gain = movers.filter((w) => w.mom1 > 0).slice(0, 3);
    const lose = movers.filter((w) => w.mom1 < 0).slice(-3).reverse();
    const series = state.market ? state.market.series : [];
    const idxPts = series.filter((s) => s.caseIdx != null);
    const cashPts = A.cashAdjustedIndex(series);
    const btcCorr = A.corrDaily(series, "caseIdx", "btc", 30);
    // 12-year backtest reconstruction, stitched to the live series at the
    // live series' first day (chart context only — the live published index
    // is never backfilled; all rebasing is cosmetic and disclosed)
    let reconPts = [];
    if (state.backtest && state.backtest.length >= 2) {
      const liveFirst = idxPts.length ? idxPts[0] : null;
      const liveFirstDay = liveFirst ? A.dayKey(liveFirst.t) : null;
      let join = state.backtest[state.backtest.length - 1];
      if (liveFirstDay) for (const p of state.backtest) { if (p[0] <= liveFirstDay) join = p; else break; }
      const k = (liveFirst ? liveFirst.caseIdx : 100) / join[1];
      reconPts = state.backtest.filter((p) => !liveFirstDay || p[0] < liveFirstDay)
        .map((p) => ({ t: Date.parse(p[0]), v: p[1] * k }));
    }
    // comparison overlays: historical backfill (backtest/macro.json —
    // steamcharts monthly players, blockchain.info BTC) joined to the LIVE
    // daily samples the collector already folds into market.series
    const mac = state.macroHist || {};
    const liveDayFirst = series.length ? series[0].day : null;
    const joinHist = (hist, liveKey) => (hist || [])
      .filter((p) => !liveDayFirst || p[0] < liveDayFirst)
      .map((p) => ({ t: Date.parse(p[0]), v: p[1] }))
      .concat(series.filter((s) => s[liveKey] != null && s[liveKey] > 0).map((s) => ({ t: s.t, v: s[liveKey] })));
    // overlays are clamped to the index's own span — the chart compares
    // things TO the index, and pre-index BTC ($0.07 in 2010) would explode
    // the rebase scale and drag the x-axis years before the index exists
    const famFirstT = state.backtest && state.backtest.length ? Date.parse(state.backtest[0][0])
      : (idxPts.length ? idxPts[0].t : null);
    const clampFam = (pts) => (famFirstT == null ? pts : pts.filter((p) => p.t >= famFirstT));
    const playersAll = state.overlays.players ? clampFam(joinHist(mac.players, "players")) : [];
    const btcAll = state.overlays.btc ? clampFam(joinHist(mac.btc, "btc")) : [];
    // EVERY line rebases to 100 at the first visible point of the selected
    // range — a fair relative comparison at any zoom. The index family
    // (recon + live + cash-adjusted) shares ONE factor so the recon→live
    // seam and the wallet-vs-real gap survive the rebase.
    const IDXR = { "1Y": 366, "5Y": 1827, "ALL": Infinity };
    const idxCut = Date.now() - (IDXR[state.idxRange] || Infinity) * 86400000;
    const idxRaw = idxPts.map((p) => ({ t: p.t, v: p.caseIdx }));
    const grpVis = reconPts.concat(idxRaw).filter((p) => p.t >= idxCut && p.v > 0);
    const gF = grpVis.length ? 100 / grpVis[0].v : 1;
    const scaleG = (pts) => pts.filter((p) => p.t >= idxCut && p.v > 0).map((p) => ({ t: p.t, v: p.v * gF }));
    const rebase = (pts) => {
      const vis = pts.filter((p) => p.t >= idxCut && p.v > 0);
      if (vis.length < 2) return [];
      const f = 100 / vis[0].v;
      return vis.map((p) => ({ t: p.t, v: p.v * f }));
    };
    const reconVis = scaleG(reconPts);
    const idxVis = scaleG(idxRaw);
    const cashVis = scaleG(cashPts.map((p) => ({ t: p.t, v: p.cashIdx })));
    const playersVis = rebase(playersAll);
    const btcVis = rebase(btcAll);
    const hasIdxChart = idxVis.length >= 2 || reconVis.length >= 2 || playersVis.length >= 2 || btcVis.length >= 2;
    const RECON_COL = "rgba(75,105,255,.85)", PLAYERS_COL = "#d32ce6"; // mil-spec ghost (.85 → 3.3:1 composited) + classified players line (DESIGN.md §2)
    const hasPlayersData = (mac.players && mac.players.length) || series.some((s) => s.players != null);
    const hasBtcData = (mac.btc && mac.btc.length) || series.some((s) => s.btc != null);
    // ovChip → DS.toggle (aria-pressed + .on move together on re-render; the
    // ds.css `[aria-pressed="false"] .ds-sw` rule dims the off swatch).
    const ovChip = (key, label, col, avail) => !avail ? "" :
      DS.toggle({ label: label, swatch: col, on: !!state.overlays[key], data: { ov: key }, cls: "ovToggle" });
    const strip =
      tile2("SKINDEX", t && t.caseIdx != null ? t.caseIdx.toFixed(1) : "—",
        t && t.idx1 != null ? fmtPct(t.idx1) + " 24h" + (t.idx7 != null ? " · " + fmtPct(t.idx7) + " 7d" : "") : "base 100 at first collection",
        t && t.idx1 != null ? cls(t.idx1) : "") +
      tile2("LIQUIDS INDEX", t && t.liqIdx != null ? t.liqIdx.toFixed(1) : "—", "commodity skins & knives, steam marks", "") +
      tile2("ART INDEX", t && t.artIdx != null ? t.artIdx.toFixed(1) : "—", "grails, marked to 30d realized sales", "") +
      // SMLX-7 draft preview — NOT a settlement input (label per methodology)
      tile2("MARKET INDEX", t && t.marketIdx != null ? t.marketIdx.toFixed(1) : "—", "SMLX-7 preview · cases + liquids", "") +
      tile2("CASH RATIO", t && t.cashRatio != null ? Math.round(t.cashRatio * 100) + "%" : "—",
        "cash sale vs steam price", "") +
      tile2("UNITS SOLD / DAY", t ? fmtCompact(t.volTotal) : "—", "across tracked items", "") +
      tile2("$ VOLUME / DAY", (() => {
        const dv = state.watch.reduce((s, w) => s + (dvolOf(w) || 0), 0);
        return dv > 0 ? "$" + fmtCompact(dv) : "—";
      })(), "units × price paid, tracked set", "") +
      tile2("CS2 PLAYERS", t && t.players != null ? fmtCompact(t.players) : "—", "in game right now", "") +
      tile2("CN / US ACTIVITY", t && t.cnus != null ? t.cnus.toFixed(2) : "—",
        t && t.cnus != null ? "Asia-evening ÷ US-evening peak" : "measuring — needs a full day of samples", "") +
      tile2("BTC CN / US (30D)", (() => {
        const bs = t && t.btcSessions;
        if (!bs || !bs.ready) return "—";
        const spread = Math.round((bs.asiaPct - bs.usPct) * 10) / 10;
        return (spread > 0 ? "+" : "") + spread + "pp";
      })(), (() => {
        const bs = t && t.btcSessions;
        if (!bs || !bs.ready) return "measuring: " + (bs ? bs.days : 0) + "/" + (bs ? bs.minDays : 5) + " days of 3h sessions";
        const f = (v) => (v > 0 ? "+" : "") + v + "%";
        return "Asia " + f(bs.asiaPct) + " vs US " + f(bs.usPct) + " · session-attributed";
      })(), "") +
      tile2("VS BITCOIN (30D)", btcCorr.corr != null ? (btcCorr.corr > 0 ? "+" : "") + btcCorr.corr.toFixed(2) : "—",
        (btcCorr.corr != null ? "return correlation" : "measuring: " + btcCorr.n + "/10 days") +
        (state.corrStudy ? " · 12y " + (state.corrStudy.monthly > 0 ? "+" : "") + state.corrStudy.monthly.toFixed(2) : "") +
        (t && t.btc != null ? " · BTC $" + fmtCompact(t.btc) : ""), "") +
      tile2("TRACKED", String(state.watch.length), state.mode === "static" && state.manifest ? "updated " + ago(state.manifest.generatedAt) : "live tracker", "");
    $("itemView").innerHTML =
      '<div class="ds-panel panel"><div class="tiles strip">' + strip + "</div>" +
        (hasIdxChart ?
          '<div class="ds-legend idxLegend">' +
            (reconPts.length >= 2 ? DS.legendItem({ swatch: RECON_COL, html: '2014→ reconstruction (<a href="backtest.html">backtest</a>, rebased)' }) : "") +
            DS.legendItem({ swatch: COL.price, label: "Skindex (wallet $)" }) +
            DS.legendItem({ swatch: COL.sma7, label: "Cash-adjusted (real $)" }) +
            ovChip("players", "CS players", PLAYERS_COL, hasPlayersData) +
            ovChip("btc", "BTC", COL.sma30, hasBtcData) +
            (reconPts.length >= 2
              ? DS.rangeChips({ ranges: Object.keys(IDXR), active: state.idxRange, dataKey: "ir", cls: "idxRangeRow" })
              : '<span class="ds-hint hint">gap between the first two = wallet inflation / exit pressure</span>') +
          "</div>" +
          '<canvas id="idxChart" height="130" aria-label="Skindex over time, with backtest reconstruction and comparison overlays" role="img"></canvas>' +
          idxDataTableHtml(reconPts, idxRaw, idxCut) : "") +
      "</div>" +
      (gain.length || lose.length ?
        '<div class="ds-panel panel moversRow">' +
          (gain.length ? '<span class="ds-hint hint">24h gainers</span>' + gain.map(moverChip).join("") : "") +
          (lose.length ? '<span class="ds-hint hint" style="margin-left:12px">losers</span>' + lose.map(moverChip).join("") : "") +
        "</div>" : "") +
      (state.market && state.market.settlement ? settlementPanel(state.market.settlement, state.market.integrity) : "") +
      '<div class="ds-panel panel" id="mktPanel" tabindex="-1"><div class="scrollX"><table class="mkt"><thead><tr><th>#</th>' +
        // sortable headers: a real <button class="thbtn"> inside the th gives
        // native focus + Enter/Space activation (A2-1/A3-9); data-k stays on
        // the th (probe contract) and rides on the button too; aria-sort only
        // on the ACTIVE th. The th click listener still works — clicks bubble.
        COLS.map((c) => "<th" + (c.nosort ? "" : ' class="sortable' + (state.sort.key === c.key ? " on" : "") + '" data-k="' + c.key + '"' +
          (state.sort.key === c.key ? ' aria-sort="' + (state.sort.dir < 0 ? "descending" : "ascending") + '"' : "")) +
          (c.num ? ' style="text-align:right"' : "") + ">" +
          (c.nosort ? c.label
            : '<button type="button" class="thbtn" data-k="' + c.key + '">' + c.label +
              (state.sort.key === c.key ? (state.sort.dir < 0 ? " ↓" : " ↑") : "") + "</button>") + "</th>").join("") +
      "</tr></thead><tbody>" +
      rows.map((w, i) =>
        '<tr class="mrow" data-i="' + i + '" tabindex="0" aria-label="' + esc(w.name) + '">' +
        "<td>" + (i + 1) + "</td>" +
        '<td class="nm" title="' + esc(w.name) + '">' + esc(w.name) + ((w.tier || w.cat) ? ' <span class="catChip">' + esc(w.tier === "art" ? "art" : w.cat) + "</span>" : "") + "</td>" +
        '<td class="r">' + fmt$(w.latest) + "</td>" +
        '<td class="r chg ' + cls(w.mom1) + '">' + fmtPct(w.mom1) + "</td>" +
        '<td class="r chg ' + cls(w.mom7) + '">' + fmtPct(w.mom7) + "</td>" +
        '<td class="r chg ' + cls(w.mom30) + '">' + fmtPct(w.mom30) + "</td>" +
        '<td class="r">' + fmtCompact(w.vol24h) + "</td>" +
        '<td class="r">' + (dvolOf(w) != null ? "$" + fmtCompact(dvolOf(w)) : "—") + "</td>" +
        '<td><canvas class="spark" width="90" height="26" data-i="' + i + '" aria-hidden="true"></canvas></td>' +
        '<td class="r">' + DS.badge({ label: w.verdict || "—", tone: w.score >= 12 ? "good" : w.score <= -12 ? "bad" : "", cls: "sigMini" }) + "</td>" +
        "</tr>").join("") +
      "</tbody></table></div>" +
      (state.watch.some((w) => w.days < 30)
        ? '<div class="ds-hint hint" style="margin-top:8px">Some items are still warming up (under 30 days of history) — momentum fills in as the collector accrues data.</div>' : "") +
      "</div>";
    $("itemView").querySelectorAll("th.sortable, th[data-k]").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (!k) return;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === "name" ? 1 : -1) };
      pendingFocus = '.thbtn[data-k="' + k + '"]'; // keyboard sort keeps its header (A2-6)
      renderHome();
    }));
    $("itemView").querySelectorAll(".mrow").forEach((el) => {
      const go = () => { pendingFocus = focusBack; selectItem(rows[Number(el.dataset.i)].name); };
      el.addEventListener("click", go);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    $("itemView").querySelectorAll(".moverChip").forEach((b) =>
      b.addEventListener("click", () => { pendingFocus = focusBack; selectItem(b.dataset.name); }));
    rows.forEach((w, i) => drawSpark($("itemView").querySelector('.spark[data-i="' + i + '"]'), w.spark));
    sparkRows = rows; // resize redraw source (A1-8)
    idxChartArgs = null;
    if (hasIdxChart) {
      const lines = [];
      if (reconVis.length >= 2) lines.push({ pts: reconVis, col: RECON_COL, w: 1.5, dash: [4, 3] });
      if (idxVis.length >= 2) lines.push({ pts: idxVis, col: COL.price, w: 2 });
      if (cashVis.length >= 2) lines.push({ pts: cashVis, col: COL.sma7, w: 1.5 });
      if (playersVis.length >= 2) lines.push({ pts: playersVis, col: PLAYERS_COL, w: 1.5, dash: [2, 3] });
      if (btcVis.length >= 2) lines.push({ pts: btcVis, col: COL.sma30, w: 1.5, dash: [5, 4] });
      // log scale whenever any visible line spans a big ratio (a 1000x
      // players range or 40x index range flattens to nothing on linear)
      const vals = lines.flatMap((l) => l.pts.map((p) => p.v)).filter((v) => v > 0);
      const useLog = vals.length && Math.max.apply(null, vals) / Math.min.apply(null, vals) > 6;
      idxChartArgs = { lines, opts: { log: useLog } }; // resize redraw source (A1-8)
      drawIdxChart($("idxChart"), lines, { log: useLog });
      $("itemView").querySelectorAll("[data-ir]").forEach((b) =>
        b.addEventListener("click", () => {
          state.idxRange = b.dataset.ir;
          pendingFocus = '[data-ir="' + b.dataset.ir + '"]';
          renderHome();
        }));
      $("itemView").querySelectorAll(".ovToggle").forEach((b) =>
        b.addEventListener("click", () => {
          const k = b.dataset.ov;
          state.overlays[k] = !state.overlays[k];
          pendingFocus = '.ovToggle[data-ov="' + k + '"]';
          renderHome();
        }));
    }
    applyPendingFocus();
  }
  function settlementPanel(st, integ) {
    const fx = st.fixings || {};
    const ft = (name, label) => {
      const f = fx[name];
      if (!f) return "";
      return tile2(label, f.value != null ? String(f.value) : "—",
        f.value != null ? "hash " + (f.hash || "").slice(0, 12) + "…" : "accruing — " + (f.accruing || ""), "");
    };
    const b = st.budget && st.budget.caseIndex;
    let integTile = "";
    if (integ && integ.summary) {
      const sm = integ.summary, n = (sm.watch || 0) + (sm.alert || 0);
      integTile = tile2("MARK INTEGRITY",
        n === 0 ? "✓ CLEAN" : "⚠ " + n + " FLAG" + (n > 1 ? "S" : ""),
        n === 0
          ? "ratio " + sm.ratioCorroborated + " · book " + sm.bookCorroborated + " corroborated"
          : (integ.flags || []).slice(0, 3).map((f) => f.severity + " " + f.lane + ": " + shortName(f.name)).join(" · "),
        n === 0 ? "up" : (sm.alert ? "dn" : ""));
    }
    return '<div class="ds-panel panel"><h2>SETTLEMENT FIXINGS · ' + esc(st.methodology) + "</h2>" +
      '<div class="tiles">' +
      ft("SETTLE-CASE-7D", "SETTLE-CASE-7D") +
      ft("SETTLE-CASE-30D", "SETTLE-CASE-30D") +
      ft("SETTLE-RATIO-30D", "SETTLE-RATIO-30D") +
      (b ? tile2("MANIP BUDGET (7D FIX)", "$" + fmtCompact(b.concentrated ? b.concentrated.costMove1pctFix7d : b.costMove1pctFix7d),
        "cheapest-attack fee-burn floor to move the 7d fixing 1%", "") : "") +
      integTile +
      "</div>" +
      '<div class="ds-hint hint">Dated settlement marks, re-derivable bit-exactly from the committed data — ' +
      '<a href="methodology.html">methodology &amp; verification</a>. A measurement, not an offer of any instrument.</div></div>';
  }
  // tile2 → DS.tile (home strip + settlement; read by TEXT only, no .lb hook needed).
  const tile2 = (lb, v, sub, c) => DS.tile({ label: lb, value: v, sub: sub || null, tone: c || null });
  // moverChip → DS.chip{interactive}; keeps the .moverChip + data-name contract hooks.
  const moverChip = (w) => DS.chip({
    interactive: true, cls: "moverChip", attrs: { "data-name": w.name, title: w.name },
    labelHtml: '<span class="nm">' + esc(shortName(w.name)) + '</span> <span class="chg ' + cls(w.mom1) + '">' + fmtPct(w.mom1) + "</span>",
  });
  function shortName(n) { return n.replace(/ \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, "").replace("Operation ", ""); }

  // Text equivalent for the home index chart (A3-20): the index family
  // (reconstruction + live), sliced to the selected range; month-end sampled
  // when long, capped at 400 rows — the summary says what it shows.
  function idxDataTableHtml(reconPts, idxRaw, idxCut) {
    const fam = reconPts.map((p) => ({ t: p.t, v: p.v, recon: true }))
      .concat(idxRaw.map((p) => ({ t: p.t, v: p.v, recon: false })))
      .filter((p) => p.t >= idxCut && p.v > 0);
    if (fam.length < 2) return "";
    let rows = fam, how = "daily";
    if (fam.length > 40) {
      const byMonth = new Map(); // last sample of each month
      for (const p of fam) byMonth.set(new Date(p.t).toISOString().slice(0, 7), p);
      rows = Array.from(byMonth.values());
      how = "month-end";
    }
    if (rows.length > 400) { rows = rows.slice(-400); how = "last 400 " + how + " rows"; }
    const anyRecon = rows.some((p) => p.recon);
    return '<details class="dataTable"><summary>Index data table (' + how + ", " + rows.length + " rows)</summary>" +
      '<div class="scroll"><table class="dt"><tr><th>Day</th><th>Index</th></tr>' +
      rows.map((p) => "<tr><td>" + new Date(p.t).toISOString().slice(0, 10) + (p.recon ? "*" : "") + "</td><td>" + p.v.toFixed(1) + "</td></tr>").join("") +
      "</table></div>" +
      (anyRecon ? '<div class="ds-hint hint">* backtest reconstruction, rebased to the live index</div>' : "") +
      "</details>";
  }

  // Last-rendered home canvases, so a window resize can redraw them without
  // a full (focus-destroying) re-render (A1-8).
  let sparkRows = null, idxChartArgs = null;
  function redrawHomeCanvases() {
    if (state.view !== "home") return;
    if (idxChartArgs && $("idxChart")) drawIdxChart($("idxChart"), idxChartArgs.lines, idxChartArgs.opts);
    if (sparkRows) sparkRows.forEach((w, i) => drawSpark($("itemView").querySelector('.spark[data-i="' + i + '"]'), w.spark));
  }

  function drawSpark(cv, prices) {
    if (!cv) return;
    const pts = (prices || []).filter((p) => p != null);
    if (pts.length < 2) return;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height, pad = 2;
    ctx.clearRect(0, 0, W, H); // idempotent redraws (resize hook)
    let lo = Math.min(...pts), hi = Math.max(...pts);
    if (hi === lo) { hi += 1e-9; }
    const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
    const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
    ctx.strokeStyle = pts[pts.length - 1] >= pts[0] ? "#3fae6a" : "#e66767";
    ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p)) : ctx.moveTo(x(i), y(p))));
    ctx.stroke();
  }
  // lines: [{pts:[{t,v}], col, w, dash?}] — the home index chart rebases every
  // line to 100 so ONE axis serves them all (never two scales on one chart).
  // opts: { log, h, fmt } — `h` overrides the CSS height and `fmt` the y-axis
  // label formatter, so a second consumer (the inventory chart, which plots
  // dollars rather than an index level) reuses this helper instead of forking
  // the dpr / axis / dash discipline. Both default to the home-chart values.
  const IDX_H = 130; // CSS height of #idxChart (matches the height="130" markup)
  const idxAxisFmt = (gv) => gv >= 1e6 ? (gv / 1e6).toFixed(1) + "M" : gv >= 1000 ? (gv / 1000).toFixed(1) + "k" : gv.toFixed(1);
  function drawIdxChart(cv, lines, opts) {
    if (!cv || !lines.length) return;
    const log = !!(opts && opts.log);
    const CH = (opts && opts.h) || IDX_H;
    const axisFmt = (opts && opts.fmt) || idxAxisFmt;
    // Same dpr discipline as drawChart (A1-8): backing = CSS px × dpr,
    // style.width/height pinned so the backing-store write can never feed
    // back into layout (the A1-1 lock) and hiDPI stays crisp.
    const cssW = Math.max(1, cv.parentElement.clientWidth - 8);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(CH * dpr);
    cv.style.width = cssW + "px"; cv.style.height = CH + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, CH);
    const W = cssW, H = CH, L = 40, R = 8, T = 8, B = 16;
    const all = lines.flatMap((l) => l.pts).filter((p) => !log || p.v > 0);
    const tv = (v) => (log ? Math.log(v) : v);
    const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t)) || t0 + 1;
    let lo = Math.min(...all.map((p) => tv(p.v))), hi = Math.max(...all.map((p) => tv(p.v)));
    const pad = (hi - lo) * 0.1 || 1; lo -= pad; hi += pad;
    const x = (t) => L + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (tv(v) - lo) / (hi - lo)) * (H - T - B);
    ctx.font = "10px -apple-system, sans-serif"; ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text; ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const gv = log ? Math.exp(lo + (hi - lo) * i / 2) : lo + (hi - lo) * i / 2;
      const yy = Math.round(y(gv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(axisFmt(gv), L - 5, yy);
    }
    const d0 = new Date(t0), d1 = new Date(t1);
    const longSpan = t1 - t0 > 400 * 86400000;
    const dl = (d) => d.toLocaleDateString("en-US", longSpan
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" });
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(dl(d0), x(t0) + 24, H - B + 4); ctx.fillText(dl(d1), x(t1) - 24, H - B + 4);
    for (const ln of lines) {
      ctx.strokeStyle = ln.col; ctx.lineWidth = ln.w || 1.5; ctx.setLineDash(ln.dash || []);
      ctx.lineJoin = "round"; ctx.beginPath();
      ln.pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
      ctx.stroke(); ctx.setLineDash([]);
    }
  }
  function goHome() {
    const prev = state.selected;
    state.selected = null; state.item = null;
    // back-to-home puts the keyboard where the user came from: the item's
    // market row when it exists, else the search box (A2-6)
    pendingFocus = () => {
      const row = prev && Array.from(document.querySelectorAll(".mrow"))
        .find((r) => r.getAttribute("aria-label") === prev);
      return row || $("searchBox");
    };
    renderHome();
  }

  // ── search ───────────────────────────────────────────────────────────────
  let searchT = null, searchResults = [];
  const searchWrap = document.querySelector(".searchWrap");
  const searchOpen = () => $("searchResults").classList.contains("open");
  $("searchBox").addEventListener("input", () => {
    clearTimeout(searchT);
    searchT = setTimeout(runSearch, 180);
  });
  // Enter only navigates while the dropdown is OPEN — Esc kills both the
  // dropdown and the stale results array, so dismiss-then-Enter is dead (A2-7)
  $("searchBox").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && searchOpen() && searchResults.length) { e.preventDefault(); pickResult(0); }
  });
  // Esc anywhere in the search composite (box OR option rows) closes and
  // returns focus to the box (A2-8); ArrowDown/ArrowUp walk box ⇄ options,
  // Enter on an option picks it — the native button click does that (A2-9).
  searchWrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const wasOpen = searchOpen();
      closeSearch();
      if (wasOpen) { e.stopPropagation(); $("searchBox").focus(); }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (!searchOpen()) return;
    const opts = Array.from($("searchResults").querySelectorAll("button.sr-row"));
    if (!opts.length) return;
    const cur = opts.indexOf(document.activeElement);
    if (e.key === "ArrowUp" && cur < 0) return; // already in the box
    e.preventDefault();
    const next = e.key === "ArrowDown"
      ? (cur < 0 ? opts[0] : opts[Math.min(cur + 1, opts.length - 1)])
      : (cur === 0 ? null : opts[cur - 1]); // null → back to the box
    (next || $("searchBox")).focus();
  });
  // aria-selected follows focus through the options (Tab or arrows) (A3-18)
  $("searchResults").addEventListener("focusin", (e) => {
    $("searchResults").querySelectorAll("button.sr-row").forEach((o) =>
      o.setAttribute("aria-selected", String(o === e.target)));
  });
  // moving focus out of the composite dismisses the dropdown (A2-8)
  searchWrap.addEventListener("focusout", (e) => {
    if (!searchWrap.contains(e.relatedTarget)) closeSearch();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".searchWrap")) closeSearch(); });
  let seedCache = null; // static-mode search universe (seed.json + manifest)
  async function staticSearch(q) {
    if (!seedCache) {
      try { seedCache = ((await (await fetch("seed.json", { cache: "no-store" })).json()).items || []).map((s) => s.name); }
      catch (e) { seedCache = []; }
    }
    const uni = new Map();
    for (const n of seedCache) uni.set(n, { name: n, watched: false, price: null });
    for (const m of state.manifest.items) uni.set(m.name, { name: m.name, watched: true, price: m.quote ? m.quote.price : m.latest });
    const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
    return Array.from(uni.values())
      .filter((it) => toks.every((t) => it.name.toLowerCase().includes(t)))
      .sort((a, b) => (b.watched - a.watched) || (a.name < b.name ? -1 : 1))
      .slice(0, 25);
  }
  async function runSearch() {
    const q = $("searchBox").value.trim();
    if (q.length < 2) return closeSearch();
    try {
      searchResults = state.mode === "static" ? await staticSearch(q)
        : (await api("/api/skins/search?q=" + encodeURIComponent(q))).results;
      // user already left the composite while the debounce/fetch ran —
      // don't pop a dropdown under nobody's focus
      if (!searchWrap.contains(document.activeElement)) return;
      const box = $("searchResults");
      box.innerHTML = searchResults.map((r, i) =>
        '<button class="sr-row" data-i="' + i + '" role="option" aria-selected="false"><span>' + esc(r.name) + '</span>' +
        '<span class="p">' + (r.watched ? '<span class="w">tracking</span> ' : "") + (r.price != null ? fmt$(r.price) : "") + "</span></button>").join("") ||
        '<div class="sr-row">No matches. Type the exact Steam market name to track anything.</div>';
      box.classList.add("open");
      $("searchBox").setAttribute("aria-expanded", "true");
      box.querySelectorAll("button.sr-row").forEach((el) =>
        el.addEventListener("click", () => pickResult(Number(el.dataset.i))));
    } catch (e) { toast("search failed: " + e.message, true); }
  }
  function closeSearch() {
    $("searchResults").classList.remove("open");
    $("searchBox").setAttribute("aria-expanded", "false");
    searchResults = []; // stale results must never answer a later Enter (A2-7)
  }
  async function pickResult(i) {
    const r = searchResults[i];
    if (!r) return;
    closeSearch();
    $("searchBox").value = "";
    if (state.mode === "static") {
      if (r.watched) { pendingFocus = focusBack; return selectItem(r.name); } // item-view entry (A2-6)
      // read-only host: tracking an item = adding it to the repo's watchlist
      toast("Add \"" + r.name + "\" to watchlist.json on GitHub — the collector picks it up next run");
      window.open(ghEditWatchlistUrl(), "_blank", "noopener");
      $("searchBox").focus(); // no navigation happened — keep the user in the search
      return;
    }
    if (!r.watched) {
      await api("/api/skins/watch", { name: r.name });
      toast("Tracking " + r.name);
      refreshItem(r.name).catch(() => {});
    }
    pendingFocus = focusBack; // survives the interim home render, lands on the item view
    await loadWatch();
    await selectItem(r.name);
  }

  // ── item view ────────────────────────────────────────────────────────────
  // Static mode: build the exact report shape the tracker API serves, from
  // the collector's committed files + the SAME shared assembly/analytics.
  async function staticItemReport(name) {
    const row = state.manifest.items.find((m) => m.name === name);
    if (!row) throw new Error("not in the collected set");
    let lines = [];
    try {
      const txt = await (await fetch("data/history/" + row.slug + ".jsonl", { cache: "no-store" })).text();
      for (const ln of txt.split("\n")) {
        if (!ln.trim()) continue;
        try { lines.push(JSON.parse(ln)); } catch (e) { /* torn line */ }
      }
    } catch (e) { /* no history file yet */ }
    let importRows = null;
    if (row.imported) {
      try { importRows = (await (await fetch("data/import/" + row.slug + ".json", { cache: "no-store" })).json()).rows; }
      catch (e) { /* missing import */ }
    }
    // DISPLAY-ONLY deep history (backtest backfill) — extends the series
    // strictly before the first collected day; never fed to the index
    let deepRows = null;
    try {
      const dj = await (await fetch("backtest/history/" + row.slug + ".json", { cache: "no-store" })).json();
      if (dj && Array.isArray(dj.rows)) deepRows = dj.rows.map((r) => ({ t: r[0], price: r[1], vol: r[2] }));
    } catch (e) { /* no deep history for this item */ }
    const base = A.deepHistoryBase(deepRows, importRows, lines);
    const deepDays = deepRows ? base.length - (importRows ? importRows.length : 0) : 0;
    const series = A.assembleSeries(base, lines);
    const analytics = A.analyze(series.daily);
    const steamSnaps = lines.filter((l) => l.src === "steam");
    const last = steamSnaps.length ? steamSnaps[steamSnaps.length - 1] : null;
    const quote = last ? { t: last.t, price: last.price, lowest: last.lowest != null ? last.lowest : null, vol: last.vol != null ? last.vol : null } : row.quote;
    const sales = row.skinport || null;
    const steamGross = quote ? quote.price : analytics.latest;
    const spMedian = (sales && sales.last24h && sales.last24h.median)
      || (sales && sales.last7d && sales.last7d.median) || null;
    return {
      name, daily: series.daily, skinportDaily: series.skinportDaily,
      analytics, snapshots: lines.length, imported: !!importRows, deepDays, watched: true, quote,
      skinport: { sales, ask: null, qty: null },
      compare: {
        steam: { gross: steamGross, net: A.netProceeds(steamGross, "steam"), cash: false },
        skinport: { gross: spMedian, net: A.netProceeds(spMedian, "skinport"), cash: true },
      },
    };
  }
  async function selectItem(name) {
    state.selected = name;
    state.view = "item";
    state.item = state.mode === "static" ? await staticItemReport(name)
      : await api("/api/skins/item?name=" + encodeURIComponent(name));
    renderItem();
    // live mode: stale (>60min) or missing quote → snapshot automatically
    const q = state.item.quote;
    if (state.mode === "live" && (!q || Date.now() - q.t > 3600000)) {
      $("netStatus").textContent = "snapshotting…";
      refreshItem(name).finally(() => { $("netStatus").textContent = "ready"; });
    }
  }
  async function refreshItem(name) {
    try {
      const r = await api("/api/skins/refresh", { name });
      const res = r.results && r.results[0];
      if (res && !res.ok) throw new Error(res.error || "refresh failed");
      if (state.selected === name) { state.item = await api("/api/skins/item?name=" + encodeURIComponent(name)); renderItem(); }
      await loadWatch();
    } catch (e) { toast("Snapshot failed: " + e.message, true); }
  }

  function renderItem() {
    const it = state.item;
    if (!it) return;
    const an = it.analytics, sig = an.signal || { score: 0, verdict: "—", reasons: [] };
    const sigCls = sig.score >= 12 ? "good" : sig.score <= -12 ? "bad" : "neutral";
    const sp = it.skinport || {};
    const spSales = sp.sales && (sp.sales.last24h || sp.sales.last7d);
    const cookieOn = !!(state.health && state.health.steamCookie);
    const ro = state.mode === "static";

    // Day-0 momentum: while our own history is too short, Skinport's
    // realized-sale medians (7/30/90d windows) give an instant read —
    // current 24h sold median vs the window median. Marked with * and
    // replaced by true price-history momentum as days accrue.
    const agg = sp.sales;
    const aggCur = agg && agg.last24h ? agg.last24h.median : null;
    const aggMom = (o) => (aggCur != null && o && o.median ? (aggCur - o.median) / o.median : null);
    let usedAgg = false;
    const momTile = (label, real, win) => {
      if (real != null) return tile(label, fmtPct(real), cls(real));
      const v = aggMom(win);
      if (v != null) { usedAgg = true; return tile(label + " SOLD*", fmtPct(v), cls(v)); }
      return tile(label, "—", "");
    };
    $("itemView").innerHTML =
      '<div class="ds-panel panel">' +
        '<button class="ds-btn btn backBtn" id="backBtn">← Market</button>' +
        '<div class="itemTitle"><h2>' + esc(it.name) + '</h2>' +
        '<span class="ds-hint hint">' + (it.quote ? "quote " + ago(it.quote.t) : "no snapshot yet") +
        " · " + an.days + " days of history" + (it.imported ? " (incl. imported)" : "") +
        (ro ? " · collector updates every 6h" : "") + "</span></div>" +
        '<div class="quoteRow">' +
          "<span>Steam median <b>" + fmt$(it.quote && it.quote.price) + "</b></span>" +
          "<span>lowest ask <b>" + fmt$(it.quote && it.quote.lowest) + "</b></span>" +
          "<span>sold 24h <b>" + (it.quote && it.quote.vol != null ? it.quote.vol : "—") + "</b></span>" +
          (sp.ask != null ? "<span>Skinport ask <b>" + fmt$(sp.ask) + "</b></span>" : "") +
        "</div>" +
        '<div class="tiles">' +
          momTile("7D", an.mom7, agg && agg.last7d) +
          momTile("30D", an.mom30, agg && agg.last30d) +
          momTile("90D", an.mom90, agg && agg.last90d) +
          tile("SMA 7 / 30", fmt$(an.sma7) + " / " + fmt$(an.sma30), "") +
          tile("RSI 14", an.rsi14 == null ? "—" : Math.round(an.rsi14), "") +
          tile("VOLATILITY /YR", an.vol30 == null ? "—" : Math.round(an.vol30 * 100) + "%", "") +
          tile("OFF PEAK", an.curDD == null ? "—" : "−" + (an.curDD * 100).toFixed(1) + "%", "") +
          tile("SOLD/DAY (30D)", an.liq30 == null ? "—" : Math.round(an.liq30), "") +
          tile("≈ $/DAY", an.liq30 != null && it.quote && it.quote.price != null
            ? "$" + fmtCompact(Math.round(an.liq30 * it.quote.price)) : "—", "") +
        "</div>" +
        (usedAgg ? '<div class="ds-hint hint" style="margin:-6px 0 12px">* from Skinport realized-sale medians — an instant read while price history builds</div>' : "") +
        (it.deepDays > 0 ? '<div class="ds-hint hint" style="margin:-4px 0 12px">Chart &amp; analytics include ' + it.deepDays.toLocaleString("en-US") +
          " days of backfilled Steam daily aggregates (display only — the <a href=\"methodology.html\">live index</a> starts at its adoption date and is never backfilled)</div>" : "") +
        (an.days < 30 ? '<div class="ds-warmup warmup">day ' + an.days + " of 30 — trend signals warm up as history builds" +
          (ro ? " (the collector records every 6 hours)" : "; Import/Bootstrap full Steam history for instant depth") + "</div>" : "") +
        '<div class="sigCard">' +
          DS.badge({ label: sig.verdict, value: (sig.score > 0 ? "+" : "") + sig.score, cls: "card sigBadge " + sigCls }) +
          '<div><ul class="sigReasons">' + sig.reasons.map((r) => "<li>" + esc(r) + "</li>").join("") +
          (sig.reasons.length ? "" : "<li>Not enough history yet — snapshots accrue daily.</li>") + "</ul>" +
          '<div class="sigNote">Heuristic score in [−100, +100] built only from the inputs above — not financial advice.</div></div>' +
        "</div>" +
      "</div>" +
      '<div class="ds-panel panel">' +
        '<div class="chartHead"><div class="ds-legend legend" id="legend"></div><div class="ranges" id="ranges">' +
          // DS.rangeChips emits aria-pressed with the .on class (A3-22);
          // the frozen `.ranges .btn` hook is re-added post-mount below.
          DS.rangeChips({ ranges: Object.keys(RANGES), active: state.range, dataKey: "r" }) +
        "</div></div>" +
        '<div class="chartWrap"><canvas id="chart" role="img" aria-label="Price history chart for ' + esc(it.name) + '"></canvas></div>' +
        dataTableHtml(it) +
      "</div>" +
      '<div class="ds-panel panel"><h2>WHERE TO SELL — NET PROCEEDS</h2><div class="cmpGrid">' +
        cmpBox("STEAM MARKET", it.compare.steam, "wallet funds only") +
        cmpBox("SKINPORT (REALIZED SALES)", it.compare.skinport, "cash out",
          spSales ? "median of actual sales · " + ((sp.sales.last24h && sp.sales.last24h.volume) || 0) + " sold in 24h" : "no sales data cached yet") +
      "</div></div>" +
      '<div class="ds-panel panel"><div class="btnrow">' +
        (ro
          ? '<a class="ds-btn primary btn" target="_blank" rel="noopener" href="' + ghEditWatchlistUrl() + '">✎ Edit tracked items (GitHub)</a>' +
            '<a class="ds-btn btn" target="_blank" rel="noopener" href="' + ghRunCollectorUrl() + '" title="Actions → Run workflow = snapshot now">⚡ Run collector now</a>'
          : '<button class="ds-btn btn" id="snapBtn">⟳ Snapshot now</button>' +
            (cookieOn ? '<button class="ds-btn btn" id="bootBtn" title="Pull full multi-year history from Steam using the configured cookie">⚡ Bootstrap full history</button>' : "") +
            '<button class="ds-btn btn" id="importBtn">📋 Import history (paste)</button>') +
        '<a class="ds-btn btn" target="_blank" rel="noopener" href="https://steamcommunity.com/market/listings/730/' + encodeURIComponent(it.name) + '">Steam page ↗</a>' +
        (ro ? "" : '<button class="ds-btn danger btn" id="unwatchBtn">✕ Stop tracking</button>') +
      "</div></div>";

    $("backBtn").addEventListener("click", goHome);
    $("ranges").querySelectorAll("[data-r]").forEach((b) => {
      b.classList.add("btn"); // frozen probe contract: `.ranges .btn[data-r=…]`
      b.addEventListener("click", () => {
        state.range = b.dataset.r;
        pendingFocus = '.ranges [data-r="' + b.dataset.r + '"]'; // chip keeps focus across re-render (A2-6)
        renderItem();
      });
    });
    if (!ro) {
      $("snapBtn").addEventListener("click", () => { toast("Snapshotting…"); refreshItem(it.name); });
      if ($("bootBtn")) $("bootBtn").addEventListener("click", bootstrapItem);
      $("importBtn").addEventListener("click", openImport);
      $("unwatchBtn").addEventListener("click", async () => {
        await api("/api/skins/watch", { name: it.name, remove: true });
        state.selected = null; state.item = null;
        await loadWatch();
        goHome();
      });
    }
    drawChart();
    applyPendingFocus();
  }
  // Item-view / portfolio stat tile. DS.tile's fixed inner classes (.ds-tile-lb)
  // can't satisfy the frozen `.tile .lb` probe selector, so the legacy inner
  // hooks ride alongside an added `ds-tile` (guard sees a migrated component).
  const tile = (lb, v, c) => '<div class="ds-tile tile"><div class="lb">' + lb + '</div><div class="v ' + c + '">' + v + "</div></div>";
  function cmpBox(title, c, cashNote, extra) {
    return '<div class="cmpBox"><h3>' + title + ' <span class="cash">' + cashNote + "</span></h3>" +
      '<div class="row"><span>Sale price</span><b>' + fmt$(c.gross) + "</b></div>" +
      '<div class="row"><span>You receive (after fees)</span><b>' + fmt$(c.net) + "</b></div>" +
      (extra ? '<div class="ds-hint hint" style="margin-top:4px">' + esc(extra) + "</div>" : "") + "</div>";
  }
  function dataTableHtml(it) {
    // text equivalent follows the SELECTED chart range (A3-20), newest first,
    // capped at 400 rows — the summary states exactly what it shows
    const vis = visibleDaily().rows;
    const total = vis.length;
    const d = vis.slice(-400).reverse();
    if (!d.length) return "";
    const lbl = state.range === "ALL" ? "all history" : "last " + state.range;
    const capNote = total > 400 ? " — latest 400 of " + total + " days" : " — " + total + " day" + (total === 1 ? "" : "s");
    return '<details class="dataTable"><summary>Data table (' + lbl + capNote + ')</summary><div class="scroll"><table class="dt">' +
      "<tr><th>Day</th><th>Price</th><th>Volume</th></tr>" +
      d.map((r) => "<tr><td>" + r.day + "</td><td>" + fmt$(r.price) + "</td><td>" + (r.vol == null ? "—" : r.vol) + "</td></tr>").join("") +
      "</table></div></details>";
  }

  async function bootstrapItem() {
    try {
      toast("Pulling full Steam history…");
      const r = await api("/api/skins/bootstrap", { name: state.selected });
      toast("Imported " + r.rows + " rows → " + r.daily + " days");
      selectItem(state.selected);
    } catch (e) { toast(e.message, true); }
  }

  // ── import modal ─────────────────────────────────────────────────────────
  // Dialog keyboard contract (A2-4/5/10, A3-12): the opener is captured on
  // open and restored by ONE shared closeImport() that every close path
  // (Cancel, backdrop, Esc, successful import) routes through; Tab/Shift+Tab
  // wrap inside the dialog while it is open; Esc is scoped to the open modal
  // so it can never fire as collateral of another Esc (search dropdown etc).
  let importOpener = null;
  function openImport() {
    importOpener = document.activeElement;
    const name = state.selected;
    $("importSnippet").textContent =
      'copy((await (await fetch("https://steamcommunity.com/market/pricehistory/?appid=730&market_hash_name=" + encodeURIComponent(' +
      JSON.stringify(name) + '))).json()).prices)';
    $("importText").value = "";
    $("importErr").textContent = "";
    $("importModal").classList.add("open");
    $("importText").focus();
  }
  function closeImport() {
    if (!$("importModal").classList.contains("open")) return;
    $("importModal").classList.remove("open");
    if (importOpener && importOpener.focus && document.contains(importOpener)) importOpener.focus();
    importOpener = null;
  }
  // exposed for programmatic drives: the opener button renders in
  // live-tracker mode only, but the modal (and its keyboard contract) must
  // work on any host — the a11y gate opens/closes it this way. The opener
  // capture lives INSIDE openImport, so any open path restores correctly.
  window.openImport = openImport;
  window.closeImport = closeImport;
  function trapImportTab(e) {
    const dlg = $("importModal").querySelector(".modal");
    const foci = Array.from(dlg.querySelectorAll('a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.disabled && el.getClientRects().length);
    if (!foci.length) return;
    const first = foci[0], last = foci[foci.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey) {
      if (cur === first || !dlg.contains(cur)) { e.preventDefault(); last.focus(); }
    } else if (cur === last || !dlg.contains(cur)) { e.preventDefault(); first.focus(); }
  }
  $("importCancel").addEventListener("click", closeImport);
  $("importModal").addEventListener("click", (e) => { if (e.target === $("importModal")) closeImport(); });
  $("importModal").addEventListener("keydown", (e) => {
    if (!$("importModal").classList.contains("open")) return;
    if (e.key === "Tab") trapImportTab(e);
    else if (e.key === "Escape") { e.stopPropagation(); closeImport(); }
  });
  // fallback for an Esc that never bubbled through the modal (focus outside
  // it while open) — still guarded on the modal actually being open (A2-10)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("importModal").classList.contains("open")) closeImport();
  });
  $("importGo").addEventListener("click", async () => {
    let rows;
    try { rows = JSON.parse($("importText").value); }
    catch (e) { $("importErr").textContent = "Not valid JSON — paste exactly what the console snippet copied."; return; }
    try {
      const r = await api("/api/skins/import", { name: state.selected, prices: rows });
      closeImport();
      toast("Imported " + r.rows + " rows → " + r.daily + " days of history");
      pendingFocus = () => $("importBtn"); // the re-render destroys the restored opener — re-land on it
      selectItem(state.selected);
    } catch (e) { $("importErr").textContent = e.message; }
  });

  // ── chart (canvas, crosshair + tooltip) ──────────────────────────────────
  const PAD = { l: 52, r: 14, t: 10, b: 20, volH: 64, gap: 26 };
  let chartGeom = null;
  function visibleDaily() {
    const daily = state.item ? state.item.daily : [];
    if (!daily.length) return { rows: [], sma7: [], sma30: [] };
    const prices = daily.map((d) => d.price);
    const s7 = A.smaTrack(prices, 7), s30 = A.smaTrack(prices, 30);
    const days = RANGES[state.range];
    const cut = days === Infinity ? 0 : Math.max(0, daily.length - days);
    return { rows: daily.slice(cut), sma7: s7.slice(cut), sma30: s30.slice(cut) };
  }
  function drawChart() {
    const cv = $("chart");
    if (!cv) return;
    const { rows, sma7, sma30 } = visibleDaily();
    const wrap = cv.parentElement;
    const W = Math.max(320, wrap.clientWidth);
    const H = 300 + PAD.gap + PAD.volH + PAD.b;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.height = H + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (rows.length < 2) {
      wrap.querySelector(".emptyChart")?.remove();
      const div = document.createElement("div");
      div.className = "emptyChart";
      div.textContent = state.mode === "static"
        ? "The collector records prices every 6 hours — a chart appears after two days of data. The tiles above already read from live sale medians."
        : rows.length === 1
          ? "One snapshot recorded — a chart appears once there are two days of data. History accrues automatically while the tracker runs; use Import/Bootstrap for instant multi-year depth."
          : "No price history yet. Hit ⟳ Snapshot now, or Import/Bootstrap full Steam history.";
      wrap.appendChild(div);
      $("legend").innerHTML = "";
      chartGeom = null;
      return;
    }
    wrap.querySelector(".emptyChart")?.remove();

    const sp = (state.item.skinportDaily || []).filter((d) => d.t >= rows[0].t);
    const plotW = W - PAD.l - PAD.r, priceH = 300 - PAD.t;
    const t0 = rows[0].t, t1 = rows[rows.length - 1].t || t0 + 1;
    const x = (t) => PAD.l + (t1 === t0 ? 0 : (t - t0) / (t1 - t0) * plotW);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      lo = Math.min(lo, rows[i].price); hi = Math.max(hi, rows[i].price);
      if (sma7[i] != null) { lo = Math.min(lo, sma7[i]); hi = Math.max(hi, sma7[i]); }
      if (sma30[i] != null) { lo = Math.min(lo, sma30[i]); hi = Math.max(hi, sma30[i]); }
    }
    for (const d of sp) { lo = Math.min(lo, d.price); hi = Math.max(hi, d.price); }
    const pad = (hi - lo) * 0.07 || hi * 0.05 || 1;
    lo = Math.max(0, lo - pad); hi = hi + pad;
    const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * priceH;

    // grid + y labels (recessive)
    ctx.font = "11px -apple-system, 'Segoe UI', sans-serif";
    ctx.fillStyle = COL.text; ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = lo + (hi - lo) * i / ticks, yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(W - PAD.r, yy); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(v >= 1000 ? "$" + (v / 1000).toFixed(1) + "k" : "$" + v.toFixed(v < 10 ? 2 : 0), PAD.l - 7, yy);
    }
    // x labels
    const spanD = (t1 - t0) / 86400000;
    const nLb = Math.min(6, rows.length);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i < nLb; i++) {
      const r = rows[Math.round(i * (rows.length - 1) / Math.max(1, nLb - 1))];
      const d = new Date(r.t);
      const lb = spanD > 400 ? d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
        : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      ctx.fillText(lb, x(r.t), H - PAD.b + 5);
    }

    // volume pane
    const volTop = 300 + PAD.gap, volMax = Math.max(1, ...rows.map((r) => r.vol || 0));
    const barW = Math.max(1, plotW / rows.length - 2);
    ctx.fillStyle = COL.vol;
    for (const r of rows) {
      if (r.vol == null) continue;
      const bh = Math.max(1, (r.vol / volMax) * PAD.volH);
      ctx.fillRect(x(r.t) - barW / 2, volTop + PAD.volH - bh, barW, bh);
    }
    ctx.fillStyle = COL.text; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("units sold / day", PAD.l, volTop - 14);

    // series lines
    const line = (pts, col, width, dash) => {
      ctx.strokeStyle = col; ctx.lineWidth = width; ctx.setLineDash(dash || []);
      ctx.lineJoin = "round"; ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (p == null) { started = false; continue; }
        if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
        else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    line(rows.map((r, i) => sma30[i] == null ? null : [x(r.t), y(sma30[i])]), COL.sma30, 1.5);
    line(rows.map((r, i) => sma7[i] == null ? null : [x(r.t), y(sma7[i])]), COL.sma7, 1.5);
    line(rows.map((r) => [x(r.t), y(r.price)]), COL.price, 2);
    if (sp.length > 1) line(sp.map((d) => [x(d.t), y(d.price)]), COL.skinport, 1.5, [5, 4]);
    else if (sp.length === 1) {
      ctx.fillStyle = COL.skinport;
      ctx.beginPath(); ctx.arc(x(sp[0].t), y(sp[0].price), 3.5, 0, Math.PI * 2); ctx.fill();
    }

    // crosshair
    if (state.hover >= 0 && state.hover < rows.length) {
      const r = rows[state.hover], xx = Math.round(x(r.t)) + 0.5;
      ctx.strokeStyle = COL.cross; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, volTop + PAD.volH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COL.price;
      ctx.beginPath(); ctx.arc(x(r.t), y(r.price), 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#15161a"; ctx.lineWidth = 2; ctx.stroke();
    }

    chartGeom = { rows, sma7, sma30, sp, x, y, W, H };
    renderLegend(sp.length > 0);
  }
  function renderLegend(hasSp) {
    $("legend").innerHTML =
      DS.legendItem({ swatch: COL.price, label: "Steam price" }) +
      DS.legendItem({ swatch: COL.sma7, label: "SMA 7" }) +
      DS.legendItem({ swatch: COL.sma30, label: "SMA 30" }) +
      (hasSp ? DS.legendItem({ swatch: COL.skinport, label: "Skinport sold (median)" }) : "");
  }

  document.addEventListener("mousemove", (e) => {
    const cv = $("chart");
    if (!cv || !chartGeom) return;
    const rc = cv.getBoundingClientRect();
    const inX = e.clientX >= rc.left && e.clientX <= rc.right;
    const inY = e.clientY >= rc.top && e.clientY <= rc.bottom;
    const tip = $("tooltip");
    if (!inX || !inY) {
      if (state.hover !== -1) { state.hover = -1; tip.style.display = "none"; drawChart(); }
      return;
    }
    const { rows, sma7, sma30, sp, x } = chartGeom;
    const px = e.clientX - rc.left;
    let best = 0, bd = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(x(rows[i].t) - px);
      if (d < bd) { bd = d; best = i; }
    }
    if (best !== state.hover) {
      state.hover = best;
      drawChart();
      const r = rows[best];
      const spRow = sp.find((d) => d.day === r.day);
      tip.innerHTML = '<div class="d">' + r.day + "</div>" +
        tipRow("Steam", fmt$(r.price), COL.price) +
        (sma7[best] != null ? tipRow("SMA 7", fmt$(A.round2(sma7[best])), COL.sma7) : "") +
        (sma30[best] != null ? tipRow("SMA 30", fmt$(A.round2(sma30[best])), COL.sma30) : "") +
        (spRow ? tipRow("Skinport", fmt$(spRow.price), COL.skinport) : "") +
        (r.vol != null ? tipRow("Sold", r.vol, COL.vol) : "");
      tip.style.display = "block";
    }
    const tw = tip.offsetWidth || 160;
    tip.style.left = Math.min(window.innerWidth - tw - 12, e.clientX + 16) + "px";
    tip.style.top = Math.max(8, e.clientY - 10) + "px";
  });
  const tipRow = (lb, v, col) => '<div class="r"><span><span style="background:' + col + ';display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px"></span>' + lb + "</span><b>" + v + "</b></div>";
  window.addEventListener("resize", () => drawChart());
  // home canvases (#idxChart + sparklines) adapt on resize too — debounced,
  // canvas-only redraw (no re-render, so keyboard focus survives) (A1-8)
  let homeRszT = null;
  window.addEventListener("resize", () => {
    clearTimeout(homeRszT);
    homeRszT = setTimeout(redrawHomeCanvases, 150);
  });

  // ── portfolio ────────────────────────────────────────────────────────────
  // Static mode has no server to keep lots on — they live in THIS browser's
  // localStorage, valued against the collector's latest quotes with the same
  // fee math the tracker uses.
  const LOTS_KEY = "skinlab_lots";
  function localLots() { try { return JSON.parse(localStorage.getItem(LOTS_KEY)) || []; } catch (e) { return []; } }
  function saveLocalLots(lots) { localStorage.setItem(LOTS_KEY, JSON.stringify(lots)); }
  function localPortfolioReport() {
    const lots = localLots().map((lot) => {
      const row = state.manifest.items.find((m) => m.name === lot.name);
      const latest = row ? (row.quote ? row.quote.price : row.latest) : null;
      const cost = A.round2(lot.qty * lot.unitCost);
      const netSteam = latest != null ? A.round2(lot.qty * A.netProceeds(latest, "steam")) : null;
      return Object.assign({}, lot, {
        latest, cost,
        gross: latest != null ? A.round2(lot.qty * latest) : null,
        netSteam,
        pl: netSteam != null ? A.round2(netSteam - cost) : null,
        plPct: netSteam != null && cost > 0 ? A.round2((netSteam - cost) / cost * 100) : null,
      });
    });
    const sum = (k) => A.round2(lots.reduce((a, l) => a + (l[k] || 0), 0));
    return { lots, totals: { cost: sum("cost"), gross: sum("gross"), netSteam: sum("netSteam"), pl: sum("pl") } };
  }
  async function loadPortfolio() {
    state.portfolio = state.mode === "static" ? localPortfolioReport() : await api("/api/skins/portfolio");
    renderPortfolio();
  }
  function renderPortfolio() {
    const p = state.portfolio;
    if (!p) return;
    const t = p.totals;
    // benchmark-relative P/L: same money, same holding periods, in the index
    const bench = (() => {
      if (!t.cost || !p.lots.length) return null;
      const entries = p.lots.map((l) => ({ t: l.addedAt, cost: l.cost }));
      const bg = A.benchmarkGrowth(entries, state.market && state.market.series);
      if (bg.factor == null) return null;
      const portPct = Math.round((t.gross - t.cost) / t.cost * 1000) / 10;
      const alpha = Math.round((portPct - bg.idxPct) * 10) / 10;
      return { alpha, portPct, idxPct: bg.idxPct, covered: bg.covered, total: bg.total };
    })();
    $("pfTotals").innerHTML =
      tile("COST BASIS", fmt$(t.cost), "") +
      tile("MARKET VALUE", fmt$(t.gross), "") +
      tile("NET IF SOLD (STEAM)", fmt$(t.netSteam), "") +
      tile("P/L AFTER FEES", fmt$(t.pl) + (t.cost ? " (" + fmtPct(t.pl / t.cost, 1) + ")" : ""), cls(t.pl)) +
      (bench
        ? tile("VS SKINDEX", (bench.alpha > 0 ? "+" : "") + bench.alpha + "pp α", cls(bench.alpha)) +
          '<div class="ds-hint hint" style="grid-column:1/-1">you ' + fmtPct(bench.portPct / 100, 1)
            + " · Skindex " + fmtPct(bench.idxPct / 100, 1) + " over the same money &amp; time"
            + (bench.covered < bench.total ? " · " + bench.covered + "/" + bench.total + " lots dated" : "") + "</div>"
        : "");
    const tb = $("pfTable");
    if (!p.lots.length) { tb.innerHTML = ""; $("pfTotals").insertAdjacentHTML("beforeend", ""); return; }
    tb.innerHTML = "<tr><th>Item</th><th>Qty</th><th>Cost</th><th>Now</th><th>P/L</th><th></th></tr>" +
      p.lots.map((l, i) => "<tr><td class='nm' title='" + esc(l.name) + "'>" + esc(l.name) + "</td>" +
        "<td>" + l.qty + "</td><td>" + fmt$(l.unitCost) + "</td><td>" + fmt$(l.latest) + "</td>" +
        "<td class='chg " + cls(l.pl) + "'>" + fmt$(l.pl) + (l.plPct != null ? "<br><span class='ds-hint hint'>" + fmtPct(l.plPct / 100) + "</span>" : "") + "</td>" +
        "<td><button class='xbtn' data-i='" + i + "' title='Remove lot' aria-label='Remove lot'>✕</button></td></tr>").join("");
    tb.querySelectorAll(".xbtn").forEach((b) => b.addEventListener("click", async () => {
      const idx = Number(b.dataset.i);
      if (state.mode === "static") {
        saveLocalLots(localLots().filter((l) => l.id !== p.lots[idx].id));
        state.portfolio = localPortfolioReport();
      } else {
        state.portfolio = await api("/api/skins/lot", { remove: p.lots[idx].id });
      }
      renderPortfolio();
      // keyboard position survives the removal: next lot's ✕ (same index in
      // the fresh list), else the last one, else back to the lot form (A2-6)
      const btns = $("pfTable").querySelectorAll(".xbtn");
      const next = btns[Math.min(idx, btns.length - 1)];
      (next || $("lotQty")).focus();
    }));
  }
  $("lotForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.selected) return toast("Select an item first", true);
    const qty = Number($("lotQty").value), unitCost = Number($("lotCost").value);
    try {
      if (state.mode === "static") {
        if (!isFinite(qty) || qty <= 0 || !isFinite(unitCost) || unitCost < 0) throw new Error("need qty>0 and cost>=0");
        const lots = localLots();
        lots.push({ id: "l" + Math.random().toString(36).slice(2, 10), name: state.selected, qty, unitCost, addedAt: Date.now() });
        saveLocalLots(lots);
        state.portfolio = localPortfolioReport();
      } else {
        state.portfolio = await api("/api/skins/lot", { name: state.selected, qty, unitCost });
      }
      renderPortfolio();
      $("lotQty").value = ""; $("lotCost").value = "";
      toast("Lot added: " + qty + " × " + state.selected);
    } catch (err) { toast(err.message, true); }
  });

  $("refreshAllBtn").addEventListener("click", async () => {
    if (state.mode === "static") {
      // read-only host — "snapshot now" = manually firing the Actions run
      window.open(ghRunCollectorUrl(), "_blank", "noopener");
      toast("On GitHub: Run workflow → the site refreshes when it commits (~2 min)");
      return;
    }
    toast("Snapshotting whole watchlist…");
    try {
      const r = await api("/api/skins/refresh", {});
      const bad = r.results.filter((x) => !x.ok);
      toast(bad.length ? bad.length + " item(s) failed — Steam rate limits; retry in a minute" : "Snapshots recorded for " + r.results.length + " item(s)", !!bad.length);
      await loadMarket();
      await loadWatch();
      if (state.selected) selectItem(state.selected);
      loadPortfolio();
    } catch (e) { toast(e.message, true); }
  });

  // ── Steam inventory ──────────────────────────────────────────────────────
  // THE DESIGN FINDING: Steam OpenID sign-in is neither used nor needed. A
  // CS2 inventory is PUBLIC JSON — steamcommunity.com/inventory/<id>/730/2
  // answers any browser for a profile whose inventory privacy is Public.
  // OpenID would only prove identity (worthless for a personal analytics
  // tool) and needs a backend callback URL, which a GitHub Pages build does
  // not have. So the whole input is a profile URL / vanity name / SteamID64,
  // and the UI says that in plain English (#invPrivacy).
  //
  // TWO MODES, matching the app's existing ladder:
  //   live   — the tracker resolves + fetches + prices + snapshots server-side
  //            (GET/POST /api/skins/inventory → INV_REPORT).
  //   static — browsers CANNOT fetch steamcommunity.com (no CORS headers), so
  //            the user PASTES the inventory JSON (the same idiom as the
  //            price-history import modal) and the identical maths runs here,
  //            with snapshots in localStorage.
  // PRIVACY, per mode (the panel says this in plain English — renderInvPrivacy
  // writes #invPrivacy from invLive(), because ONE sentence cannot be true in
  // both modes):
  //   static — the SteamID lives in memory only: never written to
  //            localStorage, never sent anywhere but Steam. (This page does
  //            ask its own host for the price history of the skins you own —
  //            that is disclosed in the panel too.)
  //   live   — the SteamID is sent to the tracker you pointed this page at
  //            (which asks Steam) and that tracker persists it under its
  //            gitignored local-data/ — nowhere else.
  // Persisted here: {t, value, count, sig, inv} — value, unit count, the
  // composition signature, and the snapshot's LINE key, which carries a
  // ONE-WAY digest of the SteamID. Never the id itself. The 🧹 Forget control
  // erases all of it (and, in live mode, the tracker's copy).
  const INV_SNAP_KEY = "skinlab_inv_v1";
  const INV_DEDUPE_MS = 600000;  // 10 min — matches the server's snapshot dedupe
  const INV_MAX_SNAPS = 2000;
  const INV_MAX_HISTORY_FETCH = 60; // never loop-fetch an unbounded item list
  const INV_TOP_ROWS = 12;
  const INV_PASTE_MAX_ASSETS = 5000; // the cap the tracker + Steam both use
  // callers MUST hold a real 17-digit id — printing a "YOUR_STEAMID64"
  // placeholder in the one address the user is told to open is a dead end,
  // not an instruction (openInvPaste shows how to FIND the id instead)
  const invUrlFor = (id) => "https://steamcommunity.com/inventory/" +
    id + "/730/2?l=english&count=5000";

  // one-way 32-bit FNV-1a digest — the snapshot SCOPE key (so a SteamID can
  // separate two inventories without ever being stored) and the composition
  // fingerprint. A bucket label, not a security primitive.
  function invDigest(s) {
    let h = 0x811c9dc5;
    s = String(s == null ? "" : s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  // WHICH holdings, at what quantity — the composition signature. Identity
  // alone cannot tell "the market moved" from "I bought a knife"; this can.
  const invSignature = (rows) => invDigest((rows || [])
    .map((r) => r.qty + "@" + r.name).sort().join("||"));
  // The LINE a snapshot belongs to — the same rule the tracker applies to its
  // own series (server.js invSnapKey), except the id is DIGESTED here because
  // the raw SteamID must never reach localStorage: identity when we know it,
  // else the composition (so two people's id-less pastes still don't merge),
  // else the legacy bucket that pre-fix rows live in.
  const invScope = (id, sig) => (id ? "id:" + invDigest(id) : sig ? "sig:" + sig : "");
  // Same basket? The signature when both snapshots carry one (`sig` on both
  // surfaces), else the unit count. An old row that recorded neither is not
  // evidence of a change — never invent a mismatch.
  const invSameBasket = (a, b) => {
    if (!a || !b) return false;
    if (a.sig && b.sig) return a.sig === b.sig;
    if (a.count != null && b.count != null) return a.count === b.count;
    return true;
  };

  // ── snapshots (static mode) — {t, value, count, sig, inv} ─────────────────
  // SCOPED to the inventory they describe: loading a second profile starts its
  // OWN line and never extends yours (a −75% "loss" measured across two
  // different people's inventories is not a return).
  function invSnapsRaw() {
    try {
      const a = JSON.parse(localStorage.getItem(INV_SNAP_KEY));
      return Array.isArray(a) ? a.filter((s) => s && isFinite(s.t) && isFinite(s.value)) : [];
    } catch (e) { return []; }
  }
  function invSnaps(id, sig) {
    const scope = invScope(id, sig);
    return invSnapsRaw().filter((s) => (s.inv || "") === scope).sort((a, b) => a.t - b.t);
  }
  function invAppendSnap(value, count, id, sig) {
    const scope = invScope(id, sig);
    const all = invSnapsRaw();
    // references INTO `all` (filter/sort keep them), so the dedupe below
    // rewrites the stored row in place
    const mine = all.filter((s) => (s.inv || "") === scope).sort((a, b) => a.t - b.t);
    const last = mine[mine.length - 1];
    const now = Date.now();
    if (last && now - last.t < INV_DEDUPE_MS) {
      last.t = now; last.value = value; last.count = count; last.sig = sig;
    } else all.push({ t: now, value: value, count: count, sig: sig, inv: scope });
    try { localStorage.setItem(INV_SNAP_KEY, JSON.stringify(all.slice(-INV_MAX_SNAPS))); } catch (e) { /* quota */ }
    return invSnaps(id, sig);
  }

  // ── paste parsing: Steam's inventory JSON → the frozen item shape ─────────
  // ONE implementation rule (the assembleSeries precedent): the assets ×
  // descriptions join is shared raw→structured assembly, so it belongs to the
  // UMD analytics module that server, collector and browser all run. This
  // wrapper PREFERS `A.parseSteamInventory` and falls back to the inline join
  // below only while a host still serves an analytics.js without it — the two
  // agree by construction (same join key, same fold, same shape), so nothing
  // drifts when the shared one takes over.
  // The CAP is not optional: a paste is unbounded user input and this is the
  // page's main thread. The shared join takes the same 5000 the tracker and
  // Steam both use (and clamps a single asset's `amount`, so "1e9" in a
  // hand-edited paste can never write an absurd value into the series).
  function invParsePaste(raw) {
    const j = invCoerceJson(raw);
    return (A && typeof A.parseSteamInventory === "function")
      ? A.parseSteamInventory(j, null, INV_PASTE_MAX_ASSETS) : invParseInventoryLocal(j);
  }
  // string → object, with the plain-English messages the UI shows. Kept out
  // of the join itself so both implementations get the same input handling.
  function invCoerceJson(raw) {
    let j = raw;
    if (typeof j === "string") {
      const s = j.trim();
      if (!s) throw new Error("Nothing pasted yet — copy the whole inventory page first.");
      try { j = JSON.parse(s); }
      catch (e) { throw new Error("That is not valid JSON — select ALL of the inventory page (Ctrl/⌘+A) and copy it whole."); }
    }
    if (!j || typeof j !== "object") throw new Error("Unexpected format — paste the JSON object Steam serves at that address.");
    if (j.success === false || (j.Error && !j.assets)) {
      throw new Error("Steam refused that inventory — set your inventory privacy to Public and reload the page.");
    }
    return j;
  }
  // assets × descriptions joined on classid_instanceid, one row PER KEY with
  // `amount` summed. Rows are deliberately NOT collapsed by name here: the
  // same skin at different floats/stickers carries different instanceids and
  // its own marketable/tradable flags, so several rows may legitimately share
  // one market_hash_name. Collapsing by name happens one layer up, in
  // inventoryValue — which is why the UI table is built from THOSE rows and
  // never from raw items. An asset whose description is missing is DROPPED,
  // never given an invented name; `count` is total UNITS. Shape:
  // { steamid64, count, items:[{name,qty,marketable,tradable}], truncated }.
  function invParseInventoryLocal(j) {
    const assets = Array.isArray(j.assets) ? j.assets : [];
    const descs = Array.isArray(j.descriptions) ? j.descriptions : [];
    if (!assets.length || !descs.length) {
      throw new Error("No items in that JSON — a private or empty inventory returns no assets.");
    }
    const byClass = new Map();
    for (const d of descs) byClass.set(String(d.classid) + "_" + String(d.instanceid), d);
    const acc = new Map();
    let capped = false;
    for (let ai = 0; ai < assets.length; ai++) {
      // the SAME cap the shared join and the tracker apply — a real cap, not
      // just a flag, so a hand-edited paste can't make this loop unbounded
      if (ai >= INV_PASTE_MAX_ASSETS) { capped = true; break; }
      const a = assets[ai];
      const key = String(a.classid) + "_" + String(a.instanceid);
      const d = byClass.get(key);
      if (!d || !d.market_hash_name) continue;
      // clamped at BOTH ends: "1e9" in a hand-edited paste must never write an
      // absurd value into the append-only series
      const n = Math.round(Number(a.amount));
      const qty = isFinite(n) && n > 0 ? Math.min(n, INV_PASTE_MAX_ASSETS) : 1;
      const cur = acc.get(key);
      if (cur) cur.qty += qty;
      else acc.set(key, { name: d.market_hash_name, qty: qty,
        marketable: !!Number(d.marketable), tradable: !!Number(d.tradable) });
    }
    const items = Array.from(acc.values());
    if (!items.length) throw new Error("Could not match any items — the assets and descriptions in that JSON do not line up.");
    const total = Number(j.total_inventory_count);
    return { steamid64: null, count: items.reduce((s, i) => s + i.qty, 0), items: items,
      truncated: capped || (isFinite(total) && total > assets.length),
      truncatedBy: capped ? "cap" : (isFinite(total) && total > assets.length) ? "short_payload" : null };
  }

  // ── client-side maths (static mode) ──────────────────────────────────────
  // These mirror the frozen analytics contract exactly. When the shared
  // analytics module publishes them (it is the SAME file the server runs) we
  // defer to it, so both surfaces compute from one implementation; the local
  // copies keep static mode self-contained on a host serving an older
  // analytics.js. NEVER fabricate a price or a day: an item we cannot price
  // is reported unpriced, and reconstruction publishes its coverage.
  // Holdings are aggregated BY NAME here (the parse layer keys by
  // classid_instanceid, so a multi-float inventory arrives as several rows of
  // one skin) — one row per market_hash_name is what gets priced and shown.
  // COUNT SEMANTICS: pricedCount / unpricedCount are UNITS, not distinct
  // names, and satisfy pricedCount + unpricedCount === count. The number of
  // distinct skins is rows.length — never conflate the two in a label.
  function invValueLocal(items, priceOf) {
    const byName = new Map();
    for (const it of (items || [])) {
      const cur = byName.get(it.name);
      if (cur) cur.qty += it.qty; else byName.set(it.name, { name: it.name, qty: it.qty });
    }
    const rows = [];
    let total = 0, pricedCount = 0, unpricedCount = 0;
    for (const it of byName.values()) {
      const p = priceOf(it.name);
      if (p == null || !isFinite(p) || p <= 0) {
        unpricedCount += it.qty;
        rows.push({ name: it.name, qty: it.qty, price: null, value: null });
        continue;
      }
      const v = A.round2(it.qty * p);
      total += v; pricedCount += it.qty;
      rows.push({ name: it.name, qty: it.qty, price: p, value: v });
    }
    rows.sort((a, b) => (b.value == null ? -1 : b.value) - (a.value == null ? -1 : a.value));
    return { total: A.round2(total), pricedCount: pricedCount, unpricedCount: unpricedCount, rows: rows };
  }
  // Values TODAY's holdings backwards on each item's OWN history. A day sums
  // only the items that already have a mark on/before it (carry-forward
  // within an item's series, never across items), so an item enters the line
  // when its own history starts — no interpolation, no index-scaled guesses.
  function invReconLocal(items, historyOf, opts) {
    const priceOf = (opts && opts.priceOf) || (() => null);
    // qty folded by name first — history is per market_hash_name, so several
    // instanceid rows of one skin are ONE reconstructed position
    const byName = new Map();
    for (const it of (items || [])) byName.set(it.name, (byName.get(it.name) || 0) + it.qty);
    const held = [], cursor = [], series = [], qtys = [];
    for (const [name, qty] of byName) {
      const h = (historyOf(name) || []).filter((r) => r && r.day && r.price > 0);
      if (!h.length) continue;
      h.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      series.push(h); qtys.push(qty); held.push(null); cursor.push(0);
    }
    const dayset = new Set();
    for (const h of series) for (const r of h) dayset.add(r.day);
    const allDays = Array.from(dayset).sort();
    const days = [];
    for (const day of allDays) {
      let v = 0, any = false;
      for (let i = 0; i < series.length; i++) {
        const h = series[i];
        while (cursor[i] < h.length && h[cursor[i]].day <= day) { held[i] = h[cursor[i]].price; cursor[i]++; }
        if (held[i] != null) { v += qtys[i] * held[i]; any = true; }
      }
      if (any) days.push({ day: day, value: A.round2(v) });
    }
    // coverage = the share of TODAY's value that has usable history (by
    // VALUE, not by count — one grail with no history matters more than ten
    // cheap stacks that have it)
    let covered = 0, total = 0, pricedNames = 0;
    for (const [name, qty] of byName) {
      const p = priceOf(name);
      if (p == null || !isFinite(p) || p <= 0) continue;
      const v = qty * p;
      total += v;
      const h = historyOf(name);
      if (h && h.length) { covered += v; pricedNames++; }
    }
    return { days: days, coveragePct: total > 0 ? Math.round((covered / total) * 1000) / 10 : 0,
      pricedNames: pricedNames, totalNames: byName.size };
  }
  const invValue = (items, priceOf) => (A && typeof A.inventoryValue === "function")
    ? A.inventoryValue(items, priceOf) : invValueLocal(items, priceOf);
  const invRecon = (items, historyOf, opts) => (A && typeof A.inventoryReconstruction === "function")
    ? A.inventoryReconstruction(items, historyOf, opts) : invReconLocal(items, historyOf, opts);

  // ── client-side pricing + history sources ────────────────────────────────
  // Prices come from the same collected quotes the rest of the dashboard
  // uses; anything outside the tracked set is honestly UNPRICED.
  function invPriceMap() {
    const m = new Map();
    for (const w of (state.watch || [])) if (w.latest != null && isFinite(w.latest)) m.set(w.name, w.latest);
    return m;
  }
  // Per-item daily history for the reconstruction. Same DISPLAY-ONLY sources
  // the item chart uses (collected jsonl + paste-import + the backtest deep
  // base) — this never reaches the index, fixings, or the collector.
  // IDEMPOTENCE: the per-load cap must not make the SAME paste answer
  // differently on the second click. Names past the cap are negative-cached
  // (and remembered in invHistSkipped) so a repeat load reads the identical
  // history set — the chart, the coverage and the alpha stop drifting. The
  // returned count is how many of THESE names the cap skipped, so the panel
  // can say so instead of quietly under-covering.
  const invHistCache = new Map();
  const invHistSkipped = new Set();
  async function invLoadHistory(names) {
    const miss = names.filter((n) => !invHistCache.has(n));
    const want = miss.slice(0, INV_MAX_HISTORY_FETCH);
    for (const n of miss.slice(INV_MAX_HISTORY_FETCH)) { invHistCache.set(n, null); invHistSkipped.add(n); }
    await Promise.all(want.map(async (name) => {
      const row = state.manifest && state.manifest.items.find((m) => m.name === name);
      if (!row || !row.slug) { invHistCache.set(name, null); return; }
      const lines = [];
      try {
        const r = await fetchTimeout("data/history/" + row.slug + ".jsonl", 8000, { cache: "no-store" });
        if (r.ok) {
          for (const ln of (await r.text()).split("\n")) {
            if (!ln.trim()) continue;
            try { lines.push(JSON.parse(ln)); } catch (e) { /* torn line */ }
          }
        }
      } catch (e) { /* no history file */ }
      let importRows = null;
      if (row.imported) {
        try {
          const r = await fetchTimeout("data/import/" + row.slug + ".json", 8000, { cache: "no-store" });
          if (r.ok) importRows = (await r.json()).rows;
        } catch (e) { /* missing import */ }
      }
      let deepRows = null;
      try {
        const r = await fetchTimeout("backtest/history/" + row.slug + ".json", 8000, {});
        if (r.ok) {
          const dj = await r.json();
          if (dj && Array.isArray(dj.rows)) deepRows = dj.rows.map((x) => ({ t: x[0], price: x[1], vol: x[2] }));
        }
      } catch (e) { /* no deep history */ }
      const daily = A.assembleSeries(A.deepHistoryBase(deepRows, importRows, lines), lines).daily;
      const out = daily.filter((d) => d.price > 0).map((d) => ({ day: d.day, price: d.price }));
      invHistCache.set(name, out.length ? out : null);
    }));
    return names.filter((n) => invHistSkipped.has(n)).length;
  }

  // "did the inventory beat the Skindex over the same span" — the same
  // benchmarkGrowth the portfolio panel uses, one entry sized to the value
  // at the first reconstructed (or first recorded) day.
  // LIKE-FOR-LIKE alpha — MUST stay identical to the server's invBenchmark
  // (a cross-surface probe check pins live ≈ static). Both legs cover the same
  // window over the same basket: open no earlier than recon.fullFrom (else an
  // item ENTERING the line reads as a gain) nor than index inception (else
  // benchmarkGrowth clamps its own leg and the two legs differ), and truncate
  // the index at the inventory's last day. The snaps fallback requires an
  // UNCHANGED BASKET (composition fingerprint, or the unit count when a
  // snapshot predates it) — a different inventory, or a deposit, is not a
  // return.
  function invBenchmark(recon, snaps) {
    const series = state.market && state.market.series;
    if (!series || !series.length) return null;
    const days = (recon && recon.days) || [];
    const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
    let first = null, last = null;
    if (days.length >= 2) {
      const from = [(recon && recon.fullFrom) || days[0].day, series[0].day].reduce((a, b) => (a > b ? a : b));
      const win = days.filter((d) => d.day >= from);
      if (win.length < 2) return null;
      first = { t: Date.parse(win[0].day + "T00:00:00Z"), v: win[0].value };
      last = { t: Date.parse(win[win.length - 1].day + "T00:00:00Z"), v: win[win.length - 1].value };
    } else if (snaps && snaps.length >= 2 && invSameBasket(snaps[0], snaps[snaps.length - 1])) {
      first = { t: snaps[0].t, v: snaps[0].value };
      last = { t: snaps[snaps.length - 1].t, v: snaps[snaps.length - 1].value };
    }
    if (!first || !last || !(first.v > 0) || !isFinite(first.t)) return null;
    const span = series.filter((s) => s && s.day <= dayOf(last.t));
    if (!span.length) return null;
    const bg = A.benchmarkGrowth([{ t: first.t, cost: first.v }], span);
    if (bg.idxPct == null) return null;
    const invPct = Math.round((last.v / first.v - 1) * 1000) / 10;
    return { idxPct: bg.idxPct, invPct: invPct,
      alpha: Math.round((invPct - bg.idxPct) * 10) / 10,
      spanDays: Math.max(0, Math.round((last.t - first.t) / 86400000)),
      from: dayOf(first.t), to: dayOf(last.t) };
  }

  // Static-mode INV_REPORT: identical shape to the server's, computed here.
  async function invBuildClientReport(parsed, profile) {
    const prices = invPriceMap();
    const priceOf = (n) => (prices.has(n) ? prices.get(n) : null);
    const value = invValue(parsed.items, priceOf);
    const historyCapped = await invLoadHistory(value.rows.filter((r) => r.value != null).map((r) => r.name));
    const historyOf = (n) => invHistCache.get(n) || null;
    const recon = invRecon(parsed.items, historyOf, { priceOf: priceOf });
    // the snapshot line is scoped to THIS inventory (digest of the id, or the
    // composition when there is no id) and stamped with the basket it describes
    const sig = invSignature(value.rows);
    const series = invAppendSnap(value.total, parsed.count, parsed.steamid64, sig);
    return {
      steamid64: parsed.steamid64, profile: profile || "", fetchedAt: Date.now(), cached: false,
      count: parsed.count, value: value, recon: recon, series: series,
      benchmark: invBenchmark(recon, series), historyCapped: historyCapped,
      // three different causes, three different user fixes (the server's note
      // branches the same way) — "Steam truncated it" was wrong for two of them
      note: parsed.truncatedBy === "cap"
        ? "Only the first " + INV_PASTE_MAX_ASSETS + " items in that paste were read — this inventory is truncated."
        : parsed.truncatedBy === "more_items"
          ? "Steam has more pages of this inventory — only the first is included."
          : parsed.truncated
            ? "Steam returned fewer items than it declared — reload the inventory page and copy it again."
            : "",
    };
  }

  // ── render ───────────────────────────────────────────────────────────────
  // Only the RESULT containers re-render; the form controls and both buttons
  // are never rebuilt, so keyboard focus survives a load without any help.
  // The one focusable INSIDE a re-rendered container is the data table's
  // <summary>, so its open state + focus are carried across explicitly.
  // Deliberately NOT the shared pendingFocus: that belongs to the home/item
  // renderers, and an async inventory load landing mid-navigation must never
  // consume (or steal) their pending target.
  let invChartArgs = null;
  const invAxisFmt = (gv) => gv >= 1000 ? "$" + (gv / 1000).toFixed(1) + "k"
    : gv >= 10 ? "$" + gv.toFixed(0) : "$" + gv.toFixed(1);
  function invDataTableHtml(days, snaps) {
    const fam = (days || []).map((d) => ({ day: d.day, v: d.value, mark: false }))
      .concat((snaps || []).map((s) => ({ day: new Date(s.t).toISOString().slice(0, 10), v: s.value, mark: true })));
    // CHRONOLOGICAL, always: this table is the keyboard/screen-reader
    // equivalent of the mouse-only crosshair, and a recorded load predating
    // the reconstruction used to be appended AFTER it (the Map month buckets
    // preserve insertion order, so it also mislabelled the month). Ties put
    // the reconstructed day first and the recorded mark second.
    fam.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.mark ? 1 : -1)));
    if (fam.length < 2) return "";
    let rows = fam, how = "daily";
    if (fam.length > 40) {
      const byMonth = new Map(); // last sample of each month
      for (const p of fam) byMonth.set(p.day.slice(0, 7), p);
      rows = Array.from(byMonth.values());
      how = "month-end";
    }
    if (rows.length > 400) { rows = rows.slice(-400); how = "last 400 " + how + " rows"; }
    const anyMark = rows.some((p) => p.mark);
    return '<details class="dataTable"><summary>Inventory data table (' + how + ", " + rows.length + " rows)</summary>" +
      '<div class="scroll"><table class="dt"><tr><th>Day</th><th>Inventory value</th></tr>' +
      rows.map((p) => "<tr><td>" + esc(p.day) + (p.mark ? "†" : "") + "</td><td>" + fmt$(p.v) + "</td></tr>").join("") +
      "</table></div>" +
      (anyMark ? DS.hint({ text: "† value recorded at an actual load (everything else is today's holdings priced at that day's marks)", cls: "hint" }) : "") +
      "</details>";
  }
  function renderInventory() {
    const rep = state.inv.report;
    const totals = $("invTotals"), tbl = $("invTable"), hint = $("invHint");
    const wrap = $("invChartWrap"), cv = $("invChart");
    renderInvPrivacy();
    // the withdraw control appears whenever something CAN be forgotten: a
    // report on screen, loads recorded in this browser, or a tracker that may
    // be holding a SteamID from an earlier session
    $("invForgetRow").hidden = !(rep || invSnapsRaw().length || invLive());
    $("invPanel").setAttribute("aria-busy", state.inv.busy ? "true" : "false");
    if (!rep) {
      totals.innerHTML = ""; tbl.innerHTML = ""; wrap.hidden = true;
      $("invLegend").innerHTML = ""; $("invChartTable").innerHTML = "";
      invChartArgs = null;
      const n = invSnapsRaw().length;
      // A FAILED first load must say what went wrong and what to do — it used
      // to sit on "Reading your inventory…" forever (invRun's catch rendered
      // while busy was still true, so this error branch was unreachable and
      // the only surface was an 8-second toast).
      hint.innerHTML = state.inv.busy ? DS.hint({ text: "Reading your inventory…", cls: "hint" })
        : state.inv.error
          ? DS.hint({ text: "Couldn't load that inventory: " + state.inv.error, cls: "hint" }) +
            DS.hint({ text: "Nothing was recorded. Fix that and press 📈 Load inventory again, " +
              "or use 📋 Paste JSON to load it from the inventory page yourself.", cls: "hint" })
          : DS.hint({ text: n
              ? n + " earlier load" + (n === 1 ? "" : "s") + " recorded in this browser — load again to chart it."
              : "Load your inventory to value it and chart it against the Skindex.", cls: "hint" });
      return;
    }
    // carry the data table's open state + focus across the re-render
    const oldDt = $("invChartTable").querySelector("details.dataTable");
    const dtOpen = !!(oldDt && oldDt.open);
    const dtFocused = !!(oldDt && document.activeElement && oldDt.contains(document.activeElement));
    const v = rep.value || { total: 0, pricedCount: 0, unpricedCount: 0, rows: [] };
    const recon = rep.recon || { days: [], coveragePct: 0, pricedNames: 0, totalNames: 0 };
    const snaps = rep.series || [];
    const b = rep.benchmark;
    // v.pricedCount / v.unpricedCount are UNIT counts (they sum to the
    // inventory's unit count); v.rows.length is the distinct-skin count
    const names = v.rows.length;
    const units = (v.pricedCount || 0) + (v.unpricedCount || 0);
    // since-first-load: only real recorded loads, never a reconstructed day.
    // A % move is a RETURN only when the basket is unchanged — buying (or
    // loading a different inventory into a legacy, unscoped line) is a
    // deposit, and printing it as a return is a lie.
    const firstSnap = snaps.length ? snaps[0] : null;
    const lastSnap = snaps.length ? snaps[snaps.length - 1] : null;
    const sameBasket = invSameBasket(firstSnap, lastSnap);
    const lastCount = lastSnap && lastSnap.count != null ? lastSnap.count : rep.count;
    const delta = firstSnap && snaps.length >= 2 && firstSnap.value > 0 ? v.total - firstSnap.value : null;
    totals.innerHTML =
      DS.tile({ label: "INVENTORY VALUE", value: fmt$(v.total),
        sub: rep.count + " item" + (rep.count === 1 ? "" : "s") + " · " + names + " distinct name" + (names === 1 ? "" : "s") }) +
      DS.tile({ label: "PRICED", value: v.pricedCount + " / " + units,
        sub: v.unpricedCount
          ? "items priced · " + v.unpricedCount + " not in the tracked set (never guessed)"
          : "items priced — every one has a mark" }) +
      DS.tile({ label: "SINCE FIRST LOAD",
        value: delta == null ? "—" : (delta >= 0 ? "+" : "") + fmt$(delta).replace("$-", "-$"),
        sub: delta == null ? "first load — the line starts here"
          : sameBasket ? fmtPct(delta / firstSnap.value, 1) + " over " + snaps.length + " recorded loads"
            // a SWAP keeps the unit count identical, so only the composition
            // signature can see it — say "different items" rather than "5 → 5"
            : "value change over " + snaps.length + " recorded loads — the holdings changed" +
              (firstSnap.count != null && lastCount != null && firstSnap.count !== lastCount
                ? " (" + firstSnap.count + " → " + lastCount + " items)" : " (different items)") +
              ", so this is not a return",
        tone: delta == null ? null : cls(delta) }) +
      (b ? DS.tile({ label: "VS SKINDEX", value: (b.alpha > 0 ? "+" : "") + b.alpha + "pp α",
        // the window is TRIMMED to where both legs are like-for-like (the
        // basket is whole and the index exists), so say which window it is
        sub: "you " + fmtPct(b.invPct / 100, 1) + " · Skindex " + fmtPct(b.idxPct / 100, 1) +
          " over " + b.spanDays + "d" + (b.from && b.to ? " · " + b.from + " → " + b.to : ""),
        tone: cls(b.alpha) })
        // say which side is missing rather than a bare dash — the alpha needs
        // BOTH a value path for the holdings AND a published index level over
        // the same span, and neither is ever fabricated
        : DS.tile({ label: "VS SKINDEX", value: "—",
          sub: (recon.days || []).length < 2 && snaps.length < 2
            ? "needs price history behind your holdings"
            : "needs a published Skindex level over that span" }));

    // chart: the reconstruction (Mil-Spec blue, solid — the primary series)
    // plus the recorded loads (Restricted violet, dashed overlay). Rarity
    // ramp per DESIGN.md §2; the near-luminance pair is separated by
    // weight + dash, and both colours are read from the token layer.
    const reconPts = (recon.days || []).map((d) => ({ t: Date.parse(d.day + "T00:00:00Z"), v: d.value }))
      .filter((p) => isFinite(p.t) && p.v > 0);
    const snapPts = snaps.map((s) => ({ t: s.t, v: s.value })).filter((p) => isFinite(p.t) && p.v > 0);
    const lines = [];
    if (reconPts.length >= 2) lines.push({ pts: reconPts, col: COL.price, w: 2, name: "Reconstructed value" });
    if (snapPts.length >= 2) lines.push({ pts: snapPts, col: COL.sma30, w: 1.5, dash: [5, 4], name: "Recorded loads" });
    if (lines.length) {
      wrap.hidden = false;
      $("invLegend").innerHTML =
        (reconPts.length >= 2 ? DS.legendItem({ swatch: COL.price, label: "Reconstructed value" }) : "") +
        (snapPts.length >= 2 ? DS.legendItem({ swatch: COL.sma30, label: "Recorded loads" }) : "");
      const all = lines.flatMap((l) => l.pts.map((p) => p.v)).filter((x) => x > 0);
      const useLog = all.length > 1 && Math.max.apply(null, all) / Math.min.apply(null, all) > 6;
      const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
      // describe EVERY plotted series. Naming only the reconstruction reported
      // the wrong end value and a start date up to months late whenever the
      // recorded-loads line was drawn too — and that line is often the one
      // setting the visible x-range and the peak.
      cv.setAttribute("aria-label",
        "Inventory value over time, " + lines.length + " series. " +
        lines.map((l) => l.name + ": " + fmt$(l.pts[0].v) + " on " + dayOf(l.pts[0].t) + " to " +
          fmt$(l.pts[l.pts.length - 1].v) + " on " + dayOf(l.pts[l.pts.length - 1].t) +
          ", " + l.pts.length + " points").join(". ") +
        ". Full figures in the data table below the chart.");
      invChartArgs = { lines: lines, opts: { log: useLog, h: 150, fmt: invAxisFmt } };
      drawIdxChart(cv, lines, invChartArgs.opts);
      $("invChartTable").innerHTML = invDataTableHtml(recon.days, snaps);
    } else {
      wrap.hidden = true; invChartArgs = null;
      $("invLegend").innerHTML = ""; $("invChartTable").innerHTML = "";
    }

    // top holdings — names come from pasted JSON, so every cell is escaped
    // (DS.specTable escapes by default and wraps the table in .ds-scroll-x)
    const top = v.rows.slice(0, INV_TOP_ROWS);
    tbl.innerHTML = top.length
      ? DS.specTable({ head: ["Item", "Qty", "Price", "Value"],
          // FULL market_hash_name (the wear suffix is a different item at a
          // different price — never shorten it away) plus a title, mirroring
          // the market table's td.nm. The trusted html slot is fed nothing but
          // DS.esc output; these names come from pasted JSON.
          rows: top.map((r) => [{ html: '<span title="' + DS.esc(r.name) + '">' + DS.esc(r.name) + "</span>" },
            String(r.qty), r.price == null ? "—" : fmt$(r.price),
            r.value == null ? "unpriced" : fmt$(r.value)]) }) +
        (v.rows.length > top.length
          ? DS.hint({ text: "+ " + (v.rows.length - top.length) + " more name" + (v.rows.length - top.length === 1 ? "" : "s"), cls: "hint" })
          : "")
      : "";

    hint.innerHTML =
      DS.hint({ text: "Reconstruction covers " + recon.coveragePct + "% of current value · " +
        recon.pricedNames + " of " + recon.totalNames + " names have usable price history · " +
        "today's holdings priced at past marks, each name entering the line when its own history starts.",
        cls: "hint" }) +
      (rep.note ? DS.hint({ text: rep.note, cls: "hint" }) : "") +
      // the per-load history cap is now stable across identical loads — say it
      // out loud instead of letting coverage creep up on every repeat paste
      (rep.historyCapped ? DS.hint({ text: "Price history is read for at most " + INV_MAX_HISTORY_FETCH +
        " holdings in this browser — " + rep.historyCapped + " name" + (rep.historyCapped === 1 ? " is" : "s are") +
        " counted as having none. Run the local tracker to chart them all.", cls: "hint" }) : "") +
      (rep.cached ? DS.hint({ text: "Served from the tracker's cache (Steam rate-limits inventory reads).", cls: "hint" }) : "") +
      // a refresh that failed leaves the PREVIOUS report on screen — say so
      // next to it rather than letting stale numbers look fresh
      (state.inv.error ? DS.hint({ text: "Last refresh failed: " + state.inv.error, cls: "hint" }) : "");

    const newDt = $("invChartTable").querySelector("details.dataTable");
    if (newDt && dtOpen) newDt.open = true;
    if (newDt && dtFocused) { const sm = newDt.querySelector("summary"); if (sm) sm.focus(); }
  }
  let invRszT = null;
  window.addEventListener("resize", () => {
    clearTimeout(invRszT);
    invRszT = setTimeout(() => {
      if (invChartArgs && $("invChart") && !$("invChartWrap").hidden) drawIdxChart($("invChart"), invChartArgs.lines, invChartArgs.opts);
    }, 150);
  });

  // ── load paths ───────────────────────────────────────────────────────────
  // A tracker is only usable when one actually answered /health — on a static
  // host (and on the setup panel) there is no server to ask, so the paste
  // flow is the whole story.
  const invLive = () => state.mode === "live" && !!state.health;
  const invSteamId = (s) => { const m = /(7656\d{13})/.exec(String(s || "")); return m ? m[1] : null; };
  // ONE privacy sentence cannot be true in both modes: in live mode the
  // SteamID IS sent (to the tracker the user is running) and IS written to
  // disk there, so "stays in this browser" would be a false promise on the
  // surface the panel is mostly used from. Written per mode, from invLive().
  // Static mode also discloses the one host request the maths needs.
  function renderInvPrivacy() {
    const el = $("invPrivacy");
    if (!el) return;
    el.textContent = invLive()
      ? "No sign-in, no password, no API key — public inventory data only. Your SteamID goes to the " +
        "tracker you connected to (which asks Steam for you) and is stored in that machine's gitignored " +
        "local-data/ folder — never uploaded anywhere else."
      : "No sign-in, no password, no API key — public inventory data only. Your SteamID stays in this " +
        "browser (it is only ever sent to Steam). To chart it, this page asks its own host for the " +
        "recorded price history of the skins you own.";
  }
  async function invRun(fn) {
    if (state.inv.busy) return;
    state.inv.busy = true; state.inv.error = "";
    if (!state.inv.report) renderInventory(); else $("invPanel").setAttribute("aria-busy", "true");
    try {
      const rep = await fn();
      if (!rep || typeof rep !== "object") throw new Error("The tracker returned an unexpected response.");
      state.inv.report = rep;
      renderInventory();
      toast("Inventory loaded: " + (rep.count || 0) + " items, " + fmt$(rep.value && rep.value.total));
    } catch (e) {
      // clear busy BEFORE the render or the panel's status region keeps
      // announcing "Reading your inventory…" for good: the no-report branch
      // tests busy first, so the error text never reached the panel and the
      // 8-second toast was the only surface. (finally stays idempotent.)
      state.inv.busy = false;
      state.inv.error = e.message;
      renderInventory();
      toast(e.message, true);
    } finally {
      state.inv.busy = false;
      $("invPanel").setAttribute("aria-busy", "false");
    }
  }
  // LIVE mode → the tracker's routes (it owns the polite fetch, the ≥10-minute
  // cache and the append-only snapshot log). A tracker that predates the
  // inventory routes answers 404 — say so and offer the paste flow instead.
  async function invLoadLive(body, profile) {
    try {
      return body ? await api("/api/skins/inventory", body)
        : await api("/api/skins/inventory?profile=" + encodeURIComponent(profile));
    } catch (e) {
      if (/HTTP 404/.test(e.message)) {
        throw new Error("This tracker does not serve inventories yet — update it, or use 📋 Paste JSON.");
      }
      throw e;
    }
  }

  // ── paste modal ──────────────────────────────────────────────────────────
  // Same dialog contract as the import modal (A2-4/5/10): the opener is
  // captured INSIDE the open function so any open path restores correctly,
  // ONE close function restores it, Tab wraps while open, Esc is scoped to
  // the open dialog. Exposed on window so probes can drive it directly.
  let invPasteOpener = null;
  function openInvPaste() {
    invPasteOpener = document.activeElement;
    // A static host cannot resolve a vanity name (no CORS to Steam), and the
    // inventory URL needs the 17-digit id. Printing a "YOUR_STEAMID64"
    // placeholder made the one address the user is told to open 404 — for the
    // field's OWN placeholder, no less. So: URL when we have an id, and how
    // to FIND the id when we don't. Pasting stays possible either way.
    const id = invSteamId($("invInput").value);
    $("invPasteUrl").textContent = id ? invUrlFor(id) : "";
    $("invPasteUrl").hidden = !id;
    $("invPasteStep1Lead").hidden = !id;
    $("invPasteIdHelp").hidden = !!id;
    $("invPasteText").value = "";
    $("invPasteErr").textContent = "";
    $("invPasteModal").classList.add("open");
    $("invPasteText").focus();
  }
  function closeInvPaste() {
    if (!$("invPasteModal").classList.contains("open")) return;
    $("invPasteModal").classList.remove("open");
    if (invPasteOpener && invPasteOpener.focus && document.contains(invPasteOpener)) invPasteOpener.focus();
    invPasteOpener = null;
  }
  window.openInvPaste = openInvPaste;
  window.closeInvPaste = closeInvPaste;
  function trapInvPasteTab(e) {
    const dlg = $("invPasteModal").querySelector(".modal");
    const foci = Array.from(dlg.querySelectorAll('a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.disabled && el.getClientRects().length);
    if (!foci.length) return;
    const first = foci[0], last = foci[foci.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey) {
      if (cur === first || !dlg.contains(cur)) { e.preventDefault(); last.focus(); }
    } else if (cur === last || !dlg.contains(cur)) { e.preventDefault(); first.focus(); }
  }
  $("invPasteCancel").addEventListener("click", closeInvPaste);
  $("invPasteModal").addEventListener("click", (e) => { if (e.target === $("invPasteModal")) closeInvPaste(); });
  $("invPasteModal").addEventListener("keydown", (e) => {
    if (!$("invPasteModal").classList.contains("open")) return;
    if (e.key === "Tab") trapInvPasteTab(e);
    else if (e.key === "Escape") { e.stopPropagation(); closeInvPaste(); }
  });
  // fallback for an Esc raised while focus sat outside the open dialog —
  // still guarded on this dialog actually being open (A2-10)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("invPasteModal").classList.contains("open")) closeInvPaste();
  });
  // ── forget (the withdraw control) ────────────────────────────────────────
  // A panel that promises "your SteamID is only stored here" must let the
  // user UNDO that. Live mode erases the tracker's copy (stored id, cached
  // holdings, whole value series) through its own POST route; both modes then
  // clear this browser's snapshots and the rendered report. Destructive, so
  // it confirms first — and it never half-clears: a failed server call leaves
  // the browser's copy alone and says so.
  async function invForget() {
    const live = invLive();
    const localN = invSnapsRaw().length;
    const loads = localN + " recorded load" + (localN === 1 ? "" : "s");
    if (!window.confirm(live
      ? "Forget the stored inventory?\n\nThe tracker deletes your SteamID, the cached holdings and " +
        "every recorded load from its local-data/ folder. This browser's " + loads + " go too.\n\nThis cannot be undone."
      : "Forget the " + loads + " stored in this browser?\n\nThe value line starts over.\n\nThis cannot be undone.")) return;
    let cleared = localN, wiped = false;
    if (live) {
      try {
        const r = await api("/api/skins/inventory/forget", {});
        cleared = r && r.cleared != null ? r.cleared : cleared;
        wiped = true;
      } catch (e) {
        toast(/HTTP 404|HTTP 405/.test(e.message)
          ? "This tracker is too old to erase stored inventories — update it, or delete its local-data/inventory files."
          : e.message, true);
        return; // nothing cleared anywhere — never leave the two copies out of step
      }
    }
    try { localStorage.removeItem(INV_SNAP_KEY); } catch (e) { /* private mode */ }
    state.inv.report = null; state.inv.error = "";
    const wasFocused = document.activeElement === $("invForget") || document.activeElement === document.body;
    renderInventory();
    // in static mode the control RETIRES itself once there is nothing left to
    // forget — never leave the keyboard standing on a hidden button
    if (wasFocused && $("invForgetRow").hidden && $("invInput")) $("invInput").focus();
    toast(wiped
      ? "Forgotten: " + cleared + " recorded load" + (cleared === 1 ? "" : "s") + ", the stored SteamID and the cached holdings are off the tracker and out of this browser."
      : "Forgotten: " + cleared + " recorded load" + (cleared === 1 ? "" : "s") + " erased from this browser.");
  }
  $("invForget").addEventListener("click", invForget);
  $("invPasteBtn").addEventListener("click", openInvPaste);
  // WHICH inventory a paste belongs to. The value line is identity-keyed on
  // both surfaces, so a paste sent with no profile lands in a
  // composition-keyed line instead of the user's real one. What the user
  // typed always wins; only when the field is empty (or still holds the
  // profile this session already resolved) do we attach the resolved
  // SteamID64 the tracker gave us — never someone else's id.
  function invPasteProfile(typed) {
    const rep = state.inv.report;
    const known = rep && rep.steamid64 ? String(rep.steamid64) : "";
    if (invSteamId(typed)) return typed;
    if (known && (!typed || (rep.profile && typed === rep.profile))) return known;
    return typed;
  }
  $("invPasteGo").addEventListener("click", async () => {
    const raw = $("invPasteText").value;
    const typed = $("invInput").value.trim();
    const profile = invPasteProfile(typed);
    let parsed;
    try { parsed = invParsePaste(raw); }
    catch (e) { $("invPasteErr").textContent = e.message; return; }
    parsed.steamid64 = invSteamId(profile);
    // closeInvPaste restores the opener; the containers that re-render hold
    // no form control, so the keyboard simply stays where it landed
    closeInvPaste();
    await invRun(async () => invLive()
      ? await invLoadLive({ paste: raw, profile: profile }, profile)
      : await invBuildClientReport(parsed, profile));
  });

  $("invForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const profile = $("invInput").value.trim();
    if (!profile) { $("invInput").focus(); return toast("Enter a Steam profile URL, vanity name, or SteamID64", true); }
    if (!invLive()) {
      // static host: the browser is not allowed to read steamcommunity.com,
      // so the honest answer is the paste flow with the exact URL prefilled
      return openInvPaste();
    }
    await invRun(async () => await invLoadLive(null, profile));
  });

  // ── boot ─────────────────────────────────────────────────────────────────
  function renderSetup() {
    $("netStatus").textContent = "tracker offline";
    $("itemView").innerHTML =
      '<div class="ds-panel panel"><h2>CONNECT YOUR TRACKER</h2>' +
      '<div class="steps" style="color:var(--text-secondary);font-size:13px">' +
      "<p>This dashboard is a static page — prices are recorded by a tiny local tracker that keeps" +
      " your history and portfolio on <b>your</b> machine (Steam/Skinport block direct browser calls).</p>" +
      "<ol>" +
      "<li>Get the repo (once): <code>git clone https://github.com/blackjakk/skin-market-lab</code></li>" +
      "<li>Start the tracker: <code>cd skin-market-lab &amp;&amp; npm start</code></li>" +
      "<li>Leave it running and hit retry — this page finds it on <code>localhost:8790</code> automatically." +
      " (History accrues while it runs; it also serves this same dashboard at" +
      ' <code>http://localhost:8790</code> if your browser blocks the cross-origin hop.)</li>' +
      "</ol></div>" +
      '<div class="btnrow"><button class="ds-btn primary btn" id="retryBtn">⟳ Retry connection</button>' +
      '<input id="apiAddr" placeholder="Custom tracker address (e.g. http://192.168.1.20:8790)" ' +
      'aria-label="Custom tracker address" style="flex:1;min-width:240px;padding:7px 10px;border-radius:8px;' +
      'border:1px solid var(--line);background:var(--surface-2);color:var(--text-primary)"></div></div>';
    $("retryBtn").addEventListener("click", () => {
      const v = $("apiAddr").value.trim().replace(/\/+$/, "");
      if (v) localStorage.setItem("skinlab_api", v);
      boot();
    });
  }
  // No tracker answered — try the collector's committed data on this host.
  async function tryStatic() {
    try {
      const r = await fetchTimeout("data/index.json", 4000, { cache: "no-store" });
      if (!r.ok) return false;
      const manifest = await r.json();
      if (!manifest || !Array.isArray(manifest.items) || !manifest.items.length) return false;
      state.mode = "static";
      state.manifest = manifest;
      return true;
    } catch (e) { return false; }
  }
  async function bootStatic() {
    $("netStatus").textContent = "data via GitHub · updated " + ago(state.manifest.generatedAt) + " · read-only";
    $("refreshAllBtn").textContent = "⚡ Run collector (GitHub)";
    $("refreshAllBtn").title = "Opens the Actions workflow — Run workflow = snapshot now";
    const hint = $("lotHint");
    if (hint) hint.textContent = "Lots are stored in this browser and valued at the latest collected prices.";
    await loadWatch();
    await loadMarket();
    await loadPortfolio();
    renderHome();
  }
  // The 12-year reconstruction (backtest/result.json, committed + served by
  // Pages AND the live tracker) — home-chart context. Missing file = live
  // chart only, no error: the reconstruction is optional garnish.
  async function loadBacktest() {
    try {
      const r = await fetchTimeout("backtest/result.json", 6000, {});
      if (!r.ok) return;
      const j = await r.json();
      const v = j && j.variants && j.variants.smlx6;
      if (v && v.series && v.series.length >= 2) state.backtest = v.series;
    } catch (e) { /* no reconstruction available */ }
    try {
      const r = await fetchTimeout("backtest/macro.json", 6000, {});
      if (r.ok) {
        const j = await r.json();
        if (j && (j.players || j.btc)) state.macroHist = j;
      }
    } catch (e) { /* no macro history available */ }
    try {
      const r = await fetchTimeout("backtest/corr.json", 6000, {});
      if (r.ok) {
        const j = await r.json();
        if (j && j.corr && j.corr.monthly != null) state.corrStudy = j.corr;
      }
    } catch (e) { /* no correlation study available */ }
    if ((state.backtest || state.macroHist || state.corrStudy) && state.view === "home" && state.market) renderHome();
  }
  async function boot() {
    $("netStatus").textContent = "connecting…";
    renderInventory(); // empty state up front — the panel never boots blank
    loadBacktest(); // fire-and-forget — re-renders home when it lands
    if (!(await resolveApiBase())) {
      if (await tryStatic()) return bootStatic();
      return renderSetup();
    }
    try {
      state.health = await api("/api/skins/health");
      renderInventory(); // the mode is only known now — live privacy copy, live controls
      $("netStatus").textContent = "ready · " + (API ? API.replace(/^https?:\/\//, "") : "local") +
        (state.health.steamCookie ? " · steam cookie set" : "") +
        (state.health.snapHours ? " · auto-snap " + state.health.snapHours + "h" : "");
      await loadWatch();
      await loadMarket();
      await loadPortfolio();
      renderHome();
    } catch (e) {
      renderSetup();
      toast("Tracker connection lost: " + e.message, true);
    }
  }
  $("homeBtn").addEventListener("click", goHome);
  boot();
})();
