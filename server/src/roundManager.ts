import type { WebSocket } from "ws";
import type { Hex } from "viem";
import { generateBoard, type GeneratedBoard, type BoardConfig } from "./board.js";
import {
  createRoundOnChain,
  revealBoardOnChain,
  startRoundOnChain,
  watchRoundFinished,
  watchTileRevealed,
} from "./chain.js";
import { env } from "./env.js";
import { proofFor } from "./merkle.js";

type Address = `0x${string}`;

export type ServerMessage =
  | { type: "safe"; tileIndex: number; nonce: string; proof: Hex[] }
  | { type: "mine-hit"; tileIndex: number; freezeMs: number; freezeUntil: number }
  | { type: "frozen"; remainingMs: number }
  | { type: "already-revealed"; tileIndex: number }
  | { type: "tile-revealed"; tileIndex: number; player: Address; reward: string }
  | { type: "flag"; tileIndex: number; player: Address; flagged: boolean }
  | { type: "round-finished" }
  | { type: "error"; message: string };

interface ActiveRound {
  roundId: bigint;
  board: GeneratedBoard;
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

  async createAndStart(config: BoardConfig, entryFeeWei: bigint, minPlayers: number): Promise<bigint> {
    const board = generateBoard(config);

    const createHash = await createRoundOnChain(entryFeeWei, board.totalSafeTiles, minPlayers);
    console.log(`createRound tx: ${createHash}`);
    // In a real deploy, read the roundId back out of the RoundCreated event/receipt instead
    // of assuming it's sequential — left simple here since this operator is the only writer.
    const roundId = BigInt(this.rounds.size);

    const startHash = await startRoundOnChain(roundId, board.root);
    console.log(`startRound tx: ${startHash}`);

    this.rounds.set(roundId, {
      roundId,
      board,
      revealed: new Set(),
      frozenUntil: new Map(),
      flags: new Map(),
      sockets: new Map(),
    });

    return roundId;
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

    // Safe: hand back exactly what's needed to submit revealSafeTile onchain. Actual
    // "revealed" state only flips once the TileRevealed event confirms (see wireChainEvents).
    return {
      type: "safe",
      tileIndex,
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
    watchTileRevealed(({ roundId, tileIndex, player, reward }) => {
      const round = this.rounds.get(roundId);
      if (!round) return;
      round.revealed.add(tileIndex);
      this.broadcast(roundId, { type: "tile-revealed", tileIndex, player, reward: reward.toString() });
    });

    watchRoundFinished(async ({ roundId }) => {
      const round = this.rounds.get(roundId);
      if (!round) return;
      this.broadcast(roundId, { type: "round-finished" });
      try {
        const hash = await revealBoardOnChain(roundId, round.board.isMine, round.board.boardSeed);
        console.log(`revealBoard tx for round ${roundId}: ${hash}`);
      } catch (err) {
        console.error(`revealBoard failed for round ${roundId}`, err);
      }
    });
  }

  private mustGet(roundId: bigint): ActiveRound {
    const round = this.rounds.get(roundId);
    if (!round) throw new Error(`unknown round ${roundId}`);
    return round;
  }
}
