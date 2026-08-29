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
  const { connect, connectors } = useConnect();
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

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <FreezeOverlay freezeUntil={freezeUntil} />

      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Minesweeper Tournament</h1>
        {isConnected ? (
          <button onClick={() => disconnect()} className="rounded-md border border-slate-700 px-3 py-1.5 text-sm">
            {address?.slice(0, 6)}…{address?.slice(-4)} · disconnect
          </button>
        ) : (
          <button
            onClick={() => connect({ connector: connectors[0] })}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold"
          >
            Connect wallet
          </button>
        )}
      </header>

      <section className="flex items-center gap-3 text-sm">
        <label>Round ID</label>
        <input
          value={roundIdInput}
          onChange={(e) => setRoundIdInput(e.target.value)}
          className="w-24 rounded-md border border-slate-700 bg-slate-900 px-2 py-1"
        />
        {entryFee !== undefined && <span className="text-slate-400">entry: {formatEther(entryFee)} MON</span>}
        {rewardPerTile !== undefined && <span className="text-slate-400">reward/tile: {formatEther(rewardPerTile)} MON</span>}
      </section>

      {roundId !== null && state === RoundState.Open && (
        <button
          disabled={!isConnected || entryFee === undefined}
          onClick={() => writeEnter({ ...tournamentContract, functionName: "enter", args: [roundId], value: entryFee })}
          className="w-fit rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Enter round
        </button>
      )}

      {finished && <p className="text-emerald-400">Board cleared — round finished.</p>}

      {dims && (
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
      )}
    </main>
  );
}
