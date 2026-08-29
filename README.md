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

## Deployed (Monad testnet)

`MinesweeperTournament`: [`0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7`](https://testnet.monadscan.com/address/0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7)
— verified on Monadscan ("Pass") and [MonadVision](https://testnet.monadvision.com/address/0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7)
("perfect match"). Deployed via CREATE2 through the canonical CreateX factory using an Alchemy
Agent Wallet session (no raw key ever touched disk for the deploy itself). `owner()` is a
separate operator keypair generated locally for `server/`'s ongoing admin calls
(`createRound`/`startRound`/`revealBoard`) — see `server/.env` (gitignored).

This is the first deploy carrying the adjacent-mine hint: safe tiles now publish their
neighbour count to every player while the reward still goes only to the revealer. That changed
the committed Merkle leaf schema and is ABI-breaking, so the two earlier addresses cannot be
reused.

Superseded, both abandoned rather than upgraded (testnet, nothing of value at risk):
- `0xb5018a829a81de6c1d37343428dac5503ebd8db2` — predates the adjacent-mine hint.
- `0x13908659c9cd15f74619def7bddb5d1a2dcf4bd1` — end-to-end testing against it caught a real
  bug (`revealSafeTile` never checked the caller had actually paid the entry fee) and a race
  (firing `startRound` immediately after `createRound` without waiting for confirmation read a
  not-yet-mined, zero-valued round and reverted). Both are fixed in the contract and in
  `server/src/roundManager.ts`/`chain.ts`.

Note if you ever redeploy: CreateX guards the salt you pass it (it does not use it raw), so
the actual deployed address will differ from a naive `computeCreate2Address(salt, initCodeHash)`
prediction unless you also replicate CreateX's guarding — read the real address back off the
`OwnershipTransferred` event in the deploy tx's receipt instead of trusting the prediction.

## Setup

Node.js (v18+) and Foundry are required. If you're on Windows and installed Foundry inside
WSL while Node lives natively on Windows (as happened here), Foundry/`cast`/`forge` calls need
to go through `wsl.exe -e bash -lc "..."` against the `/mnt/c/...` path — plain Windows shells
can't see the WSL filesystem.

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

Create and start a round once the server is running (two steps — there's a real window
between them for players to call `enter` on the contract before the pool locks in):

```bash
curl -X POST http://localhost:8787/api/rounds \
  -H "Content-Type: application/json" \
  -d '{"width":9,"height":9,"mineCount":10,"entryFeeWei":"10000000000000000","minPlayers":2}'
# -> { "roundId": "..." } — players enter from the frontend now

curl -X POST http://localhost:8787/api/rounds/<roundId>/start
```

## What's built and what's left

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
- ~~**WS auth**~~: done — the broker now requires a signature over a short-lived message
  proving control of the claimed address, and the admin routes require a bearer token. See
  `server/README.md`.
- ~~**Deploy + verify**~~: done — current address carries the adjacent-mine hint and is
  verified on both explorers. See "Deployed" above.
- **shadcn**: skipped in favor of plain Tailwind, to avoid depending on `npx shadcn init`
  while npm wasn't available; fine to add later.
- **Operator trust boundary**: the backend still *generates* the board — the onchain scheme
  proves it wasn't changed after commitment, not that the layout itself was unbiased. See the
  contract's NatSpec for the v2 idea (player-contributed entropy).
