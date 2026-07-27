# Design System CONTRACT — Skindex

The rules every DS consumer and contributor follows. The component test
(`node tools/ds-component-test.js`) is the gate; the gallery
(`design-system/gallery.html`) is the living reference.

## 1. Token-only styling

- `ds.css` styles with `var(--ds-*)` references ONLY — no raw hex, no raw
  `rgb()`. The single deliberate exception: `border: 1px solid` with no color
  on `.ds-badge.card`, which inherits `currentColor` by CSS spec (the legacy
  `.sigBadge` trick).
- `tokens.css` is ADDITIVE: `--ds-*` semantic aliases onto the raw palette in
  `skins.css :root`, plus new spacing (`--ds-space-1..6`), radius
  (`--ds-radius-sm/md/lg/xl/pill`), and type
  (`--ds-fs-cap/lbl/txt/val/val-lg/sec/hero/hero-sm`) scales.
  `--ds-space-6`, `--ds-radius-xl` and `--ds-fs-hero*` are the HERO steps —
  the one deliberately generous surface in the system (DESIGN.md §4); never
  consume them inside a panel, a table or a tile.
  **Never redefine a raw palette value** (`--accent`, `--surface-*`,
  `--status-*`, `--series-*`, …) — hue changes belong in `skins.css` and flow
  through the aliases. The chart palette is dataviz-validated (see repo
  CLAUDE.md); aliasing it is fine, substituting hues is not.
- Load order: `skins.css` → `tokens.css` → `ds.css`. `ds.js` loads before any
  script that calls `DS.*`.

## 2. Escape by default; TRUSTED slots are named

- Every plain-text field (`label`, `value`, `sub`, `text`, head cells, plain
  row cells, attribute values, swatch colors) is escaped via `DS.esc` inside
  the factory. Passing external data (item names, server strings, URL
  fragments) through these fields is always safe.
- Fields named `html`, `labelHtml`, `valueHtml`, `subHtml`, `body`, and a
  `specTable` cell's `{ html }` are **TRUSTED raw HTML**. The caller owns
  their safety: only put factory output or hand-authored markup there —
  never unescaped external data. If a trusted slot must carry data, escape
  the data portion yourself with `DS.esc` before concatenating.

## 3. No inline handlers

- Factories never emit `onclick=`/`on*=` attributes. They emit **data-\***
  hooks (the `data` / `attrs` options); consumers bind with
  `addEventListener` after the `innerHTML` write — the app's house style.
- The focusable-row pattern (rows acting as buttons: `tabindex="0"` +
  `role="button"`) binds through `DS.keyActivate(root, selector, handler)`,
  which wires click + Enter + Space (with `preventDefault`) in one call.
- Toggle state contract: `aria-pressed` and the `.on` class move **together**
  — `ds.css` keys the dimmed swatch off `aria-pressed="false"` and the accent
  border off either. A click handler must flip both (see gallery.html).

## 4. Determinism-neutral, DOM-only

- DS is a presentation layer: no `Math.random`, no `Date`, no network, no
  storage, no module state. It renders strings and binds listeners — nothing
  else.
- **Import boundary:** `analytics.js`, `settlement.js`, `collect.js`, and
  `witness.js` must NEVER import `ds.js` (nor read `tokens.css`/`ds.css`).
  Those files are the shared math/publication layer, pinned bit-exact by
  `probe.js` and re-derived by witnesses — a DOM dependency there is a
  contamination bug even if it "works". DS is consumed only by browser UI
  (`skins.js`, the HTML pages) and by its own component test.

## 5. Legacy and probe-contract classes ride via `cls`

- Every factory takes `cls` (and `attrs`) so existing selectors survive
  migration: probe contracts (e.g. a test that queries `.mrow` or
  `.h2h-link`-style hooks), legacy styling, and JS lookups keep working by
  passing the old class alongside the DS one:
  `DS.btn({ label: "1Y", cls: "compact legacy-range" })`.
- Never restyle a legacy class inside `ds.css` — the DS class carries the
  look; the legacy class is only a hook.

## 6. Adding or changing a component

1. Style in `ds.css` with tokens only; add any new token to `tokens.css`
   (additive — new alias or new scale step, never a palette edit).
2. Factory in `ds.js` following the escaping + no-inline-handler rules above,
   with a comment documenting options and any TRUSTED slot.
3. Demo every state in `gallery.html` (tones, on/off, active, disabled,
   escaped-content where text is interpolated).
4. Cover it in `tools/ds-component-test.js` — render assert + behavior assert
   (state flips, keyboard) + escaping assert if it takes text. The test must
   stay green twice in a row.
5. Docs: one usage example in `README.md`.
