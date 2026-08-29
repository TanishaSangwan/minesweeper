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

Two-step, matching the contract's own `Open` → `InProgress` lifecycle — there's a real window
between them for players to call `enter` before the pool is locked in. Both admin-only in a
real deploy (put behind auth).

- `POST /api/rounds` — `{ width, height, mineCount, entryFeeWei, minPlayers }` → generates a
  board (kept secret in memory), calls `createRound` onchain, returns `{ roundId }`. Entries
  are open at this point; nothing is committed yet.
- `POST /api/rounds/:id/start` — call once enough players have entered. Locks entries, commits
  the board's Merkle root onchain (`startRound`), and opens play. Reverts (returned as a 400)
  if the contract's own `minPlayers` threshold hasn't been met.

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

## Auth

Both admin routes require `Authorization: Bearer $ADMIN_TOKEN`. They spend the operator
wallet's gas on every call, so an unauthenticated broker can be drained in a loop. `ADMIN_TOKEN`
is a required env var — there is deliberately no "unset means open" mode.

The WS connection is authenticated by signature. Alongside `roundId` and `player`, the client
sends `issuedAt` (epoch ms) and `signature` over:

```
Minesweeper Tournament
round: <roundId>
player: <lowercased address>
issued: <issuedAt>
```

The broker recovers the signer and rejects (close code 1008) anything that doesn't match the
claimed address, or whose `issuedAt` is more than 5 minutes from now in either direction. The
bound is two-sided on purpose: a future timestamp would otherwise mint a credential that never
expires. `authMessage` in `src/auth.ts` and the copy in `web/hooks/useGameSocket.ts` must stay
byte-identical.

Without this, a player who legitimately entered could also connect *as another entrant* —
probing tiles under that identity to dodge their own 5s freezes, learning which tiles are safe,
and reading their private mine-hit channel. Signing costs no UX because the browser's session
wallet signs locally, with no prompt.
