import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  rpcHttpUrl: required("RPC_HTTP_URL"),
  rpcWsUrl: required("RPC_WS_URL"),
  chainId: Number(process.env.CHAIN_ID ?? "10143"),
  contractAddress: required("CONTRACT_ADDRESS") as `0x${string}`,
  operatorPrivateKey: required("OPERATOR_PRIVATE_KEY") as `0x${string}`,
  // Gates the operator-only round-lifecycle routes. Required, not optional: an unset token
  // would otherwise silently mean "no auth" on a publicly reachable broker.
  adminToken: required("ADMIN_TOKEN"),
  port: Number(process.env.PORT ?? "8787"),
  freezeMs: Number(process.env.FREEZE_MS ?? "5000"),

  // Lobby mode. A public deployment has nobody to run the owner-only startRound by hand, so
  // the broker keeps exactly one Open round available and starts it once minPlayers have
  // entered. Off by default, so local development keeps the explicit two-step control.
  autoRound: process.env.AUTO_ROUND === "true",
  autoRoundWidth: Number(process.env.AUTO_ROUND_WIDTH ?? "4"),
  autoRoundHeight: Number(process.env.AUTO_ROUND_HEIGHT ?? "4"),
  autoRoundMines: Number(process.env.AUTO_ROUND_MINES ?? "10"),
  autoRoundEntryFeeWei: BigInt(process.env.AUTO_ROUND_ENTRY_FEE_WEI ?? "10000000000000000"),
  autoRoundMinPlayers: Number(process.env.AUTO_ROUND_MIN_PLAYERS ?? "2"),
};
