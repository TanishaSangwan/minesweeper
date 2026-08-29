# 💣 Minesweeper Tournament

**Real-money, real-time competitive Minesweeper on Monad.**

Multiple players share a single board and race to reveal tiles. A safe reveal pays out instantly onchain and disappears for *everyone*. Hitting a mine is a private event — only that player is frozen for 5 seconds, and the board stays untouched for everyone else. The mine layout is committed onchain before play starts and can be independently verified once the round ends.

> 📄 **Full design writeup:** see the NatSpec header in [`contracts/src/MinesweeperTournament.sol`](contracts/src/MinesweeperTournament.sol), and the original plan at `C:\Users\TANISHA\.claude\plans\abstract-plotting-yeti.md`.

---

## 📦 Project Structure

| Folder | Purpose |
|---|---|
| `contracts/` | Foundry project — escrow, commit-reveal scheme, payouts |
| `server/` | Node/Express + WebSocket broker — board generation, proof broker, freeze & private messaging |
| `web/` | Next.js + wagmi frontend |

---

## 🚀 Deployed Contract (Monad Testnet)

**`MinesweeperTournament`**
[`0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7`](https://testnet.monadscan.com/address/0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7)

✅ Verified on [Monadscan](https://testnet.monadscan.com/address/0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7) ("Pass") and [MonadVision](https://testnet.monadvision.com/address/0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7) ("perfect match")

- Deployed via **CREATE2** through the canonical CreateX factory, using an Alchemy Agent Wallet session — no raw key ever touched disk for the deploy itself.
- `owner()` is a **separate operator keypair**, generated locally for `server/`'s ongoing admin calls (`createRound` / `startRound` / `revealBoard`). See `server/.env` (gitignored).

> ℹ️ This is the first deploy carrying the **adjacent-mine hint**: safe tiles now publish their neighbour count to every player, while the reward still goes only to the revealer. This changed the committed Merkle leaf schema in an ABI-breaking way, so earlier addresses cannot be reused.

### Superseded Deployments

*Both abandoned rather than upgraded — testnet only, nothing of value at risk.*

| Address | Status |
|---|---|
| `0xb5018a829a81de6c1d37343428dac5503ebd8db2` | Predates the adjacent-mine hint |
| `0x13908659c9cd15f74619def7bddb5d1a2dcf4bd1` | End-to-end testing surfaced a real bug and a race condition (see below) |

**Issues found & fixed** against the second address:
- 🐛 `revealSafeTile` never checked that the caller had actually paid the entry fee.
- 🏁 A race condition: firing `startRound` immediately after `createRound`, without waiting for confirmation, could read a not-yet-mined, zero-valued round and revert.

Both are fixed in the contract and in `server/src/roundManager.ts` / `chain.ts`.

> ⚠️ **Redeploy note:** CreateX guards the salt you pass it (it doesn't use it raw), so the actual deployed address will differ from a naive `computeCreate2Address(salt, initCodeHash)` prediction — unless you also replicate CreateX's guarding logic. Read the real address back off the `OwnershipTransferred` event in the deploy transaction's receipt instead of trusting the prediction.

---

## 🛠️ Setup

**Prerequisites:** Node.js v18+ and Foundry.

> 🪟 **Windows + WSL users:** if Foundry is installed inside WSL while Node lives natively on Windows, `forge`/`cast` calls need to go through `wsl.exe -e bash -lc "..."` against the `/mnt/c/...` path — a plain Windows shell can't see the WSL filesystem.

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
# Node.js: https://nodejs.org (v18+), or via nvm/fnm
```

Deploy in order — contracts must be live before the frontend has an address to point at.

### 1️⃣ Contracts

```bash
cd contracts
forge install --no-git OpenZeppelin/openzeppelin-contracts
forge install --no-git foundry-rs/forge-std
forge test -vv
# deploy (see contracts/README.md — Alchemy Agent Wallet preferred over a raw key) + verify
```

### 2️⃣ Server

```bash
cd ../server
npm install
cp .env.example .env   # set CONTRACT_ADDRESS from the deploy above, and OPERATOR_PRIVATE_KEY
npm run dev
```

### 3️⃣ Web

```bash
cd ../web
npm install
cp .env.example .env.local   # set NEXT_PUBLIC_CONTRACT_ADDRESS from the deploy above
npm run dev
```

---

## 🎮 Running a Round

Creating and starting a round is a deliberate two-step process — there's a real window between the steps for players to call `enter` on the contract before the pool locks in.

```bash
# 1. Create the round
curl -X POST http://localhost:8787/api/rounds \
  -H "Content-Type: application/json" \
  -d '{"width":9,"height":9,"mineCount":10,"entryFeeWei":"10000000000000000","minPlayers":2}'
# -> { "roundId": "..." }   players enter from the frontend now

# 2. Start it once players have entered
curl -X POST http://localhost:8787/api/rounds/<roundId>/start
```

---

## ✅ What's Built

- The contract, with tests
- The full commit-reveal fairness scheme
- The broker: board generation, proof-serving, freeze / private-message logic, chain-event-driven board sync
- A working frontend: wallet connect, enter, live board, freeze overlay, flags

## 🧭 Follow-ups

*(Called out in-code where relevant — nothing here was silently skipped.)*

| Item | Status | Notes |
|---|---|---|
| **Wallet / auth** | Open | Uses a plain injected-wallet connector so the app runs standalone. Swap for Para per the `monskills` `wallet-integration` skill (`para init` + `ParaProvider`) once Node/npm and `para login` are available — that skill owns the actual wiring; this repo doesn't guess it. |
| **`useSendTransactionSync`** | Open | The scaffold skill calls out Monad's `eth_sendRawTransactionSync` for faster UI feedback, but doesn't document the hook's exact package/import. `revealSafeTile` currently goes through standard `useWriteContract` + `useWaitForTransactionReceipt` instead of guessing an import that might not exist. Swap in once the hook's source is confirmed. |
| ~~WS auth~~ | ✅ Done | The broker now requires a signature over a short-lived message proving control of the claimed address; admin routes require a bearer token. See `server/README.md`. |
| ~~Deploy + verify~~ | ✅ Done | Current address carries the adjacent-mine hint and is verified on both explorers — see [Deployed](#-deployed-contract-monad-testnet) above. |
| **shadcn** | Skipped | Using plain Tailwind instead, to avoid depending on `npx shadcn init` while npm wasn't available. Fine to add later. |
| **Operator trust boundary** | Open | The backend still *generates* the board — the onchain scheme proves it wasn't changed after commitment, not that the layout itself was unbiased. See the contract's NatSpec for the v2 idea (player-contributed entropy). |
