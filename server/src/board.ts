import { randomBytes, randomInt } from "node:crypto";
import { commitBoard, type BoardCommitment } from "./merkle.js";

export interface BoardConfig {
  width: number;
  height: number;
  mineCount: number;
}

export interface GeneratedBoard extends BoardCommitment {
  width: number;
  height: number;
  totalTiles: number;
  totalSafeTiles: number;
}

/** Cryptographically random 256-bit board seed — the "random number" committed via the root
 *  at round start and only published in cleartext once the round is Finished. */
function randomBoardSeed(): bigint {
  return BigInt("0x" + randomBytes(32).toString("hex"));
}

/** Mines among each tile's up-to-8 neighbours on a row-major `width` x `height` grid — the
 *  classic Minesweeper hint. Mirrors `_adjacentMines` in MinesweeperTournament.sol exactly
 *  (edges clamp, so a corner has 3 neighbours); the two must change together, or `revealBoard`
 *  will reject the published board at the end of the round. Counts are computed for mine tiles
 *  too, so every leaf in the tree is well-defined. */
export function computeAdjacentMines(isMine: boolean[], width: number, height: number): number[] {
  return isMine.map((_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    let count = 0;
    for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
      for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
        if (nx === x && ny === y) continue;
        if (isMine[ny * width + nx]) count++;
      }
    }
    return count;
  });
}

/** Uniformly random mine placement via partial Fisher-Yates over tile indices. */
function placeMines(totalTiles: number, mineCount: number): boolean[] {
  const isMine = new Array<boolean>(totalTiles).fill(false);
  const indices = Array.from({ length: totalTiles }, (_, i) => i);
  for (let i = 0; i < mineCount; i++) {
    const j = i + randomInt(totalTiles - i);
    [indices[i], indices[j]] = [indices[j], indices[i]];
    isMine[indices[i]] = true;
  }
  return isMine;
}

export function generateBoard({ width, height, mineCount }: BoardConfig): GeneratedBoard {
  const totalTiles = width * height;
  if (mineCount <= 0 || mineCount >= totalTiles) {
    throw new Error(`mineCount must be between 1 and ${totalTiles - 1}`);
  }
  return rebuildBoard({
    width,
    height,
    isMine: placeMines(totalTiles, mineCount),
    boardSeed: randomBoardSeed(),
  });
}

/**
 * Rebuilds a board from a layout + seed that were persisted earlier. Everything derived —
 * adjacency, nonces, leaves, root — is recomputed rather than stored, so a restored round is
 * byte-identical to the original and its root must still match what was committed onchain
 * (`RoundManager.restore` asserts exactly that). Only the two irrecoverable inputs are kept
 * on disk; see `store.ts` for why.
 */
export function rebuildBoard({
  width,
  height,
  isMine,
  boardSeed,
}: {
  width: number;
  height: number;
  isMine: boolean[];
  boardSeed: bigint;
}): GeneratedBoard {
  const totalTiles = width * height;
  if (isMine.length !== totalTiles) {
    throw new Error(`layout has ${isMine.length} tiles, expected ${totalTiles} for ${width}x${height}`);
  }
  const adjacentMines = computeAdjacentMines(isMine, width, height);
  const commitment = commitBoard(isMine, adjacentMines, boardSeed);

  return {
    ...commitment,
    width,
    height,
    totalTiles,
    totalSafeTiles: isMine.reduce((n, mine) => (mine ? n : n + 1), 0),
  };
}
