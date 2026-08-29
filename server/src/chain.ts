import { createPublicClient, createWalletClient, defineChain, http, webSocket, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { minesweeperTournamentAbi } from "./abi.js";
import { env } from "./env.js";

// Not in viem/chains yet in every version — defined locally from monskills `addresses`/
// `gas` skill values rather than guessed.
export const monadTestnet = defineChain({
  id: env.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [env.rpcHttpUrl], webSocket: [env.rpcWsUrl] },
  },
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(env.rpcHttpUrl),
});

// Separate client over the websocket transport for event subscriptions (see monskills
// `concepts` real-time-data guidance: Geth-compatible WS is the default choice).
export const wsClient = createPublicClient({
  chain: monadTestnet,
  transport: webSocket(env.rpcWsUrl),
});

const operatorAccount = privateKeyToAccount(env.operatorPrivateKey);

export const walletClient = createWalletClient({
  account: operatorAccount,
  chain: monadTestnet,
  transport: http(env.rpcHttpUrl),
});

export const contract = {
  address: env.contractAddress,
  abi: minesweeperTournamentAbi,
} as const;

// Gas notes (monskills `gas` skill): Monad charges gas_limit * price, not gas used. These
// are trusted operator-only admin calls (not exposed to players), so rather than hardcoding
// limits we can't verify without a compiled build, we estimate once and add a small 10%
// buffer per the skill's guidance, instead of trusting a wallet's post-revert fallback.
async function writeWithBufferedGas(
  functionName: "createRound" | "startRound" | "cancelRound" | "revealBoard",
  args: readonly unknown[],
) {
  const estimate = await publicClient.estimateContractGas({
    ...contract,
    functionName,
    args,
    account: operatorAccount,
  } as never);
  const gas = estimate + estimate / 10n;
  const { request } = await publicClient.simulateContract({
    ...contract,
    functionName,
    args,
    account: operatorAccount,
    gas,
  } as never);
  return walletClient.writeContract(request);
}

export async function createRoundOnChain(entryFee: bigint, totalSafeTiles: number, minPlayers: number) {
  return writeWithBufferedGas("createRound", [entryFee, totalSafeTiles, minPlayers]);
}

export async function startRoundOnChain(roundId: bigint, merkleRoot: Hex) {
  return writeWithBufferedGas("startRound", [roundId, merkleRoot]);
}

export async function cancelRoundOnChain(roundId: bigint) {
  return writeWithBufferedGas("cancelRound", [roundId]);
}

export async function revealBoardOnChain(roundId: bigint, isMine: boolean[], boardSeed: bigint) {
  return writeWithBufferedGas("revealBoard", [roundId, isMine, boardSeed]);
}

export async function readRoundInfo(roundId: bigint) {
  return publicClient.readContract({ ...contract, functionName: "roundInfo", args: [roundId] });
}

export function watchTileRevealed(
  onEvent: (args: { roundId: bigint; tileIndex: number; player: Hex; reward: bigint }) => void,
) {
  return wsClient.watchContractEvent({
    ...contract,
    eventName: "TileRevealed",
    onLogs: (logs) => {
      for (const log of logs) {
        const { roundId, tileIndex, player, reward } = log.args;
        if (roundId === undefined || tileIndex === undefined || !player || reward === undefined) continue;
        onEvent({ roundId, tileIndex: Number(tileIndex), player, reward });
      }
    },
  });
}

export function watchRoundFinished(onEvent: (args: { roundId: bigint }) => void) {
  return wsClient.watchContractEvent({
    ...contract,
    eventName: "RoundFinished",
    onLogs: (logs) => {
      for (const log of logs) {
        if (log.args.roundId === undefined) continue;
        onEvent({ roundId: log.args.roundId });
      }
    },
  });
}
