// SkindexSettlement.test.js — proves the optimistic dated-fixing settlement:
// bonded propose → optimistic challenge window → resolver adjudication →
// finalize, per (fixingId, day). Bond flows in both directions, window edges,
// the reopen-on-rejection path (no challenger-fixing), and the bond-burn war
// economics. Run: npx hardhat test
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const BOND = ethers.parseEther("0.1");
const WINDOW = 3600;

// fixingId convention: keccak256 of the FROZEN fixing name (ethers.id ==
// keccak256(utf8) == the contract's fixingIdOf).
const FIX_CASE30 = ethers.id("SETTLE-CASE-30D");
const FIX_RATIO30 = ethers.id("SETTLE-RATIO-30D");
const DAY = 20260727; // UTC day, YYYYMMDD
const DAY2 = 20260728;

// SETTLE-CASE-30D publishes 2 decimals → value scaled ×100 (173.42 → 17342).
const TRUE_VALUE = 17342n;
const LIE_VALUE = 17999n;
const TRUE_HASH = ethers.id('{"methodology":"SMLX-6","name":"SETTLE-CASE-30D",...}');
const LIE_HASH = ethers.id("tampered-canonical-form");

const S = { None: 0n, Proposed: 1n, Disputed: 2n, Finalized: 3n };

describe("SkindexSettlement (optimistic dated-fixing settlement)", function () {
  let ss, owner, runner, challenger, other;

  beforeEach(async function () {
    [owner, runner, challenger, other] = await ethers.getSigners();
    ss = await ethers.deployContract("SkindexSettlement", [BOND, WINDOW]);
  });

  async function proposed(by = runner, value = TRUE_VALUE, hash = TRUE_HASH) {
    await ss.connect(by).propose(FIX_CASE30, DAY, value, hash, { value: BOND });
  }
  async function disputed(pv = TRUE_VALUE, ph = TRUE_HASH, cv = LIE_VALUE, ch = LIE_HASH) {
    await proposed(runner, pv, ph);
    await ss.connect(challenger).challenge(FIX_CASE30, DAY, cv, ch, { value: BOND });
  }

  describe("deployment & conventions", function () {
    it("exposes bond, window, owner, and resolver defaulting to the deployer", async function () {
      expect(await ss.bondAmount()).to.equal(BOND);
      expect(await ss.challengeWindow()).to.equal(BigInt(WINDOW));
      expect(await ss.owner()).to.equal(owner.address);
      expect(await ss.resolver()).to.equal(owner.address);
    });

    it("rejects a zero bond (spam would be free)", async function () {
      await expect(ethers.deployContract("SkindexSettlement", [0n, WINDOW]))
        .to.be.revertedWith("SS: zero bond");
    });

    it("rejects a zero challenge window (no optimistic phase)", async function () {
      await expect(ethers.deployContract("SkindexSettlement", [BOND, 0n]))
        .to.be.revertedWith("SS: zero window");
    });

    it("fixingIdOf is keccak256 of the frozen fixing name", async function () {
      expect(await ss.fixingIdOf("SETTLE-CASE-30D")).to.equal(FIX_CASE30);
      expect(await ss.fixingIdOf("SETTLE-RATIO-30D")).to.equal(FIX_RATIO30);
    });
  });

  describe("propose", function () {
    it("stores the bonded claim and emits Proposed", async function () {
      await expect(ss.connect(runner).propose(FIX_CASE30, DAY, TRUE_VALUE, TRUE_HASH, { value: BOND }))
        .to.emit(ss, "Proposed").withArgs(FIX_CASE30, DAY, runner.address, TRUE_VALUE, TRUE_HASH);
      const f = await ss.proposalOf(FIX_CASE30, DAY);
      expect(f.status).to.equal(S.Proposed);
      expect(f.proposer).to.equal(runner.address);
      expect(f.value).to.equal(TRUE_VALUE);
      expect(f.dataHash).to.equal(TRUE_HASH);
      expect(f.proposerBond).to.equal(BOND);
    });

    it("requires the exact bond (under and over both revert)", async function () {
      await expect(ss.propose(FIX_CASE30, DAY, TRUE_VALUE, TRUE_HASH, { value: BOND - 1n }))
        .to.be.revertedWith("SS: bad bond");
      await expect(ss.propose(FIX_CASE30, DAY, TRUE_VALUE, TRUE_HASH, { value: BOND + 1n }))
        .to.be.revertedWith("SS: bad bond");
    });

    it("requires a non-empty dataHash (the commitment is the point)", async function () {
      await expect(ss.propose(FIX_CASE30, DAY, TRUE_VALUE, ethers.ZeroHash, { value: BOND }))
        .to.be.revertedWith("SS: empty dataHash");
    });

    it("rejects day 0", async function () {
      await expect(ss.propose(FIX_CASE30, 0, TRUE_VALUE, TRUE_HASH, { value: BOND }))
        .to.be.revertedWith("SS: bad day");
    });

    it("one live proposal per (fixingId, day)", async function () {
      await proposed();
      await expect(ss.connect(other).propose(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: BOND }))
        .to.be.revertedWith("SS: exists");
    });

    it("slots are independent across days and across fixings", async function () {
      await proposed();
      await ss.connect(other).propose(FIX_CASE30, DAY2, TRUE_VALUE, LIE_HASH, { value: BOND });
      await ss.connect(other).propose(FIX_RATIO30, DAY, 11683n, LIE_HASH, { value: BOND }); // 1.1683 ×10⁴
      expect((await ss.proposalOf(FIX_CASE30, DAY2)).status).to.equal(S.Proposed);
      expect((await ss.proposalOf(FIX_RATIO30, DAY)).status).to.equal(S.Proposed);
    });

    it("getFixing refuses to answer for a merely-proposed slot", async function () {
      await proposed();
      await expect(ss.getFixing(FIX_CASE30, DAY)).to.be.revertedWith("SS: not finalized");
    });
  });

  describe("challenge", function () {
    it("a conflicting bonded claim moves the slot to Disputed", async function () {
      await proposed();
      await expect(ss.connect(challenger).challenge(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: BOND }))
        .to.emit(ss, "Challenged").withArgs(FIX_CASE30, DAY, challenger.address, LIE_VALUE, LIE_HASH);
      const f = await ss.proposalOf(FIX_CASE30, DAY);
      expect(f.status).to.equal(S.Disputed);
      expect(f.challenger).to.equal(challenger.address);
      expect(f.chValue).to.equal(LIE_VALUE);
      expect(f.chDataHash).to.equal(LIE_HASH);
      expect(f.challengerBond).to.equal(BOND);
    });

    it("an identical (value, dataHash) claim is not a conflict", async function () {
      await proposed();
      await expect(ss.connect(challenger).challenge(FIX_CASE30, DAY, TRUE_VALUE, TRUE_HASH, { value: BOND }))
        .to.be.revertedWith("SS: not a conflict");
    });

    it("a dataHash-only conflict counts (the hash commits to the whole canonical form)", async function () {
      await proposed();
      await ss.connect(challenger).challenge(FIX_CASE30, DAY, TRUE_VALUE, LIE_HASH, { value: BOND });
      expect((await ss.proposalOf(FIX_CASE30, DAY)).status).to.equal(S.Disputed);
    });

    it("requires the exact bond and a non-empty dataHash", async function () {
      await proposed();
      await expect(ss.connect(challenger).challenge(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: 1n }))
        .to.be.revertedWith("SS: bad bond");
      await expect(ss.connect(challenger).challenge(FIX_CASE30, DAY, LIE_VALUE, ethers.ZeroHash, { value: BOND }))
        .to.be.revertedWith("SS: empty dataHash");
    });

    it("the proposer cannot challenge itself", async function () {
      await proposed();
      await expect(ss.connect(runner).challenge(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: BOND }))
        .to.be.revertedWith("SS: self challenge");
    });

    it("closes with the window", async function () {
      await proposed();
      await time.increase(WINDOW + 1);
      await expect(ss.connect(challenger).challenge(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: BOND }))
        .to.be.revertedWith("SS: window closed");
    });

    it("is still open at the exact last second of the window", async function () {
      await proposed();
      const f = await ss.proposalOf(FIX_CASE30, DAY);
      await time.setNextBlockTimestamp(Number(f.proposedAt) + WINDOW);
      await ss.connect(challenger).challenge(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: BOND });
      expect((await ss.proposalOf(FIX_CASE30, DAY)).status).to.equal(S.Disputed);
    });

    it("cannot challenge an empty slot or an already-disputed one", async function () {
      await expect(ss.connect(challenger).challenge(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: BOND }))
        .to.be.revertedWith("SS: not proposed");
      await disputed();
      await expect(ss.connect(other).challenge(FIX_CASE30, DAY, 1n, ethers.id("third-opinion"), { value: BOND }))
        .to.be.revertedWith("SS: not proposed");
    });
  });

  describe("finalize (unchallenged path)", function () {
    it("refuses while the window is open — including its exact last second", async function () {
      await proposed();
      await expect(ss.finalize(FIX_CASE30, DAY)).to.be.revertedWith("SS: window open");
      const f = await ss.proposalOf(FIX_CASE30, DAY);
      await time.setNextBlockTimestamp(Number(f.proposedAt) + WINDOW);
      await expect(ss.finalize(FIX_CASE30, DAY)).to.be.revertedWith("SS: window open");
    });

    it("anyone finalizes after the window; proposer reclaims the bond", async function () {
      await proposed();
      await time.increase(WINDOW + 1);
      await expect(ss.connect(other).finalize(FIX_CASE30, DAY))
        .to.emit(ss, "Finalized").withArgs(FIX_CASE30, DAY, TRUE_VALUE, TRUE_HASH, false);
      expect((await ss.proposalOf(FIX_CASE30, DAY)).status).to.equal(S.Finalized);
      expect(await ss.withdrawable(runner.address)).to.equal(BOND);
      const [value, dataHash, wasDisputed] = await ss.getFixing(FIX_CASE30, DAY);
      expect(value).to.equal(TRUE_VALUE);
      expect(dataHash).to.equal(TRUE_HASH);
      expect(wasDisputed).to.equal(false);
    });

    it("cannot finalize an empty, disputed, or already-finalized slot", async function () {
      await expect(ss.finalize(FIX_CASE30, DAY)).to.be.revertedWith("SS: not proposed");
      await disputed();
      await time.increase(WINDOW + 1);
      await expect(ss.finalize(FIX_CASE30, DAY)).to.be.revertedWith("SS: not proposed");
      await ss.propose(FIX_CASE30, DAY2, TRUE_VALUE, TRUE_HASH, { value: BOND });
      await time.increase(WINDOW + 1);
      await ss.finalize(FIX_CASE30, DAY2);
      await expect(ss.finalize(FIX_CASE30, DAY2)).to.be.revertedWith("SS: not proposed");
    });

    it("a finalized slot can no longer be challenged", async function () {
      await proposed();
      await time.increase(WINDOW + 1);
      await ss.finalize(FIX_CASE30, DAY);
      await expect(ss.connect(challenger).challenge(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: BOND }))
        .to.be.revertedWith("SS: not proposed");
    });
  });

  describe("resolve (disputed path)", function () {
    it("only the resolver resolves — including after the role moves off the owner", async function () {
      await disputed();
      await expect(ss.connect(other).resolve(FIX_CASE30, DAY, true)).to.be.revertedWith("SS: not resolver");
      await ss.setResolver(other.address);
      await expect(ss.connect(owner).resolve(FIX_CASE30, DAY, true)).to.be.revertedWith("SS: not resolver");
      await ss.connect(other).resolve(FIX_CASE30, DAY, true);
    });

    it("cannot resolve a slot that is not disputed", async function () {
      await expect(ss.resolve(FIX_CASE30, DAY, true)).to.be.revertedWith("SS: not disputed");
      await proposed();
      await expect(ss.resolve(FIX_CASE30, DAY, true)).to.be.revertedWith("SS: not disputed");
    });

    it("proposalValid=true: proposer's value finalizes, proposer takes both bonds", async function () {
      await disputed();
      await expect(ss.resolve(FIX_CASE30, DAY, true))
        .to.emit(ss, "Resolved").withArgs(FIX_CASE30, DAY, true, runner.address)
        .and.to.emit(ss, "Finalized").withArgs(FIX_CASE30, DAY, TRUE_VALUE, TRUE_HASH, true);
      const [value, dataHash, wasDisputed] = await ss.getFixing(FIX_CASE30, DAY);
      expect(value).to.equal(TRUE_VALUE);
      expect(dataHash).to.equal(TRUE_HASH);
      expect(wasDisputed).to.equal(true);
      expect(await ss.withdrawable(runner.address)).to.equal(BOND * 2n);
      expect(await ss.withdrawable(challenger.address)).to.equal(0n);
    });

    it("proposalValid=false: challenger takes the pot and the slot REOPENS (no challenger-fixing)", async function () {
      await disputed(LIE_VALUE, LIE_HASH, TRUE_VALUE, TRUE_HASH); // proposer lied
      await expect(ss.resolve(FIX_CASE30, DAY, false))
        .to.emit(ss, "Resolved").withArgs(FIX_CASE30, DAY, false, challenger.address)
        .and.to.emit(ss, "Reopened").withArgs(FIX_CASE30, DAY);
      expect(await ss.withdrawable(challenger.address)).to.equal(BOND * 2n);
      const f = await ss.proposalOf(FIX_CASE30, DAY);
      expect(f.status).to.equal(S.None); // the challenger's claim was never adopted
      expect(f.proposer).to.equal(ethers.ZeroAddress);
      await expect(ss.getFixing(FIX_CASE30, DAY)).to.be.revertedWith("SS: not finalized");
    });

    it("a reopened slot accepts an honest re-propose with a FRESH window", async function () {
      await disputed(LIE_VALUE, LIE_HASH, TRUE_VALUE, TRUE_HASH);
      await time.increase(WINDOW + 1); // the old window would already be over
      await ss.resolve(FIX_CASE30, DAY, false);
      await ss.connect(other).propose(FIX_CASE30, DAY, TRUE_VALUE, TRUE_HASH, { value: BOND });
      await expect(ss.finalize(FIX_CASE30, DAY)).to.be.revertedWith("SS: window open"); // fresh proposedAt
      await time.increase(WINDOW + 1);
      await ss.finalize(FIX_CASE30, DAY);
      const [value] = await ss.getFixing(FIX_CASE30, DAY);
      expect(value).to.equal(TRUE_VALUE);
    });

    it("a bond-burn war pays the honest challenger every round", async function () {
      for (let round = 0; round < 2; round++) {
        await ss.connect(runner).propose(FIX_CASE30, DAY, LIE_VALUE, LIE_HASH, { value: BOND });
        await ss.connect(challenger).challenge(FIX_CASE30, DAY, TRUE_VALUE, TRUE_HASH, { value: BOND });
        await ss.resolve(FIX_CASE30, DAY, false);
      }
      expect(await ss.withdrawable(challenger.address)).to.equal(BOND * 4n); // 2 rounds × pot
      expect(await ss.withdrawable(runner.address)).to.equal(0n);
      expect((await ss.proposalOf(FIX_CASE30, DAY)).status).to.equal(S.None);
    });
  });

  describe("resolver admin", function () {
    it("setResolver is owner-only, non-zero, and emits", async function () {
      await expect(ss.connect(other).setResolver(other.address)).to.be.reverted; // OZ custom error
      await expect(ss.setResolver(ethers.ZeroAddress)).to.be.revertedWith("SS: zero resolver");
      await expect(ss.setResolver(other.address))
        .to.emit(ss, "ResolverChanged").withArgs(other.address);
      expect(await ss.resolver()).to.equal(other.address);
    });
  });

  describe("withdrawals & bond accounting", function () {
    it("withdraw pays out, zeroes the ledger, and refuses an empty claim", async function () {
      await proposed();
      await time.increase(WINDOW + 1);
      await ss.finalize(FIX_CASE30, DAY);
      const before = await ethers.provider.getBalance(runner.address);
      await expect(ss.connect(runner).withdraw())
        .to.emit(ss, "Withdrawal").withArgs(runner.address, BOND);
      expect(await ss.withdrawable(runner.address)).to.equal(0n);
      expect(await ethers.provider.getBalance(runner.address)).to.be.greaterThan(before);
      await expect(ss.connect(runner).withdraw()).to.be.revertedWith("SS: nothing to withdraw");
    });

    it("bonds are conserved: contract holds exactly the pot until it is withdrawn", async function () {
      const addr = await ss.getAddress();
      await disputed();
      expect(await ethers.provider.getBalance(addr)).to.equal(BOND * 2n);
      await ss.resolve(FIX_CASE30, DAY, true);
      expect(await ethers.provider.getBalance(addr)).to.equal(BOND * 2n); // pull-payment: still escrowed
      await ss.connect(runner).withdraw();
      expect(await ethers.provider.getBalance(addr)).to.equal(0n);
    });
  });
});
