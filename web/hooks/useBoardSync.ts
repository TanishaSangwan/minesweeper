"use client";

import { useState } from "react";
import { useWatchContractEvent } from "wagmi";
import { tournamentContract } from "@/lib/contract";

export interface RevealedTile {
  player: `0x${string}`;
  reward: bigint;
}

/**
 * Shared "tile removed for everyone" board state, read directly from the contract's own
 * TileRevealed event over the RPC websocket (monskills `concepts` real-time-data guidance) —
 * not from the broker — so this view can never disagree with onchain truth.
 */
export function useBoardSync(roundId: bigint | null) {
  const [revealed, setRevealed] = useState<Map<number, RevealedTile>>(new Map());
  const [finished, setFinished] = useState(false);

  useWatchContractEvent({
    ...tournamentContract,
    eventName: "TileRevealed",
    enabled: roundId !== null,
    onLogs(logs) {
      setRevealed((prev) => {
        const next = new Map(prev);
        for (const log of logs) {
          const { roundId: eventRoundId, tileIndex, player, reward } = log.args;
          if (eventRoundId !== roundId || tileIndex === undefined || !player || reward === undefined) continue;
          next.set(tileIndex, { player, reward });
        }
        return next;
      });
    },
  });

  useWatchContractEvent({
    ...tournamentContract,
    eventName: "RoundFinished",
    enabled: roundId !== null,
    onLogs(logs) {
      if (logs.some((log) => log.args.roundId === roundId)) setFinished(true);
    },
  });

  return { revealed, finished };
}
