---
name: design-system-review
description: "Use when reviewing or adding any DOM/UI change in skin-market-lab: verifies the change routes through the Design System (DS.* factories, .ds-* classes, --ds-* tokens), adds no bypass, preserves probe contracts, and stays determinism-neutral."
---

# Design System review — skin-market-lab

Reviewer checklist for ANY diff that touches the DOM/UI surfaces
(`skins.js`, `index.html`, `methodology.html`, `backtest.html`, `skins.css`).
Every item below must hold before the diff ships.

## 0. Read DESIGN.md first

`DESIGN.md` (repo root) is the visual contract: palette (sole action
orange, rarity-ramp data colors), type/spacing/radius scales, elevation
tiers, component rules, do/don't. Any UI diff must conform to it — and a
deliberate visual change must UPDATE it in the same diff (plus the token
and the ds-component-test pins that resolve it, with the WCAG math
re-run). Doc and tokens never drift apart.

## 1. Route through the Design System — never hand-roll

- ALL new chrome goes through `DS.*` factories, `.ds-*` classes, and
  `--ds-*` tokens. Never hand-roll component markup (tiles, chips, buttons,
  panels, badges, hints, legends, swatches), never inline a raw hex/rgb()
  color or a raw font stack.
- Raw palette values live ONLY in the token definition layer (the
  `skins.css` `:root` block / `design-system/` tokens). Consumers reference
  tokens via `var(--ds-*)`.

## 2. Run the guard — and respect the ratchet

- Run `node tools/ds-guard.js` — judge by the BARE exit code, never pipe it
  (a pipe eats the exit status).
- Run `--update-baseline` ONLY after a verified migration LOWERS counts —
  never to admit a bypass. A rising count is a defect in the diff, not a
  baseline to be raised.
- A brand-new UI file must be added to the guard's `CONFIG.files` in the
  same diff that creates it.

## 3. Escaping

- Text goes through `DS.esc` by default.
- `html` / `labelHtml` / `body` are TRUSTED slots — never pass unescaped
  data (user input, fetched item names, server-sourced strings) into them.

## 4. Probe contracts are FROZEN API

Before renaming or removing ANY class, id, or user-visible text, grep
`probe.js` AND `client-probe.js` for the selector. Known probe-contract
surfaces include:

`.mrow`, `#idxChart`, `#chart`, `.idxLegend`, `[data-ir]`, `[data-ov]`,
`aria-pressed`, `.warmup`, `"SOLD*"`, `"day N of 30"`, the `a.btn`
watchlist link, `#backBtn`, `.sigCard`, `table.mkt`, `th.sortable`,
`#netStatus`, `#verifyBtn`, `#budgetOut`, `#integOut`.

Legacy classes ride ALONGSIDE `.ds-*` via the `cls` hook — migrate the
look, keep the hook. A migration must leave every probe selector resolving.

## 5. Determinism-neutral — DS is DOM-only

- The Design System is a DOM presentation layer. `analytics.js`,
  `settlement.js`, `collect.js`, `witness.js`, and `backtest.js` never
  import or depend on it.
- Index/fixings inputs are untouched by any UI diff: no change to series
  assembly, index math, fixing hashes, weights, or integrity lanes may ride
  in a UI change.

## 6. Gates to run for any UI diff

```
node probe.js
node client-probe.js
node tools/ds-component-test.js
node tools/ds-guard.js
```

All four must pass on bare exit code 0.

## 7. No-go list

- No inline event handlers (`onclick="..."` etc.).
- No new raw palette values in `tokens.css` — additive semantic ALIASES
  only; the raw palette is frozen.
- No DS usage in Node-side settlement paths (collector, witness, fixings,
  server settlement code) — the DS must never be a settlement dependency.
