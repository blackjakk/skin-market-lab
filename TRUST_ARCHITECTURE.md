# Trust architecture — from tamper-evident to independently witnessed

The index math (SMLX-5) and the mark surveillance (INTEG-1) close every
attack we control. What remains is the TRUST SHAPE of the pipeline itself:

> One collector, run by one GitHub account, is the only writer of `data/`.
> Hashes prove the fixings were computed correctly FROM `data/` — they
> prove nothing about whether `data/` reflects the real world. The system
> is tamper-EVIDENT (history is append-only, everything re-derives), not
> tamper-PROOF (the writer is trusted at write time).

This document covers the two structural upgrades: the WITNESS protocol
(independent replication + divergence alarm — **built**, `witness.js` +
`witness.yml`) and corroboration of the marks themselves (§4 — **built**:
third venues live, and every lane now ranked by how hard its evidence is to
fake, because more corroboration of a weak kind is not more assurance).

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

## 4 · Corroboration — and how much each kind of it is worth

**Evidence is ranked, not counted** (2026-07-27). The third-venue lane below
added *quantity* of corroboration, but of the weakest kind available: asks.
Every lane now publishes an explicit strength, ranked by what it costs an
attacker to FAKE the corroboration, and coverage is reported per tier —
never as one number that adds free evidence to paid evidence.

| Tier | Lanes | What it is | Cost to fake |
|---|---|---|---|
| **strong** | `ratio`, `volume`, `art-evidence` | realized sales: Skinport realized medians/volumes, Steam's own sold-per-day, realized sale counts | the venue fee on every washed unit (Steam 15% / Skinport 12%) — the same fee-burn the manipulation budget is built on |
| **medium** | `book` | standing bids: committed capital that can actually be filled | no fee to post or pull, but real money at risk while it stands |
| **weak** | `venue` | third-venue ASKS (TM Market, Waxpeer, BUFF `sell_min_price`) | **zero** — a listing is free to post |

> **Divergence from an ask venue is evidence. Agreement is not.**

That asymmetry is the whole revision. A third venue that DISAGREES still
raises exactly the flags it did before, at the same thresholds — an attacker
who did not bother to move it is caught. A third venue that AGREES no longer
counts toward "this mark is corroborated": the agreement could have been
bought for nothing. The coverage is still published in full (per venue:
`checked` = marks it was gated against, `agreed` = how many did not diverge,
with `counts:false`) — demoted in the open, not silently dropped. **The honest
consequence: the corroboration numbers this project publishes are now SMALLER
than they read before.** They were previously inflated by treating three
agreeing ask venues as three confirmations of a mark.

The version id stays `INTEG-1`: no fixing computation, canonical form or hash
changed. The record carries `revision` + `revisionNote` saying what did.

### 4a · The `volume` lane (strong tier, shipped 2026-07-27)

The strong detector we already had the data for and were not using: Steam's
daily **sold-per-day**, per item, against that item's OWN trailing 30-day
baseline, then gated on the day's cross-sectional median — the same
median-relative construction as the ratio lane and the index clamp, so a
market-wide volume surge (or drought) flags nobody. It flags a significant
idiosyncratic price move whose volume response collapsed relative to the
market: a price printed on a tape that did not confirm it. Volume is the one
input an attacker cannot manufacture without paying ~15% per unit.

Thresholds were **measured over the committed backtest history** (49 items,
103,518 eligible item-days since 2019), not chosen by taste: the watch move
step (0.10 log) sits at the 97.1st percentile of idiosyncratic daily moves and
the response step (−0.5) at the 1.4th percentile of volume responses; together
they fire on 0.111% of item-days (~one every 24 market-days), and the
conjunction is 3.7× more likely under a big move than on a calm day (80× at
the alert pair). The measurement also **corrected the premise**: the median
volume response on a genuine big-move day is only +0.04 log, so "volume failed
to rise" describes ~45% of honest moves and would be useless — what is rare is
a big move whose volume collapses. Names under 10 units/day are excluded (the
measured knee: 1.06% flag rate below, 0.15% above). Flag-only and firewalled
like every other lane, proven by a probe pin that runs the collector with the
integrity layer live and dead and compares series, weights, budget, fixing
preimages and hashes.

Honest limit: no lane is what makes an attack expensive. Every corroboration
lane's move threshold is wider than the per-name push the winsorization clamp
already permits (0.05 log), so the §5 attack floors in the methodology are
unchanged by detection. These lanes catch large single-name distortions and
thin-tape marks, not the cheapest 1% index push.

### 4b · The third-venue lane — SHIPPED 2026-07-27 (three venues, live)

Every mark is single-venue at source (Steam). The `venue` lane adds
independent read paths so faking a mark means moving unrelated markets
at once. Built as a pluggable ADAPTER interface, not one scraper, so a
venue that rots costs coverage and nothing else. **Weak tier** (see above):
its divergence flags, its agreement is published but uncounted.

- **Live adapters** (all live-verified from this environment, never
  dark-shipped — the book-lane lesson holds):
  - **TM Market** (`market.csgo.com/api/v2/prices/USD.json`) — public,
    27,341 items, 56/56 tracked names matched.
  - **Waxpeer** (`api.waxpeer.com/v1/prices?minified=1`) — public,
    21,889 items, prices in 1/1000 USD, 56/56 matched.
  - **Buff163** — the as-designed premise was that Buff needs a key.
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
  `ok | insufficient | no-quotes | unavailable` with a reason, plus
  `checked` / `agreed` / `counts:false`. An unavailable venue is never
  folded in as agreement, a stale quote (past `venueMaxAgeH`) is not even
  checked — and since the evidence tiering, an AVAILABLE venue's agreement
  is not counted as corroboration either. Only its divergence is.
- **Flag-only, and firewalled.** The lane never rejects a mark, never
  alters a price. Proven, not asserted: a probe pin runs the collector
  twice from identical seeds — every venue live vs every venue dead —
  and asserts byte-identical series, today block, weights, budget,
  fixing canonical preimages and fixing hashes.
- **Marks stay Steam.** These venues corroborate; none becomes a mark
  source without its own methodology version bump.

**Honest limits.** All three publish ASKS, not realized sales — they
corroborate quoted level, not executed trade, which is exactly why this lane
is weak-tier and why its agreement now buys no coverage (§4). TM Market and
Waxpeer are strongly correlated with each other, so three venues is closer to
~1.3 independent reads than 3. Buff coverage stays below `venueMinQuotes`
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
- [x] Evidence TIERING shipped: lanes ranked strong/medium/weak by cost to
      fake, ask agreement uncounted, coverage published per tier.
- [x] `volume` lane shipped (strong tier): Steam's own realized sold-per-day
      vs each item's baseline, thresholds measured over committed history.
- [ ] A THIRD VENUE that publishes REALIZED sales (all three are asks). The
      volume lane closed part of this gap from Steam's own data; an
      independent venue's realized tape is still missing.
