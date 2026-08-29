import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * On-disk store for the one piece of round state that cannot be recovered from anywhere else:
 * the secret board layout and its seed.
 *
 * Everything else a round needs is either derivable (adjacency, nonces, leaves, root — all
 * recomputed by `rebuildBoard`) or already onchain (revealed tiles, entrants, state). The
 * layout is not: mines are placed with a CSPRNG at `createRound` and only the Merkle *root*
 * is published, by design. So if this process forgets the layout mid-round it can never serve
 * another proof, the round can never reach `Finished`, `revealBoard` can never run, and the
 * pool is stranded permanently — `cancelRound` is Open-only, so there is no way back.
 *
 * That is not hypothetical: it destroyed live rounds during development, twice, each time
 * from an ordinary server restart.
 *
 * These files contain the unrevealed mine layout — the one secret the whole commit-reveal
 * scheme depends on. Anyone who reads them can win every tile. They are written 0600 inside a
 * 0700 directory and must stay gitignored.
 */

const STORE_DIR = process.env.ROUND_STORE_DIR ?? join(process.cwd(), ".rounds");

export interface PersistedRound {
  roundId: string; // bigint as decimal string — JSON has no bigint
  width: number;
  height: number;
  isMine: boolean[];
  boardSeed: string; // bigint as decimal string
  started: boolean;
  minPlayers: number;
  entrants: string[];
}

function ensureDir(): void {
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
}

function fileFor(roundId: string): string {
  // roundId always comes from a bigint, but this path is built from it — keep it digits-only
  // so nothing can escape the store directory.
  if (!/^\d+$/.test(roundId)) throw new Error(`refusing to build a store path from ${roundId}`);
  return join(STORE_DIR, `${roundId}.json`);
}

export function saveRound(round: PersistedRound): void {
  ensureDir();
  const path = fileFor(round.roundId);
  writeFileSync(path, JSON.stringify(round), { mode: 0o600 });
  chmodSync(path, 0o600); // explicit: writeFileSync's mode is ignored if the file already exists
}

export function loadRounds(): PersistedRound[] {
  let names: string[];
  try {
    names = readdirSync(STORE_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return []; // no store yet — first run
  }

  const rounds: PersistedRound[] = [];
  for (const name of names) {
    try {
      rounds.push(JSON.parse(readFileSync(join(STORE_DIR, name), "utf8")) as PersistedRound);
    } catch (err) {
      // One unreadable file must not stop every other round from being restored.
      console.error(`round store: skipping unreadable ${name}`, err);
    }
  }
  return rounds.sort((a, b) => Number(BigInt(a.roundId) - BigInt(b.roundId)));
}

/** Drops a round's secret once it can no longer matter (the layout is public onchain). */
export function deleteRound(roundId: string): void {
  try {
    rmSync(fileFor(roundId));
  } catch {
    /* already gone */
  }
}

export const storeDir = STORE_DIR;
