# Deploying the broker + frontend

## Live

- **Broker**: https://broker-production-af4b.up.railway.app (Railway project `minesweeper-broker`,
  service `broker`, volume `broker-volume` mounted at `/data`)
- **Contract**: `0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7` on Monad testnet


The broker must go up first: the frontend is built against its URL.

## Why these hosts

The broker holds long-lived WebSocket connections and each live round's secret board layout,
so it needs a real always-on container with a persistent disk — not a serverless function.
Railway gives both with the least ceremony. The frontend is a stock Next.js app, so Vercel.

**Do not put the broker on Vercel.** Serverless functions cannot hold a socket open, and
losing the in-memory board layout of a live round strands its pool permanently.

## 1. Broker — Railway

```bash
npm i -g @railway/cli
railway login
cd server
railway init
railway volume add --mount-path /data     # REQUIRED: round secrets live here
# Note: no `--service` flag on this subcommand; it attaches to the linked service.
railway up
```

Set these variables (`railway variables --set 'K=V'`, or the dashboard):

| Variable | Value |
| --- | --- |
| `RPC_HTTP_URL` | `https://testnet-rpc.monad.xyz` |
| `RPC_WS_URL` | `wss://testnet-rpc.monad.xyz` |
| `CHAIN_ID` | `10143` |
| `CONTRACT_ADDRESS` | `0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7` |
| `OPERATOR_PRIVATE_KEY` | the key from `server/.env` — **secret** |
| `ADMIN_TOKEN` | the token from `server/.env` — **secret** |
| `ROUND_STORE_DIR` | `/data/rounds` |
| `AUTO_ROUND` | `true` — otherwise nobody can start a round |
| `AUTO_ROUND_MIN_PLAYERS` | `2` |
| `AUTO_ROUND_ENTRY_FEE_WEI` | `100000000000000000` (0.1 MON) |

Then `railway domain` for a public URL.

**Fund the operator wallet** (`owner()`) or every round-lifecycle call fails:

```bash
curl -X POST https://agents.devnads.com/v1/faucet -H "Content-Type: application/json" \
  -d '{"chainId":10143,"address":"<operator address>"}'
```

It only signs admin calls and never touches player funds — payouts are pulled by each
player's own wallet — but it *is* the contract owner, so treat the key as a secret.

## 2. Frontend — Vercel

```bash
npm i -g vercel
cd web
vercel
```

Environment variables (note `wss://`, not `https://`, for the socket):

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_CHAIN_ID` | `10143` |
| `NEXT_PUBLIC_RPC_HTTP_URL` | `https://testnet-rpc.monad.xyz` |
| `NEXT_PUBLIC_RPC_WS_URL` | `wss://testnet-rpc.monad.xyz` |
| `NEXT_PUBLIC_CONTRACT_ADDRESS` | `0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7` |
| `NEXT_PUBLIC_BROKER_HTTP_URL` | `https://broker-production-af4b.up.railway.app` |
| `NEXT_PUBLIC_BROKER_WS_URL` | `wss://broker-production-af4b.up.railway.app` |

Then `vercel --prod`.

## Lobby mode

With `AUTO_ROUND=true` the broker keeps exactly one Open round available and starts it as soon
as `AUTO_ROUND_MIN_PLAYERS` have entered, opening a fresh one when the previous board is
cleared. Without it, `startRound` is owner-only with no UI, so a visitor lands on a page with
nothing to join.

## Known limits before real money

- **Operator picks the board.** The onchain scheme proves it wasn't altered after commitment,
  not that the layout was unbiased. Player-contributed entropy is the v2 fix.
- **Losing a tile race costs gas.** Monad charges `gas_limit * price` even on a revert.
- **Reward must beat gas.** `entryFee * players / safeTiles` must exceed ~0.011 MON or every
  reveal is a loss. Small boards or large pools.
