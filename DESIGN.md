# DESIGN.md — Skindex

How the product should LOOK. `CLAUDE.md` is how to build; this file is the
visual contract. **Read this before writing any UI** — markup, CSS, canvas
paint, or DS component work. The token layer (`skins.css :root` +
`design-system/tokens.css` aliases) is the single implementation of this
document: if this file and a token disagree, fix one of them in the same
diff — never let them drift.

Lineage: the system's discipline is borrowed from Coinbase's design
language (one sole action color used sparingly, editorial calm over
trading-platform aggression, pill CTAs, monospace numerals, depth from
hairlines and layering rather than shadows) — re-grounded in a CS2
identity: dark smoke surfaces, CS orange as the action color, and the CS2
rarity ramp as the data palette.

## 1. Identity

An institutional research terminal for a game-item market. It should read
like a Bloomberg page that grew up in the CS2 inventory screen: dark,
dense, numeric, calm. Restraint is the brand — one orange, everything else
neutral or data.

## 2. Color

All values are WCAG-validated against the surfaces they actually meet
(ratios noted). Raw hex lives ONLY in the `skins.css :root` block;
everything else consumes tokens (`var(--…)` in CSS, computed-style reads
in canvas code). The a11y probe re-measures the starred floors in CI.

**Surfaces (dark-first; there is no light theme):**

| Token | Value | Use |
|---|---|---|
| `--surface-0` | `#0e0f12` | page canvas |
| `--surface-1` | `#15161a` | panels, chart backgrounds |
| `--surface-2` | `#1c1e24` | raised: tiles, chips, inputs, tooltips |
| `--line` | `#2a2d36` | decorative hairlines only |
| `--line-input` | `#6a6e7a` | input/textarea boundaries (3.55:1 vs panel ★≥3) |

**Action color — CS2 Orange, the ONLY one:**

| Token | Value | Rule |
|---|---|---|
| `--accent` | `#de9b35` | primary buttons (as text/border), active states, links, warm-up chip, focus ring. 7.6:1 on panels, 7.0:1 on tiles (★≥4.5 as text). |

Coinbase reserves its blue; we reserve this orange. It never appears in a
chart series, a status color, or a background fill larger than a chip.
`--ds-focus` aliases it — every `:focus-visible` ring is 2px accent.

**Text:**

| Token | Value | |
|---|---|---|
| `--text-primary` | `#f2f2ef` | headings, values |
| `--text-secondary` | `#b9bbc2` | labels, prose |
| `--text-muted` | `#878a94` | captions, meta (4.83:1 on tiles ★≥4.5) |

**Semantics (never button fills, never mixed into the data ramp):**

| Token | Value | |
|---|---|---|
| `--status-good` | `#3fae6a` | up moves (always paired with a ± sign) |
| `--status-bad` | `#e66767` | down moves |
| `--status-neutral` | `#9aa0a6` | flat |

**Data ramp — the CS2 rarity tiers (charts/series ONLY, ★each ≥3:1 vs
`--surface-1`):**

| Token / const | Value | Rarity | Series |
|---|---|---|---|
| `--series-price` | `#4b69ff` | Mil-Spec | Steam price line, the Skindex (4.1:1) |
| `--series-sma7` | `#199e70` | — (functional) | SMA 7 overlay (5.3:1) |
| `--series-sma30` | `#8847ff` | Restricted | SMA 30 + BTC overlay (3.8:1) |
| `--series-skinport` | `#caab05` | Gold | realized-cash line — real money marks gold (8.0:1) |
| `PLAYERS_COL` | `#d32ce6` | Classified | CS2 players overlay (4.5:1) |
| `RECON_COL` | `rgba(75,105,255,.85)` | Mil-Spec (ghost) | 2014→ reconstruction, dashed (3.3:1 composited) |
| `--vol-bar` | `#636a7a` | — | volume bars (3.3:1 ★≥3) |

Mil-spec and restricted sit close in luminance — they must always differ
in weight/dash (price = solid 2px; SMA/BTC = thin or dashed overlays).
Like Coinbase's "yellow is for the Bitcoin glyph only": rarity colors are
for DATA. Never use them for chrome, buttons, or emphasis text.

## 3. Typography

- **Family:** the system stack (`-apple-system, "Segoe UI", Roboto,
  Helvetica, Arial`) for everything. No webfonts — this is a
  zero-dependency page; identity comes from color and density, not type.
- **Numerals:** every quantitative cell sets
  `font-variant-numeric: tabular-nums` (tables, tiles, prices). Numbers
  align or they're wrong.
- **Scale** (the `--ds-fs-*` tokens — pick a step, never a fresh px):
  `cap 10.5px` (tile labels, captions, uppercase w/ letter-spacing) ·
  `lbl 11.5px` (chips, small labels, data tables) · `txt 12.5px` (rows,
  buttons, cells) · body `14px` · `val 17px` (tile values) ·
  `val-lg 20px` (doc-page stat tiles) · page `h1` 20–22px.
- **Weight discipline:** headings and values sit at 600 — never 800+, no
  display bolding. Labels get their hierarchy from size + letter-spacing
  + muted color, not weight.

## 4. Spacing

Base unit 4px approximated by the `--ds-space-*` scale: `1: 4px`
(chip-row gaps) · `2: 8px` (control gaps, form grids) · `3: 10px` (tile
grids) · `4: 14px` (panel padding, legends) · `5: 20px` (page gutter).
Panels stack with 16px between. Density is the point — this is a
terminal, not a marketing page; do not add editorial whitespace inside
panels.

## 5. Radius

`--ds-radius-sm 6px` (compact chips, chart corners) · `md 8px` (inputs,
tiles, tooltips) · `lg 10px` (panels) · `pill 99px`. **Every CTA is a
pill**: `.ds-btn`, `.ds-toggle`, `.ds-warmup`, mover chips. Sharp corners
(0px) do not exist in the system.

## 6. Elevation

Three tiers, nothing else:
1. **Flat** — most surfaces; separation via surface steps (0→1→2).
2. **Hairline** — `1px var(--line)` dividers and card borders.
3. **Pop** — `--ds-shadow: 0 8px 24px rgba(0,0,0,.5)` for the few things
   that float: tooltips, toasts, modals, the skip-link pill.

Depth comes from surface-on-surface layering, never from stacking shadow
tiers.

## 7. Components (route through `DS.*` — never hand-roll)

- **Buttons** (`DS.btn`): pill, `--surface-2` fill, hairline border,
  12.5px text. Primary = accent text + accent border (never an orange
  fill larger than a chip). Active (`.on`) = accent border. Focus = 2px
  accent ring. Coarse pointers: ≥44px tall (≥32px for `.compact` chips).
- **Range chips / toggles** (`DS.rangeChips`, `DS.toggle`): pills with
  `aria-pressed`; active = accent border + brighter text.
- **Stat tiles** (`DS.tile`): `--surface-2`, radius-md, muted 10.5px
  uppercase label over 17px tabular value.
- **Panels** (`DS.panel`): `--surface-1`, radius-lg, 14px padding, h2 in
  small caps.
- **Tables**: hairline row dividers, tabular numerals, sortable headers
  are real buttons with `aria-sort`; every doc-page table lives in
  `.ds-scroll-x`.
- **Inputs**: `--surface-2` fill, `--line-input` border, radius-md,
  visible `<label for>` (placeholder is never the label).
- **Modal**: `--surface-1`, radius-lg, pop shadow, focus-trapped, Esc
  restores the opener.
- **Toast** (`DS.toast` semantics): `role=status`, flips to `alert` +
  longer dwell when bad.
- **Charts** (canvas): background `--surface-1`, grid `#23252d`, axis
  text = muted token (read from computed style — no hex copies), series
  per the rarity ramp, volume bars `--vol-bar`, crosshair `#6a6e7a`.
  Every chart has a keyboard-reachable `<details>` data table sized to
  the visible range.

## 8. Responsive & touch

Breakpoint 900px: two-column (`330px minmax(0,1fr)`) → single column
(`minmax(0,1fr)`). Grid tracks around tables/canvases are always
`minmax(0,…)`; canvases pin `style.width` and handle dpr. No horizontal
page scroll at any width — scroll lives inside `.scrollX`/`.ds-scroll-x`
wrappers. Coarse pointers get the 44/32px target floors via
`@media (pointer: coarse)` only.

## 9. Do / Don't

**Do**
- Reserve `--accent` orange for actions, links, active states, focus.
- Draw every series from the rarity ramp; differentiate near-luminance
  pairs by weight/dash.
- Set every number in tabular-nums; keep ± signs next to colored deltas.
- Render every CTA as a pill; keep depth to flat/hairline/pop.
- Re-run the WCAG math (`tools/a11y-probe.js` covers the floors) when
  touching any token.

**Don't**
- Introduce a second action color, or use rarity colors for chrome.
- Fill buttons or backgrounds with orange, green, or red.
- Inline a raw hex/font outside the token layer (ds-guard blocks it).
- Add shadow tiers, sharp corners, webfonts, or a light theme.
- Let canvas code hardcode a copy of a token — read computed style.

## 10. Constraints & provenance

- Fixed dark theme by design (`color-scheme: dark`); a light theme is out
  of scope until this file specifies one.
- The DOM/UI layer is determinism-neutral: nothing here may touch
  `analytics.js` / `settlement.js` / collector / witness code paths.
- Frozen probe contracts (see the review skills) override aesthetics —
  a restyle keeps every contract selector and behavior alive.
- Gates for any visual diff: `probe.js`, `client-probe.js`,
  `tools/ds-component-test.js` (pins token resolved values — update pins
  WITH a deliberate palette change), `tools/ds-guard.js`,
  `tools/a11y-probe.js`.
- Rarity hex values follow the CS2 item-quality convention (Mil-Spec
  `#4b69ff`, Restricted `#8847ff`, Classified `#d32ce6`, Gold family) —
  lifted as data-viz colors, validated here against our surfaces.
