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

## Home-hierarchy components

The home page leads with ONE object instead of a strip of equal tiles. These
four factories are that hierarchy — use them on any page with a single
headline number.

### DS.hero — the page's primary object

Big level + delta chip + a lens control, with the chart living INSIDE the card
as its own background (bled to the card edges) and the range chips on the
bottom edge. `eyebrow`/`value`/`delta`/`sub` are escaped; `controls`, `chart`,
`foot` and `after` are TRUSTED slots.

```js
DS.hero({
  labelId: "heroIdxLb", eyebrow: "SKINDEX", value: "100.7",
  delta: "+0.4% 24h", deltaTone: "up",           // "" | "up" | "dn"
  sub: "Steam wallet marks · base 100 at first collection",
  controls: DS.segmented({ … }),                  // TRUSTED
  chart: '<canvas id="idxChart" height="190" role="img" aria-label="…"></canvas>',
  foot: legendHtml + DS.rangeChips({ … }),        // TRUSTED
  after: dataTableHtml,                           // TRUSTED (outside the foot)
})
```

### DS.segmented — one number, N lenses

A LENS switch, not a filter: every option must be the *same* quantity read a
different way (wallet-$ vs cash-adjusted real-$). Different baskets belong in
separate tiles. Real `<button>`s with `aria-pressed`, native Tab + Enter/Space
(no roving tabindex is claimed, so none is owed). `aria-pressed` and `.on` move
together, exactly as in `DS.toggle`.

```js
DS.segmented({ label: "Skindex lens", active: "wallet", dataKey: "lens",
  options: [{ value: "wallet", label: "Wallet $", title: "the published Skindex" },
            { value: "real",   label: "Real $",   title: "through the cash ratio" }] })
```

### DS.tabs / DS.tabPanel / DS.tabsKeyNav — a real ARIA tablist

Splits one long table into readable segments. `DS.tabs` emits `role="tab"`
buttons with `aria-selected`, `aria-controls` and **roving tabindex** (the
whole bar is ONE tab stop). `DS.tabsKeyNav` is the other half of the contract —
←/→ wrap, Home/End jump, each move activates. **Wire both or use neither:** a
tablist without arrow keys is an unfulfilled ARIA promise.

```js
DS.tabs({ label: "Market segment", active: tab, dataKey: "mt",
  idPrefix: "mtab", panelId: "mktTabPanel",
  tabs: [{ value: "all", label: "All", count: 64 }, …] }) +
DS.tabPanel({ id: "mktTabPanel", labelledBy: "mtab-" + tab, body: tableHtml })

DS.tabsKeyNav(root.querySelector('[role="tablist"]'), (el) => { … });
```

`labelledBy` must name the ACTIVE tab so `aria-controls`/`aria-labelledby`
stay a real pair across re-renders.

### DS.statusRail — permanently-visible trust/provenance

READ-ONLY by contract: it emits no focusable control, so it never competes with
the data for attention or for the keyboard. `label`/`value`/`sub` are escaped
(`subHtml` is the TRUSTED alternative); `tone` is `"" | "good" | "bad" | "warn"`.

```js
DS.statusRail({ title: "STATUS", labelId: "homeRailLb", rows: [
  { label: "MARK INTEGRITY", value: "✓ CLEAN", sub: "ratio 12/14 corroborated", tone: "good" },
  { label: "WITNESS", value: "ATTESTED", sub: "SMLX-6 · 3/3 days re-derived", tone: "good" },
] })
```

## Class-only components

No factory needed — apply the class to your own markup:

- `.ds-warmup` — the data-honesty pill (`<span class="ds-warmup">day 12 of 30…</span>`)
- `.ds-chartbox` — chart container (`<div class="ds-chartbox"><canvas></canvas></div>`)
- `.ds-topnav` — doc-page top navigation (`<div class="ds-topnav"><a href="./">←</a></div>`)
- `.ds-legend` / `.ds-sw` — legend row / swatch primitives
- `.ds-range` — the chip-row wrapper `DS.rangeChips` emits
