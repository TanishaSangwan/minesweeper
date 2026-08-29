"use client";

import { useMemo, useState } from "react";
import { useReadContract, useWatchContractEvent } from "wagmi";
import { tournamentContract } from "@/lib/contract";

export interface RevealedTile {
  /** Who claimed the tile, when we know it. Attribution rides on the `TileRevealed` event,
   *  which is best-effort on public RPCs (see below), so this can be null for a tile that is
   *  definitely revealed. */
  player: `0x${string}` | null;
  /** Neighbour-mine count — the public Minesweeper hint, shown to every player regardless of
   *  who revealed (and was paid for) the tile. */
  adjacentMines: number;
}

/**
 * Shared "tile removed for everyone" board state.
 *
 * This polls the contract's `revealedTiles` view rather than watching `TileRevealed` logs.
 * Monad's public testnet RPC does not implement `eth_newFilter` ("Method not found") and caps
 * `eth_getLogs` at a 100-block range — and with Monad's block rate the gap between polls
 * routinely exceeds that. viem's event watching depends on one or the other, so a log-driven
 * board silently never updates: the reveal transaction succeeds onchain and the tile stays
 * dark. Reading state directly has no such limits and is still onchain truth, so the UI
 * cannot drift from the contract.
 *
 * The event watch is kept purely for player attribution (who gets the green highlight). If it
 * yields nothing on a restricted RPC the board is still correct — tiles just aren't
 * attributed.
 */
export function useBoardSync(roundId: bigint | null) {
  const [byPlayer, setByPlayer] = useState<Map<number, `0x${string}`>>(new Map());

  const { data } = useReadContract({
    ...tournamentContract,
    functionName: "revealedTiles",
    args: roundId !== null ? [roundId] : undefined,
    query: { enabled: roundId !== null, refetchInterval: 1500 },
  });

  useWatchContractEvent({
    ...tournamentContract,
    eventName: "TileRevealed",
    enabled: roundId !== null,
    onLogs(logs) {
      setByPlayer((prev) => {
        const next = new Map(prev);
        for (const log of logs) {
          const { roundId: eventRoundId, tileIndex, player } = log.args;
          if (eventRoundId !== roundId || tileIndex === undefined || !player) continue;
          next.set(Number(tileIndex), player);
        }
        return next;
      });
    },
  });

  const revealed = useMemo(() => {
    const map = new Map<number, RevealedTile>();
    if (!data) return map;
    const [flags, hints] = data;
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      map.set(i, { player: byPlayer.get(i) ?? null, adjacentMines: Number(hints[i]) });
    }
    return map;
  }, [data, byPlayer]);

  return { revealed };
}
