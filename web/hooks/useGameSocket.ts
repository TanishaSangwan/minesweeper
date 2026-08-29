"use client";

import { useEffect, useRef, useState } from "react";
import { brokerWsUrl } from "@/lib/contract";

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
 * this hook never touches funds. Global "tile removed for everyone" state should be read
 * from the contract's own TileRevealed event (see useBoardSync), not from here, so it can
 * never drift from onchain truth; this socket's broadcasts are for freeze notices and flags.
 */
export function useGameSocket(
  roundId: string | null,
  player: `0x${string}` | undefined,
  onMessage: (msg: ServerMessage) => void,
) {
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!roundId || !player) return;

    const socket = new WebSocket(`${brokerWsUrl}/ws?roundId=${roundId}&player=${player}`);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (event) => {
      try {
        onMessageRef.current(JSON.parse(event.data) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };

    return () => socket.close();
  }, [roundId, player]);

  function click(tileIndex: number) {
    socketRef.current?.send(JSON.stringify({ type: "click", tileIndex }));
  }

  function flag(tileIndex: number, flagged: boolean) {
    socketRef.current?.send(JSON.stringify({ type: "flag", tileIndex, flagged }));
  }

  return { connected, click, flag };
}
