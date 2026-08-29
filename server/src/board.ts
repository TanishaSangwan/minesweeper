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
  const isMine = placeMines(totalTiles, mineCount);
  const boardSeed = randomBoardSeed();
  const commitment = commitBoard(isMine, boardSeed);

  return {
    ...commitment,
    width,
    height,
    totalTiles,
    totalSafeTiles: totalTiles - mineCount,
  };
}
