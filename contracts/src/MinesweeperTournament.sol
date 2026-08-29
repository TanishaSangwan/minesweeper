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
///      `keccak256(abi.encode(tileIndex, isMine, adjacentMines, nonce))` where
///      `nonce = uint256(keccak256(abi.encode(boardSeed, tileIndex)))` for a secret
///      `boardSeed` only the operator knows, and `adjacentMines` is the Minesweeper hint —
///      the number of mines in that tile's up-to-8 neighbours.
///   2. A safe-tile reveal (`revealSafeTile`) only needs that one tile's hint + nonce +
///      Merkle proof — never the seed itself or any other tile's nonce — so revealing one
///      tile leaks nothing about the rest of the board beyond its own hint. Because the hint
///      is inside the committed leaf, a caller cannot claim a tile with a made-up number:
///      the proof only verifies against the count the operator committed to before play.
///   3. After the round ends, the operator publishes `boardSeed` + the full layout via
///      `revealBoard`. The contract re-derives every leaf from the seed — recomputing every
///      tile's `adjacentMines` itself from the published layout — rebuilds the root, and
///      reverts if it doesn't match what was committed at `startRound`. So both "the board
///      wasn't changed after commitment" and "every hint served during play was the true
///      neighbour count for that layout" are enforced onchain, not just claimed.
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
        uint16 width;
        uint16 height;
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
    /// @notice Neighbour-mine count of each revealed tile. Only meaningful where
    ///         `tileRevealed` is true (an unrevealed tile reads 0, same as a true 0-hint).
    ///         Stored, not just emitted, so a client joining mid-round can read the board
    ///         state it missed instead of depending on having listened to every event.
    mapping(uint256 => mapping(uint16 => uint8)) public tileHint;
    mapping(uint256 => bool[]) private finalBoard;

    event RoundCreated(
        uint256 indexed roundId,
        uint256 entryFee,
        uint16 width,
        uint16 height,
        uint16 totalSafeTiles,
        uint16 minPlayers
    );
    event Entered(uint256 indexed roundId, address indexed player, uint256 pool);
    event RoundCancelled(uint256 indexed roundId);
    event RoundStarted(uint256 indexed roundId, bytes32 merkleRoot, uint256 rewardPerTile);
    /// @dev `adjacentMines` is the public Minesweeper hint — every client sees it, while only
    ///      `player` is paid. `roundId`/`tileIndex`/`player` already use all three indexed
    ///      topic slots, so the hint travels in the data section.
    event TileRevealed(
        uint256 indexed roundId,
        uint16 indexed tileIndex,
        address indexed player,
        uint8 adjacentMines,
        uint256 reward
    );
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
    error InvalidDimensions();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Opens a new round for entries. `totalSafeTiles` must equal
    ///         (width * height - mineCount) of the board the operator will later commit to.
    /// @dev `width`/`height` are stored because `revealBoard` recomputes every tile's
    ///      neighbour count from the published layout to check it against the commitment —
    ///      that check is only possible if the grid shape is known onchain.
    function createRound(
        uint256 entryFee,
        uint16 width,
        uint16 height,
        uint16 totalSafeTiles,
        uint16 minPlayers
    ) external onlyOwner returns (uint256 roundId) {
        if (width == 0 || height == 0) revert InvalidDimensions();
        uint256 totalTiles = uint256(width) * height;
        // Tile indices are uint16 everywhere (`revealSafeTile`, `tileRevealed`, `tileHint`),
        // so a larger grid would contain tiles nobody could ever address or reveal — and the
        // round could never reach `totalSafeTiles` and finish. Bounding it here is what makes
        // the uint16 narrowing in `revealedTiles` safe.
        if (totalTiles > type(uint16).max) revert InvalidDimensions();
        if (totalSafeTiles == 0 || totalSafeTiles > totalTiles) revert InvalidDimensions();

        roundId = nextRoundId++;
        Round storage r = rounds[roundId];
        r.entryFee = entryFee;
        r.width = width;
        r.height = height;
        r.totalSafeTiles = totalSafeTiles;
        r.minPlayers = minPlayers;
        r.state = RoundState.Open;
        emit RoundCreated(roundId, entryFee, width, height, totalSafeTiles, minPlayers);
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
    ///
    ///         `adjacentMines` is the tile's Minesweeper hint. It is part of the committed
    ///         leaf, so a caller passing anything other than the committed count fails proof
    ///         verification — the number cannot be forged. It is emitted on `TileRevealed`,
    ///         which is public: the hint becomes visible to every player, while `reward` goes
    ///         only to `msg.sender`. Revealing to everyone and paying one player are
    ///         deliberately decoupled.
    function revealSafeTile(
        uint256 roundId,
        uint16 tileIndex,
        uint8 adjacentMines,
        uint256 nonce,
        bytes32[] calldata proof
    ) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.InProgress) revert InvalidState();
        if (tileRevealed[roundId][tileIndex]) revert TileAlreadyRevealed();
        if (!hasEntered[roundId][msg.sender]) revert NotEntered();

        bytes32 leaf = keccak256(abi.encode(tileIndex, false, adjacentMines, nonce));
        if (!MerkleProof.verify(proof, r.merkleRoot, leaf)) revert InvalidProof();

        // Effects before interaction.
        tileRevealed[roundId][tileIndex] = true;
        tileHint[roundId][tileIndex] = adjacentMines;
        r.revealedSafeTiles += 1;
        bool boardCleared = r.revealedSafeTiles == r.totalSafeTiles;
        if (boardCleared) r.state = RoundState.Finished;

        uint256 reward = r.rewardPerTile;
        emit TileRevealed(roundId, tileIndex, msg.sender, adjacentMines, reward);
        if (boardCleared) emit RoundFinished(roundId);

        (bool ok,) = msg.sender.call{value: reward}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Publishes the full mine layout + the seed that derived every tile's nonce,
    ///         and self-verifies it by rebuilding the Merkle root and comparing it to what
    ///         was committed at `startRound`. Reverts if the published board is not what was
    ///         actually committed — this is what makes the reveal publicly checkable rather
    ///         than merely claimed.
    ///
    ///         Every tile's `adjacentMines` is recomputed here from `isMine` rather than
    ///         taken as input, so the rebuilt root only matches if each hint served during
    ///         play was the genuine neighbour count for this layout. An operator that fed
    ///         players doctored numbers cannot produce a board that reconciles.
    function revealBoard(uint256 roundId, bool[] calldata isMine, uint256 boardSeed) external onlyOwner {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Finished) revert InvalidState();

        uint256 width = r.width;
        uint256 n = isMine.length;
        if (n != width * r.height) revert BoardMismatch();

        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 nonce = uint256(keccak256(abi.encode(boardSeed, i)));
            uint8 adjacentMines = _adjacentMines(isMine, i, width, r.height);
            leaves[i] = keccak256(abi.encode(i, isMine[i], adjacentMines, nonce));
        }
        if (_computeRoot(leaves) != r.merkleRoot) revert BoardMismatch();

        finalBoard[roundId] = isMine;
        emit BoardRevealed(roundId, boardSeed);
    }

    /// @dev Mines among tile `index`'s up-to-8 neighbours on a `width` x `height` grid,
    ///      indexed row-major. Clamped at the edges — corners have 3 neighbours, not 8.
    ///      `server/src/board.ts` mirrors this exactly; the two must change together.
    function _adjacentMines(bool[] calldata isMine, uint256 index, uint256 width, uint256 height)
        private
        pure
        returns (uint8 count)
    {
        uint256 x = index % width;
        uint256 y = index / width;
        uint256 xStart = x == 0 ? 0 : x - 1;
        uint256 xEnd = x + 1 >= width ? width - 1 : x + 1;
        uint256 yStart = y == 0 ? 0 : y - 1;
        uint256 yEnd = y + 1 >= height ? height - 1 : y + 1;

        for (uint256 ny = yStart; ny <= yEnd; ny++) {
            for (uint256 nx = xStart; nx <= xEnd; nx++) {
                if (nx == x && ny == y) continue;
                if (isMine[ny * width + nx]) count++;
            }
        }
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
            RoundState state,
            uint16 width,
            uint16 height
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
            r.state,
            r.width,
            r.height
        );
    }

    /// @notice Every tile's revealed state + hint in one call, so a client joining mid-round
    ///         can rebuild the visible board without replaying the event log.
    function revealedTiles(uint256 roundId)
        external
        view
        returns (bool[] memory revealed, uint8[] memory hints)
    {
        Round storage r = rounds[roundId];
        // `createRound` caps width * height at type(uint16).max, so `i` always fits a uint16
        // and the narrowing below cannot truncate.
        uint16 n = uint16(uint256(r.width) * r.height);
        revealed = new bool[](n);
        hints = new uint8[](n);
        for (uint16 i = 0; i < n; i++) {
            revealed[i] = tileRevealed[roundId][i];
            hints[i] = tileHint[roundId][i];
        }
    }

    function entrantsOf(uint256 roundId) external view returns (address[] memory) {
        return rounds[roundId].entrants;
    }

    function finalBoardOf(uint256 roundId) external view returns (bool[] memory) {
        return finalBoard[roundId];
    }
}
