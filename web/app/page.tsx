"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { useAccount, useConnect, useDisconnect, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { Board } from "@/components/Board";
import { FreezeOverlay } from "@/components/FreezeOverlay";
import { tournamentContract, brokerHttpUrl, RoundState } from "@/lib/contract";
import { useBoardSync } from "@/hooks/useBoardSync";
import { useGameSocket, type ServerMessage } from "@/hooks/useGameSocket";

interface RoundDimensions {
  width: number;
  height: number;
  totalTiles: number;
  totalSafeTiles: number;
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();

  const [roundIdInput, setRoundIdInput] = useState("0");
  const roundId = roundIdInput.trim() ? BigInt(roundIdInput) : null;

  const [dims, setDims] = useState<RoundDimensions | null>(null);
  const [flags, setFlags] = useState<Map<number, `0x${string}`>>(new Map());
  const [freezeUntil, setFreezeUntil] = useState<number | null>(null);

  const { data: roundInfo } = useReadContract({
    ...tournamentContract,
    functionName: "roundInfo",
    args: roundId !== null ? [roundId] : undefined,
    query: { enabled: roundId !== null, refetchInterval: 4000 },
  });
  const [entryFee, , , , , rewardPerTile, , state] = roundInfo ?? [];

  const { revealed, finished } = useBoardSync(roundId);

  // Board dimensions + tile counts are UI-only (never the mine layout) — see server/README.md.
  useEffect(() => {
    if (roundId === null) return;
    fetch(`${brokerHttpUrl}/api/rounds/${roundId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setDims)
      .catch(() => setDims(null));
  }, [roundId]);

  const { writeContract: writeEnter, data: enterHash } = useWriteContract();
  useWaitForTransactionReceipt({ hash: enterHash });

  const { writeContract: writeReveal } = useWriteContract();

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "safe":
          // The broker never submits this transaction itself — the player's own wallet does,
          // and the payout lands directly in that wallet via the contract.
          writeReveal({
            ...tournamentContract,
            functionName: "revealSafeTile",
            args: [roundId!, msg.tileIndex, BigInt(msg.nonce), msg.proof],
          });
          break;
        case "mine-hit":
          setFreezeUntil(msg.freezeUntil);
          break;
        case "flag":
          setFlags((prev) => {
            const next = new Map(prev);
            if (msg.flagged) next.set(msg.tileIndex, msg.player);
            else next.delete(msg.tileIndex);
            return next;
          });
          break;
        case "frozen":
          setFreezeUntil(Date.now() + msg.remainingMs);
          break;
        case "error":
          console.error("broker error:", msg.message);
          break;
      }
    },
    [roundId, writeReveal],
  );

  const { click, flag: sendFlag } = useGameSocket(roundId !== null ? roundId.toString() : null, address, handleMessage);

  const inProgress = state === RoundState.InProgress;
  const frozen = Boolean(freezeUntil && freezeUntil > Date.now());

  const statusLine = connectError?.message ?? (finished ? "Board cleared — round finished." : null);

  return (
    <main className="flex min-h-screen items-start justify-center p-6 sm:p-10">
      <FreezeOverlay freezeUntil={freezeUntil} />

      <div className="win-window w-full max-w-2xl">
        {/* Title bar */}
        <div className="win-titlebar flex items-center justify-between px-2 py-1">
          <span className="flex items-center gap-2 text-sm">💣 Minesweeper Tournament</span>
          <div className="flex gap-1">
            <span className="win-raised flex h-4 w-4 items-center justify-center text-[10px] leading-none text-black">
              _
            </span>
            <span className="win-raised flex h-4 w-4 items-center justify-center text-[10px] leading-none text-black">
              ✕
            </span>
          </div>
        </div>

        <div className="p-3">
          {/* Toolbar: wallet + LED counters, echoing the classic mine-counter/timer row */}
          <div className="win-sunken mb-3 flex flex-wrap items-center justify-between gap-3 p-2">
            <div className="win-sunken led-display px-2 py-1 text-lg">
              {entryFee !== undefined ? `FEE ${formatEther(entryFee)}` : "FEE ----"}
            </div>

            {isConnected ? (
              <button onClick={() => disconnect()} className="win-btn px-3 py-1 text-xs">
                {address?.slice(0, 6)}…{address?.slice(-4)} · disconnect
              </button>
            ) : connectors.length === 0 ? (
              <span className="text-xs font-bold text-red-800">No wallet extension detected</span>
            ) : (
              <button onClick={() => connect({ connector: connectors[0] })} className="win-btn px-3 py-1 text-xs font-bold">
                Connect Wallet
              </button>
            )}

            <div className="win-sunken led-display px-2 py-1 text-lg">
              {rewardPerTile !== undefined ? `WIN ${formatEther(rewardPerTile)}` : "WIN ----"}
            </div>
          </div>

          {/* Round controls */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <label className="font-bold">Round ID</label>
            <input
              value={roundIdInput}
              onChange={(e) => setRoundIdInput(e.target.value)}
              className="win-sunken w-16 bg-white px-2 py-1 text-black outline-none"
            />
            {roundId !== null && state === RoundState.Open && (
              <button
                disabled={!isConnected || entryFee === undefined}
                onClick={() => writeEnter({ ...tournamentContract, functionName: "enter", args: [roundId], value: entryFee })}
                className="win-btn px-3 py-1 font-bold disabled:opacity-60"
              >
                Enter Round
              </button>
            )}
          </div>

          {/* Board */}
          <div className="flex justify-center">
            {dims ? (
              <Board
                width={dims.width}
                height={dims.height}
                revealed={revealed}
                flags={flags}
                myAddress={address}
                frozen={frozen || !inProgress}
                onReveal={click}
                onToggleFlag={(index) => sendFlag(index, !flags.has(index))}
              />
            ) : (
              <div className="win-sunken px-4 py-6 text-xs text-neutral-600">Waiting for round…</div>
            )}
          </div>
        </div>

        {/* Status bar */}
        <div className="win-sunken mx-3 mb-3 px-2 py-1 text-xs">
          {statusLine ?? (frozen ? "Frozen — hold on…" : inProgress ? "Right-click a tile to flag it." : "Round not started yet.")}
        </div>
      </div>
    </main>
  );
}
