// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MinesweeperTournament} from "../src/MinesweeperTournament.sol";

/// @dev Builds Merkle trees/proofs independently of the contract's internal (private)
///      helpers, using the exact same sorted-pair hashing + odd-node-promotion rule, so a
///      pass here proves the public interface is self-consistent (not just that the
///      contract agrees with itself).
contract MinesweeperTournamentTest is Test {
    MinesweeperTournament tournament;
    address owner = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    // Fixed 4-tile test board: indices 0,1 safe; indices 2,3 mines.
    uint256 constant BOARD_SEED = 42;
    uint16 constant TOTAL_TILES = 4;
    uint16 constant TOTAL_SAFE = 2;

    bool[] isMine;
    bytes32[] leaves;
    bytes32 root;

    function setUp() public {
        tournament = new MinesweeperTournament(owner);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);

        isMine.push(false);
        isMine.push(false);
        isMine.push(true);
        isMine.push(true);

        for (uint16 i = 0; i < TOTAL_TILES; i++) {
            leaves.push(keccak256(abi.encode(i, isMine[i], _nonce(i))));
        }
        root = _computeRoot(leaves);
    }

    function _nonce(uint16 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(BOARD_SEED, uint256(i))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _computeRoot(bytes32[] memory level) internal pure returns (bytes32) {
        while (level.length > 1) {
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2) {
                next[i / 2] = (i + 1 < level.length) ? _hashPair(level[i], level[i + 1]) : level[i];
            }
            level = next;
        }
        return level[0];
    }

    /// @dev Proof for `leaves[index]`, mirroring the same pairing/promotion rule as the tree.
    function _proof(uint256 index) internal view returns (bytes32[] memory) {
        bytes32[] memory level = leaves;
        uint256 idx = index;
        bytes32[] memory buf = new bytes32[](32);
        uint256 len = 0;

        while (level.length > 1) {
            uint256 pairIdx = idx % 2 == 0 ? idx + 1 : idx - 1;
            if (pairIdx < level.length) buf[len++] = level[pairIdx];

            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2) {
                next[i / 2] = (i + 1 < level.length) ? _hashPair(level[i], level[i + 1]) : level[i];
            }
            level = next;
            idx = idx / 2;
        }

        bytes32[] memory proof = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) proof[i] = buf[i];
        return proof;
    }

    function _createAndStartRound() internal returns (uint256 roundId) {
        roundId = tournament.createRound(1 ether, TOTAL_SAFE, 2);
        vm.prank(alice);
        tournament.enter{value: 1 ether}(roundId);
        vm.prank(bob);
        tournament.enter{value: 1 ether}(roundId);
        tournament.startRound(roundId, root);
    }

    function test_RevealSafeTilePaysOutEqualSplit() public {
        uint256 roundId = _createAndStartRound();
        uint256 balBefore = alice.balance;

        vm.prank(alice);
        tournament.revealSafeTile(roundId, 0, _nonce(0), _proof(0));

        // pool = 2 ether, totalSafeTiles = 2 -> reward = 1 ether per tile.
        assertEq(alice.balance, balBefore + 1 ether);
        assertTrue(tournament.tileRevealed(roundId, 0));
    }

    function test_DuplicateRevealReverts() public {
        uint256 roundId = _createAndStartRound();
        vm.prank(alice);
        tournament.revealSafeTile(roundId, 0, _nonce(0), _proof(0));

        vm.prank(bob);
        vm.expectRevert(MinesweeperTournament.TileAlreadyRevealed.selector);
        tournament.revealSafeTile(roundId, 0, _nonce(0), _proof(0));
    }

    function test_MineTileCannotBeClaimedAsSafe() public {
        uint256 roundId = _createAndStartRound();
        // tile 2 is a mine; claiming it as safe (isMine=false) must fail proof verification.
        vm.prank(alice);
        vm.expectRevert(MinesweeperTournament.InvalidProof.selector);
        tournament.revealSafeTile(roundId, 2, _nonce(2), _proof(2));
    }

    function test_BoardClearedFinishesRoundAndPublishesBoard() public {
        uint256 roundId = _createAndStartRound();
        vm.prank(alice);
        tournament.revealSafeTile(roundId, 0, _nonce(0), _proof(0));
        vm.prank(bob);
        tournament.revealSafeTile(roundId, 1, _nonce(1), _proof(1));

        (,,,,,,, MinesweeperTournament.RoundState state) = tournament.roundInfo(roundId);
        assertEq(uint8(state), uint8(MinesweeperTournament.RoundState.Finished));

        tournament.revealBoard(roundId, isMine, BOARD_SEED);
        bool[] memory published = tournament.finalBoardOf(roundId);
        assertEq(published.length, TOTAL_TILES);
        assertTrue(published[2]);
        assertTrue(published[3]);
    }

    function test_RevealBoardRejectsTamperedBoard() public {
        uint256 roundId = _createAndStartRound();
        vm.prank(alice);
        tournament.revealSafeTile(roundId, 0, _nonce(0), _proof(0));
        vm.prank(bob);
        tournament.revealSafeTile(roundId, 1, _nonce(1), _proof(1));

        bool[] memory tampered = new bool[](4);
        tampered[0] = false;
        tampered[1] = false;
        tampered[2] = false; // lies: claims tile 2 (an actual mine) was safe
        tampered[3] = true;

        vm.expectRevert(MinesweeperTournament.BoardMismatch.selector);
        tournament.revealBoard(roundId, tampered, BOARD_SEED);
    }

    function test_CancelRoundRefundsEntrants() public {
        uint256 roundId = tournament.createRound(1 ether, TOTAL_SAFE, 2);
        vm.prank(alice);
        tournament.enter{value: 1 ether}(roundId);

        uint256 balBefore = alice.balance;
        tournament.cancelRound(roundId);
        assertEq(alice.balance, balBefore + 1 ether);
    }

    function test_StartRoundRevertsBelowMinPlayers() public {
        uint256 roundId = tournament.createRound(1 ether, TOTAL_SAFE, 2);
        vm.prank(alice);
        tournament.enter{value: 1 ether}(roundId);

        vm.expectRevert(MinesweeperTournament.NotEnoughPlayers.selector);
        tournament.startRound(roundId, root);
    }

    function test_WrongEntryFeeReverts() public {
        uint256 roundId = tournament.createRound(1 ether, TOTAL_SAFE, 2);
        vm.prank(alice);
        vm.expectRevert(MinesweeperTournament.WrongEntryFee.selector);
        tournament.enter{value: 0.5 ether}(roundId);
    }
}
