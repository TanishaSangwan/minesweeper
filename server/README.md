# server/

The "broker": generates the board + Merkle commitment, brokers tile clicks (safe → proof for
the player's wallet to submit onchain; mine → private freeze notice, no chain call), and
mirrors the shared board off the contract's own `TileRevealed` events. See
`roundManager.ts` for the full explanation of what this process is (and isn't) trusted for.

## Setup

```bash
npm install
cp .env.example .env   # fill in CONTRACT_ADDRESS once contracts/ is deployed, and OPERATOR_PRIVATE_KEY
npm run dev
```

`OPERATOR_PRIVATE_KEY` only ever calls admin-only contract functions (`createRound`,
`startRound`, `cancelRound`, `revealBoard`) — it never touches player funds, since payouts are
pulled by each player's own wallet via `revealSafeTile`. Fine for a hackathon; swap for an
Alchemy Agent Wallet session (monskills `wallet` skill) before this handles real value beyond
gas.

## HTTP

`POST /api/rounds` — `{ width, height, mineCount, entryFeeWei, minPlayers }` → generates a
board, calls `createRound` + `startRound` onchain, returns `{ roundId }`. Put this behind
admin auth before it's public.

## WebSocket — `/ws?roundId=<id>&player=<0x address>`

Client → server:
- `{ type: "click", tileIndex }`
- `{ type: "flag", tileIndex, flagged }`

Server → client (see `ServerMessage` in `roundManager.ts` for the full union):
- `"safe"` (private) — submit `revealSafeTile(roundId, tileIndex, nonce, proof)` with the
  player's own wallet.
- `"mine-hit"` (private) — freeze countdown, tile stays hidden for everyone else.
- `"frozen"` / `"already-revealed"` (private) — rejected click, with why.
- `"tile-revealed"` (broadcast) — driven by the onchain `TileRevealed` event, not a guess.
- `"flag"` (broadcast) — flags are visible to everyone.
- `"round-finished"` (broadcast) — board is fully cleared; `revealBoard` fires automatically.

**Not yet done:** the `player` on the WS connection is just a query param — add real auth
(e.g. a signed message) before this leaves hackathon-land, since right now nothing stops a
client from claiming someone else's address and reading their private channel.
