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

## 4 · Buff163 — the third venue (designed, key-gated, NOT dark-built)

Buff163 is the Chinese venue and the single most informative third leg:
it is the deepest real-money skin market and directly prices the
CN-side demand this market swings on.

- **Access**: steamwebapi.com's free tier proxies Buff163 prices; needs
  a user-registered key stored as the `BUFF_API_KEY` Actions secret.
  No key → lane off, integrity coverage reads `0/n (no key)`.
- **Fetcher**: goes through `market.js`'s injectable transport like
  every source. The exact route/shape gets pinned ON FIRST LIVE CONTACT,
  in the same session the key lands — the book-lane incident (nameid
  flow shipped against a Steam page that no longer existed) is the
  standing lesson: **never dark-ship a fetcher you cannot live-verify.**
- **Budget**: rotating subset per run sized to the key's quota once
  known (mirror the Skinport 8-per-run pattern; persist a cursor).
- **Storage**: `data/buff.json` `{slug: {t, priceUsd, sellNum, buyNum}}`
  — NEVER lines in the history jsonl (assembleSeries pollution rule).
- **Integrity lane `buff`**: each item's steam/buff ratio vs its own
  trailing baseline, median-relative cross-sectional gate, thresholds
  mirroring the `ratio` lane. Three independent legs (Skinport realized,
  Steam book, Buff asks) makes a coordinated fake ~3× harder again.
- **New metric — CN PREMIUM**: median over liquid cases of
  (buff price ÷ steam price), published in `market.today.cnPremium`.
  Complements the players-based CN/US gauge with an actual PRICE spread;
  divergence between the two is itself a signal (demand vs. capital
  controls).
- **Marks stay Steam.** Buff corroborates and gauges; it does not
  become a mark source without its own methodology version bump.

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
- [ ] Buff lane: wire + live-verify the day `BUFF_API_KEY` exists.
