// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title SkindexSettlement — optimistic, challenge-by-re-derivation settlement of
/// dated Skindex fixings (SMLX-6).
/// @notice Brings a published Skindex fixing on chain WITHOUT trusting the poster.
/// A fixing value is *proven from a publicly re-derivable artifact*, never typed
/// in by an admin:
///
///   1. BONDED PROPOSE. A runner posts the claimed `(fixingId, day, value,
///      dataHash)` with a bond. `dataHash` is the fixing's published SHA-256
///      commitment: sha256 over the canonical form
///      `{methodology:"SMLX-6", name, window, days, values, value}` exactly as
///      settlement.js `canonical()` serializes it — the same hash published in
///      `data/settlement.json` and appended to `data/settlements.jsonl`.
///   2. OPTIMISTIC CHALLENGE. Anyone may, within `challengeWindow`, post a
///      CONFLICTING `(value, dataHash)` with a matching bond. Re-deriving the
///      fixing is deterministic — the committed daily series plus the SMLX-6
///      rules give one byte-exact canonical form — so an honest challenger can
///      always reproduce the true value and hash. The recipe is public
///      (methodology.html §6 "Verification — check the operator"): in-browser
///      re-derivation, the shell one-liner
///      `node -e "const S=require('./settlement.js'), ... S.canonical(f)"`,
///      and the continuous witness protocol (fork the repo, enable Actions,
///      witness.yml re-derives every publication each cycle).
///   3. SETTLE. Unchallenged after the window -> `finalize()` by anyone,
///      proposer reclaims the bond. Challenged -> the `resolver` re-derives the
///      artifact off-chain and rules `resolve(proposalValid)`; the loser's bond
///      goes to the winner.
///
/// The chain never recomputes the fixing — it adjudicates commitments to a
/// public, independently re-derivable artifact.
///
/// VALUE ENCODING (off-chain convention, documented here, not enforced):
///  - `day` is the fixing's UTC day encoded YYYYMMDD (e.g. 20260727) — the
///    numeric form of the published series' "YYYY-MM-DD" day keys.
///  - `value` is the fixing value scaled by 10^decimals per the SMLX-6 catalog
///    spec: SETTLE-CASE-7D/30D publish 2 decimals (x100); SETTLE-RATIO-30D
///    publishes 4 decimals (x10000). The catalog is ADDITIVE — a new fixing
///    (e.g. SETTLE-CASE-90D) carries its own decimals in its published spec.
///  - `fixingId` = keccak256 of the fixing's frozen name string (see
///    `fixingIdOf`), e.g. fixingIdOf("SETTLE-CASE-30D").
///
/// KNOWN LIMITS (v1, documented, not hidden):
///  - RESOLVER TRUST: the resolver (defaults to the deployer; an EOA or
///    multisig) adjudicates disputes with a single boolean. A corrupt resolver
///    can finalize a lie or reject the truth, and a vanished resolver strands a
///    disputed day's bonds (no dispute timeout in v1). END-STATE: replace the
///    single referee with a WITNESS-COMMITTEE VOTE — the WitnessOracle registry
///    already aggregates independently re-derived values per day, and the
///    off-chain witness network (forks running witness.yml) computes exactly
///    the evidence such a vote needs every cycle. Until then, treat the
///    resolver like the off-chain operator: verifiable, not trustless.
///  - COMMITMENT, NOT PROOF: `dataHash` commits to the off-chain artifact; the
///    chain cannot detect a rewrite of the committed `data/` history that
///    re-derives self-consistently. That fork is caught off-chain by
///    independent witnesses holding their own clones (TRUST_ARCHITECTURE.md).
///  - NO CHALLENGER-FIXING: a rejected proposal REOPENS the (fixingId, day)
///    slot instead of adopting the challenger's counter-claim — the resolver's
///    boolean attests only that the proposal is NOT the canonical
///    re-derivation, never that the challenger's value is. Honest parties
///    re-propose against the same public data; a liar burning a bond each
///    round pays the challenger each round, so censorship-by-reproposal is
///    economically self-limiting, not free.
contract SkindexSettlement is Ownable {
    uint256 public immutable bondAmount;      // wei required to propose or challenge
    uint256 public immutable challengeWindow; // seconds a proposal stays open

    address public resolver; // the re-derivation referee (defaults to owner)

    enum Status {
        None,      // 0 no proposal (or a rejected proposal was cleared)
        Proposed,  // 1 bonded value posted; challenge window open
        Disputed,  // 2 conflicting bonded value; awaiting resolve
        Finalized  // 3 settled; getFixing() answers
    }

    struct Fixing {
        Status  status;
        address proposer;
        uint64  proposedAt;
        int64   value;          // scaled per the fixing's published decimals
        bytes32 dataHash;       // sha256(canonical form) — the published fixing hash
        uint256 proposerBond;
        address challenger;
        int64   chValue;
        bytes32 chDataHash;
        uint256 challengerBond;
    }

    mapping(bytes32 => mapping(uint32 => Fixing)) public fixings; // fixingId => day => Fixing
    mapping(address => uint256) public withdrawable;              // pull-payment ledger

    event Proposed(bytes32 indexed fixingId, uint32 indexed day, address indexed proposer, int64 value, bytes32 dataHash);
    event Challenged(bytes32 indexed fixingId, uint32 indexed day, address indexed challenger, int64 value, bytes32 dataHash);
    event Finalized(bytes32 indexed fixingId, uint32 indexed day, int64 value, bytes32 dataHash, bool disputed);
    event Resolved(bytes32 indexed fixingId, uint32 indexed day, bool proposalValid, address winner);
    event Reopened(bytes32 indexed fixingId, uint32 indexed day);
    event ResolverChanged(address indexed resolver);
    event Withdrawal(address indexed who, uint256 amount);

    constructor(uint256 _bondAmount, uint256 _challengeWindow) Ownable(msg.sender) {
        require(_bondAmount > 0, "SS: zero bond");        // a free bond makes spam free
        require(_challengeWindow > 0, "SS: zero window"); // no window = no optimistic phase
        bondAmount      = _bondAmount;
        challengeWindow = _challengeWindow;
        resolver        = msg.sender;
    }

    modifier onlyResolver() {
        require(msg.sender == resolver, "SS: not resolver");
        _;
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    function setResolver(address r) external onlyOwner {
        require(r != address(0), "SS: zero resolver");
        resolver = r;
        emit ResolverChanged(r);
    }

    // ─── 1. Bonded propose / 2. challenge ───────────────────────────────────

    /// Post a bonded fixing claim for (fixingId, day). One live proposal per
    /// slot; a REJECTED proposal clears the slot so an honest one can re-run.
    function propose(bytes32 fixingId, uint32 day, int64 value, bytes32 dataHash) external payable {
        Fixing storage f = fixings[fixingId][day];
        require(f.status == Status.None, "SS: exists");
        require(day > 0, "SS: bad day");
        require(msg.value == bondAmount, "SS: bad bond");
        require(dataHash != bytes32(0), "SS: empty dataHash");
        f.status       = Status.Proposed;
        f.proposer     = msg.sender;
        f.proposedAt   = uint64(block.timestamp);
        f.value        = value;
        f.dataHash     = dataHash;
        f.proposerBond = msg.value;
        emit Proposed(fixingId, day, msg.sender, value, dataHash);
    }

    /// Dispute a live proposal with a conflicting re-derivation. The conflict
    /// may be in the value, the dataHash, or both — a hash conflict alone
    /// matters because the hash commits to the whole canonical form (window
    /// membership, per-day values), not just the headline mean.
    function challenge(bytes32 fixingId, uint32 day, int64 value, bytes32 dataHash) external payable {
        Fixing storage f = fixings[fixingId][day];
        require(f.status == Status.Proposed, "SS: not proposed");
        require(block.timestamp <= f.proposedAt + challengeWindow, "SS: window closed");
        require(msg.value == bondAmount, "SS: bad bond");
        require(dataHash != bytes32(0), "SS: empty dataHash");
        require(value != f.value || dataHash != f.dataHash, "SS: not a conflict");
        require(msg.sender != f.proposer, "SS: self challenge");
        f.status         = Status.Disputed;
        f.challenger     = msg.sender;
        f.chValue        = value;
        f.chDataHash     = dataHash;
        f.challengerBond = msg.value;
        emit Challenged(fixingId, day, msg.sender, value, dataHash);
    }

    // ─── 3. Settle ──────────────────────────────────────────────────────────

    /// Unchallenged after the window → anyone finalizes; proposer reclaims the bond.
    function finalize(bytes32 fixingId, uint32 day) external {
        Fixing storage f = fixings[fixingId][day];
        require(f.status == Status.Proposed, "SS: not proposed");
        require(block.timestamp > f.proposedAt + challengeWindow, "SS: window open");
        f.status = Status.Finalized;
        _credit(f.proposer, f.proposerBond);
        emit Finalized(fixingId, day, f.value, f.dataHash, false);
    }

    /// Resolve a DISPUTED fixing. The resolver re-derives the artifact
    /// off-chain (settlement.js recipe / witness evidence — see the contract
    /// notice) and rules on the PROPOSAL only:
    ///  - valid   → finalize the proposer's value; proposer takes both bonds.
    ///  - invalid → challenger takes both bonds and the slot REOPENS (status
    ///    None) so an honest proposal can re-run — the challenger's counter-
    ///    claim is evidence for the ruling, never the settled value itself.
    function resolve(bytes32 fixingId, uint32 day, bool proposalValid) external onlyResolver {
        Fixing storage f = fixings[fixingId][day];
        require(f.status == Status.Disputed, "SS: not disputed");
        uint256 pot = f.proposerBond + f.challengerBond;
        if (proposalValid) {
            f.status = Status.Finalized;
            _credit(f.proposer, pot);
            emit Resolved(fixingId, day, true, f.proposer);
            emit Finalized(fixingId, day, f.value, f.dataHash, true);
        } else {
            address challengerAddr = f.challenger;
            delete fixings[fixingId][day]; // reopen the canonical slot
            _credit(challengerAddr, pot);
            emit Resolved(fixingId, day, false, challengerAddr);
            emit Reopened(fixingId, day);
        }
    }

    // ─── Pull-payment withdrawals ───────────────────────────────────────────

    function _credit(address who, uint256 amount) internal {
        if (amount > 0) withdrawable[who] += amount;
    }

    function withdraw() external {
        uint256 amount = withdrawable[msg.sender];
        require(amount > 0, "SS: nothing to withdraw");
        withdrawable[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "SS: transfer failed");
        emit Withdrawal(msg.sender, amount);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// The settled fixing. Reverts unless finalized — consumers can never read
    /// a provisional or disputed value by accident.
    function getFixing(bytes32 fixingId, uint32 day) external view returns (
        int64 value, bytes32 dataHash, bool disputed
    ) {
        Fixing storage f = fixings[fixingId][day];
        require(f.status == Status.Finalized, "SS: not finalized");
        return (f.value, f.dataHash, f.challenger != address(0));
    }

    /// Full slot state for UIs/monitors (any status; None = all-zero).
    function proposalOf(bytes32 fixingId, uint32 day) external view returns (Fixing memory) {
        return fixings[fixingId][day];
    }

    /// The id convention: keccak256 of the frozen fixing name string
    /// (e.g. "SETTLE-CASE-30D" — SMLX-* codes and SETTLE-* ids are frozen
    /// identifiers, never renamed).
    function fixingIdOf(string calldata name) external pure returns (bytes32) {
        return keccak256(bytes(name));
    }
}
