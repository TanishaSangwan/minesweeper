import { defineChain, http } from "viem";
import { createConfig, injected } from "wagmi";

// Monad testnet, defined locally from monskills `addresses`/`gas` skill values rather than
// guessed — swap for `wagmi/chains`' `monad`/`monadTestnet` once Para's Monad-specific wagmi
// wiring patch is applied (monskills `wallet-integration` skill).
export const monadTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "10143"),
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_RPC_HTTP_URL ?? "https://testnet-rpc.monad.xyz"],
      webSocket: [process.env.NEXT_PUBLIC_RPC_WS_URL ?? "wss://testnet-rpc.monad.xyz"],
    },
  },
  blockExplorers: {
    default: { name: "Monadscan", url: "https://testnet.monadscan.com" },
  },
});

// Placeholder wallet connection (browser-injected wallets — MetaMask, etc.) so the app runs
// standalone today. Swap for `ParaProvider` per the monskills `wallet-integration` skill
// (embedded MPC wallets + the same external-wallet connect) once `para init` + `para login`
// have been run — that skill owns the actual wiring, not this file.
export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  transports: {
    [monadTestnet.id]: http(),
  },
  // Next.js App Router renders once on the server (no window.ethereum there) and once on the
  // client — without this, wagmi's initial connector/account state can mismatch between the
  // two passes.
  ssr: true,
});
