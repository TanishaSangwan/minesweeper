"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { Board } from "@/components/Board";
import { FreezeOverlay } from "@/components/FreezeOverlay";
import { tournamentContract, brokerHttpUrl, RoundState } from "@/lib/contract";
import { monadTestnet } from "@/lib/wagmi";
import { useBoardSync } from "@/hooks/useBoardSync";
import { useGameSocket, type ServerMessage } from "@/hooks/useGameSocket";

interface RoundDimensions {
  width: number;
  height: number;
  totalTiles: number;
  totalSafeTiles: number;
}

export default function Home() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, error: connectError, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, error: switchError, isPending: isSwitching } = useSwitchChain();

  // A wallet left on its default network will happily quote fees in ETH and try to spend the
  // wrong asset. Nothing here works until it's on Monad, so gate the whole UI on it.
  const wrongNetwork = isConnected && chainId !== monadTestnet.id;

  const [roundIdInput, setRoundIdInput] = useState("0");
  const roundId = roundIdInput.trim() ? BigInt(roundIdInput) : null;

  const [dims, setDims] = useState<RoundDimensions | null>(null);
  const [flags, setFlags] = useState<Map<number, `0x${string}`>>(new Map());
  const [freezeUntil, setFreezeUntil] = useState<number | null>(null);
  // Broker replies that aren't a proof still need to reach the player — otherwise a rejected
  // click is indistinguishable from a dead board.
  const [status, setStatus] = useState<string | null>(null);

  const { data: roundInfo } = useReadContract({
    ...tournamentContract,
    functionName: "roundInfo",
    args: roundId !== null ? [roundId] : undefined,
    query: { enabled: roundId !== null, refetchInterval: 4000 },
  });
  const [entryFee, , , , , rewardPerTile, , state] = roundInfo ?? [];

  const { revealed } = useBoardSync(roundId);

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
          setStatus(null);
          // The broker never submits this transaction itself — the player's own wallet does,
          // and the payout lands directly in that wallet via the contract. `adjacentMines`
          // is part of the committed leaf, so it has to travel with the proof; the contract
          // then emits it publicly, which is how every other player learns the number.
          writeReveal({
            ...tournamentContract,
            functionName: "revealSafeTile",
            args: [roundId!, msg.tileIndex, msg.adjacentMines, BigInt(msg.nonce), msg.proof],
          });
          break;
        case "mine-hit":
          setStatus(null);
          setFreezeUntil(msg.freezeUntil);
          break;
        case "already-revealed":
          setStatus(`Tile ${msg.tileIndex} was already revealed by someone else.`);
          break;
        case "round-finished":
          setStatus("Board cleared — the operator is publishing the full layout onchain.");
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
          setStatus(msg.message);
          console.error("broker error:", msg.message);
          break;
      }
    },
    [roundId, writeReveal],
  );

  const { click, flag: sendFlag } = useGameSocket(roundId !== null ? roundId.toString() : null, address, handleMessage);

  const inProgress = state === RoundState.InProgress;
  // Derived from polled round state, not the RoundFinished event — see useBoardSync for why
  // event watching is unreliable against Monad's public RPC.
  const finished = state === RoundState.Finished;
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
        ) : connectors.length > 0 ? (
          // One button per discovered wallet (EIP-6963), rather than assuming connectors[0]
          // exists — with no wallet extension installed that array is empty and the old
          // single button silently did nothing when clicked.
          <div className="flex gap-2">
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                disabled={isConnecting}
                onClick={() => connect({ connector })}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
              >
                {isConnecting ? "Connecting…" : `Connect ${connector.name}`}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-sm text-amber-400">
            No wallet detected — install MetaMask, then reload this page.
          </span>
        )}
      </header>

      {/* Connect failures were previously swallowed, so a rejected or unavailable wallet
          looked identical to a dead button. */}
      {connectError && (
        <p className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          Wallet connection failed: {connectError.message}
        </p>
      )}

      {wrongNetwork && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-3 text-sm">
          <p className="font-semibold text-amber-300">
            Wrong network — your wallet is on chain {chainId}, not Monad Testnet ({monadTestnet.id}).
          </p>
          <p className="mt-1 text-amber-200/80">
            That&apos;s why fees are quoted in ETH. Entry fees and rewards are in MON.
          </p>
          <button
            onClick={() => switchChain({ chainId: monadTestnet.id })}
            disabled={isSwitching}
            className="mt-2 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
          >
            {isSwitching ? "Switching…" : "Switch to Monad Testnet"}
          </button>
          {switchError && (
            <p className="mt-2 text-red-300">
              Switch failed: {switchError.message} — add it manually in MetaMask (chain id{" "}
              {monadTestnet.id}, RPC {monadTestnet.rpcUrls.default.http[0]}, symbol MON).
            </p>
          )}
        </div>
      )}

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
          disabled={!isConnected || wrongNetwork || entryFee === undefined}
          onClick={() => writeEnter({ ...tournamentContract, functionName: "enter", args: [roundId], value: entryFee })}
          className="w-fit rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Enter round
        </button>
      )}

      {status && (
        <p className="rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-2 text-sm text-sky-200">
          {status}
        </p>
      )}

      {finished && <p className="text-emerald-400">Board cleared — round finished.</p>}

      {dims && (
        <Board
          width={dims.width}
          height={dims.height}
          revealed={revealed}
          flags={flags}
          myAddress={address}
          frozen={frozen || !inProgress || wrongNetwork}
          onReveal={click}
          onToggleFlag={(index) => sendFlag(index, !flags.has(index))}
        />
      )}
    </main>
  );
}
