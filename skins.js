// skins.js — Skin Market Lab client (vanilla JS, no build).
// Talks to skins/server.js; analytics math is shared via analytics.js
// (window.SkinAnalytics — the exact module the server runs).
"use strict";
(function () {
  const A = window.SkinAnalytics;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // series palette (kept in sync with skins.css — validated for the dark surface)
  const css = getComputedStyle(document.documentElement);
  const COL = {
    price: css.getPropertyValue("--series-price").trim() || "#3987e5",
    sma7: css.getPropertyValue("--series-sma7").trim() || "#199e70",
    sma30: css.getPropertyValue("--series-sma30").trim() || "#d95926",
    skinport: css.getPropertyValue("--series-skinport").trim() || "#9085e9",
    vol: css.getPropertyValue("--vol-bar").trim() || "#4a4e5a",
    grid: "#23252d", text: "#7c7f88", cross: "#5a5e6a",
  };

  // mode: "live"   — a tracker server answers (full read/write)
  //       "static" — no tracker; reading the collector's committed data
  //                  files from this same static host (GitHub Pages)
  const state = { mode: "live", manifest: null, watch: [], market: null, selected: null, item: null,
    portfolio: null, range: "3M", hover: -1, view: "home", sort: { key: "vol24h", dir: -1 } };
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
    el.textContent = msg;
    el.className = bad ? "bad" : "";
    el.style.display = "block";
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.style.display = "none"; }, 3500);
  }

  const fmt$ = (v) => v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (v, dp) => v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(dp == null ? 1 : dp) + "%";
  const cls = (v) => v == null ? "" : v > 0.0005 ? "up" : v < -0.0005 ? "dn" : "";
  const ago = (t) => {
    if (!t) return "never";
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "just now" : m < 60 ? m + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago";
  };

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
    const strip =
      tile2("LAB CASE INDEX", t && t.caseIdx != null ? t.caseIdx.toFixed(1) : "—",
        t && t.idx1 != null ? fmtPct(t.idx1) + " 24h" + (t.idx7 != null ? " · " + fmtPct(t.idx7) + " 7d" : "") : "base 100 at first collection",
        t && t.idx1 != null ? cls(t.idx1) : "") +
      tile2("LIQUIDS INDEX", t && t.liqIdx != null ? t.liqIdx.toFixed(1) : "—", "commodity skins & knives, steam marks", "") +
      tile2("ART INDEX", t && t.artIdx != null ? t.artIdx.toFixed(1) : "—", "grails, marked to 30d realized sales", "") +
      tile2("CASH RATIO", t && t.cashRatio != null ? Math.round(t.cashRatio * 100) + "%" : "—",
        "cash sale vs steam price", "") +
      tile2("UNITS SOLD / DAY", t ? fmtCompact(t.volTotal) : "—", "across tracked items", "") +
      tile2("CS2 PLAYERS", t && t.players != null ? fmtCompact(t.players) : "—", "in game right now", "") +
      tile2("CN / US ACTIVITY", t && t.cnus != null ? t.cnus.toFixed(2) : "—",
        t && t.cnus != null ? "Asia-evening ÷ US-evening peak" : "measuring — needs a full day of samples", "") +
      tile2("VS BITCOIN (30D)", btcCorr.corr != null ? (btcCorr.corr > 0 ? "+" : "") + btcCorr.corr.toFixed(2) : "—",
        (btcCorr.corr != null ? "return correlation" : "measuring: " + btcCorr.n + "/10 days") +
        (t && t.btc != null ? " · BTC $" + fmtCompact(t.btc) : ""), "") +
      tile2("TRACKED", String(state.watch.length), state.mode === "static" && state.manifest ? "updated " + ago(state.manifest.generatedAt) : "live tracker", "");
    $("itemView").innerHTML =
      '<div class="panel"><div class="tiles strip">' + strip + "</div>" +
        (idxPts.length >= 2 ?
          '<div class="idxLegend">' +
            '<span><span class="sw" style="background:' + COL.price + '"></span>Lab Index (wallet $)</span>' +
            '<span><span class="sw" style="background:' + COL.sma7 + '"></span>Cash-adjusted (real $)</span>' +
            (series.some((s) => s.btc != null) ? '<span><span class="sw" style="background:' + COL.sma30 + '"></span>BTC (rebased)</span>' : "") +
            '<span class="hint">gap between the first two = wallet inflation / exit pressure</span>' +
          "</div>" +
          '<canvas id="idxChart" height="130" aria-label="Lab case index, cash-adjusted index and BTC over time" role="img"></canvas>' : "") +
      "</div>" +
      (gain.length || lose.length ?
        '<div class="panel moversRow">' +
          (gain.length ? '<span class="hint">24h gainers</span>' + gain.map(moverChip).join("") : "") +
          (lose.length ? '<span class="hint" style="margin-left:12px">losers</span>' + lose.map(moverChip).join("") : "") +
        "</div>" : "") +
      (state.market && state.market.settlement ? settlementPanel(state.market.settlement) : "") +
      '<div class="panel"><div class="scrollX"><table class="mkt"><thead><tr><th>#</th>' +
        COLS.map((c) => "<th" + (c.nosort ? "" : ' class="sortable' + (state.sort.key === c.key ? " on" : "") + '" data-k="' + c.key + '"') +
          (c.num ? ' style="text-align:right"' : "") + ">" + c.label +
          (state.sort.key === c.key ? (state.sort.dir < 0 ? " ↓" : " ↑") : "") + "</th>").join("") +
      "</tr></thead><tbody>" +
      rows.map((w, i) =>
        '<tr class="mrow" data-i="' + i + '" tabindex="0" aria-label="' + esc(w.name) + '">' +
        "<td>" + (i + 1) + "</td>" +
        '<td class="nm">' + esc(w.name) + ((w.tier || w.cat) ? ' <span class="catChip">' + esc(w.tier === "art" ? "art" : w.cat) + "</span>" : "") + "</td>" +
        '<td class="r">' + fmt$(w.latest) + "</td>" +
        '<td class="r chg ' + cls(w.mom1) + '">' + fmtPct(w.mom1) + "</td>" +
        '<td class="r chg ' + cls(w.mom7) + '">' + fmtPct(w.mom7) + "</td>" +
        '<td class="r chg ' + cls(w.mom30) + '">' + fmtPct(w.mom30) + "</td>" +
        '<td class="r">' + fmtCompact(w.vol24h) + "</td>" +
        '<td><canvas class="spark" width="90" height="26" data-i="' + i + '"></canvas></td>' +
        '<td class="r"><span class="sigMini ' + (w.score >= 12 ? "good" : w.score <= -12 ? "bad" : "") + '">' + esc(w.verdict || "—") + "</span></td>" +
        "</tr>").join("") +
      "</tbody></table></div>" +
      (state.watch.some((w) => w.days < 30)
        ? '<div class="hint" style="margin-top:8px">Some items are still warming up (under 30 days of history) — momentum fills in as the collector accrues data.</div>' : "") +
      "</div>";
    $("itemView").querySelectorAll("th.sortable, th[data-k]").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (!k) return;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === "name" ? 1 : -1) };
      renderHome();
    }));
    $("itemView").querySelectorAll(".mrow").forEach((el) => {
      const go = () => selectItem(rows[Number(el.dataset.i)].name);
      el.addEventListener("click", go);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    $("itemView").querySelectorAll(".moverChip").forEach((b) =>
      b.addEventListener("click", () => selectItem(b.dataset.name)));
    rows.forEach((w, i) => drawSpark($("itemView").querySelector('.spark[data-i="' + i + '"]'), w.spark));
    if (idxPts.length >= 2) {
      const lines = [{ pts: idxPts.map((p) => ({ t: p.t, v: p.caseIdx })), col: COL.price, w: 2 }];
      if (cashPts.length >= 2) lines.push({ pts: cashPts.map((p) => ({ t: p.t, v: p.cashIdx })), col: COL.sma7, w: 1.5 });
      const btcBase = series.find((s) => s.btc != null);
      if (btcBase) {
        const btcPts = series.filter((s) => s.btc != null).map((s) => ({ t: s.t, v: 100 * s.btc / btcBase.btc }));
        if (btcPts.length >= 2) lines.push({ pts: btcPts, col: COL.sma30, w: 1.5, dash: [5, 4] });
      }
      drawIdxChart($("idxChart"), lines);
    }
  }
  function settlementPanel(st) {
    const fx = st.fixings || {};
    const ft = (name, label) => {
      const f = fx[name];
      if (!f) return "";
      return tile2(label, f.value != null ? String(f.value) : "—",
        f.value != null ? "hash " + (f.hash || "").slice(0, 12) + "…" : "accruing — " + (f.accruing || ""), "");
    };
    const b = st.budget && st.budget.caseIndex;
    return '<div class="panel"><h2>SETTLEMENT FIXINGS · ' + esc(st.methodology) + "</h2>" +
      '<div class="tiles">' +
      ft("SETTLE-CASE-7D", "SETTLE-CASE-7D") +
      ft("SETTLE-CASE-30D", "SETTLE-CASE-30D") +
      ft("SETTLE-RATIO-30D", "SETTLE-RATIO-30D") +
      (b ? tile2("MANIP BUDGET (7D FIX)", "$" + fmtCompact(b.costMove1pctFix7d),
        "fee-burn floor to move the 7d fixing 1%", "") : "") +
      "</div>" +
      '<div class="hint">Dated settlement marks, re-derivable bit-exactly from the committed data — ' +
      '<a href="methodology.html">methodology &amp; verification</a>. A measurement, not an offer of any instrument.</div></div>';
  }
  const tile2 = (lb, v, sub, c) =>
    '<div class="tile"><div class="lb">' + lb + '</div><div class="v ' + c + '">' + v + '</div>' +
    (sub ? '<div class="sub2">' + sub + "</div>" : "") + "</div>";
  const moverChip = (w) =>
    '<button class="moverChip" data-name="' + esc(w.name) + '"><span class="nm">' + esc(shortName(w.name)) + '</span> <span class="chg ' + cls(w.mom1) + '">' + fmtPct(w.mom1) + "</span></button>";
  function shortName(n) { return n.replace(/ \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, "").replace("Operation ", ""); }

  function drawSpark(cv, prices) {
    if (!cv) return;
    const pts = (prices || []).filter((p) => p != null);
    if (pts.length < 2) return;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height, pad = 2;
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
  function drawIdxChart(cv, lines) {
    if (!cv || !lines.length) return;
    cv.width = cv.parentElement.clientWidth - 8;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height, L = 40, R = 8, T = 8, B = 16;
    const all = lines.flatMap((l) => l.pts);
    const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t)) || t0 + 1;
    let lo = Math.min(...all.map((p) => p.v)), hi = Math.max(...all.map((p) => p.v));
    const pad = (hi - lo) * 0.1 || 1; lo -= pad; hi += pad;
    const x = (t) => L + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    ctx.font = "10px -apple-system, sans-serif"; ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text; ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const v = lo + (hi - lo) * i / 2, yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(v.toFixed(1), L - 5, yy);
    }
    const d0 = new Date(t0), d1 = new Date(t1);
    const dl = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
    state.selected = null; state.item = null;
    renderHome();
  }

  // ── search ───────────────────────────────────────────────────────────────
  let searchT = null, searchResults = [];
  $("searchBox").addEventListener("input", () => {
    clearTimeout(searchT);
    searchT = setTimeout(runSearch, 180);
  });
  $("searchBox").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearch();
    if (e.key === "Enter" && searchResults.length) { e.preventDefault(); pickResult(0); }
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
      const box = $("searchResults");
      box.innerHTML = searchResults.map((r, i) =>
        '<button class="sr-row" data-i="' + i + '" role="option"><span>' + esc(r.name) + '</span>' +
        '<span class="p">' + (r.watched ? '<span class="w">tracking</span> ' : "") + (r.price != null ? fmt$(r.price) : "") + "</span></button>").join("") ||
        '<div class="sr-row">No matches. Type the exact Steam market name to track anything.</div>';
      box.classList.add("open");
      box.querySelectorAll("button.sr-row").forEach((el) =>
        el.addEventListener("click", () => pickResult(Number(el.dataset.i))));
    } catch (e) { toast("search failed: " + e.message, true); }
  }
  function closeSearch() { $("searchResults").classList.remove("open"); }
  async function pickResult(i) {
    const r = searchResults[i];
    if (!r) return;
    closeSearch();
    $("searchBox").value = "";
    if (state.mode === "static") {
      if (r.watched) return selectItem(r.name);
      // read-only host: tracking an item = adding it to the repo's watchlist
      toast("Add \"" + r.name + "\" to watchlist.json on GitHub — the collector picks it up next run");
      window.open(ghEditWatchlistUrl(), "_blank", "noopener");
      return;
    }
    if (!r.watched) {
      await api("/api/skins/watch", { name: r.name });
      toast("Tracking " + r.name);
      refreshItem(r.name).catch(() => {});
    }
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
    const series = A.assembleSeries(importRows, lines);
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
      analytics, snapshots: lines.length, imported: !!importRows, watched: true, quote,
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
      '<div class="panel">' +
        '<button class="btn backBtn" id="backBtn">← Market</button>' +
        '<div class="itemTitle"><h2>' + esc(it.name) + '</h2>' +
        '<span class="hint">' + (it.quote ? "quote " + ago(it.quote.t) : "no snapshot yet") +
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
        (usedAgg ? '<div class="hint" style="margin:-6px 0 12px">* from Skinport realized-sale medians — an instant read while price history builds</div>' : "") +
        (an.days < 30 ? '<div class="warmup">day ' + an.days + " of 30 — trend signals warm up as history builds" +
          (ro ? " (the collector records every 6 hours)" : "; Import/Bootstrap full Steam history for instant depth") + "</div>" : "") +
        '<div class="sigCard">' +
          '<div class="sigBadge ' + sigCls + '"><span class="sc">' + (sig.score > 0 ? "+" : "") + sig.score + "</span>" + esc(sig.verdict) + "</div>" +
          '<div><ul class="sigReasons">' + sig.reasons.map((r) => "<li>" + esc(r) + "</li>").join("") +
          (sig.reasons.length ? "" : "<li>Not enough history yet — snapshots accrue daily.</li>") + "</ul>" +
          '<div class="sigNote">Heuristic score in [−100, +100] built only from the inputs above — not financial advice.</div></div>' +
        "</div>" +
      "</div>" +
      '<div class="panel">' +
        '<div class="chartHead"><div class="legend" id="legend"></div><div class="ranges" id="ranges">' +
          Object.keys(RANGES).map((r) => '<button class="btn' + (state.range === r ? " on" : "") + '" data-r="' + r + '">' + r + "</button>").join("") +
        "</div></div>" +
        '<div class="chartWrap"><canvas id="chart" role="img" aria-label="Price history chart for ' + esc(it.name) + '"></canvas></div>' +
        dataTableHtml(it) +
      "</div>" +
      '<div class="panel"><h2>WHERE TO SELL — NET PROCEEDS</h2><div class="cmpGrid">' +
        cmpBox("STEAM MARKET", it.compare.steam, "wallet funds only") +
        cmpBox("SKINPORT (REALIZED SALES)", it.compare.skinport, "cash out",
          spSales ? "median of actual sales · " + ((sp.sales.last24h && sp.sales.last24h.volume) || 0) + " sold in 24h" : "no sales data cached yet") +
      "</div></div>" +
      '<div class="panel"><div class="btnrow">' +
        (ro
          ? '<a class="btn primary" target="_blank" rel="noopener" href="' + ghEditWatchlistUrl() + '">✎ Edit tracked items (GitHub)</a>' +
            '<a class="btn" target="_blank" rel="noopener" href="' + ghRunCollectorUrl() + '" title="Actions → Run workflow = snapshot now">⚡ Run collector now</a>'
          : '<button class="btn" id="snapBtn">⟳ Snapshot now</button>' +
            (cookieOn ? '<button class="btn" id="bootBtn" title="Pull full multi-year history from Steam using the configured cookie">⚡ Bootstrap full history</button>' : "") +
            '<button class="btn" id="importBtn">📋 Import history (paste)</button>') +
        '<a class="btn" target="_blank" rel="noopener" href="https://steamcommunity.com/market/listings/730/' + encodeURIComponent(it.name) + '">Steam page ↗</a>' +
        (ro ? "" : '<button class="btn danger" id="unwatchBtn">✕ Stop tracking</button>') +
      "</div></div>";

    $("backBtn").addEventListener("click", goHome);
    $("ranges").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => { state.range = b.dataset.r; renderItem(); }));
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
  }
  const tile = (lb, v, c) => '<div class="tile"><div class="lb">' + lb + '</div><div class="v ' + c + '">' + v + "</div></div>";
  function cmpBox(title, c, cashNote, extra) {
    return '<div class="cmpBox"><h3>' + title + ' <span class="cash">' + cashNote + "</span></h3>" +
      '<div class="row"><span>Sale price</span><b>' + fmt$(c.gross) + "</b></div>" +
      '<div class="row"><span>You receive (after fees)</span><b>' + fmt$(c.net) + "</b></div>" +
      (extra ? '<div class="hint" style="margin-top:4px">' + esc(extra) + "</div>" : "") + "</div>";
  }
  function dataTableHtml(it) {
    const d = it.daily.slice(-30).reverse();
    if (!d.length) return "";
    return '<details class="dataTable"><summary>Data table (last 30 days)</summary><div class="scroll"><table class="dt">' +
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
  function openImport() {
    const name = state.selected;
    $("importSnippet").textContent =
      'copy((await (await fetch("https://steamcommunity.com/market/pricehistory/?appid=730&market_hash_name=" + encodeURIComponent(' +
      JSON.stringify(name) + '))).json()).prices)';
    $("importText").value = "";
    $("importErr").textContent = "";
    $("importModal").classList.add("open");
    $("importText").focus();
  }
  $("importCancel").addEventListener("click", () => $("importModal").classList.remove("open"));
  $("importModal").addEventListener("click", (e) => { if (e.target === $("importModal")) $("importModal").classList.remove("open"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("importModal").classList.remove("open"); });
  $("importGo").addEventListener("click", async () => {
    let rows;
    try { rows = JSON.parse($("importText").value); }
    catch (e) { $("importErr").textContent = "Not valid JSON — paste exactly what the console snippet copied."; return; }
    try {
      const r = await api("/api/skins/import", { name: state.selected, prices: rows });
      $("importModal").classList.remove("open");
      toast("Imported " + r.rows + " rows → " + r.daily + " days of history");
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
      '<span><span class="sw" style="background:' + COL.price + '"></span>Steam price</span>' +
      '<span><span class="sw" style="background:' + COL.sma7 + '"></span>SMA 7</span>' +
      '<span><span class="sw" style="background:' + COL.sma30 + '"></span>SMA 30</span>' +
      (hasSp ? '<span><span class="sw" style="background:' + COL.skinport + '"></span>Skinport sold (median)</span>' : "");
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
  const tipRow = (lb, v, col) => '<div class="r"><span><span class="sw" style="background:' + col + ';display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px"></span>' + lb + "</span><b>" + v + "</b></div>";
  window.addEventListener("resize", () => drawChart());

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
        "<td class='chg " + cls(l.pl) + "'>" + fmt$(l.pl) + (l.plPct != null ? "<br><span class='hint'>" + fmtPct(l.plPct / 100) + "</span>" : "") + "</td>" +
        "<td><button class='xbtn' data-i='" + i + "' title='Remove lot' aria-label='Remove lot'>✕</button></td></tr>").join("");
    tb.querySelectorAll(".xbtn").forEach((b) => b.addEventListener("click", async () => {
      if (state.mode === "static") {
        saveLocalLots(localLots().filter((l) => l.id !== p.lots[Number(b.dataset.i)].id));
        state.portfolio = localPortfolioReport();
      } else {
        state.portfolio = await api("/api/skins/lot", { remove: p.lots[Number(b.dataset.i)].id });
      }
      renderPortfolio();
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
      '<div class="panel"><h2>CONNECT YOUR TRACKER</h2>' +
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
      '<div class="btnrow"><button class="btn primary" id="retryBtn">⟳ Retry connection</button>' +
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
  async function boot() {
    $("netStatus").textContent = "connecting…";
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
