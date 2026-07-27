// scripts/deploy.js — deploys the Skindex on-chain settlement layer:
// SkindexSettlement (one, all fixings) + one WitnessOracle per catalog fixing.
//
// NO SECRETS LIVE HERE. Every parameter comes from env vars (documented in
// DEPLOY.md) with safe local defaults; keys and any real deployment are USER
// actions. Dry-run on the in-process node (no key, no funds, nothing leaves
// the machine):
//
//   npx hardhat run scripts/deploy.js
//
// Constructor params (env → default):
//   SETTLEMENT_BOND  ETH to propose/challenge a fixing        → "0.01"
//   CHALLENGE_WINDOW seconds a proposal stays open            → 86400 (1 day —
//                    fixings are daily; give re-derivers a full cycle)
//   RESOLVER         dispute referee address                  → deployer
//   WITNESS_QUORUM   min witness reports for a median         → 2
//   WITNESSES        comma-separated witness addresses        → none (curate later)
//   FIXINGS          comma-separated fixing names             → the SMLX-6 catalog
//                    (the catalog is ADDITIVE — deploy another oracle for a new
//                    fixing such as SETTLE-CASE-90D; never rename existing ids)
const hre = require("hardhat");

const DEFAULT_FIXINGS = ["SETTLE-CASE-7D", "SETTLE-CASE-30D", "SETTLE-RATIO-30D"];

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No signer for network '" + network.name + "'. Export PRIVATE_KEY (see DEPLOY.md) — deployment keys are a user action, never committed."
    );
  }

  const bond = ethers.parseEther(process.env.SETTLEMENT_BOND || "0.01");
  const windowS = BigInt(process.env.CHALLENGE_WINDOW || 86400);
  const quorum = Number(process.env.WITNESS_QUORUM || 2);
  const resolver = process.env.RESOLVER || null;
  const witnesses = (process.env.WITNESSES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fixings = (process.env.FIXINGS || DEFAULT_FIXINGS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const dry = network.name === "hardhat";

  console.log((dry ? "(dry-run, in-process node) " : "") + "Deploying as " + deployer.address + " on '" + network.name + "'");
  console.log("  bond " + ethers.formatEther(bond) + " ETH · window " + windowS + "s · quorum " + quorum);

  // 1. SkindexSettlement — one contract settles every (fixingId, day).
  const settlement = await ethers.deployContract("SkindexSettlement", [bond, windowS]);
  await settlement.waitForDeployment();
  console.log("SkindexSettlement  " + (await settlement.getAddress()));
  if (resolver) {
    await (await settlement.setResolver(resolver)).wait();
    console.log("  resolver → " + resolver);
  } else {
    console.log("  resolver = deployer (set RESOLVER, ideally a multisig, before real use)");
  }

  // 2. One WitnessOracle per fixing series (fixingId = keccak256(name)).
  const oracles = {};
  for (const name of fixings) {
    const oracle = await ethers.deployContract("WitnessOracle", [ethers.id(name), quorum]);
    await oracle.waitForDeployment();
    oracles[name] = await oracle.getAddress();
    for (const w of witnesses) await (await oracle.addWitness(w)).wait();
    console.log("WitnessOracle      " + oracles[name] + "  " + name + (witnesses.length ? "  (" + witnesses.length + " witnesses)" : "  (registry empty — curate via addWitness)"));
  }

  console.log(dry
    ? "\nDry-run complete — nothing was deployed to a real network and no addresses were persisted."
    : "\nDeployed. Record these addresses yourself (this script deliberately writes no files).");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
