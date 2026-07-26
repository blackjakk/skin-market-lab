// ─── design-system/ds.js — Skin Market Lab Design System factories ─────────
// HTML-STRING factories (the whole app renders via innerHTML — same idiom).
// UMD, same shape as analytics.js: Node require (the component test) and
// browser global `window.DS`. DOM-only presentation layer, determinism-
// neutral by construction: no Math.random, no Date, no network, no state.
// analytics.js / settlement.js / collect.js / witness.js must NEVER import
// this file (see CONTRACT.md).
//
// ESCAPING CONTRACT: every plain-text field (label, value, sub, text, head
// cells, plain row cells, …) is escaped via DS.esc. Fields named `html`,
// `labelHtml`, `valueHtml`, `subHtml`, `body`, or a specTable cell's
// `{ html }` are TRUSTED raw HTML — the caller owns their safety; never pass
// unescaped external data through a trusted slot.
//
// HANDLERS ARE NOT INLINE: factories emit data-* hooks (`data`, `attrs`);
// consumers bind addEventListener after innerHTML (house style), or use
// DS.keyActivate for the focusable-row pattern.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // cx("ds-tile", tone, cls) → "ds-tile up mine" — joins truthy class parts.
  function cx() {
    const out = [];
    for (let i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
    return out.join(" ");
  }

  // attrs({ id: "x", "data-k": "v", off: null, disabled: true }) →
  //   ' id="x" data-k="v" disabled'
  // null/undefined/false skipped; true renders bare; VALUES escaped. Keys are
  // developer-authored (never external data) and pass through as written.
  function attrs(o) {
    if (!o) return "";
    let s = "";
    for (const k in o) {
      const v = o[k];
      if (v == null || v === false) continue;
      s += v === true ? " " + k : " " + k + '="' + esc(v) + '"';
    }
    return s;
  }

  // dataAttrs({ ov: "btc" }) → ' data-ov="btc"' — sugar used by factories.
  function dataAttrs(d) {
    if (!d) return "";
    let s = "";
    for (const k in d) { if (d[k] != null) s += " data-" + k + '="' + esc(d[k]) + '"'; }
    return s;
  }

  // ── factories ────────────────────────────────────────────────────────────
  // tile({ label, value, sub, tone, cls, attrs, valueHtml, subHtml })
  //   tone: "" | "up" | "dn" | "good" | "bad" (colors the value via ds.css);
  //   "big" rides via cls for the doc-page stat scale.
  //   valueHtml / subHtml: TRUSTED alternatives to value / sub.
  function tile(o) {
    o = o || {};
    return '<div class="' + cx("ds-tile", o.tone, o.cls) + '"' + attrs(o.attrs) + ">" +
      '<div class="ds-tile-lb">' + esc(o.label) + "</div>" +
      '<div class="ds-tile-v">' + (o.valueHtml != null ? o.valueHtml : esc(o.value)) + "</div>" +
      (o.sub != null || o.subHtml != null
        ? '<div class="ds-tile-sub">' + (o.subHtml != null ? o.subHtml : esc(o.sub)) + "</div>" : "") +
      "</div>";
  }

  // tiles(bodyHtml, cls) — grid wrapper for a run of tile()s. bodyHtml is
  // TRUSTED (it is factory output by construction). cls "strip" = home strip.
  function tiles(bodyHtml, cls) {
    return '<div class="' + cx("ds-tiles", cls) + '">' + (bodyHtml || "") + "</div>";
  }

  // chip({ label, labelHtml, cls, attrs, interactive })
  //   interactive: true → a real <button> with cursor/hover/focus affordances
  //   (the moverChip pattern); otherwise an inert <span> pill (catChip/.cash).
  function chip(o) {
    o = o || {};
    const body = o.labelHtml != null ? o.labelHtml : esc(o.label);
    if (o.interactive) {
      return '<button type="button" class="' + cx("ds-chip", "interactive", o.cls) + '"' +
        attrs(o.attrs) + ">" + body + "</button>";
    }
    return '<span class="' + cx("ds-chip", o.cls) + '"' + attrs(o.attrs) + ">" + body + "</span>";
  }

  // toggle({ label, swatch, on, data, cls, attrs }) → <button aria-pressed>
  //   swatch: a CSS color (use a var(--ds-series-*) token) for the .ds-sw
  //   line; data: { ov: "btc" } → data-ov="btc" hook for the consumer's
  //   listener. STATE CONTRACT: aria-pressed and the "on" class move
  //   TOGETHER — ds.css dims the swatch off aria-pressed="false" and lights
  //   the border off either. Flip both in your click handler.
  function toggle(o) {
    o = o || {};
    const on = !!o.on;
    return '<button type="button" class="' + cx("ds-toggle", on && "on", o.cls) +
      '" aria-pressed="' + on + '"' + dataAttrs(o.data) + attrs(o.attrs) + ">" +
      (o.swatch ? '<span class="ds-sw" style="background:' + esc(o.swatch) + '"></span>' : "") +
      esc(o.label) + "</button>";
  }

  // btn({ label, labelHtml, cls, attrs, primary }) — the .ds-btn button.
  //   primary: true = accent CTA; danger / compact / on ride via cls.
  function btn(o) {
    o = o || {};
    return '<button type="button" class="' + cx("ds-btn", o.primary && "primary", o.cls) + '"' +
      attrs(o.attrs) + ">" + (o.labelHtml != null ? o.labelHtml : esc(o.label)) + "</button>";
  }

  // rangeChips({ ranges: ["1Y","5Y","ALL"], active, dataKey, cls }) →
  //   a .ds-range row of compact .ds-btn chips, each carrying
  //   data-<dataKey>="<range>" (dataKey defaults to "r") + aria-pressed;
  //   the active range gets the .on class. Consumer binds click on
  //   [data-<dataKey>] and re-renders with the new active.
  function rangeChips(o) {
    o = o || {};
    const key = o.dataKey || "r";
    return '<span class="' + cx("ds-range", o.cls) + '">' +
      (o.ranges || []).map(function (r) {
        const on = r === o.active;
        return '<button type="button" class="' + cx("ds-btn", "compact", on && "on") +
          '" data-' + key + '="' + esc(r) + '" aria-pressed="' + on + '">' + esc(r) + "</button>";
      }).join("") + "</span>";
  }

  // legendItem({ swatch, label, html, cls }) — one legend entry with a color
  //   swatch. `label` is escaped; `html` is the TRUSTED alternative (links).
  function legendItem(o) {
    o = o || {};
    return '<span class="' + cx("ds-legend-item", o.cls) + '">' +
      (o.swatch ? '<span class="ds-sw" style="background:' + esc(o.swatch) + '"></span>' : "") +
      (o.html != null ? o.html : esc(o.label)) + "</span>";
  }

  // panel({ title, body, cls, attrs }) — the .ds-panel card. `title` is
  //   escaped into a .ds-panel-h heading; `body` is TRUSTED.
  function panel(o) {
    o = o || {};
    return '<div class="' + cx("ds-panel", o.cls) + '"' + attrs(o.attrs) + ">" +
      (o.title != null ? '<h2 class="ds-panel-h">' + esc(o.title) + "</h2>" : "") +
      (o.body || "") + "</div>";
  }

  // hint("text") or hint({ text, html, cls }) — muted helper line. `html` TRUSTED.
  function hint(o) {
    if (typeof o === "string") o = { text: o };
    o = o || {};
    return '<div class="' + cx("ds-hint", o.cls) + '">' +
      (o.html != null ? o.html : esc(o.text)) + "</div>";
  }

  // badge({ label, tone, value, cls, attrs }) — verdict badge.
  //   tone: "good" | "bad" | (default neutral). Inline sigMini scale by
  //   default; cls:"card" upgrades to the boxed sigBadge scale where `value`
  //   renders as the big .ds-badge-v number.
  function badge(o) {
    o = o || {};
    return '<span class="' + cx("ds-badge", o.tone, o.cls) + '"' + attrs(o.attrs) + ">" +
      (o.value != null ? '<span class="ds-badge-v">' + esc(o.value) + "</span>" : "") +
      esc(o.label) + "</span>";
  }

  // specTable({ head: ["A","B"], rows: [["x","y"], [{ html: "<b>t</b>" }, "z"]], cls })
  //   head cells + plain row cells are ESCAPED; a cell object opts out:
  //   { html } is TRUSTED, { text, cls } stays escaped with a td class.
  //   Output is wrapped in a .ds-scroll-x overflow container so wide tables
  //   scroll inside their own box on narrow viewports (never page blowout);
  //   header cells carry scope="col" for AT column association.
  function specTable(o) {
    o = o || {};
    const cell = function (c) {
      if (c != null && typeof c === "object") {
        return '<td class="' + cx(c.cls) + '">' + (c.html != null ? c.html : esc(c.text)) + "</td>";
      }
      return "<td>" + esc(c) + "</td>";
    };
    return '<div class="ds-scroll-x"><table class="' + cx("ds-spec-table", o.cls) + '">' +
      (o.head
        ? "<thead><tr>" + o.head.map(function (h) { return '<th scope="col">' + esc(h) + "</th>"; }).join("") + "</tr></thead>"
        : "") +
      "<tbody>" + (o.rows || []).map(function (r) {
        return "<tr>" + r.map(cell).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
  }

  // keyActivate(rootEl, selector, handler) — binds click + Enter/Space
  //   keyboard activation to every selector match under rootEl (the .mrow
  //   focusable-row pattern: give rows tabindex="0" + role="button").
  //   preventDefault fires on Space (stops page scroll) AND Enter (stops
  //   native double-activation when the target is a real button); the
  //   handler receives (event, el).
  function keyActivate(rootEl, selector, handler) {
    rootEl.querySelectorAll(selector).forEach(function (el) {
      el.addEventListener("click", function (e) { handler(e, el); });
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(e, el); }
      });
    });
  }

  return {
    esc: esc, cx: cx, attrs: attrs,
    tile: tile, tiles: tiles, chip: chip, toggle: toggle, btn: btn,
    rangeChips: rangeChips, legendItem: legendItem, panel: panel, hint: hint,
    badge: badge, specTable: specTable, keyActivate: keyActivate,
  };
});
