# Trust architecture — from tamper-evident to independently witnessed

The index math (SMLX-5) and the mark surveillance (INTEG-1) close every
attack we control. What remains is the TRUST SHAPE of the pipeline itself:

> One collector, run by one GitHub account, is the only writer of `data/`.
> Hashes prove the fixings were computed correctly FROM `data/` — they
> prove nothing about whether `data/` reflects the real world. The system
> is tamper-EVIDENT (history is append-only, everything re-derives), not
> tamper-PROOF (the writer is trusted at write time).

This document designs the two structural upgrades: the WITNESS protocol
(independent replication + divergence alarm — **built**, `witness.js` +
`witness.yml`) and the Buff163 third venue (**designed, deliberately not
dark-built** — see §4).

## 1 · The independence ladder

Each rung is strictly stronger. Be honest about which rung is in effect.

| Rung | Who runs the witness | What it proves | What it can't |
|---|---|---|---|
| L0 | This repo witnesses itself (the shipped `witness.yml` cron) | The published series/fixings re-derive from the committed files; publication didn't drift or corrupt | Nothing about operator honesty — same credentials |
| L1 | Second repo, same owner, different infra | Infrastructure faults, upstream drift | Same |
| L2 | ONE third party forks the repo and enables the witness workflow | The operator cannot fabricate data without that party's red CI catching it (within tolerances) | Collusion; the third party's own honesty |
| L3 | N independent parties witness | Fabrication requires N-way collusion | See §5 — the ceiling |

**The design goal is making L2 a five-minute act**: fork →
enable Actions → done. The witness needs no key, no config (the primary
URL defaults to the canonical Pages site), and alarms by failing its own
workflow run — GitHub emails the fork owner on failure automatically.
Real assurance is never "the operator lists witnesses"; it is "YOU run
one." A witness list displayed by the primary is informational only and
trivially sybil-able — the protocol's honesty comes from self-service.

## 2 · The witness protocol (`witness.js`)

Three checks per run, strongest first:

1. **Full re-derivation (byte-exact).** Fetch the primary's
   `watchlist.json` + every `data/history/<slug>.jsonl` + every
   `data/import/<slug>.json`, rebuild every item with the SAME
   `assembleMarketItem` code the collector uses (exported from
   `collect.js` — one function, never forked), run `marketOverview`, and
   compare every published day's `caseIdx`/`liqIdx`/`artIdx`/`cashRatio`
   plus the published weights. Any mismatched day = the published index
   does not follow from the committed raw files.
2. **Fixing hashes (byte-exact).** `computeAll` over the published
   series; SHA-256 of each canonical fixing must equal the published
   hash, and the methodology stamp must match this checkout's
   `settlement.js`. (1)+(2) together: raw files → series → fixings is
   fully honest, or the alarm trips.
3. **Independent observation (tolerance-based).** The witness takes its
   OWN live Steam samples for a rotating subset (default 6/run,
   politeness-gapped) and compares against the primary's latest quotes.
   Prices sampled hours apart legitimately differ, so this lane uses
   bands, not equality: |log deviation| ≤ 0.12 passes; the alarm needs
   **≥2 divergent names in one run** (single-name noise is tolerated;
   systematic fabrication is not). Fetch failures are recorded but never
   counted as lies.

**Alarm semantics**: `data/witness.json` records every check; the
process exits non-zero on any reason, which fails the workflow run — red
CI on the witness repo + GitHub's automatic failure email. An
unreachable primary is its own verdict (`UNREACHABLE`), also red:
downtime deserves attention, but the file distinguishes it from lying.

**Timing**: the witness cron runs at :47 (30 min after the primary's
:17) so it always sees a freshly published snapshot; Pages deploys are
atomic per force-push, so index/settlement/history are always a
consistent set.

## 3 · What the witness changes about each attack

- **Operator fabricates a price in `data/`** → check 1 passes (the fake
  is in the files), but check 3 catches any fabrication large enough to
  matter (>12% vs reality, twice) the next time the rotation samples it
  — expected detection within ~1–2 days at 6 obs/run, 4 runs/day, 55
  steam-marked items.
- **Operator publishes an index that doesn't match the files** → check 1
  trips same-day.
- **Operator tampers a fixing or its hash** → check 2 trips same-day.
- **Operator rewrites history** (force-push edits old `data/`) → the
  witness's own repo holds committed copies of `witness.json` verdicts
  over time; combined with git history on the fork (which fetched the
  data), rewrites are provable after the fact. (A stronger version —
  the witness archiving full data snapshots — is a cheap future flag:
  `WITNESS_ARCHIVE=1` copying the fetched files into the witness repo.)

## 4 · The third-venue lane — SHIPPED 2026-07-27 (three venues, live)

Every mark is single-venue at source (Steam). The `venue` lane adds
independent read paths so faking a mark means moving unrelated markets
at once. Built as a pluggable ADAPTER interface, not one scraper, so a
venue that rots costs coverage and nothing else.

- **Live adapters** (all live-verified from this environment, never
  dark-shipped — the book-lane lesson holds):
  - **TM Market** (`market.csgo.com/api/v2/prices/USD.json`) — public,
    27,341 items, 56/56 tracked names matched.
  - **Waxpeer** (`api.waxpeer.com/v1/prices?minified=1`) — public,
    21,889 items, prices in 1/1000 USD, 56/56 matched.
  - **Buff163** — the §4-as-designed premise was that Buff needs a key.
    That is only half true: `/api/market/goods/info?goods_id=<id>`
    answers `{"code":"OK"}` LOGGED OUT. Only name→goods_id *discovery*
    needs a session, so `BUFF_COOKIE` gates that one call; with the
    committed `data/buff-ids.json` hint map (re-verified name-for-name on
    every read, never trusted blind) the lane reads Buff credential-free
    today. No cookie and no id → `not configured`, published as
    unavailable.
- **Rejected on purpose — BitSkins.** Public and trivial to add, but its
  `suggested_price` is Steam-DERIVED: the median ratio to our own Steam
  mark measured 1.000. It would have agreed by construction and inflated
  coverage with a tautology. A corroborating venue that echoes the thing
  it corroborates is worse than no venue.
- **Comparison is median-relative, not level.** These venues sit ~0.66×
  Steam and that discount moves with FX, so a level test would flag the
  whole market daily. Published tolerances live in every integrity
  record: `venueDevWatch .25 · venueDevAlert .5 · venueUniqueMult 1.6 ·
  venueMinQuotes 5 · venueMaxAgeH 48`.
- **Storage**: `data/venues.json` — NEVER lines in the history jsonl
  (a stray `src` line would fold a third venue's ask into assembleSeries
  and quietly change the published index).
- **Coverage is published honestly** per venue as
  `ok | insufficient | no-quotes | unavailable` with a reason. An
  unavailable venue is never folded in as agreement, and a stale quote
  (past `venueMaxAgeH`) does not count as corroborated.
- **Flag-only, and firewalled.** The lane never rejects a mark, never
  alters a price. Proven, not asserted: a probe pin runs the collector
  twice from identical seeds — every venue live vs every venue dead —
  and asserts byte-identical series, today block, weights, budget,
  fixing canonical preimages and fixing hashes.
- **Marks stay Steam.** These venues corroborate; none becomes a mark
  source without its own methodology version bump.

**Honest limits.** All three publish ASKS, not realized sales — they
corroborate quoted level, not executed trade. TM Market and Waxpeer are
strongly correlated with each other, so three venues is closer to ~1.3
independent reads than 3. Buff coverage stays below `venueMinQuotes`
until more ids accrue or a cookie lands. The CN PREMIUM metric designed
here is not built: with Buff coverage thin it would be a headline number
resting on a handful of items.

## 5 · The ceiling — what nothing in this file fixes

- **A Valve-side lie is invisible to everyone.** Every witness reads the
  same public endpoints; if Steam itself serves wrong numbers, all
  parties agree on the wrong numbers. This is issuer risk, not operator
  risk — disclosed in methodology §9, not fixable by replication.
- **Witness sybil**: the primary can run fake "independent" witnesses.
  Mitigated only by self-service (run your own), never by lists.
- **World-truth attestation**: no cryptographic chain exists from
  Steam's servers to `data/` (no signed responses, no TLS-notarization
  in scope). Witnessing narrows the trust gap to "N parties all saw the
  same thing at the same time" — that is the practical maximum for a
  walled-garden data source, and it is how real-world thin-market
  benchmarks (LBMA, Platts) actually work: published methodology,
  verifiable inputs, adversarial observers.

## 6 · Rollout state

- [x] L0 self-witness shipped (`witness.yml` cron in this repo).
- [x] Fork-and-enable path documented (README + methodology §6).
- [ ] L2: at least one third party enables a witness fork.
- [ ] `WITNESS_ARCHIVE` snapshot mode (cheap, when wanted).
- [x] Third-venue lane SHIPPED: TM Market + Waxpeer public, Buff163
      credential-free per goods_id (`BUFF_COOKIE` gates discovery only).
- [ ] CN PREMIUM metric — blocked on Buff coverage, not on code.
- [ ] A venue that publishes REALIZED sales (all three are asks).
