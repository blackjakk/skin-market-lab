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
    overlays: { players: true, btc: true } };
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
    { key: "spark", label: "14d", num: false, nosort: true },
    { key: "score", label: "Signal", num: true },
  ];
  function sortedRows() {
    const { key, dir } = state.sort;
    return state.watch.slice().sort((a, b) => {
      const av = a[key], bv = b[key];
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
      tile2("CS2 PLAYERS", t && t.players != null ? fmtCompact(t.players) : "—", "in game right now", "") +
      tile2("CN / US ACTIVITY", t && t.cnus != null ? t.cnus.toFixed(2) : "—",
        t && t.cnus != null ? "Asia-evening ÷ US-evening peak" : "measuring — needs a full day of samples", "") +
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
  // lines: [{pts:[{t,v}], col, w, dash?}] — all rebased to 100 so ONE axis
  // serves every series (never two scales on one chart)
  const IDX_H = 130; // CSS height of #idxChart (matches the height="130" markup)
  function drawIdxChart(cv, lines, opts) {
    if (!cv || !lines.length) return;
    const log = !!(opts && opts.log);
    // Same dpr discipline as drawChart (A1-8): backing = CSS px × dpr,
    // style.width/height pinned so the backing-store write can never feed
    // back into layout (the A1-1 lock) and hiDPI stays crisp.
    const cssW = Math.max(1, cv.parentElement.clientWidth - 8);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(IDX_H * dpr);
    cv.style.width = cssW + "px"; cv.style.height = IDX_H + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, IDX_H);
    const W = cssW, H = IDX_H, L = 40, R = 8, T = 8, B = 16;
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
      ctx.fillText(gv >= 1e6 ? (gv / 1e6).toFixed(1) + "M" : gv >= 1000 ? (gv / 1000).toFixed(1) + "k" : gv.toFixed(1), L - 5, yy);
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
    $("pfTotals").innerHTML =
      tile("COST BASIS", fmt$(t.cost), "") +
      tile("MARKET VALUE", fmt$(t.gross), "") +
      tile("NET IF SOLD (STEAM)", fmt$(t.netSteam), "") +
      tile("P/L AFTER FEES", fmt$(t.pl) + (t.cost ? " (" + fmtPct(t.pl / t.cost, 1) + ")" : ""), cls(t.pl));
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
    loadBacktest(); // fire-and-forget — re-renders home when it lands
    if (!(await resolveApiBase())) {
      if (await tryStatic()) return bootStatic();
      return renderSetup();
    }
    try {
      state.health = await api("/api/skins/health");
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
