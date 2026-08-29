"use client";

import { useEffect, useRef, useState } from "react";
import { brokerWsUrl } from "@/lib/contract";
import type { SessionWallet } from "@/lib/session";

/** Must match `authMessage` in server/src/auth.ts byte for byte, or every connection is
 *  rejected. Kept as a literal here rather than imported, since the two run in different
 *  packages — change them together. */
function authMessage(roundId: string, player: string, issuedAt: string): string {
  return [
    "Minesweeper Tournament",
    `round: ${roundId}`,
    `player: ${player.toLowerCase()}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

export type ServerMessage =
  | { type: "safe"; tileIndex: number; adjacentMines: number; nonce: string; proof: `0x${string}`[] }
  | { type: "mine-hit"; tileIndex: number; freezeMs: number; freezeUntil: number }
  | { type: "frozen"; remainingMs: number }
  | { type: "already-revealed"; tileIndex: number }
  | { type: "tile-revealed"; tileIndex: number; adjacentMines: number; player: `0x${string}`; reward: string }
  | { type: "flag"; tileIndex: number; player: `0x${string}`; flagged: boolean }
  | { type: "round-finished" }
  | { type: "error"; message: string };

/**
 * The player's private + shared channel to the broker (see server/README.md). Board-safe
 * clicks come back here with a Merkle proof for the caller to submit onchain themselves —
 * this hook never touches funds. Global "tile removed for everyone" state is read from the
 * contract itself (see useBoardSync), not from here, so it can never drift from onchain
 * truth; this socket carries private freeze notices and flag broadcasts.
 *
 * The connection is authenticated: the session wallet signs a short-lived message proving it
 * controls the address it claims. Without that, anyone could connect as another entrant to
 * dodge freezes and read their private mine-hit channel. Signing costs nothing here because
 * the session key is local — no wallet prompt.
 */
export function useGameSocket(
  roundId: string | null,
  session: SessionWallet | null,
  onMessage: (msg: ServerMessage) => void,
) {
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!roundId || !session) return;

    let socket: WebSocket | undefined;
    let cancelled = false;

    (async () => {
      const player = session.account.address;
      const issuedAt = String(Date.now());
      const signature = await session.client.signMessage({
        account: session.account,
        message: authMessage(roundId, player, issuedAt),
      });
      if (cancelled) return;

      const query = new URLSearchParams({ roundId, player, issuedAt, signature });
      socket = new WebSocket(`${brokerWsUrl}/ws?${query.toString()}`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onclose = (e) => {
        setConnected(false);
        // 1008 is the broker rejecting the handshake — surface it rather than looking idle.
        if (e.code === 1008) {
          onMessageRef.current({ type: "error", message: `broker refused the connection: ${e.reason}` });
        }
      };
      socket.onmessage = (event) => {
        try {
          onMessageRef.current(JSON.parse(event.data) as ServerMessage);
        } catch {
          // ignore malformed frames
        }
      };
    })();

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [roundId, session]);

  function click(tileIndex: number) {
    socketRef.current?.send(JSON.stringify({ type: "click", tileIndex }));
  }

  function flag(tileIndex: number, flagged: boolean) {
    socketRef.current?.send(JSON.stringify({ type: "flag", tileIndex, flagged }));
  }

  return { connected, click, flag };
}
