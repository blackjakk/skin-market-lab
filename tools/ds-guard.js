#!/usr/bin/env node
// tools/ds-guard.js — Design System "no-bypass" enforcement ratchet.
//
// Scans the UI surfaces for patterns that BYPASS the design system, counts
// them per file × category, and ratchets against a committed baseline
// (tools/ds-guard-baseline.json): a migration can only LOWER the debt; any
// count that RISES fails the build. Zero dependencies, node-only.
//
// Categories:
//   rawHex     — hex color literals (#fff / #15161a / #rrggbbaa) and
//                rgb()/rgba() with literal channels. var(--x) usages never
//                count (hexes inside a var(...) fallback are skipped; rgba
//                wrapping a var() is skipped). EXCEPTION: in skins.css the
//                :root { ... } block is the token DEFINITION layer and is
//                excluded from the count.
//   fontStack  — font-family declarations whose value is not var(--ds-*)
//                and not inherit.
//   handRolled — literal class="..." / class='...' attributes (JS + HTML)
//                whose class list contains one of the legacy component
//                tokens (CONFIG.handRolledMarkers, EXACT tokens — "btnrow"
//                never matches "btn") WITHOUT any ds-* class alongside.
//                A list carrying both "ds-tile" and the legacy hook "tile"
//                is a MIGRATED component and does not count.
//   inlineStyle— style="..." attributes containing a raw hex color
//                (style attrs using only var() are fine).
//
// design-system/ itself is intentionally NOT in CONFIG.files — it is the
// definition layer the tokens/classes live in; only consumer surfaces are
// ratcheted. New UI files MUST be added to CONFIG.files.
//
// Usage:
//   node tools/ds-guard.js                    ratchet check (exit 0 pass / 1 fail)
//   node tools/ds-guard.js --report           print the file × category table
//   node tools/ds-guard.js --update-baseline  rewrite the baseline from current
//                                             counts (ONLY after a verified
//                                             migration — never to admit a bypass)
//   node tools/ds-guard.js --selftest         detector self-check on a throwaway
//                                             temp copy (never touches the baseline)
//
// Exit codes: 0 = pass, 1 = new bypass (or missing baseline / selftest fail),
// 2 = crash. Judge by the BARE exit code — never pipe it.

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// ───────────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────────
const CONFIG = {
  repoRoot: path.join(__dirname, ".."),
  baselineFile: path.join(__dirname, "ds-guard-baseline.json"),
  // UI surfaces only. Node-side files (server.js, analytics.js, settlement.js,
  // collect.js, witness.js, backtest.js) are NOT scanned — the DS is DOM-only
  // and must never leak into them (see the design-system-review skill).
  files: ["skins.js", "index.html", "methodology.html", "backtest.html", "skins.css"],
  categories: ["rawHex", "fontStack", "handRolled", "inlineStyle"],
  // Per-file category opt-in (default: all). skins.css is a stylesheet —
  // class=/style= attributes don't occur there, so only the color + font
  // categories are meaningful.
  fileCategories: {
    "skins.css": ["rawHex", "fontStack"],
  },
  // Files whose :root { ... } block is the token definition layer (excluded
  // from rawHex).
  rootExcluded: ["skins.css"],
  // Legacy component class tokens. EXACT-token match only.
  handRolledMarkers: [
    "tile", "tile2", "chip", "btn", "hint", "warmup",
    "panel", "badge", "legend", "sw", "spec",
  ],
  maxOffendersShown: 5,
};

// ───────────────────────────────────────────────────────────────────────────
// Span helpers — offsets of regions to EXCLUDE from a detector.
// ───────────────────────────────────────────────────────────────────────────
function inSpans(idx, spans) {
  for (const [a, b] of spans) if (idx >= a && idx < b) return true;
  return false;
}

// All `var( ... )` spans (so a hex living inside a var() fallback never counts).
function varSpans(src) {
  const spans = [];
  const re = /var\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    spans.push([m.index, i]);
  }
  return spans;
}

// Every `:root ... { ... }` block span (brace-matched, defensive vs nesting).
function rootBlockSpans(src) {
  const spans = [];
  const re = /:root\b[^{]*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    spans.push([m.index, i]);
  }
  return spans;
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineOf(starts, idx) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1; // 1-based
}
function excerptAt(src, starts, idx) {
  const ln = lineOf(starts, idx);
  const a = starts[ln - 1];
  const b = src.indexOf("\n", a);
  const text = src.slice(a, b === -1 ? src.length : b).trim();
  return { line: ln, text: text.length > 140 ? text.slice(0, 137) + "..." : text };
}

// ───────────────────────────────────────────────────────────────────────────
// DETECTORS — each returns an array of offenders [{line, text}].
// ───────────────────────────────────────────────────────────────────────────

// Hex literal: 3/4/6/8 hex digits, longest-first, not part of a longer hex run.
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
// rgb()/rgba() functional notation.
const RGB_RE = /\brgba?\(([^)]*)\)/g;

function detectRawHex(src, opts) {
  const skip = (opts && opts.skipSpans) || [];
  const vspans = varSpans(src);
  const starts = lineStarts(src);
  const out = [];
  let m;
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(src)) !== null) {
    if (inSpans(m.index, skip) || inSpans(m.index, vspans)) continue;
    out.push(excerptAt(src, starts, m.index));
  }
  RGB_RE.lastIndex = 0;
  while ((m = RGB_RE.exec(src)) !== null) {
    if (inSpans(m.index, skip)) continue;
    const body = m[1];
    if (/var\s*\(/.test(body)) continue;      // rgba(var(--x-rgb), .5) — token use
    if (!/\d/.test(body)) continue;           // no literal channels
    out.push(excerptAt(src, starts, m.index));
  }
  return out.sort((a, b) => a.line - b.line);
}

// font-family whose value is not var(--ds-*) and not inherit.
const FONT_RE = /font-family\s*:\s*([^;}"'`\n]*)/g;
function detectFontStack(src) {
  const starts = lineStarts(src);
  const out = [];
  let m;
  FONT_RE.lastIndex = 0;
  while ((m = FONT_RE.exec(src)) !== null) {
    const val = (m[1] || "").trim();
    if (/^var\(\s*--ds-/.test(val)) continue;
    if (/^inherit\b/.test(val)) continue;
    out.push(excerptAt(src, starts, m.index));
  }
  return out;
}

// class="..." / class='...' whose token list holds a legacy marker and no ds-*.
// JS-built markup concatenates ('class="btn' + expr + '"'), so the captured
// value can include expression fragments — tokens are split on every
// non-class character ([^A-Za-z0-9_-]) which both cleans those fragments and
// keeps "ds-tile" / "btnrow" intact as single tokens.
const CLASS_RE = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function detectHandRolled(src, markers) {
  const starts = lineStarts(src);
  const out = [];
  let m;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(src)) !== null) {
    const val = m[1] !== undefined ? m[1] : m[2];
    const tokens = val.split(/[^A-Za-z0-9_-]+/).filter(Boolean);
    if (tokens.some((t) => t.startsWith("ds-"))) continue; // migrated component
    if (tokens.some((t) => markers.includes(t))) out.push(excerptAt(src, starts, m.index));
  }
  return out;
}

// style="..." attributes containing a raw hex color (var()-only styles fine).
const STYLE_RE = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function detectInlineStyle(src) {
  const starts = lineStarts(src);
  const out = [];
  let m;
  STYLE_RE.lastIndex = 0;
  while ((m = STYLE_RE.exec(src)) !== null) {
    const val = m[1] !== undefined ? m[1] : m[2];
    HEX_RE.lastIndex = 0;
    if (HEX_RE.test(val)) out.push(excerptAt(src, starts, m.index));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// SCAN
// ───────────────────────────────────────────────────────────────────────────
function scanSource(src, rel) {
  const cats = CONFIG.fileCategories[rel] || CONFIG.categories;
  const on = (c) => cats.includes(c);
  const skipSpans = CONFIG.rootExcluded.includes(rel) ? rootBlockSpans(src) : [];
  return {
    rawHex: on("rawHex") ? detectRawHex(src, { skipSpans }) : [],
    fontStack: on("fontStack") ? detectFontStack(src) : [],
    handRolled: on("handRolled") ? detectHandRolled(src, CONFIG.handRolledMarkers) : [],
    inlineStyle: on("inlineStyle") ? detectInlineStyle(src) : [],
  };
}

function scanAll() {
  const offenders = {}; // rel → cat → [{line,text}]
  const counts = {};    // rel → cat → n
  for (const rel of CONFIG.files) {
    const abs = path.join(CONFIG.repoRoot, rel);
    if (!fs.existsSync(abs)) {
      console.error(`[ds-guard] WARNING: missing file ${rel} (counted as 0)`);
      offenders[rel] = { rawHex: [], fontStack: [], handRolled: [], inlineStyle: [] };
    } else {
      offenders[rel] = scanSource(fs.readFileSync(abs, "utf8"), rel);
    }
    counts[rel] = {};
    for (const c of CONFIG.categories) counts[rel][c] = offenders[rel][c].length;
  }
  return { counts, offenders };
}

// ───────────────────────────────────────────────────────────────────────────
// BASELINE I/O
// ───────────────────────────────────────────────────────────────────────────
function readBaseline() {
  if (!fs.existsSync(CONFIG.baselineFile)) return null;
  return JSON.parse(fs.readFileSync(CONFIG.baselineFile, "utf8")).counts || null;
}

function writeBaseline(counts) {
  const out = {
    _comment:
      "DS no-bypass ratchet baseline (tools/ds-guard.js). Per-file bypass debt; " +
      "the guard fails when any count EXCEEDS these. Lower via migration, then " +
      "lock the gain with `node tools/ds-guard.js --update-baseline`. Never " +
      "raise the baseline to admit a new bypass.",
    generated: new Date().toISOString().slice(0, 10),
    categories: CONFIG.categories,
    handRolledMarkers: CONFIG.handRolledMarkers,
    fileCategories: CONFIG.fileCategories,
    counts,
  };
  fs.writeFileSync(CONFIG.baselineFile, JSON.stringify(out, null, 2) + "\n");
}

// ───────────────────────────────────────────────────────────────────────────
// REPORT
// ───────────────────────────────────────────────────────────────────────────
function printReport(counts, baseline) {
  const cats = CONFIG.categories;
  const fileW = Math.max(18, ...CONFIG.files.map((f) => f.length)) + 2;
  const cell = (s, w) => String(s).padStart(w);
  const width = fileW + cats.length * 13 + 8;
  console.log("\nDS GUARD — bypass debt" + (baseline ? " (Δ vs baseline)" : ""));
  console.log("─".repeat(width));
  let header = "file".padEnd(fileW);
  for (const c of cats) header += cell(c, 13);
  header += cell("TOTAL", 8);
  console.log(header);
  console.log("─".repeat(width));
  const tot = {}; const btot = {};
  cats.forEach((c) => { tot[c] = 0; btot[c] = 0; });
  for (const f of CONFIG.files) {
    let line = f.padEnd(fileW), ftot = 0;
    for (const c of cats) {
      const n = (counts[f] && counts[f][c]) || 0;
      tot[c] += n; ftot += n;
      let s = String(n);
      if (baseline) {
        const b = (baseline[f] && baseline[f][c]) || 0;
        btot[c] += b;
        const d = n - b;
        s = `${n} (${d === 0 ? "·" : d > 0 ? "+" + d : d})`;
      }
      line += cell(s, 13);
    }
    console.log(line + cell(ftot, 8));
  }
  console.log("─".repeat(width));
  let tline = "ALL".padEnd(fileW), grand = 0;
  for (const c of cats) {
    grand += tot[c];
    let s = String(tot[c]);
    if (baseline) {
      const d = tot[c] - btot[c];
      s = `${tot[c]} (${d === 0 ? "·" : d > 0 ? "+" + d : d})`;
    }
    tline += cell(s, 13);
  }
  console.log(tline + cell(grand, 8));
  console.log("─".repeat(width));
}

// ───────────────────────────────────────────────────────────────────────────
// SELFTEST — throwaway temp copies only; asserts the detectors catch injected
// bypasses AND stay quiet on the DS-clean forms. Never touches the baseline.
// ───────────────────────────────────────────────────────────────────────────
function selftest() {
  const baselineBefore = fs.existsSync(CONFIG.baselineFile)
    ? fs.readFileSync(CONFIG.baselineFile, "utf8") : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ds-guard-selftest-"));
  const fails = [];
  const assert = (ok, msg) => { if (!ok) fails.push(msg); };

  try {
    // 1) Injection test on a temp copy of a real config file.
    const realSrc = fs.readFileSync(path.join(CONFIG.repoRoot, "index.html"), "utf8");
    const injected = realSrc + [
      "",
      '<div style="color:#ff0000">bypass: raw hex in a style attr</div>',
      '<div class="tile">bypass: hand-rolled tile</div>',
      '<span style="font-family: Comic Sans MS, cursive">bypass: raw font stack</span>',
      // DS-clean forms — must NOT count:
      '<div class="ds-tile tile">migrated (legacy hook rides alongside ds-*)</div>',
      '<div style="color: var(--ds-accent)">clean var()-only style</div>',
      '<span style="font-family: var(--ds-font-data)">clean token font</span>',
      '<b class="btnrow">no exact-token marker ("btnrow" is not "btn")</b>',
    ].join("\n");
    const tmpFile = path.join(tmp, "injected.html");
    fs.writeFileSync(tmpFile, injected);

    const base = scanSource(realSrc, "index.html");
    const got = scanSource(fs.readFileSync(tmpFile, "utf8"), "index.html");
    const delta = (c) => got[c].length - base[c].length;
    assert(delta("rawHex") === 1, `rawHex delta ${delta("rawHex")} (want 1: #ff0000 only)`);
    assert(delta("inlineStyle") === 1, `inlineStyle delta ${delta("inlineStyle")} (want 1)`);
    assert(delta("handRolled") === 1, `handRolled delta ${delta("handRolled")} (want 1: class="tile" only)`);
    assert(delta("fontStack") === 1, `fontStack delta ${delta("fontStack")} (want 1: raw stack only)`);

    // 2) :root exclusion — token definitions don't count, consumers do.
    const css = ':root {\n  --a: #111111;\n  --b: rgba(1,2,3,.5);\n}\n' +
      '.x { color: #222222; box-shadow: 0 0 4px rgba(0,0,0,.4); }\n' +
      '.y { color: var(--a, #333333); }\n'; // hex inside var() fallback — never counts
    fs.writeFileSync(path.join(tmp, "t.css"), css);
    const cssGot = scanSource(fs.readFileSync(path.join(tmp, "t.css"), "utf8"), "skins.css");
    assert(cssGot.rawHex.length === 2,
      `css rawHex ${cssGot.rawHex.length} (want 2: .x hex + .x rgba; :root + var() fallback excluded)`);
    assert(cssGot.handRolled.length === 0 && cssGot.inlineStyle.length === 0,
      "skins.css must only ratchet rawHex/fontStack");

    // 3) Concatenated JS markup (the skins.js idiom) still detected.
    const js = 'el.innerHTML = \'<button class="btn\' + (on ? " on" : "") + \'">go</button>\';\n' +
      'ok.innerHTML = \'<button class="ds-btn btn">migrated</button>\';\n';
    const jsGot = scanSource(js, "skins.js");
    assert(jsGot.handRolled.length === 1,
      `concat-markup handRolled ${jsGot.handRolled.length} (want 1; migrated ds-btn excluded)`);

    // 4) The baseline file was never touched.
    const baselineAfter = fs.existsSync(CONFIG.baselineFile)
      ? fs.readFileSync(CONFIG.baselineFile, "utf8") : null;
    assert(baselineBefore === baselineAfter, "baseline file changed during selftest");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (fails.length) {
    console.error("[ds-guard] SELFTEST FAIL:");
    for (const f of fails) console.error("  ✗ " + f);
    return 1;
  }
  console.log("[ds-guard] SELFTEST PASS (injection detected, clean forms quiet, :root excluded, baseline untouched)");
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selftest();

  const { counts, offenders } = scanAll();

  if (args.includes("--update-baseline")) {
    writeBaseline(counts);
    console.log(`[ds-guard] baseline written → ${path.relative(CONFIG.repoRoot, CONFIG.baselineFile)}`);
    printReport(counts, null);
    return 0;
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error("[ds-guard] ✗ no baseline (tools/ds-guard-baseline.json missing).");
    console.error("Run `node tools/ds-guard.js --update-baseline` and commit the result.");
    return 1;
  }

  if (args.includes("--report")) printReport(counts, baseline);

  // Ratchet: any count above baseline fails, with the first offending lines.
  const violations = [];
  for (const f of CONFIG.files) {
    for (const c of CONFIG.categories) {
      const cur = (counts[f] && counts[f][c]) || 0;
      const base = (baseline[f] && baseline[f][c]) || 0;
      if (cur > base) violations.push({ f, c, cur, base });
    }
  }
  if (violations.length) {
    console.error("[ds-guard] ✗ NEW DESIGN-SYSTEM BYPASSES (count exceeds baseline):");
    for (const v of violations) {
      console.error(`\n  ${v.f} · ${v.c}: ${v.cur} vs baseline ${v.base} (+${v.cur - v.base})`);
      for (const o of offenders[v.f][v.c].slice(0, CONFIG.maxOffendersShown)) {
        console.error(`      L${o.line}: ${o.text}`);
      }
      if (offenders[v.f][v.c].length > CONFIG.maxOffendersShown) {
        console.error(`      … ${offenders[v.f][v.c].length - CONFIG.maxOffendersShown} more`);
      }
    }
    console.error("\nRoute new UI through DS.* factories / .ds-* classes / --ds-* tokens.");
    console.error("If a verified migration legitimately moved counts, re-lock with");
    console.error("`node tools/ds-guard.js --update-baseline` — never to admit a bypass.");
    return 1;
  }

  // Informational: debt below baseline → the ratchet can be tightened.
  let cur = 0, base = 0;
  for (const f of CONFIG.files) for (const c of CONFIG.categories) {
    cur += (counts[f] && counts[f][c]) || 0;
    base += (baseline[f] && baseline[f][c]) || 0;
  }
  if (cur < base) {
    console.log(`[ds-guard] ✓ no new bypasses — debt ${base} → ${cur}: ratchet can be ` +
      "lowered (run --update-baseline to lock the gain).");
  } else {
    console.log(`[ds-guard] ✓ no new bypasses (debt ${cur} == baseline).`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error("[ds-guard] CRASH:", e && e.stack ? e.stack : e);
  process.exit(2);
}
