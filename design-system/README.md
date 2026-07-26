# Design System — Skindex

HTML-string factories + `.ds-*` classes + `--ds-*` tokens for the dashboard
and doc pages. Rules live in [CONTRACT.md](CONTRACT.md); every component is
demoed live in [gallery.html](gallery.html); the gate is
`node tools/ds-component-test.js`.

**Include order** (browser):

```html
<link rel="stylesheet" href="skins.css">              <!-- raw palette -->
<link rel="stylesheet" href="design-system/tokens.css">
<link rel="stylesheet" href="design-system/ds.css">
<script src="design-system/ds.js"></script>            <!-- window.DS -->
```

Node (the component test): `const DS = require("./design-system/ds.js")` —
same UMD shape as `analytics.js`.

All factories return **HTML strings** (the app's `innerHTML` idiom). Plain
text fields are escaped; `html`/`labelHtml`/`valueHtml`/`subHtml`/`body` and
specTable `{ html }` cells are TRUSTED. Handlers are never inline — bind with
`addEventListener` after the `innerHTML` write, or use `DS.keyActivate`.

## Helpers

```js
DS.esc('<b>&"')                    // "&lt;b&gt;&amp;&quot;" — HTML-escape
DS.cx("ds-tile", tone, extraCls)   // joins truthy class parts
DS.attrs({ id: "x", disabled: true, skip: null })  // ' id="x" disabled'
```

## Factories

### DS.tile — stat tile (label / value / sub)

```js
DS.tile({ label: "SKINDEX", value: "112.4", sub: "+1.2% 24h", tone: "up" })
// tone: "up" | "dn" | "good" | "bad"; cls: "big" = doc-page stat scale
// valueHtml / subHtml = TRUSTED alternatives to value / sub
```

### DS.tiles — grid wrapper for a run of tiles

```js
DS.tiles(DS.tile({...}) + DS.tile({...}), "strip")   // "strip" = home-strip grid
```

### DS.chip — pill (inert span, or interactive button)

```js
DS.chip({ label: "CASE" })                                        // inert
DS.chip({ label: "AK-47 | Redline", interactive: true,
          attrs: { "data-name": name } })                         // <button>
```

### DS.toggle — swatch + label button with aria-pressed

```js
DS.toggle({ label: "BTC", swatch: "var(--ds-series-sma30)",
            on: false, data: { ov: "btc" } })
// click handler must flip aria-pressed AND the "on" class together:
btn.setAttribute("aria-pressed", String(!on)); btn.classList.toggle("on", !on);
```

### DS.btn — button

```js
DS.btn({ label: "✎ Edit tracked items", primary: true })
DS.btn({ label: "✕ Stop tracking", cls: "danger" })     // danger/compact/on via cls
```

### DS.rangeChips — compact range-selector row

```js
DS.rangeChips({ ranges: ["1Y", "5Y", "ALL"], active: "ALL", dataKey: "ir" })
// each chip carries data-ir="1Y|5Y|ALL" + aria-pressed; active gets .on
// consumer: bind click on [data-ir], re-render with the new active
```

### DS.legendItem — legend entry with a color swatch

```js
DS.legendItem({ swatch: "var(--ds-series-price)", label: "Skindex (wallet $)" })
DS.legendItem({ swatch: c, html: 'recon (<a href="backtest.html">backtest</a>)' })  // TRUSTED
```

### DS.panel — card with optional heading

```js
DS.panel({ title: "SETTLEMENT FIXINGS", body: tilesHtml, attrs: { id: "fixings" } })
// title escaped → .ds-panel-h; body TRUSTED
```

### DS.hint — muted helper line

```js
DS.hint("Some items are still warming up.")
DS.hint({ html: 'see <a href="methodology.html">methodology</a>' })   // TRUSTED
```

### DS.badge — verdict badge (sigMini scale; card scale via cls)

```js
DS.badge({ label: "BUY", tone: "good" })                       // inline
DS.badge({ label: "ACCUMULATE", tone: "good", cls: "card", value: "+34" })  // boxed
```

### DS.specTable — doc-page spec table

```js
DS.specTable({
  head: ["Fixing", "Definition", "Min days"],
  rows: [
    ["SETTLE-CASE-7D", "Mean of daily Skindex", "3"],       // escaped
    ["SETTLE-RATIO-30D", { html: "Mean of daily <b>cash ratio</b>" }, "7"],  // trusted cell
  ],
})
```

### DS.keyActivate — click + Enter/Space on focusable rows

```js
// rows: <div class="mrow" tabindex="0" role="button" data-name="…">
DS.keyActivate(rootEl, ".mrow", (e, el) => selectItem(el.dataset.name));
```

## Class-only components

No factory needed — apply the class to your own markup:

- `.ds-warmup` — the data-honesty pill (`<span class="ds-warmup">day 12 of 30…</span>`)
- `.ds-chartbox` — chart container (`<div class="ds-chartbox"><canvas></canvas></div>`)
- `.ds-topnav` — doc-page top navigation (`<div class="ds-topnav"><a href="./">←</a></div>`)
- `.ds-legend` / `.ds-sw` — legend row / swatch primitives
- `.ds-range` — the chip-row wrapper `DS.rangeChips` emits
