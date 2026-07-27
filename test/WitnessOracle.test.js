// WitnessOracle.test.js — proves the witness-median feed: owner-curated
// registry, per-day idempotent pushes, quorum-gated median (odd/even counts,
// truncation-toward-zero, adversarial orderings, int64 extremes), the
// registry × median interplay (removal excludes, re-add revives), and the
// advisory lastCompleteDay staleness view. Run: npx hardhat test
const { expect } = require("chai");
const { ethers } = require("hardhat");

const FIX = ethers.id("SETTLE-CASE-30D");
const QUORUM = 3;
const DAY = 20260727; // UTC day, YYYYMMDD
const DAY2 = 20260728;
const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

describe("WitnessOracle (quorum-gated witness-median feed)", function () {
  let wo, owner, w1, w2, w3, w4, w5, outsider;

  beforeEach(async function () {
    [owner, w1, w2, w3, w4, w5, outsider] = await ethers.getSigners();
    wo = await ethers.deployContract("WitnessOracle", [FIX, QUORUM]);
  });

  async function registry(...ws) {
    for (const w of ws) await wo.addWitness(w.address);
  }
  async function pushAll(day, entries) {
    for (const [w, v] of entries) await wo.connect(w).push(day, v);
  }

  describe("deployment", function () {
    it("exposes fixingId, quorum, owner; the registry starts empty", async function () {
      expect(await wo.fixingId()).to.equal(FIX);
      expect(await wo.quorum()).to.equal(QUORUM);
      expect(await wo.owner()).to.equal(owner.address);
      expect(await wo.witnessCount()).to.equal(0n);
    });

    it("rejects a zero quorum", async function () {
      await expect(ethers.deployContract("WitnessOracle", [FIX, 0]))
        .to.be.revertedWith("WO: zero quorum");
    });
  });

  describe("registry (owner-curated, v1)", function () {
    it("addWitness registers, emits, and enumerates", async function () {
      await expect(wo.addWitness(w1.address)).to.emit(wo, "WitnessAdded").withArgs(w1.address);
      expect(await wo.isWitness(w1.address)).to.equal(true);
      expect(await wo.witnessCount()).to.equal(1n);
      expect(await wo.getWitnesses()).to.deep.equal([w1.address]);
    });

    it("rejects duplicates and the zero address", async function () {
      await wo.addWitness(w1.address);
      await expect(wo.addWitness(w1.address)).to.be.revertedWith("WO: already witness");
      await expect(wo.addWitness(ethers.ZeroAddress)).to.be.revertedWith("WO: zero witness");
    });

    it("add/remove/setQuorum are owner-only", async function () {
      await expect(wo.connect(outsider).addWitness(w1.address)).to.be.reverted;    // OZ custom error
      await wo.addWitness(w1.address);
      await expect(wo.connect(outsider).removeWitness(w1.address)).to.be.reverted;
      await expect(wo.connect(outsider).setQuorum(1)).to.be.reverted;
    });

    it("removeWitness deregisters, emits, and shrinks the enumeration", async function () {
      await registry(w1, w2, w3);
      await expect(wo.removeWitness(w2.address)).to.emit(wo, "WitnessRemoved").withArgs(w2.address);
      expect(await wo.isWitness(w2.address)).to.equal(false);
      expect(await wo.witnessCount()).to.equal(2n);
      expect(await wo.getWitnesses()).to.not.include(w2.address);
      await expect(wo.removeWitness(w2.address)).to.be.revertedWith("WO: not a witness");
    });

    it("setQuorum updates, emits, and refuses zero", async function () {
      await expect(wo.setQuorum(2)).to.emit(wo, "QuorumChanged").withArgs(2);
      expect(await wo.quorum()).to.equal(2);
      await expect(wo.setQuorum(0)).to.be.revertedWith("WO: zero quorum");
    });
  });

  describe("push", function () {
    it("only registry members push; day 0 is rejected", async function () {
      await expect(wo.connect(outsider).push(DAY, 100n)).to.be.revertedWith("WO: not a witness");
      await wo.addWitness(w1.address);
      await expect(wo.connect(w1).push(0, 100n)).to.be.revertedWith("WO: bad day");
    });

    it("stores the report and emits Pushed(overwrite=false)", async function () {
      await wo.addWitness(w1.address);
      await expect(wo.connect(w1).push(DAY, 17342n))
        .to.emit(wo, "Pushed").withArgs(DAY, w1.address, 17342n, false);
      const [pushed, value] = await wo.reports(DAY, w1.address);
      expect(pushed).to.equal(true);
      expect(value).to.equal(17342n);
      expect(await wo.reportCount(DAY)).to.equal(1n);
    });

    it("re-pushing the same day OVERWRITES — never duplicates the reporter", async function () {
      await wo.addWitness(w1.address);
      await wo.connect(w1).push(DAY, 100n);
      await expect(wo.connect(w1).push(DAY, 105n))
        .to.emit(wo, "Pushed").withArgs(DAY, w1.address, 105n, true);
      const [, value] = await wo.reports(DAY, w1.address);
      expect(value).to.equal(105n);
      expect(await wo.reportCount(DAY)).to.equal(1n); // still one report
    });

    it("days are independent report sets", async function () {
      await registry(w1, w2);
      await wo.connect(w1).push(DAY, 100n);
      await wo.connect(w1).push(DAY2, 200n);
      await wo.connect(w2).push(DAY2, 210n);
      expect(await wo.reportCount(DAY)).to.equal(1n);
      expect(await wo.reportCount(DAY2)).to.equal(2n);
      const [, vA] = await wo.reports(DAY, w1.address);
      const [, vB] = await wo.reports(DAY2, w1.address);
      expect(vA).to.equal(100n);
      expect(vB).to.equal(200n);
    });
  });

  describe("median", function () {
    it("reverts below quorum — an under-attested day is unreadable", async function () {
      await registry(w1, w2, w3);
      await pushAll(DAY, [[w1, 100n], [w2, 105n]]); // 2 < quorum 3
      await expect(wo.median(DAY)).to.be.revertedWith("WO: below quorum");
    });

    it("odd count: the exact middle value", async function () {
      await registry(w1, w2, w3);
      await pushAll(DAY, [[w1, 100n], [w2, 105n], [w3, 200n]]);
      expect(await wo.median(DAY)).to.equal(105n);
    });

    it("even count: the mean of the two middle values", async function () {
      await registry(w1, w2, w3, w4);
      await pushAll(DAY, [[w1, 10n], [w2, 20n], [w3, 30n], [w4, 40n]]);
      expect(await wo.median(DAY)).to.equal(25n);
    });

    it("even count truncates toward zero — positive and negative", async function () {
      await registry(w1, w2, w3, w4);
      await pushAll(DAY, [[w1, 1n], [w2, 3n], [w3, 4n], [w4, 10n]]); // middles 3,4 → 7/2
      expect(await wo.median(DAY)).to.equal(3n);
      await pushAll(DAY2, [[w1, -1n], [w2, -3n], [w3, -4n], [w4, -10n]]); // middles -4,-3 → -7/2
      expect(await wo.median(DAY2)).to.equal(-3n); // toward zero, not floor (-4)
    });

    it("is independent of push order (adversarial orderings agree)", async function () {
      await registry(w1, w2, w3, w4, w5);
      await pushAll(DAY, [[w1, 500n], [w2, 100n], [w3, 300n], [w4, 200n], [w5, 400n]]);
      await pushAll(DAY2, [[w5, 400n], [w4, 200n], [w3, 300n], [w2, 100n], [w1, 500n]]);
      expect(await wo.median(DAY)).to.equal(300n);
      expect(await wo.median(DAY2)).to.equal(300n);
    });

    it("one wild outlier cannot drag the median past its honest neighbours", async function () {
      await registry(w1, w2, w3, w4, w5);
      await pushAll(DAY, [[w1, 99n], [w2, 100n], [w3, 100n], [w4, 101n], [w5, INT64_MAX]]);
      expect(await wo.median(DAY)).to.equal(100n);
    });

    it("survives int64 extremes without overflow (int256 averaging)", async function () {
      await registry(w1, w2, w3, w4);
      await pushAll(DAY, [[w1, INT64_MAX], [w2, INT64_MAX], [w3, INT64_MAX], [w4, INT64_MAX]]);
      expect(await wo.median(DAY)).to.equal(INT64_MAX); // (max+max)/2 must not wrap
      await pushAll(DAY2, [[w1, INT64_MIN], [w2, INT64_MIN], [w3, INT64_MAX]]);
      expect(await wo.median(DAY2)).to.equal(INT64_MIN);
    });

    it("an overwrite moves the median (a witness may correct itself)", async function () {
      await registry(w1, w2, w3);
      await pushAll(DAY, [[w1, 100n], [w2, 100n], [w3, 900n]]);
      expect(await wo.median(DAY)).to.equal(100n);
      await wo.connect(w2).push(DAY, 900n);
      expect(await wo.median(DAY)).to.equal(900n);
    });
  });

  describe("registry × median interplay", function () {
    it("a removed witness's reports stop counting immediately", async function () {
      await registry(w1, w2, w3, w4);
      await pushAll(DAY, [[w1, 100n], [w2, 100n], [w3, 100n], [w4, 999n]]);
      expect(await wo.median(DAY)).to.equal(100n);
      await wo.removeWitness(w4.address); // the outlier is expelled
      expect(await wo.reportCount(DAY)).to.equal(3n);
      expect(await wo.median(DAY)).to.equal(100n); // now the odd-count middle of the honest three
    });

    it("removal below quorum makes the day unreadable again", async function () {
      await registry(w1, w2, w3);
      await pushAll(DAY, [[w1, 100n], [w2, 100n], [w3, 100n]]);
      expect(await wo.median(DAY)).to.equal(100n);
      await wo.removeWitness(w3.address);
      await expect(wo.median(DAY)).to.be.revertedWith("WO: below quorum");
    });

    it("re-adding a witness revives its stored report (registry is the trust root)", async function () {
      await registry(w1, w2, w3);
      await pushAll(DAY, [[w1, 100n], [w2, 100n], [w3, 300n]]);
      await wo.removeWitness(w3.address);
      await expect(wo.median(DAY)).to.be.revertedWith("WO: below quorum");
      await wo.addWitness(w3.address);
      expect(await wo.reportCount(DAY)).to.equal(3n);
      expect(await wo.median(DAY)).to.equal(100n);
    });

    it("median respects a live quorum change in both directions", async function () {
      await registry(w1, w2, w3);
      await pushAll(DAY, [[w1, 100n], [w2, 200n]]);
      await expect(wo.median(DAY)).to.be.revertedWith("WO: below quorum"); // 2 < 3
      await wo.setQuorum(2);
      expect(await wo.median(DAY)).to.equal(150n);
      await wo.setQuorum(3);
      await expect(wo.median(DAY)).to.be.revertedWith("WO: below quorum");
    });
  });

  describe("staleness (lastCompleteDay)", function () {
    it("starts at 0 and advances when a day first meets quorum", async function () {
      expect(await wo.lastCompleteDay()).to.equal(0);
      await registry(w1, w2, w3);
      await wo.connect(w1).push(DAY, 100n);
      await wo.connect(w2).push(DAY, 100n);
      expect(await wo.lastCompleteDay()).to.equal(0); // 2 < quorum
      await expect(wo.connect(w3).push(DAY, 100n))
        .to.emit(wo, "DayCompleted").withArgs(DAY, 3);
      expect(await wo.lastCompleteDay()).to.equal(DAY);
    });

    it("never regresses when an OLDER day completes later", async function () {
      await registry(w1, w2, w3);
      await pushAll(DAY2, [[w1, 100n], [w2, 100n], [w3, 100n]]); // newer day completes first
      expect(await wo.lastCompleteDay()).to.equal(DAY2);
      await pushAll(DAY, [[w1, 90n], [w2, 90n], [w3, 90n]]);     // older day fills in afterwards
      expect(await wo.lastCompleteDay()).to.equal(DAY2);
    });

    it("is advisory: a later removal does not rewind it, but median() re-checks live", async function () {
      await registry(w1, w2, w3);
      await pushAll(DAY, [[w1, 100n], [w2, 100n], [w3, 100n]]);
      expect(await wo.lastCompleteDay()).to.equal(DAY);
      await wo.removeWitness(w3.address);
      expect(await wo.lastCompleteDay()).to.equal(DAY);           // advisory high-water mark
      await expect(wo.median(DAY)).to.be.revertedWith("WO: below quorum"); // the live gate still holds
    });
  });
});
