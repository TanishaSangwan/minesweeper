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
    [roundId, session],
  );

  const { click, flag: sendFlag } = useGameSocket(
    roundId !== null ? roundId.toString() : null,
    session,
    handleMessage,
  );

  const inProgress = state === RoundState.InProgress;
  // Derived from polled round state, not the RoundFinished event — see useBoardSync for why
  // event watching is unreliable against Monad's public RPC.
  const finished = state === RoundState.Finished;
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
              // One button per discovered wallet (EIP-6963) rather than assuming connectors[0]
              // exists — that assumption made the button silently dead with no extension.
              <div className="flex gap-1">
                {connectors.map((connector) => (
                  <button
                    key={connector.uid}
                    disabled={isConnecting}
                    onClick={() => connect({ connector })}
                    className="win-btn px-3 py-1 text-xs font-bold disabled:opacity-60"
                  >
                    {isConnecting ? "Connecting…" : connector.name}
                  </button>
                ))}
              </div>
            )}

            <div className="win-sunken led-display px-2 py-1 text-lg">
              {rewardPerTile !== undefined ? `WIN ${formatEther(rewardPerTile)}` : "WIN ----"}
            </div>
          </div>

          {/* Funding goes through the injected wallet, so it has to be on Monad. Reveals do
              not — the session wallet has the chain hard-wired. */}
          {wrongNetwork && (
            <div className="win-sunken mb-3 p-2 text-xs">
              <p className="font-bold text-red-800">
                Wrong network — wallet is on chain {chainId}, not Monad Testnet ({monadTestnet.id}).
              </p>
              <p className="mt-1">That&apos;s why fees show in ETH. Entry fees and rewards are in MON.</p>
              <button
                onClick={() => switchChain({ chainId: monadTestnet.id })}
                disabled={isSwitching}
                className="win-btn mt-2 px-3 py-1 font-bold disabled:opacity-60"
              >
                {isSwitching ? "Switching…" : "Switch to Monad Testnet"}
              </button>
              {switchError && (
                <p className="mt-1 text-red-800">
                  Switch failed — add it manually: chain id {monadTestnet.id}, RPC{" "}
                  {monadTestnet.rpcUrls.default.http[0]}, symbol MON.
                </p>
              )}
            </div>
          )}

          {/* Session wallet: signs every reveal, so a round is playable without a dialog per
              tile. It is the entrant too — revealSafeTile authorises and pays msg.sender. */}
          {session && (
            <div className="win-sunken mb-3 p-2 text-xs">
              <p className="font-bold">Session wallet — reveals sign themselves, no popup</p>
              <p className="mt-1 break-all font-mono text-[10px] text-neutral-700">
                {session.account.address}
              </p>
              <p className="mt-1">
                balance: {sessionBalance ? formatEther(sessionBalance.value) : "…"} MON
                {entryFee !== undefined && (sessionBalance?.value ?? 0n) < entryFee && (
                  <span className="ml-2 font-bold text-red-800">— top up to enter</span>
                )}
              </p>
              <button
                disabled={!isConnected || wrongNetwork || isFunding}
                onClick={() => fundSession({ to: session.account.address, value: parseEther("1") })}
                className="win-btn mt-2 px-3 py-1 font-bold disabled:opacity-60"
              >
                {isFunding ? "Funding…" : "Fund 1 MON from your wallet"}
              </button>
              <p className="mt-1 text-neutral-600">
                One confirmation, then the round is prompt-free. Winnings land here — send them
                back to your main wallet afterwards.
              </p>
            </div>
          )}

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
                myAddress={sessionAddress}
                frozen={frozen || !inProgress}
                onReveal={click}
                onToggleFlag={(index) => sendFlag(index, !flags.has(index))}
              />
            ) : (
              <div className="win-sunken px-4 py-6 text-xs text-neutral-600">Waiting for round…</div>
            )}
          </div>
        </div>

        {/* Status bar — broker replies land here; they used to go only to the console, so a
            rejected click was indistinguishable from a dead board. */}
        <div className="win-sunken mx-3 mb-3 px-2 py-1 text-xs">
          {status ??
            statusLine ??
            (frozen ? "Frozen — hold on…" : inProgress ? "Right-click a tile to flag it." : "Round not started yet.")}
        </div>
      </div>
    </main>
  );
}
