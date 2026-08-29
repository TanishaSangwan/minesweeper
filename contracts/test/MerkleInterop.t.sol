// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MinesweeperTournament} from "../src/MinesweeperTournament.sol";

/// @dev Differential test between this contract and the broker's TypeScript commitment code
///      (`server/src/merkle.ts` + `server/src/board.ts`). Every constant below is a golden
///      vector produced by that TypeScript for a fixed board and seed — the root was computed
///      off-chain and is fed to `startRound` verbatim.
///
///      This is the check that the two implementations cannot silently drift. The leaf schema
///      (`tileIndex, isMine, adjacentMines, nonce`), the sorted-pair tree with odd-node
///      promotion, the nonce derivation, and — via `revealBoard` — the neighbour-count rule
///      must all agree byte-for-byte, or the contract cannot reproduce this root. If you
///      change the hashing or the adjacency rule on either side, this test fails until both
///      sides match again.
///
///      Board is 4x3 with 10 mines (safe tiles at 0 and 11) so the board can actually be
///      cleared, which is the only route to `revealBoard` — the function that recomputes
///      every tile's neighbour count on-chain. Hints across the tree are 3,4,5,7, so a
///      miscount anywhere (including on mine tiles, which are also committed) breaks the root.
contract MerkleInteropTest is Test {
    MinesweeperTournament tournament;
    address alice = address(0xA11CE);

    uint16 constant W = 4;
    uint16 constant H = 3;
    uint16 constant TOTAL_SAFE = 2;
    uint256 constant SEED = 123456789;

    /// @dev Computed by server/src/merkle.ts, not by this contract.
    bytes32 constant TS_ROOT = 0x82c24e275b442c3cc753c2f90500c1a275cf622e4cbde439eeacc6701b577e55;

    uint8 constant HINT_0 = 3;
    uint8 constant HINT_11 = 3;
    uint256 constant NONCE_0 =
        61118840945578433118766677210179858416698632854244025329207438107505462835651;
    uint256 constant NONCE_11 =
        15284268143186018632361571665769607104269542327368338907410341773745180450541;

    bool[] isMine;

    function setUp() public {
        tournament = new MinesweeperTournament(address(this));
        vm.deal(alice, 10 ether);

        // hints, per the TypeScript: 3,4,5,3,4,7,7,4,3,5,4,3
        isMine.push(false);
        isMine.push(true);
        isMine.push(true);
        isMine.push(true);
        isMine.push(true);
        isMine.push(true);
        isMine.push(true);
        isMine.push(true);
        isMine.push(true);
        isMine.push(true);
        isMine.push(true);
        isMine.push(false);
    }

    function _proof0() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](4);
        p[0] = 0x157393052c4d0639f1eeca8390e10bfd26509935937ac965c552b03ecb16fd29;
        p[1] = 0x18b051c27780583cfe3540d880f653f98a7ea287ce40700134a3d60b3afd3ded;
        p[2] = 0xf4c6d8a1eea07f62ca91e9c61d80fc4141967db6d9f1f5b55f187e800229d189;
        p[3] = 0xb9c0b318dd1cafa56b317f0a75ef73f485bbd631d962121584f0cc2a415cc143;
    }

    /// @dev Three siblings, not four — tile 11 is promoted unhashed at an odd level, so this
    ///      vector also pins the odd-node promotion rule shared by both implementations.
    function _proof11() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](3);
        p[0] = 0x84b4a4f1aa9b0bd920368b7ac76bd3ac28602cc9862bdec3a5f0630ff7f789d8;
        p[1] = 0x55e2c4a25200b099a2e819cdb538d2833d8b7ad1dca226b2edf72ffe3ec73606;
        p[2] = 0xa567bc919f5241b6405b4c15f6221060885276ebd6e713bd92859e38ddbdbfa0;
    }

    function _startRound() internal returns (uint256 roundId) {
        roundId = tournament.createRound(1 ether, W, H, TOTAL_SAFE, 1);
        vm.prank(alice);
        tournament.enter{value: 1 ether}(roundId);
        tournament.startRound(roundId, TS_ROOT);
    }

    /// @dev Proofs built by the TypeScript verify against the contract's leaf hashing and
    ///      OpenZeppelin's `MerkleProof` — so leaf encoding, tree shape and sibling ordering
    ///      all agree across the two implementations.
    function test_TypeScriptProofsVerifyOnChain() public {
        uint256 roundId = _startRound();

        vm.prank(alice);
        tournament.revealSafeTile(roundId, 0, HINT_0, NONCE_0, _proof0());
        assertTrue(tournament.tileRevealed(roundId, 0));
        assertEq(tournament.tileHint(roundId, 0), HINT_0);

        vm.prank(alice);
        tournament.revealSafeTile(roundId, 11, HINT_11, NONCE_11, _proof11());
        assertEq(tournament.tileHint(roundId, 11), HINT_11);
    }

    /// @dev The one that pins the adjacency rule: `revealBoard` recomputes all 12 neighbour
    ///      counts on-chain and rebuilds the root. It can only match a root the TypeScript
    ///      produced if `_adjacentMines` and `computeAdjacentMines` agree on every tile —
    ///      including the mine tiles, whose hints are committed but never served in play.
    function test_ContractRecomputesTypeScriptRoot() public {
        uint256 roundId = _startRound();

        vm.prank(alice);
        tournament.revealSafeTile(roundId, 0, HINT_0, NONCE_0, _proof0());
        vm.prank(alice);
        tournament.revealSafeTile(roundId, 11, HINT_11, NONCE_11, _proof11());

        (,,,,,,, MinesweeperTournament.RoundState state,,) = tournament.roundInfo(roundId);
        assertEq(uint8(state), uint8(MinesweeperTournament.RoundState.Finished));

        // Reverts with BoardMismatch if the contract's recomputed hints differ anywhere.
        tournament.revealBoard(roundId, isMine, SEED);
        assertEq(tournament.finalBoardOf(roundId).length, 12);
    }

    /// @dev Guards the differential property itself: if the contract ignored adjacency (or
    ///      computed it differently), a board with the same mines but a different neighbour
    ///      structure would still reconcile. Moving a mine must break the root.
    function test_DifferentLayoutDoesNotReconcile() public {
        uint256 roundId = _startRound();

        vm.prank(alice);
        tournament.revealSafeTile(roundId, 0, HINT_0, NONCE_0, _proof0());
        vm.prank(alice);
        tournament.revealSafeTile(roundId, 11, HINT_11, NONCE_11, _proof11());

        bool[] memory moved = new bool[](12);
        for (uint256 i = 0; i < 12; i++) moved[i] = isMine[i];
        // Swap a mine into a safe slot and vice versa: same mine count, different hints.
        moved[0] = true;
        moved[5] = false;

        vm.expectRevert(MinesweeperTournament.BoardMismatch.selector);
        tournament.revealBoard(roundId, moved, SEED);
    }

    /// @dev A board of the wrong size for the round's declared dimensions is rejected before
    ///      it can index out of bounds during neighbour counting.
    function test_WrongSizedBoardRejected() public {
        uint256 roundId = _startRound();

        vm.prank(alice);
        tournament.revealSafeTile(roundId, 0, HINT_0, NONCE_0, _proof0());
        vm.prank(alice);
        tournament.revealSafeTile(roundId, 11, HINT_11, NONCE_11, _proof11());

        bool[] memory short = new bool[](11);
        vm.expectRevert(MinesweeperTournament.BoardMismatch.selector);
        tournament.revealBoard(roundId, short, SEED);
    }
}
