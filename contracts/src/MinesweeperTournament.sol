// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title MinesweeperTournament
/// @notice Escrows entry fees for a shared, real-time competitive Minesweeper round.
///
/// Fairness scheme (commit-reveal):
///   1. The operator (the backend that generates the board) commits to the mine layout by
///      publishing a Merkle root at `startRound`. Each leaf is
///      `keccak256(abi.encode(tileIndex, isMine, nonce))` where
///      `nonce = uint256(keccak256(abi.encode(boardSeed, tileIndex)))` for a secret
///      `boardSeed` only the operator knows.
///   2. A safe-tile reveal (`revealSafeTile`) only needs that one tile's nonce + Merkle
///      proof — never the seed itself or any other tile's nonce — so revealing one tile
///      leaks nothing about the rest of the board.
///   3. After the round ends, the operator publishes `boardSeed` + the full layout via
///      `revealBoard`. The contract re-derives every leaf from the seed, rebuilds the root
///      itself, and reverts if it doesn't match what was committed at `startRound` — so
///      "the board wasn't changed after commitment" is enforced onchain, not just claimed.
///
/// Trust boundary: this proves the committed board was not altered mid-round. It does NOT
/// prove the operator picked an unbiased layout in the first place (the operator still
/// generates the board). Removing that assumption would need player-contributed entropy
/// folded into `boardSeed` — left as a future enhancement.
///
/// Mine hits are intentionally never submitted onchain: only safe reveals move money, so
/// only safe reveals need a transaction. Freezing a player for 5s after a mine hit and
/// notifying them privately is enforced off-chain by the backend broker.
contract MinesweeperTournament is Ownable, ReentrancyGuard {
    enum RoundState {
        Open,
        InProgress,
        Finished,
        Cancelled
    }

    struct Round {
        uint256 entryFee;
        uint16 totalSafeTiles;
        uint16 revealedSafeTiles;
        uint16 minPlayers;
        uint256 pool;
        uint256 rewardPerTile;
        bytes32 merkleRoot;
        RoundState state;
        address[] entrants;
    }

    uint256 public nextRoundId;
    mapping(uint256 => Round) private rounds;
    mapping(uint256 => mapping(address => bool)) public hasEntered;
    mapping(uint256 => mapping(uint16 => bool)) public tileRevealed;
    mapping(uint256 => bool[]) private finalBoard;

    event RoundCreated(uint256 indexed roundId, uint256 entryFee, uint16 totalSafeTiles, uint16 minPlayers);
    event Entered(uint256 indexed roundId, address indexed player, uint256 pool);
    event RoundCancelled(uint256 indexed roundId);
    event RoundStarted(uint256 indexed roundId, bytes32 merkleRoot, uint256 rewardPerTile);
    event TileRevealed(uint256 indexed roundId, uint16 indexed tileIndex, address indexed player, uint256 reward);
    event RoundFinished(uint256 indexed roundId);
    event BoardRevealed(uint256 indexed roundId, uint256 boardSeed);

    error InvalidState();
    error WrongEntryFee();
    error AlreadyEntered();
    error NotEnoughPlayers();
    error TileAlreadyRevealed();
    error NotEntered();
    error InvalidProof();
    error BoardMismatch();
    error TransferFailed();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Opens a new round for entries. `totalSafeTiles` must equal
    ///         (width * height - mineCount) of the board the operator will later commit to.
    function createRound(uint256 entryFee, uint16 totalSafeTiles, uint16 minPlayers)
        external
        onlyOwner
        returns (uint256 roundId)
    {
        roundId = nextRoundId++;
        Round storage r = rounds[roundId];
        r.entryFee = entryFee;
        r.totalSafeTiles = totalSafeTiles;
        r.minPlayers = minPlayers;
        r.state = RoundState.Open;
        emit RoundCreated(roundId, entryFee, totalSafeTiles, minPlayers);
    }

    /// @notice Pays the entry fee and joins the round's prize pool.
    function enter(uint256 roundId) external payable {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Open) revert InvalidState();
        if (msg.value != r.entryFee) revert WrongEntryFee();
        if (hasEntered[roundId][msg.sender]) revert AlreadyEntered();

        hasEntered[roundId][msg.sender] = true;
        r.entrants.push(msg.sender);
        r.pool += msg.value;
        emit Entered(roundId, msg.sender, r.pool);
    }

    /// @notice Escape hatch if a round never reaches `minPlayers` — refunds every entrant.
    function cancelRound(uint256 roundId) external onlyOwner nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Open) revert InvalidState();
        r.state = RoundState.Cancelled;

        uint256 refund = r.entryFee;
        address[] memory entrants = r.entrants;
        for (uint256 i = 0; i < entrants.length; i++) {
            (bool ok,) = entrants[i].call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
        emit RoundCancelled(roundId);
    }

    /// @notice Locks entries and commits to the board via its Merkle root. Reward per tile
    ///         is fixed here as `pool / totalSafeTiles` (equal split across all safe tiles).
    function startRound(uint256 roundId, bytes32 merkleRoot) external onlyOwner {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Open) revert InvalidState();
        if (r.entrants.length < r.minPlayers) revert NotEnoughPlayers();

        r.state = RoundState.InProgress;
        r.merkleRoot = merkleRoot;
        r.rewardPerTile = r.pool / r.totalSafeTiles;
        emit RoundStarted(roundId, merkleRoot, r.rewardPerTile);
    }

    /// @notice Reveals one safe tile and pays out instantly. Reverts if the tile is a mine,
    ///         already claimed, the caller never paid the entry fee, or the proof doesn't
    ///         match the committed root — so only a genuinely safe, not-yet-claimed tile
    ///         revealed by an actual entrant can ever pay out. Whichever valid transaction
    ///         lands first wins the tile; every later one reverts.
    function revealSafeTile(uint256 roundId, uint16 tileIndex, uint256 nonce, bytes32[] calldata proof)
        external
        nonReentrant
    {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.InProgress) revert InvalidState();
        if (tileRevealed[roundId][tileIndex]) revert TileAlreadyRevealed();
        if (!hasEntered[roundId][msg.sender]) revert NotEntered();

        bytes32 leaf = keccak256(abi.encode(tileIndex, false, nonce));
        if (!MerkleProof.verify(proof, r.merkleRoot, leaf)) revert InvalidProof();

        // Effects before interaction.
        tileRevealed[roundId][tileIndex] = true;
        r.revealedSafeTiles += 1;
        bool boardCleared = r.revealedSafeTiles == r.totalSafeTiles;
        if (boardCleared) r.state = RoundState.Finished;

        uint256 reward = r.rewardPerTile;
        emit TileRevealed(roundId, tileIndex, msg.sender, reward);
        if (boardCleared) emit RoundFinished(roundId);

        (bool ok,) = msg.sender.call{value: reward}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Publishes the full mine layout + the seed that derived every tile's nonce,
    ///         and self-verifies it by rebuilding the Merkle root and comparing it to what
    ///         was committed at `startRound`. Reverts if the published board is not what was
    ///         actually committed — this is what makes the reveal publicly checkable rather
    ///         than merely claimed.
    function revealBoard(uint256 roundId, bool[] calldata isMine, uint256 boardSeed) external onlyOwner {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Finished) revert InvalidState();

        uint256 n = isMine.length;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 nonce = uint256(keccak256(abi.encode(boardSeed, i)));
            leaves[i] = keccak256(abi.encode(i, isMine[i], nonce));
        }
        if (_computeRoot(leaves) != r.merkleRoot) revert BoardMismatch();

        finalBoard[roundId] = isMine;
        emit BoardRevealed(roundId, boardSeed);
    }

    /// @dev Sorted-pair Merkle root, matching OpenZeppelin's `MerkleProof` convention. An
    ///      odd node at any level is promoted unhashed to the next level.
    function _computeRoot(bytes32[] memory leaves) private pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 nextLen = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](nextLen);
            for (uint256 i = 0; i < level.length; i += 2) {
                if (i + 1 < level.length) {
                    next[i / 2] = _hashPair(level[i], level[i + 1]);
                } else {
                    next[i / 2] = level[i];
                }
            }
            level = next;
        }
        return level[0];
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function roundInfo(uint256 roundId)
        external
        view
        returns (
            uint256 entryFee,
            uint16 totalSafeTiles,
            uint16 revealedSafeTiles,
            uint16 minPlayers,
            uint256 pool,
            uint256 rewardPerTile,
            bytes32 merkleRoot,
            RoundState state
        )
    {
        Round storage r = rounds[roundId];
        return (
            r.entryFee,
            r.totalSafeTiles,
            r.revealedSafeTiles,
            r.minPlayers,
            r.pool,
            r.rewardPerTile,
            r.merkleRoot,
            r.state
        );
    }

    function entrantsOf(uint256 roundId) external view returns (address[] memory) {
        return rounds[roundId].entrants;
    }

    function finalBoardOf(uint256 roundId) external view returns (bool[] memory) {
        return finalBoard[roundId];
    }
}
