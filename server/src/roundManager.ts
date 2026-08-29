import type { WebSocket } from "ws";
import type { Hex } from "viem";
import { generateBoard, rebuildBoard, type GeneratedBoard, type BoardConfig } from "./board.js";
import {
  createRoundOnChain,
  readEntrants,
  readRoundInfo,
  revealBoardOnChain,
  startRoundOnChain,
  watchRoundFinished,
  watchTileRevealed,
} from "./chain.js";
import { env } from "./env.js";
import { proofFor } from "./merkle.js";
import { deleteRound, loadRounds, saveRound, storeDir } from "./store.js";

type Address = `0x${string}`;

/** Addresses reach this process from two places with different casing — checksummed from the
 *  contract, arbitrary from the WS query string — so normalize before comparing them. */
function normalizeAddress(address: string): Address {
  return address.toLowerCase() as Address;
}

export type ServerMessage =
  | { type: "safe"; tileIndex: number; adjacentMines: number; nonce: string; proof: Hex[] }
  | { type: "mine-hit"; tileIndex: number; freezeMs: number; freezeUntil: number }
  | { type: "frozen"; remainingMs: number }
  | { type: "already-revealed"; tileIndex: number }
  | { type: "tile-revealed"; tileIndex: number; adjacentMines: number; player: Address; reward: string }
  | { type: "flag"; tileIndex: number; player: Address; flagged: boolean }
  | { type: "round-finished" }
  | { type: "error"; message: string };

interface ActiveRound {
  roundId: bigint;
  board: GeneratedBoard;
  started: boolean; // true once startRound has been confirmed onchain (entries locked, root committed)
  entrants: Set<Address>; // lowercased; read off the contract at startRound, final thereafter
  entrantsLoaded: boolean; // false until that read succeeds — an empty set is not "no entrants"
  revealed: Set<number>; // mirrors onchain TileRevealed truth
  frozenUntil: Map<Address, number>; // epoch ms
  flags: Map<number, Address>;
  sockets: Map<Address, Set<WebSocket>>;
}

/**
 * Owns exactly the parts of the game that don't move money: which tile is a mine, per-player
 * freeze timers + private mine-hit notices, and flag broadcast. It never custodies funds and
 * never itself submits a payout transaction — a safe click hands the player's own wallet a
 * Merkle proof to submit `revealSafeTile` with. Global "tile removed for everyone" state is
 * driven by subscribing to the contract's own TileRevealed event, not a separate broadcast,
 * so this process's view of the shared board can never drift from onchain truth.
 */
export class RoundManager {
  private rounds = new Map<bigint, ActiveRound>();

  /** Opens a round for entries. Generates the board immediately (kept secret in memory) but
   *  deliberately does not commit its root onchain yet — see `startRound`. Waits for the
   *  createRound transaction to actually be mined (not just submitted) before returning,
   *  since `startRound` needs to observe this round's existence onchain. */
  async createRound(config: BoardConfig, entryFeeWei: bigint, minPlayers: number): Promise<bigint> {
    const board = generateBoard(config);
    // Dimensions go onchain because `revealBoard` recomputes every tile's neighbour count
    // from the published layout to check it against the commitment.
    const roundId = await createRoundOnChain(
      entryFeeWei,
      board.width,
      board.height,
      board.totalSafeTiles,
      minPlayers,
    );
    console.log(`round ${roundId} created (createRound confirmed onchain)`);

    const round: ActiveRound = {
      roundId,
      board,
      started: false,
      entrants: new Set(),
      entrantsLoaded: false,
      revealed: new Set(),
      frozenUntil: new Map(),
      flags: new Map(),
      sockets: new Map(),
    };
    this.rounds.set(roundId, round);
    // Persist before returning: from here on the layout is the only thing that cannot be
    // recovered from the chain, and losing it strands the pool permanently.
    this.persist(round);

    return roundId;
  }

  /** Locks entries and commits the board's Merkle root onchain — call once enough players
   *  have entered. The contract enforces `minPlayers` itself and reverts otherwise; that
   *  revert propagates to the caller rather than being swallowed. */
  async startRound(roundId: bigint): Promise<void> {
    const round = this.mustGet(roundId);
    if (round.started) throw new Error(`round ${roundId} already started`);

    await startRoundOnChain(roundId, round.board.root);
    // Mark started as soon as the transaction lands. The chain is authoritative: once
    // startRound is mined the round IS InProgress, and a later failure here must not leave
    // this process believing otherwise — that state is unrecoverable, because re-calling
    // startRound reverts and `cancelRound` only works while a round is still Open.
    round.started = true;
    this.persist(round);
    console.log(`round ${roundId} started (entries locked, root committed onchain)`);

    // Entries are locked now, so the entrant list is final. Loading it is best-effort and
    // retried: the public RPC rate-limits (15/sec), and a transient failure here must not
    // strand the round.
    await this.loadEntrants(round);
  }

  /** Caches the round's final entrant list, retrying through transient RPC failures. */
  private async loadEntrants(round: ActiveRound, attempts = 6): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const entrants = await readEntrants(round.roundId);
        round.entrants = new Set(entrants.map(normalizeAddress));
        round.entrantsLoaded = true;
        this.persist(round);
        console.log(`round ${round.roundId}: ${round.entrants.size} entrants cached`);
        return;
      } catch (err) {
        const wait = 400 * attempt;
        console.warn(
          `round ${round.roundId}: entrant load attempt ${attempt}/${attempts} failed (${(err as Error).message.split("\n")[0]}), retrying in ${wait}ms`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    console.error(`round ${round.roundId}: could not cache entrants; clicks will retry on demand`);
  }

  /** Dimensions + tile counts only — never the mine layout itself. Safe to expose publicly
   *  so the frontend can lay out the grid before any tile has been clicked. */
  getPublicInfo(roundId: bigint) {
    const round = this.mustGet(roundId);
    return {
      width: round.board.width,
      height: round.board.height,
      totalTiles: round.board.totalTiles,
      totalSafeTiles: round.board.totalSafeTiles,
    };
  }

  registerSocket(roundId: bigint, player: Address, socket: WebSocket) {
    const round = this.mustGet(roundId);
    const existing = round.sockets.get(player) ?? new Set<WebSocket>();
    existing.add(socket);
    round.sockets.set(player, existing);
    socket.on("close", () => existing.delete(socket));
  }

  /** The core race: first click on an unrevealed, non-frozen tile gets an answer; a mine
   *  hit is only ever sent back to the clicking player, never broadcast. */
  handleClick(roundId: bigint, player: Address, tileIndex: number): ServerMessage {
    const round = this.mustGet(roundId);
    if (!round.started) {
      return { type: "error", message: "round has not started yet — entries are still open" };
    }
    // `revealSafeTile` reverts with NotEntered for anyone who didn't pay, so handing a
    // non-entrant a proof would only buy them a guaranteed-to-revert transaction — and on
    // Monad a revert still costs gas_limit * price. Refuse here instead.
    if (!round.entrantsLoaded) {
      // Cache is cold (the startRound read failed and is still retrying). Refusing here would
      // wrongly tell a paid-up player they never entered, so retry the load and ask them to
      // click again rather than asserting either way.
      void this.loadEntrants(round, 3);
      return { type: "error", message: "still verifying entries — click again in a moment" };
    }
    if (!round.entrants.has(normalizeAddress(player))) {
      return { type: "error", message: "you have not entered this round" };
    }
    const now = Date.now();

    const frozenUntil = round.frozenUntil.get(player) ?? 0;
    if (frozenUntil > now) {
      return { type: "frozen", remainingMs: frozenUntil - now };
    }
    if (round.revealed.has(tileIndex)) {
      return { type: "already-revealed", tileIndex };
    }
    if (tileIndex < 0 || tileIndex >= round.board.totalTiles) {
      return { type: "error", message: "tile index out of range" };
    }

    if (round.board.isMine[tileIndex]) {
      const freezeUntil = now + env.freezeMs;
      round.frozenUntil.set(player, freezeUntil);
      // Private: only this player's own socket(s) ever see this message. The tile is
      // untouched for everyone else — no broadcast, no chain call.
      return { type: "mine-hit", tileIndex, freezeMs: env.freezeMs, freezeUntil };
    }

    // Safe: hand back exactly what's needed to submit revealSafeTile onchain. The hint is
    // part of the committed leaf, so it must be submitted with the proof — and it only
    // becomes public for everyone else once TileRevealed carries it back out of the
    // contract, which is also when this player is paid. Actual "revealed" state only flips
    // once that event confirms (see wireChainEvents).
    return {
      type: "safe",
      tileIndex,
      adjacentMines: round.board.adjacentMines[tileIndex],
      nonce: round.board.nonces[tileIndex].toString(),
      proof: proofFor(round.board.leaves, tileIndex),
    };
  }

  handleFlag(roundId: bigint, player: Address, tileIndex: number, flagged: boolean): ServerMessage {
    const round = this.mustGet(roundId);
    if (flagged) round.flags.set(tileIndex, player);
    else round.flags.delete(tileIndex);
    return { type: "flag", tileIndex, player, flagged };
  }

  broadcast(roundId: bigint, message: ServerMessage, except?: Address) {
    const round = this.rounds.get(roundId);
    if (!round) return;
    for (const [addr, sockets] of round.sockets) {
      if (addr === except) continue;
      for (const socket of sockets) socket.send(JSON.stringify(message));
    }
  }

  sendTo(roundId: bigint, player: Address, message: ServerMessage) {
    const round = this.rounds.get(roundId);
    for (const socket of round?.sockets.get(player) ?? []) socket.send(JSON.stringify(message));
  }

  /** Subscribes to onchain truth once, at startup, and keeps every active round's mirror
   *  (and connected clients) in sync with it. */
  wireChainEvents() {
    watchTileRevealed(({ roundId, tileIndex, adjacentMines, player, reward }) => {
      const round = this.rounds.get(roundId);
      if (!round) return;
      round.revealed.add(tileIndex);
      // The hint is broadcast to everyone; `reward` is informational here — it was already
      // paid to `player` by the contract, and no other client is being credited by this.
      this.broadcast(roundId, {
        type: "tile-revealed",
        tileIndex,
        adjacentMines,
        player,
        reward: reward.toString(),
      });
    });

    watchRoundFinished(async ({ roundId }) => {
      const round = this.rounds.get(roundId);
      if (!round) return;
      this.broadcast(roundId, { type: "round-finished" });
      try {
        // `revealBoardOnChain` resolves to a receipt now, not a hash — logging the object
        // itself would print "[object Object]".
        const receipt = await revealBoardOnChain(roundId, round.board.isMine, round.board.boardSeed);
        console.log(`revealBoard tx for round ${roundId}: ${receipt.transactionHash}`);
        // The layout is public onchain now, so the stored secret has no further value.
        deleteRound(roundId.toString());
      } catch (err) {
        console.error(`revealBoard failed for round ${roundId}`, err);
      }
    });
  }

  /** Writes the round's irrecoverable state (layout + seed) to disk. Best-effort: a store
   *  failure must not take down a round that is otherwise fine, but it is loud, because it
   *  means the next restart will strand this pool. */
  private persist(round: ActiveRound): void {
    try {
      saveRound({
        roundId: round.roundId.toString(),
        width: round.board.width,
        height: round.board.height,
        isMine: round.board.isMine,
        boardSeed: round.board.boardSeed.toString(),
        started: round.started,
        entrants: [...round.entrants],
      });
    } catch (err) {
      console.error(
        `round ${round.roundId}: FAILED to persist board layout — a restart will strand this round`,
        err,
      );
    }
  }

  /**
   * Rebuilds in-memory rounds from the store at startup. Call before serving traffic.
   *
   * For any round already committed onchain the rebuilt Merkle root is checked against the
   * root the contract holds. A mismatch means the stored layout is not the one that was
   * committed — every proof from it would be rejected — so the round is dropped rather than
   * served, loudly.
   */
  async restore(): Promise<void> {
    const persisted = loadRounds();
    if (persisted.length === 0) return;

    let restored = 0;
    for (const p of persisted) {
      const roundId = BigInt(p.roundId);
      try {
        const board = rebuildBoard({
          width: p.width,
          height: p.height,
          isMine: p.isMine,
          boardSeed: BigInt(p.boardSeed),
        });

        if (p.started) {
          const info = await readRoundInfo(roundId);
          const onchainRoot = info[6];
          const state = Number(info[7]);
          if (onchainRoot !== board.root) {
            console.error(
              `round ${roundId}: stored layout does not match the committed root ` +
                `(onchain ${onchainRoot}, rebuilt ${board.root}) — dropping it`,
            );
            continue;
          }
          // Finished/Cancelled rounds need nothing more from this process, and their layout
          // is already public onchain.
          if (state === 2 || state === 3) {
            deleteRound(p.roundId);
            continue;
          }
        }

        this.rounds.set(roundId, {
          roundId,
          board,
          started: p.started,
          entrants: new Set(p.entrants.map(normalizeAddress)),
          entrantsLoaded: p.entrants.length > 0,
          revealed: new Set(), // re-learned from TileRevealed; the chain stays authoritative
          frozenUntil: new Map(), // freezes are deliberately not persisted — a restart forgives them
          flags: new Map(),
          sockets: new Map(),
        });
        restored++;
      } catch (err) {
        console.error(`round ${roundId}: could not restore from store`, err);
      }
    }
    console.log(`restored ${restored} round(s) from ${storeDir}`);
  }

  private mustGet(roundId: bigint): ActiveRound {
    const round = this.rounds.get(roundId);
    if (!round) throw new Error(`unknown round ${roundId}`);
    return round;
  }
}
