import { minesweeperTournamentAbi } from "./abi";

export const tournamentContract = {
  address: (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  abi: minesweeperTournamentAbi,
} as const;

export const brokerHttpUrl = process.env.NEXT_PUBLIC_BROKER_HTTP_URL ?? "http://localhost:8787";
export const brokerWsUrl = process.env.NEXT_PUBLIC_BROKER_WS_URL ?? "ws://localhost:8787";

export enum RoundState {
  Open = 0,
  InProgress = 1,
  Finished = 2,
  Cancelled = 3,
}
