"use client";

import { createWalletClient, http, type Account, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "./wagmi";

/**
 * A throwaway "session wallet" held in the browser, so tile reveals sign themselves.
 *
 * Why this exists: a competitive round is a race, and MetaMask prompts for confirmation on
 * every transaction — there is no way for a dapp to suppress that, by design. Clicking through
 * a dialog per tile makes the game unplayable. The standard answer is a session key: a keypair
 * the page holds and signs with directly, funded once from the player's real wallet.
 *
 * It must be the entrant, not a delegate: `revealSafeTile` both checks `hasEntered[msg.sender]`
 * and pays `msg.sender`, so the session wallet enters the round and collects the rewards.
 *
 * TRADE-OFF, deliberately taken for a testnet demo: this private key lives in localStorage,
 * readable by any script that runs on this origin. Fund it with what a round costs and no
 * more. It is not a place to keep anything you would miss. A production build should use
 * Para's embedded MPC wallet (monskills `wallet-integration`) instead, which gets the same
 * no-prompt UX without a raw key in browser storage.
 */

const STORAGE_KEY = "minesweeper.sessionKey.v1";
const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;

/** Returns the stored session key, creating one on first use. Browser-only. */
export function loadOrCreateSessionKey(): `0x${string}` {
  let key = window.localStorage.getItem(STORAGE_KEY) as `0x${string}` | null;
  if (!key || !HEX_32_BYTES.test(key)) {
    key = generatePrivateKey();
    window.localStorage.setItem(STORAGE_KEY, key);
  }
  return key;
}

/** Discards the current session wallet. Anything left in it becomes unreachable. */
export function clearSessionKey(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

export interface SessionWallet {
  account: Account;
  client: WalletClient;
}

export function createSessionWallet(privateKey: `0x${string}`): SessionWallet {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    client: createWalletClient({ account, chain: monadTestnet, transport: http() }),
  };
}
