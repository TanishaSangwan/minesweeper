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
  port: Number(process.env.PORT ?? "8787"),
  freezeMs: Number(process.env.FREEZE_MS ?? "5000"),
};
