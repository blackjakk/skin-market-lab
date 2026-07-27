// ─── design-system/ds.js — Skindex Design System factories ─────────
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

  // hero({ eyebrow, value, delta, deltaTone, sub, controls, chart, foot, after,
  //        labelId, cls, attrs }) — the page's PRIMARY object: one big level,
  //   its delta chip beside it, a lens control top-right, and the chart living
  //   INSIDE the card as its own background (bled to the card edges) with the
  //   range chips on the bottom edge.
  //   eyebrow / value / delta / sub are ESCAPED; controls / chart / foot /
  //   after are TRUSTED slots (factory output by construction).
  //   deltaTone: "" | "up" | "dn".
  function hero(o) {
    o = o || {};
    return '<section class="' + cx("ds-hero", o.cls) + '"' +
      (o.labelId ? ' aria-labelledby="' + esc(o.labelId) + '"' : "") + attrs(o.attrs) + ">" +
      '<div class="ds-hero-top"><div class="ds-hero-id">' +
        '<div class="ds-hero-eyebrow"' + (o.labelId ? ' id="' + esc(o.labelId) + '"' : "") + ">" +
          esc(o.eyebrow) + "</div>" +
        '<div class="ds-hero-valrow"><span class="ds-hero-val">' + esc(o.value) + "</span>" +
          (o.delta != null ? '<span class="' + cx("ds-hero-delta", o.deltaTone) + '">' +
            esc(o.delta) + "</span>" : "") +
        "</div>" +
        (o.sub != null ? '<div class="ds-hero-sub">' + esc(o.sub) + "</div>" : "") +
      "</div>" + (o.controls || "") + "</div>" +
      (o.chart ? '<div class="ds-hero-chart">' + o.chart + "</div>" : "") +
      (o.foot ? '<div class="ds-hero-foot">' + o.foot + "</div>" : "") +
      (o.after || "") + "</section>";
  }

  // segmented({ label, options: [{ value, label, title }], active, dataKey,
  //            cls, attrs }) — a LENS switch: same number, different view.
  //   Emits role="group" + real <button aria-pressed> children carrying
  //   data-<dataKey>="<value>". STATE CONTRACT (as DS.toggle): aria-pressed
  //   and the "on" class move together. Native Tab/Enter/Space operation —
  //   no roving tabindex is claimed, so none is owed. For a control that
  //   swaps a PANEL rather than a value, use DS.tabs instead.
  function segmented(o) {
    o = o || {};
    const key = o.dataKey || "seg";
    return '<div class="' + cx("ds-seg", o.cls) + '" role="group"' +
      (o.label ? ' aria-label="' + esc(o.label) + '"' : "") + attrs(o.attrs) + ">" +
      (o.options || []).map(function (op) {
        const on = op.value === o.active;
        return '<button type="button" class="' + cx("ds-seg-btn", on && "on") +
          '" data-' + key + '="' + esc(op.value) + '" aria-pressed="' + on + '"' +
          (op.title ? ' title="' + esc(op.title) + '"' : "") + ">" + esc(op.label) + "</button>";
      }).join("") + "</div>";
  }

  // tabs({ label, tabs: [{ value, label, count, title }], active, dataKey,
  //       idPrefix, panelId, cls, attrs }) — a real ARIA tablist.
  //   Each tab is a <button role="tab"> with aria-selected, aria-controls and
  //   ROVING TABINDEX (active = 0, rest = −1) so the whole bar is ONE tab
  //   stop. The arrow-key half of the contract is DS.tabsKeyNav — a tablist
  //   without it is an unfulfilled ARIA promise; wire both or use neither.
  //   Pair with DS.tabPanel so aria-controls/aria-labelledby actually resolve.
  function tabs(o) {
    o = o || {};
    const key = o.dataKey || "tab";
    const pre = o.idPrefix || "ds-tab";
    return '<div class="' + cx("ds-tabs", o.cls) + '" role="tablist"' +
      (o.label ? ' aria-label="' + esc(o.label) + '"' : "") + attrs(o.attrs) + ">" +
      (o.tabs || []).map(function (tb) {
        const on = tb.value === o.active;
        return '<button type="button" role="tab" id="' + esc(pre + "-" + tb.value) + '" class="' +
          cx("ds-tab", on && "on") + '" data-' + key + '="' + esc(tb.value) +
          '" aria-selected="' + on + '" tabindex="' + (on ? "0" : "-1") + '"' +
          (o.panelId ? ' aria-controls="' + esc(o.panelId) + '"' : "") +
          (tb.title ? ' title="' + esc(tb.title) + '"' : "") + ">" + esc(tb.label) +
          (tb.count != null ? ' <span class="ds-tab-n">' + esc(tb.count) + "</span>" : "") +
          "</button>";
      }).join("") + "</div>";
  }

  // tabPanel({ id, labelledBy, body, cls, attrs }) — the region a DS.tabs bar
  //   controls. `labelledBy` must be the ACTIVE tab's id (that is what makes
  //   aria-controls/aria-labelledby a real pair). `body` is TRUSTED.
  function tabPanel(o) {
    o = o || {};
    return '<div class="' + cx("ds-tabpanel", o.cls) + '" id="' + esc(o.id) + '" role="tabpanel"' +
      (o.labelledBy ? ' aria-labelledby="' + esc(o.labelledBy) + '"' : "") + attrs(o.attrs) + ">" +
      (o.body || "") + "</div>";
  }

  // tabsKeyNav(tablistEl, onSelect) — the keyboard half of the tablist
  //   contract: ←/→ wrap through the tabs, Home/End jump to the ends, and each
  //   move ACTIVATES (automatic activation, the pattern for cheap panels).
  //   Moves focus itself, then calls onSelect(tabEl) so the consumer reads its
  //   own data-* key and re-renders. Click activation stays the consumer's
  //   (clicks bubble to a delegated listener exactly like the sort headers).
  function tabsKeyNav(listEl, onSelect) {
    if (!listEl) return;
    const items = Array.prototype.slice.call(listEl.querySelectorAll('[role="tab"]'));
    items.forEach(function (el, i) {
      el.addEventListener("keydown", function (e) {
        let j = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % items.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + items.length) % items.length;
        else if (e.key === "Home") j = 0;
        else if (e.key === "End") j = items.length - 1;
        else return;
        e.preventDefault();
        items[j].focus();
        if (onSelect) onSelect(items[j]);
      });
    });
  }

  // statusRail({ title, rows: [{ label, value, sub, subHtml, tone }], labelId,
  //             cls, attrs }) — a permanently-visible trust/provenance column.
  //   READ-ONLY BY CONTRACT: it renders no focusable controls, so it never
  //   competes with the data for attention or for the keyboard.
  //   tone: "" | "good" | "bad" | "warn" (colors the value).
  //   label / value / sub are ESCAPED; `subHtml` is the TRUSTED alternative.
  function statusRail(o) {
    o = o || {};
    return '<section class="' + cx("ds-rail", o.cls) + '"' +
      (o.labelId ? ' aria-labelledby="' + esc(o.labelId) + '"' : "") + attrs(o.attrs) + ">" +
      (o.title != null
        ? '<h2 class="ds-rail-h"' + (o.labelId ? ' id="' + esc(o.labelId) + '"' : "") + ">" +
          esc(o.title) + "</h2>" : "") +
      (o.rows || []).map(function (r) {
        return '<div class="' + cx("ds-rail-row", r.tone) + '">' +
          '<div class="ds-rail-lb">' + esc(r.label) + "</div>" +
          '<div class="ds-rail-v">' + esc(r.value) + "</div>" +
          (r.sub != null || r.subHtml != null
            ? '<div class="ds-rail-sub">' + (r.subHtml != null ? r.subHtml : esc(r.sub)) + "</div>"
            : "") + "</div>";
      }).join("") + "</section>";
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
    hero: hero, segmented: segmented, tabs: tabs, tabPanel: tabPanel,
    tabsKeyNav: tabsKeyNav, statusRail: statusRail,
  };
});
