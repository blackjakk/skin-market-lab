// Hardhat toolchain for the ON-CHAIN layer only (contracts/ + test/ + scripts/).
// The Skindex runtime (server.js, collect.js, witness.js, the dashboard) stays
// ZERO-DEPENDENCY — everything this config needs is devDependencies, installed
// only when you work on the contracts. `npm start` never touches any of it.
require("@nomicfoundation/hardhat-toolbox");

// Optional testnet wiring — every value is a USER-supplied env var (no secrets
// in the repo, no defaults that could reach a real chain). See DEPLOY.md.
const testnet = {
  url: process.env.TESTNET_RPC_URL || "http://127.0.0.1:1", // placeholder — unreachable by design
  accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
};
if (process.env.TESTNET_CHAIN_ID) testnet.chainId = Number(process.env.TESTNET_CHAIN_ID);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    testnet,
  },
  paths: {
    // Generated outputs live under node_modules/.cache (node_modules/ is already
    // gitignored) so the zero-dependency runtime tree stays clean — no build
    // dirs to commit or ignore.
    artifacts: "node_modules/.cache/hardhat/artifacts",
    cache: "node_modules/.cache/hardhat/cache",
  },
  typechain: {
    outDir: "node_modules/.cache/hardhat/typechain-types",
  },
};
