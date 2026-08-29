"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "viem";
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { Board } from "@/components/Board";
import { FreezeOverlay } from "@/components/FreezeOverlay";
import { tournamentContract, brokerHttpUrl, RoundState } from "@/lib/contract";
import { monadTestnet } from "@/lib/wagmi";
import { createSessionWallet, loadOrCreateSessionKey, type SessionWallet } from "@/lib/session";
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

  // Session wallet: signs reveals with no prompt, so a round is actually playable. It is the
  // entrant too, since revealSafeTile both authorises and pays msg.sender. See lib/session.ts.
  const [sessionKey, setSessionKey] = useState<`0x${string}` | null>(null);
  useEffect(() => setSessionKey(loadOrCreateSessionKey()), []);
  const session: SessionWallet | null = useMemo(
    () => (sessionKey ? createSessionWallet(sessionKey) : null),
    [sessionKey],
  );
  const sessionAddress = session?.account.address ?? undefined;
  const { data: sessionBalance } = useBalance({
    address: sessionAddress,
    query: { enabled: Boolean(sessionAddress), refetchInterval: 4000 },
  });
  const { sendTransaction: fundSession, isPending: isFunding } = useSendTransaction();

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
          // Signed by the session wallet, so no confirmation dialog interrupts the race. The
          // broker never submits this itself; the payout lands in whichever wallet sends it,
          // which is why the session wallet is the entrant. `adjacentMines` is part of the
          // committed leaf, so it travels with the proof; the contract then emits it
          // publicly, which is how every other player learns the number.
          if (!session) {
            setStatus("session wallet not ready yet");
            break;
          }
          session.client
            .writeContract({
              ...tournamentContract,
              chain: monadTestnet,
              account: session.account,
              functionName: "revealSafeTile",
              args: [roundId!, msg.tileIndex, msg.adjacentMines, BigInt(msg.nonce), msg.proof],
            })
            .catch((err: Error) => {
              // A revert here is usually just losing the race for that tile.
              setStatus(`tile ${msg.tileIndex}: ${err.message.split("\n")[0]}`);
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

  const { click, flag: sendFlag } = useGameSocket(
    roundId !== null ? roundId.toString() : null,
    sessionAddress,
    handleMessage,
  );

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

      {session && (
        <section className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-3 text-sm">
          <p className="font-semibold">Session wallet — signs tile reveals with no popup</p>
          <p className="mt-1 font-mono text-xs text-slate-400 break-all">{session.account.address}</p>
          <p className="mt-1 text-slate-300">
            balance: {sessionBalance ? formatEther(sessionBalance.value) : "…"} MON
            {entryFee !== undefined && (sessionBalance?.value ?? 0n) < entryFee && (
              <span className="ml-2 text-amber-400">— needs topping up to enter</span>
            )}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              disabled={!isConnected || wrongNetwork || isFunding}
              onClick={() =>
                fundSession({ to: session.account.address, value: parseEther("1") })
              }
              className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {isFunding ? "Funding…" : "Fund 1 MON from your wallet"}
            </button>
            <span className="text-xs text-slate-500">
              One confirmation, then the whole round is prompt-free. Rewards land here — send
              them back to your main wallet when you&apos;re done.
            </span>
          </div>
        </section>
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
          disabled={!session || entryFee === undefined || (sessionBalance?.value ?? 0n) < entryFee}
          onClick={() =>
            session
              ?.client.writeContract({
                ...tournamentContract,
                chain: monadTestnet,
                account: session.account,
                functionName: "enter",
                args: [roundId],
                value: entryFee,
              })
              .then(() => setStatus("entered — waiting for the operator to start the round"))
              .catch((err: Error) => setStatus(`enter failed: ${err.message.split("\n")[0]}`))
          }
          className="w-fit rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Enter round (session wallet, no popup)
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
          frozen={frozen || !inProgress}
          onReveal={click}
          onToggleFlag={(index) => sendFlag(index, !flags.has(index))}
        />
      )}
    </main>
  );
}
