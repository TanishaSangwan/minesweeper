// Mirrors MinesweeperTournament.sol exactly:
//   nonce_i = uint256(keccak256(abi.encode(boardSeed, i)))
//   leaf_i  = keccak256(abi.encode(tileIndex, isMine, adjacentMines, nonce))
//   node    = sorted-pair keccak256(abi.encodePacked(a, b)), odd node promoted unhashed
// Solidity's abi.encode pads every uintN to a 32-byte word identically regardless of
// declared width, so using `uint256` for every integer here produces byte-identical
// encodings to the contract's uint16 tileIndex and uint8 adjacentMines — see the contract's
// NatSpec for why this is safe rather than a mismatch.
import { encodeAbiParameters, encodePacked, keccak256, parseAbiParameters, type Hex } from "viem";

export function nonceForTile(boardSeed: bigint, tileIndex: number): bigint {
  const encoded = encodeAbiParameters(parseAbiParameters("uint256, uint256"), [
    boardSeed,
    BigInt(tileIndex),
  ]);
  return BigInt(keccak256(encoded));
}

export function leafHash(
  tileIndex: number,
  isMine: boolean,
  adjacentMines: number,
  nonce: bigint,
): Hex {
  const encoded = encodeAbiParameters(parseAbiParameters("uint256, bool, uint256, uint256"), [
    BigInt(tileIndex),
    isMine,
    BigInt(adjacentMines),
    nonce,
  ]);
  return keccak256(encoded);
}

function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(encodePacked(["bytes32", "bytes32"], [lo, hi]));
}

function nextLevel(level: Hex[]): Hex[] {
  const next: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) {
    next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
  }
  return next;
}

export function computeRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) throw new Error("cannot build a Merkle root from zero leaves");
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

/** Proof for `leaves[index]`, siblings ordered bottom-up — matches OpenZeppelin's MerkleProof.verify. */
export function proofFor(leaves: Hex[], index: number): Hex[] {
  const proof: Hex[] = [];
  let level = leaves;
  let idx = index;
  while (level.length > 1) {
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pairIdx < level.length) proof.push(level[pairIdx]);
    level = nextLevel(level);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export interface BoardCommitment {
  isMine: boolean[];
  adjacentMines: number[];
  boardSeed: bigint;
  nonces: bigint[];
  leaves: Hex[];
  root: Hex;
}

/** Builds the full commitment for a generated board: nonces, leaves, root, and per-tile proofs.
 *  `adjacentMines` is committed alongside `isMine` so the hint a player is served for a tile is
 *  bound to the root and cannot be altered mid-round — see the contract's NatSpec. */
export function commitBoard(
  isMine: boolean[],
  adjacentMines: number[],
  boardSeed: bigint,
): BoardCommitment {
  if (adjacentMines.length !== isMine.length) {
    throw new Error("adjacentMines and isMine must describe the same number of tiles");
  }
  const nonces = isMine.map((_, i) => nonceForTile(boardSeed, i));
  const leaves = isMine.map((mine, i) => leafHash(i, mine, adjacentMines[i], nonces[i]));
  const root = computeRoot(leaves);
  return { isMine, adjacentMines, boardSeed, nonces, leaves, root };
}
