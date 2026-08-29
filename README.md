# Minesweeper Tournament (Monad hackathon)

Real-money, real-time competitive Minesweeper. Multiple players share one board and race to
reveal tiles — a safe reveal pays out instantly onchain and removes the tile for everyone; a
mine hit is private (that player only) and freezes them for 5s without touching the tile for
anyone else. The mine layout is committed onchain before play starts and independently
verifiable after the round ends. Full design writeup: `contracts/src/MinesweeperTournament.sol`'s
NatSpec header, and the plan this was built from at
`C:\Users\TANISHA\.claude\plans\abstract-plotting-yeti.md`.

```
contracts/   Foundry project — MinesweeperTournament.sol (escrow, commit-reveal, payouts)
server/      Node/Express + ws broker — board generation, proof broker, freeze + private msgs
web/         Next.js + wagmi frontend
```

## Setup

Node.js (v18+) and Foundry are required and were **not** available in the environment this
was scaffolded in — install both first:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
# Node.js: https://nodejs.org (v18+), or via nvm/fnm
```

Then, in order (contracts must be deployed before the frontend has an address to point at):

```bash
# 1. contracts
cd contracts
forge install --no-git OpenZeppelin/openzeppelin-contracts
forge install --no-git foundry-rs/forge-std
forge test -vv
# deploy (see contracts/README.md — Alchemy Agent Wallet preferred over a raw key) + verify

# 2. server
cd ../server
npm install
cp .env.example .env   # set CONTRACT_ADDRESS from the deploy above, and OPERATOR_PRIVATE_KEY
npm run dev

# 3. web
cd ../web
npm install
cp .env.example .env.local   # set NEXT_PUBLIC_CONTRACT_ADDRESS from the deploy above
npm run dev
```

Create a round once the server is running:

```bash
curl -X POST http://localhost:8787/api/rounds \
  -H "Content-Type: application/json" \
  -d '{"width":9,"height":9,"mineCount":10,"entryFeeWei":"10000000000000000","minPlayers":2}'
```

## What's built vs. what's left

Built: the contract (+ tests), the full commit-reveal fairness scheme, the broker (board gen,
proof-serving, freeze/private-message logic, chain-event-driven board sync), and a working
frontend (wallet connect, enter, live board, freeze overlay, flags).

Left as follow-ups (called out in-code where relevant, not silently skipped):
- **Wallet/auth**: uses a plain injected-wallet connector so the app runs standalone. Swap for
  Para per monskills `wallet-integration` skill (`para init` + `ParaProvider`) once Node/npm
  and `para login` are available — that skill owns the actual wiring, this repo doesn't guess it.
- **`useSendTransactionSync`**: the scaffold skill calls out Monad's `eth_sendRawTransactionSync`
  for faster UI feedback, but doesn't document the hook's exact package/import, so
  `revealSafeTile` currently goes through standard `useWriteContract` +
  `useWaitForTransactionReceipt` instead of guessing an import that might not exist. Swap in
  once that hook's source is confirmed.
- **WS auth**: the broker's `/ws?...&player=0x..` trusts the client-supplied address — needs a
  signed-message check before this is anything but a demo (see `server/README.md`).
- **Deploy + verify**: not run yet (needs Foundry + the Alchemy Agent Wallet session).
- **shadcn**: skipped in favor of plain Tailwind, to avoid depending on `npx shadcn init`
  while npm wasn't available; fine to add later.
- **Operator trust boundary**: the backend still *generates* the board — the onchain scheme
  proves it wasn't changed after commitment, not that the layout itself was unbiased. See the
  contract's NatSpec for the v2 idea (player-contributed entropy).
