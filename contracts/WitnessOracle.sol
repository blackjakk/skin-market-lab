// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title WitnessOracle — quorum-gated witness-median feed for one Skindex
/// fixing series.
/// @notice The on-chain aggregation point for the OFF-CHAIN witness protocol
/// (TRUST_ARCHITECTURE.md / methodology.html §6): anyone can fork the Skindex
/// repo and enable Actions, and their fork independently re-derives the full
/// index and every fixing hash from the committed raw files each cycle
/// (witness.yml). This contract lets a curated set of such witnesses PUSH the
/// value they re-derived, per day, and exposes the quorum-gated MEDIAN — the
/// value a majority-honest committee agrees on. One instance attests ONE
/// fixing series (`fixingId`); deploy one per catalog entry.
///
/// VALUE ENCODING: same off-chain convention as SkindexSettlement — `day` is
/// the UTC day as YYYYMMDD; `value` is the re-derived fixing value scaled by
/// the fixing's published decimals (SMLX-6 catalog).
///
/// TRUST MODEL (v1, documented, not hidden):
///  - REGISTRY CURATION IS THE ROOT: the owner picks the witnesses, so a
///    colluding registry is a colluding oracle — v1 upgrades "trust the
///    operator" to "trust that a majority of the named, publicly-auditable
///    witnesses is honest". Each witness's off-chain fork is independently
///    inspectable (red CI on any fork is a public alarm the operator cannot
///    suppress), which is what makes the curation auditable rather than blind.
///  - END-STATE: PERMISSIONLESS STAKED WITNESSES — registration open to
///    anyone bonding stake, slashing by divergence from the settled median,
///    and the SkindexSettlement resolver role replaced by this committee's
///    vote. v1 ships the aggregation semantics (push/overwrite, live-registry
///    filtering, quorum, median) that end-state reuses unchanged.
///  - A REMOVED witness's reports stop counting immediately (median filters
///    by CURRENT membership); RE-ADDING a witness revives its stored reports.
///    Both follow from "the registry is the trust root" and are exercised in
///    the test suite.
///  - `lastCompleteDay` is ADVISORY staleness: it advances when a day first
///    meets quorum and does not retro-regress if later removals drop that day
///    below quorum — `median()` itself always re-checks quorum live.
///  - EVEN-COUNT MEDIAN averages the two middle values with integer division
///    truncating toward zero (Solidity semantics) — at most 1 unit (one
///    10^-decimals step) of rounding, deterministic across nodes.
contract WitnessOracle is Ownable {
    bytes32 public immutable fixingId; // which fixing series this instance attests
    uint32  public quorum;             // min current-registry reports for a median

    address[] private _witnesses;
    mapping(address => bool) public isWitness;

    struct Report {
        bool  pushed;
        int64 value;
    }
    mapping(uint32 => mapping(address => Report)) public reports; // day => witness => report
    mapping(uint32 => address[]) private _reporters;              // day => ever-pushed set

    uint32 public lastCompleteDay; // latest day that reached quorum at push time (advisory)

    event WitnessAdded(address indexed witness);
    event WitnessRemoved(address indexed witness);
    event QuorumChanged(uint32 quorum);
    event Pushed(uint32 indexed day, address indexed witness, int64 value, bool overwrite);
    event DayCompleted(uint32 indexed day, uint256 reportCount);

    constructor(bytes32 _fixingId, uint32 _quorum) Ownable(msg.sender) {
        require(_quorum > 0, "WO: zero quorum");
        fixingId = _fixingId;
        quorum   = _quorum;
    }

    // ─── Registry (owner-curated, v1) ───────────────────────────────────────

    function addWitness(address w) external onlyOwner {
        require(w != address(0), "WO: zero witness");
        require(!isWitness[w], "WO: already witness");
        isWitness[w] = true;
        _witnesses.push(w);
        emit WitnessAdded(w);
    }

    function removeWitness(address w) external onlyOwner {
        require(isWitness[w], "WO: not a witness");
        isWitness[w] = false;
        uint256 n = _witnesses.length;
        for (uint256 i = 0; i < n; i++) {
            if (_witnesses[i] == w) {
                _witnesses[i] = _witnesses[n - 1];
                _witnesses.pop();
                break;
            }
        }
        emit WitnessRemoved(w);
    }

    function setQuorum(uint32 q) external onlyOwner {
        require(q > 0, "WO: zero quorum");
        quorum = q;
        emit QuorumChanged(q);
    }

    // ─── Pushes ─────────────────────────────────────────────────────────────

    /// Report the value this witness independently re-derived for `day`.
    /// Idempotent within a day: re-pushing OVERWRITES the witness's report
    /// (a witness that corrects itself before settlement is a feature), never
    /// duplicates it.
    function push(uint32 day, int64 value) external {
        require(isWitness[msg.sender], "WO: not a witness");
        require(day > 0, "WO: bad day");
        Report storage r = reports[day][msg.sender];
        bool overwrite = r.pushed;
        if (!overwrite) {
            r.pushed = true;
            _reporters[day].push(msg.sender);
        }
        r.value = value;
        emit Pushed(day, msg.sender, value, overwrite);
        if (day > lastCompleteDay) {
            uint256 live = _liveCount(day);
            if (live >= quorum) {
                lastCompleteDay = day;
                emit DayCompleted(day, live);
            }
        }
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// Median of the day's reports from CURRENT registry members. Reverts
    /// below quorum — consumers can never read an under-attested value.
    /// Even count → mean of the two middle values (integer division, toward
    /// zero). Independent of push order.
    function median(uint32 day) external view returns (int64) {
        address[] storage who = _reporters[day];
        uint256 n = who.length;
        int256[] memory vals = new int256[](n);
        uint256 count = 0;
        for (uint256 i = 0; i < n; i++) {
            if (isWitness[who[i]]) {
                vals[count++] = reports[day][who[i]].value;
            }
        }
        require(count >= quorum, "WO: below quorum");
        // insertion sort the first `count` entries (registry sizes are small)
        for (uint256 i = 1; i < count; i++) {
            int256 key = vals[i];
            uint256 j = i;
            while (j > 0 && vals[j - 1] > key) {
                vals[j] = vals[j - 1];
                j--;
            }
            vals[j] = key;
        }
        if (count % 2 == 1) return int64(vals[count / 2]);
        return int64((vals[count / 2 - 1] + vals[count / 2]) / 2);
    }

    /// Reports for `day` that currently count (live-registry filtered).
    function reportCount(uint32 day) external view returns (uint256) {
        return _liveCount(day);
    }

    function witnessCount() external view returns (uint256) {
        return _witnesses.length;
    }

    function getWitnesses() external view returns (address[] memory) {
        return _witnesses;
    }

    function _liveCount(uint32 day) internal view returns (uint256 count) {
        address[] storage who = _reporters[day];
        for (uint256 i = 0; i < who.length; i++) {
            if (isWitness[who[i]]) count++;
        }
    }
}
