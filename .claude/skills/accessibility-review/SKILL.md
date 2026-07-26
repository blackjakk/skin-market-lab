---
name: accessibility-review
description: "Use when reviewing or adding any UI/DOM change in skin-market-lab: verifies keyboard operability, visible focus, focus management across re-renders, contrast tokens, responsive behavior at phone/tablet/zoom, touch targets, and ARIA semantics — and that the a11y probe still passes."
---

# Accessibility review — skin-market-lab

Reviewer checklist for ANY diff that touches the UI surfaces (`skins.js`,
`index.html`, `methodology.html`, `backtest.html`, `skins.css`,
`design-system/`). Companion to the `design-system-review` skill (run both
for UI diffs). Background + measured baselines: `A11Y.md`.

## 1. Keyboard operability — everything clickable is keyable

- Every new interactive element is a real `<button>`/`<a>` (or carries
  `tabindex="0"` + Enter/Space activation with `preventDefault` on Space).
  Click-only `<div>`/`<th>`/`<tr>` handlers are defects — the sort-header
  pattern is `<button class="thbtn">` INSIDE the cell (clicks bubble to the
  legacy th listener; native key activation for free).
- Esc handlers are SCOPED: guard on the thing actually being open and
  `stopPropagation()` when consumed. Never add an unconditional
  document-level Esc.
- Walk the new flow with Tab/Shift+Tab/Enter/Space/Esc in a real browser
  before shipping. If you can't complete it keyboard-only, it isn't done.

## 2. Focus management — never strand the user on `<body>`

- Any handler that triggers an innerHTML re-render MUST restore focus:
  set `pendingFocus` (selector or `() => element` — NOT a `"#id"` string
  containing hex-like chars; ds-guard lexes `"#backBtn"` as a color) before
  the render; `renderHome`/`renderItem` apply it.
- View transitions: entering the item view focuses `#backBtn`; returning
  home focuses the originating row, falling back to `#searchBox`.
- Modals: capture the opener INSIDE the open function (open-path-agnostic),
  restore it from one shared close function that ALL close paths route
  through; Tab wraps inside while open. Keep `window.openImport`/
  `window.closeImport` exposed — the a11y probe drives them.

## 3. Visible focus — hover is not focus

- Never reuse a hover style as the `:focus-visible` style and never
  `outline:none` without a replacement ring. The house ring is
  `outline: 2px solid var(--ds-focus)` (offset −2px inside table rows /
  list options so containers don't clip it).
- New DS components inherit the ring from ds.css; hand-rolled focusables
  (there shouldn't be any — see design-system-review) need the rule added
  explicitly.

## 4. Contrast — the tokens are load-bearing measured values

- `--text-muted #878a94`, `--line-input #6a6e7a`, `--vol-bar #636a7a` were
  chosen by WCAG math against their real backings (4.83 / 3.55 / 3.33).
  Don't darken them; don't put muted text on anything darker than
  `--surface-2` without re-measuring ≥4.5 (≥3 for non-text).
- Canvas paint reads tokens (`COL.text` ← `--text-muted`); never hardcode a
  copy of a token in JS — read it from computed style with the token's
  value as the fallback.
- New input/textarea borders use `--line-input` (decorative hairlines keep
  `--line`); placeholders inherit the `::placeholder` rule (muted token).

## 5. Responsive — the traps that actually bit

- Grid tracks holding content-sized things (tables, canvases) must be
  `minmax(0,1fr)`, never bare `1fr` — `minmax(auto,1fr)` lets min-content
  dictate page width (the 873px mobile lock).
- Any canvas whose backing store is set from JS must ALSO pin
  `cv.style.width/height` (and use dpr like `drawChart`), or the backing
  write becomes layout input.
- Every table on a doc page lives inside `.ds-scroll-x` (DS.specTable does
  this; hand-written tables get the wrapper manually).
- Check new layouts at 390×844 (touch), 768×1024, ~1000px desktop, and
  200% zoom: `document.scrollingElement.scrollWidth` must equal
  `innerWidth`. Horizontal page scroll is a defect; scroll belongs inside
  wrappers.
- Touch targets: interactive controls ≥24px ALWAYS; under
  `@media (pointer: coarse)` ≥32px (chips) / ≥44px (buttons/toggles). Put
  the bump in the coarse-pointer block, not the desktop styles.

## 6. Semantics

- Canvases: `role="img"` + descriptive `aria-label`, or `aria-hidden="true"`
  if decorative-redundant (sparks). Charts need a text equivalent sized to
  what the chart shows (the `<details>` data-table pattern, range-aware).
- Status surfaces that change (`#netStatus`, `#verifyOut`) are
  `role="status"`; error slots are `role="alert"`; `toast(msg, bad)`
  already flips role per severity — reuse it, don't hand-roll toasts.
- Form fields: visible `<label for>` (placeholder is not a label); the
  visible label IS the accessible name (label-in-name — don't add a
  differently-worded aria-label on top).
- Toggles/chips expose state (`aria-pressed` via DS factories; `aria-sort`
  on the active sort th only). Landmarks: every page keeps `<nav>` +
  `<main>`; the skip link stays the first tab stop.
- Search composite: `aria-expanded` mirrors the dropdown, `aria-selected`
  follows the focused option, Esc closes from anywhere inside, stale
  results are cleared on close. Don't add ARIA roles that promise behavior
  you didn't implement.

## 7. Frozen contracts — a11y edition

`.mrow` keeps `tabindex="0"` on EVERY row (roving tabindex is deliberately
deferred — see A11Y.md residual risks), `th.sortable` keeps `data-k` on the
th, `.ranges .btn[data-r]` must keep resolving (DS.rangeChips + post-mount
`btn` class), skip-link markup `a.skip-link[href="#mktPanel"]` + the
`#mktPanel tabindex="-1"` panel around the market table.
Grep `probe.js`, `client-probe.js`, AND `tools/a11y-probe.js` before
renaming anything.

## 8. Gates for any UI diff

```
node probe.js
node client-probe.js
node tools/ds-component-test.js
node tools/ds-guard.js          # bare exit code
node tools/a11y-probe.js        # 34 checks, ~15s
```

All five green on bare exit codes. If an a11y-probe check must change
because a spec deliberately changed, change the check IN the same diff with
the rationale in the commit — never delete a check to make a diff pass.

## 9. No-go list

- No `outline:none` without a ≥2px replacement ring.
- No click-only interactive elements.
- No unconditional document-level key handlers.
- No new hardcoded copies of color tokens in JS paint code.
- No bare `1fr` around tables/canvases; no table outside a scroll wrapper
  on doc pages.
- No ARIA role without its full behavior contract.
- No CSS animation/transition without a `prefers-reduced-motion` guard
  (today there are zero — keep the trivially-satisfied state).
