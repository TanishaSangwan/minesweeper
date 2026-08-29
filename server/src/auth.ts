import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { verifyMessage } from "viem";
import { env } from "./env.js";

/**
 * Two separate trust problems, both harmless on localhost and both exploitable the moment
 * this is reachable from the internet.
 *
 * 1. Admin endpoints (`createRound`, `startRound`) spend the operator wallet's gas on every
 *    call. Unauthenticated, anyone can drain it in a loop.
 * 2. The WS `player` parameter used to be taken on trust. A player who legitimately entered
 *    a round could also connect *as another entrant*: probe tiles under that identity to
 *    dodge their own 5s freezes, learn which tiles are safe, then claim them from their own
 *    wallet. Freeze-bypass and theft of the private mine-hit channel in one.
 */

/** Bearer-token gate for operator-only routes. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = env.adminToken;

  // Compare in constant time, and only after length-matching — timingSafeEqual throws on a
  // length mismatch, which would itself leak the token's length.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

/** How stale a signed handshake may be. Long enough for a slow wallet, short enough that a
 *  leaked signature is not a lasting credential. */
const MAX_AGE_MS = 5 * 60_000;

/**
 * The exact string a player signs to prove they control the address they claim.
 * `web/hooks/useGameSocket.ts` builds this identically — the two must stay in step or every
 * connection is rejected.
 */
export function authMessage(roundId: string, player: string, issuedAt: string): string {
  return [
    "Minesweeper Tournament",
    `round: ${roundId}`,
    `player: ${player.toLowerCase()}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

export async function verifyPlayerSignature(params: {
  roundId: string;
  player: string;
  issuedAt: string;
  signature: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { roundId, player, issuedAt, signature } = params;

  if (!/^0x[0-9a-fA-F]{40}$/.test(player)) return { ok: false, reason: "malformed player address" };
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return { ok: false, reason: "malformed signature" };

  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) return { ok: false, reason: "malformed issuedAt" };
  // Bounded on both sides: a future timestamp would otherwise mint a credential good forever.
  if (Math.abs(Date.now() - issued) > MAX_AGE_MS) return { ok: false, reason: "handshake expired" };

  try {
    const valid = await verifyMessage({
      address: player as `0x${string}`,
      message: authMessage(roundId, player, issuedAt),
      signature: signature as `0x${string}`,
    });
    return valid ? { ok: true } : { ok: false, reason: "signature does not match player" };
  } catch (err) {
    return { ok: false, reason: `signature check failed: ${(err as Error).message}` };
  }
}
