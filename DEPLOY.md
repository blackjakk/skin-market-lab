# Deploying the Skindex settlement contracts

The on-chain layer is **optional** — the tracker, collector, dashboard, and
witness protocol all run with no chain at all. These contracts exist so an
instrument settling on a Skindex fixing can consume a **proven** value instead
of trusting a poster.

**The runtime app stays zero-dependency.** Everything the contracts need
(Hardhat, the OpenZeppelin library) is in `devDependencies` only; `npm start`,
`node collect.js`, `node witness.js`, and every probe run exactly as before
without `npm install`. Install the toolchain only when you work on
`contracts/`, `test/`, or `scripts/`.

## What gets deployed (`scripts/deploy.js`, in order)

1. `SkindexSettlement` — optimistic dated-fixing settlement, one contract for
   all fixings: bonded `propose(fixingId, day, value, dataHash)` → optimistic
   challenge window → `finalize()` by anyone, or resolver adjudication on a
   dispute (loser's bond to the winner; a rejected proposal **reopens** the
   slot — the challenger's counter-claim is never adopted as the fixing).
2. One `WitnessOracle` per catalog fixing (`SETTLE-CASE-7D`, `SETTLE-CASE-30D`,
   `SETTLE-RATIO-30D` by default) — owner-curated witness registry, per-day
   pushes, quorum-gated median, `lastCompleteDay` staleness view. The catalog
   is **additive**: a new fixing (e.g. `SETTLE-CASE-90D`) gets its own oracle
   via `FIXINGS=...`; existing ids are frozen and never renamed.

## Conventions (must match off-chain exactly)

- `fixingId` = `keccak256(bytes(name))` of the frozen fixing name
  (`SkindexSettlement.fixingIdOf("SETTLE-CASE-30D")`; `ethers.id(name)` in JS).
- `day` = the UTC day as `YYYYMMDD` (`20260727` for the series key
  `"2026-07-27"`).
- `value` = the fixing value scaled by its published decimals:
  `SETTLE-CASE-*` publish 2 decimals (× 100), `SETTLE-RATIO-30D` publishes 4
  (× 10000). A new fixing carries its own decimals in its published spec.
- `dataHash` = the fixing's published SHA-256: sha256 over `canonical(f)` from
  `settlement.js` — `JSON.stringify({methodology:"SMLX-6", name, window, days,
  values, value})`, the same hash in `data/settlement.json` /
  `data/settlements.jsonl`. Anyone re-derives it (methodology.html §6):

  ```bash
  node -e "const S=require('./settlement.js'),c=require('crypto');
  const m=require('./data/index.json').market;
  for(const [n,f] of Object.entries(S.computeAll(m.series)))
    console.log(n, c.createHash('sha256').update(S.canonical(f)).digest('hex'))"
  ```

## Trust model (v1 — read before relying on it)

- The **resolver** (defaults to the deployer; set a multisig via `RESOLVER`)
  adjudicates disputes with a boolean. v1 trusts it; the documented end-state
  replaces it with a witness-committee vote (see the natspec in
  `contracts/SkindexSettlement.sol`).
- The **witness registry** is owner-curated in v1 — a colluding registry is a
  colluding oracle. The end-state is permissionless staked witnesses; the
  off-chain protocol anyone can run today (fork + enable Actions →
  `witness.yml`) is described in `TRUST_ARCHITECTURE.md` and
  methodology.html §6.
- `dataHash` is a **commitment**, not an on-chain proof: the chain adjudicates
  hashes of a publicly re-derivable artifact; a self-consistent rewrite of the
  committed `data/` history is caught by independent off-chain witnesses, not
  by the contract.

## Prerequisites

- Node 22+ and `npm install` (devDependencies only — see above).
- For any real network: a **funded deployer key** and the target chain's RPC
  URL + chain id. **Keys and deployment are user actions** — this repo ships
  no key, no funded default RPC, and the deploy script writes no files.

## Environment variables

```bash
# required for any real deploy — placeholders, supply your own
export PRIVATE_KEY=0x<funded-deployer-key>          # NEVER commit this
export TESTNET_RPC_URL=https://<your-testnet-rpc>
export TESTNET_CHAIN_ID=<chain-id>                  # must match the RPC

# optional settlement params (defaults shown)
export SETTLEMENT_BOND=0.01        # ETH bond to propose/challenge
export CHALLENGE_WINDOW=86400      # seconds — daily fixings get a full day
export RESOLVER=0x<referee-multisig>   # defaults to the deployer
export WITNESS_QUORUM=2
export WITNESSES=0xA...,0xB...     # optional initial registry
export FIXINGS=SETTLE-CASE-7D,SETTLE-CASE-30D,SETTLE-RATIO-30D
```

## Steps

```bash
npm install
npx hardhat test                       # 58 tests, all green expected

# 1. DRY-RUN on the in-process node — no key, no funds, nothing persisted.
#    Should print "(dry-run, in-process node)".
npx hardhat run scripts/deploy.js

# 2. REAL deploy (user action — after exporting the env vars above)
npx hardhat run scripts/deploy.js --network testnet

# 3. Record the printed addresses yourself, then curate:
#    - settlement.setResolver(<multisig>) if not set at deploy
#    - oracle.addWitness(<addr>) per witness, per oracle
```

## Notes

- Build outputs (artifacts, cache, typechain) are routed under
  `node_modules/.cache/hardhat/` (see `hardhat.config.js`), so the working
  tree stays clean — nothing generated to commit or ignore.
- Constructors hold no large literals (EIP-3860 init-code limits are nowhere
  near — the hashmark-heroes TeamNFT lesson, kept in mind by construction).
- CI runs `npm ci && npx hardhat test` as the `contracts` job in
  `.github/workflows/gates.yml`; the existing runtime gates are untouched.
