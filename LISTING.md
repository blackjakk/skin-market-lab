# LISTING.md — parameter sheet for venues settling on Skindex fixings

For any market — centralized or DEX — considering instruments that settle on
the Skindex settlement fixings. This sheet states what the oracle provides,
what it can safely carry, and the parameters a conservative listing should
use. It is a measurement spec, **not an offer, solicitation, or endorsement
of any instrument**. Companion docs: `methodology.html` (rulebook + live
budget + §5b capacity model), `DEPLOY.md` (on-chain settlement contracts),
`TRUST_ARCHITECTURE.md` (threat model), `README.md`.

## 1. What the oracle provides

| Output | Cadence | Nature | Instrument fit |
|---|---|---|---|
| `SETTLE-CASE-7D` | daily value, 7-day mean | canonical, hashed, re-derivable | short-dated linears |
| `SETTLE-CASE-30D` | daily value, 30-day mean | canonical, hashed, re-derivable | **the benchmark tenor** |
| `SETTLE-CASE-90D` | daily value, 90-day mean (accruing since 2026-07-27) | canonical, hashed, re-derivable | quarterly-dated size |
| `SETTLE-RATIO-30D` | daily value | canonical, hashed, re-derivable | cash-ratio derivatives |
| `PERPMARK-CASE` | every collector run | **experimental**, non-canonical, no hash | mark-price smoothing preview only |
| `budget.oiCapacity` | every collector run | published capacity line per fixing | position/OI limits |

Every canonical fixing publishes a SHA-256 over its canonical form; any
counterparty re-derives it bit-exactly from the committed `data/` files
(one-click verification on the methodology page; independent continuous
verification via witness forks — `witness.yml`).

## 2. Capacity — read it live, don't hardcode it

`data/settlement.json → latest.budget.oiCapacity` publishes, per fixing:
`boundConcentrated` (cheapest clamped 1% attack), `boundCapture` (center
capture under a 5%-credible-print dispute layer), and `capacityLinear`
(= min(bounds)/3, the κ=3 corruption margin) with all assumptions inline.
Indicative values at 2026-07-27 volumes: 7D ≈ $250k · 30D ≈ $1.07M ·
90D ≈ $3.2M · RATIO-30D ≈ $1.3M of LINEAR notional, single-party worst
case. The line is volume-derived and moves with the market — venues should
read it at listing time and re-check on a schedule.

Independent ceiling regardless of the budget math: the case basket trades
≈ $0.65M/day (combined cases+liquids preview universe ≈ 2×) — hedgeable OI
saturates in the low single-digit millions.

## 3. Settlement path (dated instruments — the recommended shape)

1. Instrument expires against a fixing (e.g. SETTLE-CASE-30D at day D).
2. Proposer submits (value, canonical hash) to `SkindexSettlement`
   (`contracts/`, see DEPLOY.md) with a bond; the challenge window opens.
3. Anyone re-derives the fixing from `data/` (witness recipe); a mismatch
   is challenged with a matching bond; the resolver adjudicates (v1:
   curated resolver — the trust model is natspec'd; end-state: witness
   committee).
4. Markets read `getFixing()` — it reverts until finalized. **Never settle
   on an unchallenged-window value.**

The center-capture bound in §2 EXISTS ONLY because of this dispute layer:
a fully automatic pay-on-the-number market has ≈ zero safe capacity
(capture costs ~$44k at current volumes and moves the print without bound).

## 4. Perp listing parameters (if a perp is listed anyway)

A vanilla perp marked to raw index prints is NOT supported — single prints
cost ~$1k/1% to nudge and update every 3h. The conservative template
("pre-launch-market" style):

- **Mark price:** PERPMARK-CASE construction (median of last ≤5 prints,
  2% max-step guard) or stricter. Never a single print.
- **Funding:** settled daily against SETTLE-CASE-7D — funding inherits a
  fixing's robustness rather than a spot print's.
- **Leverage:** ≤ 2–3×. **Maintenance margin** sized to a full 5%
  inter-update gap (the winsorization clamp width).
- **OI cap:** ≤ the live `capacityLinear` of the funding fixing; per-account
  caps a fraction of that.
- **Staleness guard:** liquidations freeze if the feed is older than 2×
  the collector cadence.
- **No near-the-money binaries/digitals** on any fixing: a tiny Δ becomes
  decisive, so their safe capacity is ≈ zero (published in the capacity
  assumptions).

## 5. Risk disclosures a listing must carry

- **Single-publisher tail risk (unhedgeable):** Valve is the underlying's
  issuer, venue, and regulator. Policy changes (trade locks, drop pools,
  API/ToS enforcement) can gap the index violently or end the data source.
  The CS2 announcement repriced the index +92% in 30 days; the lever swings
  both ways. Price this permanently; it never diversifies away.
- **Wallet-locked marks:** Steam marks are wallet dollars, not withdrawable
  cash; the cash ratio (~64% currently) is published — real-money exposure
  should reference cash-adjusted values or hedge the ratio.
- **Fee floor economics:** manipulation budgets are fee-burn FLOORS
  (inventory and price risk excluded); the κ=3 margin partially — not
  fully — absorbs model risk. Single-venue marks are corroborated
  (INTEG-1) but flags never auto-reject.
- **Preview outputs:** the market index (cases+liquids) and PERPMARK are
  labeled previews/experimental — nothing may settle on them.
- Not financial advice; nothing here creates an instrument. Whoever lists
  bears their own legal/compliance analysis (skins trading sits in a
  jurisdiction-dependent gray zone with a gambling-adjacent history).

## 6. Listing checklist

- [ ] Read `latest.budget.oiCapacity`; set OI/position caps ≤ capacityLinear.
- [ ] Linear payoffs only; no near-the-money digitals.
- [ ] Settle only on finalized (`SkindexSettlement`) fixing values.
- [ ] Run (or rely on ≥N independent) witness forks; wire them as
      challengers, and toward `WitnessOracle` quorum if reading on-chain.
- [ ] Re-check capacity on a schedule; caps follow the line down as well as up.
- [ ] Carry §5 disclosures verbatim or stronger.
