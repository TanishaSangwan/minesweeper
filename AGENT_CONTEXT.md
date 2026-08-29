# Agent handoff — Minesweeper Tournament on Monad

Read this before touching anything. It's written for a cold-start agent picking up this
project with no prior context — not a changelog, a briefing.

## What this is

A real-money, real-time multiplayer Minesweeper built for a Monad hackathon. Multiple players
share one board and race to reveal tiles:
- Safe reveal → instant onchain payout to that player, tile removed for **everyone**, and the
  tile's **adjacent-mine count is published to everyone**. Revealing to all and paying one are
  deliberately decoupled: the hint is public, the reward is not. Without this the game had no
  deduction at all — every click was a blind coin flip.
- Mine hit → private message to **that player only**, 5s move-freeze, tile stays hidden for
  everyone else (no global removal, no payout, no onchain call at all).
- Flags → visible to all players, purely cosmetic, no chain interaction.
- Fairness → the mine layout is committed onchain (as a Merkle root) before play starts; the
  secret that proves it is only published after the round ends, so anyone can verify the
  layout wasn't tampered with mid-game.

## Architecture — read this before changing anything structural

```
contracts/   Foundry project — MinesweeperTournament.sol (escrow, commit-reveal, payouts)
server/      Node/Express + ws broker — board generation, proof broker, freeze + private msgs
web/         Next.js + wagmi frontend
```

**Division of responsibility (don't blur this without a reason):**
- **Onchain = source of truth for money and the shared board**: entry fees, escrow, board
  commitment, safe-tile reveal + payout, final board verification.
- **`server/` = fast-path game logic with zero money movement**: knows the mine layout, hands
  out Merkle proofs for legitimate safe clicks, enforces freeze timers, sends private mine-hit
  notices. It never custodies funds and never submits the payout transaction itself — the
  *player's own wallet* submits `revealSafeTile` with the proof the broker gave it.
- **`web/`'s shared board state comes from watching the contract's own `TileRevealed` event**
  over websocket RPC, not from the broker's say-so — this is deliberate, so the UI can never
  drift from onchain truth. The broker's own WS channel is only for private freeze notices and
  flag broadcast (see `web/hooks/useBoardSync.ts` vs `web/hooks/useGameSocket.ts`).

## The fairness scheme (read `contracts/src/MinesweeperTournament.sol`'s NatSpec header first)

1. `server/` generates the board + one secret `boardSeed`.
2. Per tile `i`: `nonce_i = keccak256(boardSeed, i)`,
   `leaf_i = keccak256(tileIndex_i, isMine_i, adjacentMines_i, nonce_i)`.
   `adjacentMines_i` is the Minesweeper hint (mines among that tile's up-to-8 neighbours,
   computed for mine tiles too). Committing it means a caller cannot claim a tile while
   feeding everyone a false number — a wrong count simply fails proof verification.
3. Only the Merkle **root** goes onchain at `startRound` (the commitment).
4. A tile click only ever gets that *one* tile's `(nonce_i, proof)` — never `boardSeed` or any
   other tile's nonce, so no click leaks info about the rest of the board.
5. `revealBoard` (after the round ends) publishes `boardSeed` + full layout; the contract
   re-derives every leaf — **recomputing each tile's neighbour count itself** from the
   published layout — rebuilds the root, and **reverts if it doesn't match**. So both "the
   board wasn't altered" and "every hint served during play was honest" are enforced onchain.
   `revealBoard` needs the grid shape, which is why `createRound` takes `width`/`height`.

**Trust boundary, stated plainly**: this proves the board wasn't changed after commitment. It
does **not** prove the layout was unbiased — `server/` still generates it. Fixing that needs
player-contributed entropy folded into `boardSeed` (not built — see "Left to do" below).

`server/src/merkle.ts` mirrors the contract's exact hashing (sorted-pair, odd-node-promoted,
`abi.encode`-style leaf construction) byte-for-byte, and `server/src/board.ts`'s
`computeAdjacentMines` mirrors the contract's `_adjacentMines`. If you touch either the Merkle
logic or the neighbour-count rule, you **must** update both sides or every proof breaks.
`contracts/test/MerkleInterop.t.sol` is the guard: it feeds the contract a root computed by the
TypeScript and fails if the two implementations disagree anywhere. `web/lib/abi.ts` and
`server/src/abi.ts` are hand-maintained duplicates of the contract ABI — keep both in sync (or
better, replace both with the generated ABI from `contracts/out/.../MinesweeperTournament.json`
once you're set up to regenerate it).

## Deployed state (Monad testnet, chain id 10143)

- Contract: `0x1970bA7FceE762a529ED61D22880859F7a0E3Ab7` — verified on Monadscan ("Pass") and
  MonadVision ("perfect match"). Deployed via CREATE2 through the canonical CreateX factory
  (`0xba5Ed...ba5Ed`) using an Alchemy Agent Wallet session. This is the first deploy carrying
  the adjacent-mine hint.
- `owner()` is a **separate** operator keypair (not the Alchemy session) generated locally via
  `cast wallet new` — currently `0x44000668AC4047775638A8637b712c0A318Ef5e9`. This is who
  `server/`'s ongoing admin calls (`createRound`/`startRound`/`revealBoard`) sign with. Its
  private key lives only in `server/.env` (gitignored, not in this doc, not in git history).
  It never touches player funds — only `onlyOwner` admin calls. **Fund it** or every admin
  call fails; it is not the same wallet the faucet tops up for players.
- **Abandoned, don't use:** `0xb5018a829a81de6c1d37343428dac5503ebd8db2` (predates the
  adjacent-mine hint, so its leaf schema and ABI differ) and
  `0x13908659c9cd15f74619def7bddb5d1a2dcf4bd1` (had two real bugs, see below).
- `server/.env` / `web/.env.local` hold the live RPC URLs, contract address, and operator key.
  Both are gitignored. `*.env.example` in each dir show the shape without secrets.

**If you redeploy**: CreateX *guards* the salt you pass — the actual CREATE2 address is **not**
the naive `computeCreate2Address(salt, initCodeHash)` prediction. Read the real address back
off the `OwnershipTransferred` event in the deploy tx's receipt instead of trusting the
prediction (bit me once already — see git history around the first deploy attempt).

## Real bugs found by testing against the live chain (not just `forge test`) — why the code looks the way it does

1. **`revealSafeTile` didn't check `hasEntered`.** Anyone could claim reward without ever
   paying the entry fee. Fixed with a `NotEntered` require + regression test. If you add new
   payout paths, check entry-gating again — it's easy to forget. The broker enforces the same
   rule (`RoundManager.handleClick`): once the contract rejects non-entrants, handing one a
   proof only buys them a guaranteed-to-revert transaction, and on Monad a revert still costs
   `gas_limit * price`.
2. **`createRound` → `startRound` fired back-to-back with no wait for confirmation.**
   `startRound` read the not-yet-mined round as a zeroed struct and divided by zero. Fixed by
   (a) `chain.ts`'s admin-call helper now waits for the tx receipt before returning, and (b)
   splitting the API into two real steps — `POST /api/rounds` opens entries, `POST
   /api/rounds/:id/start` locks + commits, with an actual gap between them for players to
   `enter`. **Do not re-collapse these into one call** — that's what caused the bug.
3. **`startRound` marked the round started only *after* a follow-up RPC read.** That read
   (`entrantsOf`, caching who paid) hit the 15/sec rate limit and threw — *after* the
   `startRound` transaction had already been mined. The broker was left believing the round
   hadn't started while onchain it was `InProgress`. That state is **unrecoverable**:
   re-calling `startRound` reverts, and `cancelRound` is `Open`-only, so the pool is stranded.
   Fixed by setting `started = true` immediately after the tx lands and treating the entrant
   read as best-effort with retries. **General rule: never gate already-committed onchain
   state behind a later call that can fail.**

## Environment gotchas specific to this machine (Windows, mixed Node/Foundry setup)

Skip this section if you're on a clean Linux/Mac box — it won't apply.

- **Node.js is native Windows** (`C:\Program Files\nodejs`), **Foundry is inside WSL**
  (`~/.foundry/bin`). `forge`/`cast` calls must go through
  `wsl.exe -e bash -lc "cd '/mnt/c/...' && ~/.foundry/bin/forge ..."` — the `/mnt/c/...` path,
  not the Windows path. Plain Windows shells can't see the WSL filesystem or its `forge`.
- **PATH is stale in every shell** the harness spawns (installers updated the registry but
  running processes didn't pick it up). Two different fixes were needed for two different
  failure modes:
  - A monskills hook constructs its **own** restricted internal PATH (checks `~/.local/bin`,
    `~/.volta/bin`, `/usr/bin`, etc.) that doesn't include Windows-installer locations at all —
    no shell-level PATH export fixes this. Fix: shim scripts were dropped in `~/.local/bin`
    (`node`, `npm`, `npx`, `alchemy`) that just `exec` the real binaries — this satisfies both
    the hook's PATH and normal shell PATH resolution.
  - `npm run <script>` on Windows always spawns a native `cmd.exe` subshell internally, even
    when invoked from bash — the `~/.local/bin` shims (bash-only) don't help there. Fix:
    inline `export PATH="/c/Program Files/nodejs:$HOME/AppData/Roaming/npm:$PATH"` before any
    `npm run ...` call whose PATH needs to reach that nested subshell.
- **OneDrive breaks `next dev`.** The project lives under `OneDrive\Desktop\minesweeper` —
  OneDrive's cloud-placeholder files crash Next's dev server on `readlink` for
  `.next/app-build-manifest.json`. Fixed once via `attrib.exe +P -U <path> /S /D` (pins the
  folder to stay fully local). Shouldn't need repeating unless OneDrive re-clouds the folder.
- Alchemy CLI auth lives in `~/.config/alchemy/` (not `~/.alchemy/` — the wallet skill's docs
  say the latter, actual CLI version uses the former). Don't waste time checking the wrong path.

## Public RPC limits that will silently break your frontend

`https://testnet-rpc.monad.xyz` (and its `wss://` twin) is what the app points at by default.
Three hard limits, found the hard way:

- **`eth_newFilter` → "Method not found".** Not implemented.
- **`eth_getLogs` capped at a 100-block range**, and Monad's block rate means the gap between
  two polls routinely exceeds that.
- **15 requests/second**, shared across every poller you have running.

Consequence: **wagmi/viem's `useWatchContractEvent` does not work here.** It needs filters or
a workable `getLogs` window, gets neither, and fails *silently* — the reveal transaction
succeeds onchain, the money moves, and the UI never updates. This looked exactly like a broken
frontend for a while. `web/hooks/useBoardSync.ts` therefore polls the contract's
`revealedTiles(roundId)` view instead of watching `TileRevealed`; that view exists precisely
because reading state has none of these limits and is still onchain truth. Do not "simplify"
it back to event watching.

The `wss://` endpoint **does** support `eth_subscribe`, which is why `server/src/chain.ts`'s
websocket client can watch events fine. Only the HTTP-transport frontend is affected. Event
watching is kept in `useBoardSync` for player attribution only, and degrades to null.

The 15/sec limit also bit `startRound` once — see bug #3 below.

## Economics: reward must exceed gas, or the game is a money shredder

`rewardPerTile = pool / totalSafeTiles`, fixed at `startRound`. A safe reveal costs roughly
**0.011 MON** of gas (~110k gas at ~100 gwei). So the round is only worth playing if:

```
entryFee * numPlayers / totalSafeTiles  >  ~0.011 MON
```

A 9x9 board has 71 safe tiles, so it needs a **~0.8 MON pool** to break even. A 0.01 MON entry
on a 9x9 pays 0.00014 MON per tile — about **80x less than the gas to claim it**. Every reveal
is then a guaranteed loss, which reads as "the app is taking my money" and is not a bug.

Also inherent: **solo play can never profit.** With one entrant the pool is your own fee, so
clearing the board returns what you put in, minus gas. The game only pays when other players'
fees are in the pool and you win more than your share of tiles. Demo with small boards (few
safe tiles) or large pools.

## Monad-specific things that actually mattered here (not generic EVM advice)

- Gas is charged on `gas_limit`, not gas used — `server/src/chain.ts`'s admin calls estimate
  gas once and add a small buffer rather than trusting a fallback (see monskills `gas` skill).
- Ordinary block-inclusion latency between two sequenced transactions from the same signer is
  real and bit us (bug #2 above) — always wait for a receipt before a dependent call reads
  that state, don't assume same-account nonce ordering alone is enough for a *reader* to see
  the effect immediately.

## Left to do (not silently skipped — each is a deliberate deferral, not an oversight)

- **Wallet/auth**: `web/` uses a plain injected-wallet connector (works standalone). Swap for
  Para per monskills `wallet-integration` skill (`para init` + `ParaProvider`) — that skill
  owns the actual wiring, don't hand-roll it from memory.
- **`useSendTransactionSync`**: monskills' scaffold skill calls out Monad's
  `eth_sendRawTransactionSync` for faster confirmation UX, but doesn't document the hook's
  exact package/import — `revealSafeTile` currently uses standard `useWriteContract` +
  `useWaitForTransactionReceipt`. Swap in once that hook's actual source is confirmed; don't
  guess an import path that might not exist.
- **WS auth**: `server`'s `/ws?...&player=0x..` trusts a client-supplied address — needs a
  signed-message check before this is anything but a demo.
- **Board seed lives only in RAM** (`RoundManager.rounds`). Restart the broker mid-round and
  every live round's seed is gone: no more proofs can be served, the round can never reach
  `Finished`, `revealBoard` can never run, and the pool is locked forever. This has already
  destroyed live rounds during development — `tsx watch` restarts on any edit to `server/`.
  Persist the seed before this matters.
- **No escape hatch once `InProgress`.** `cancelRound` is `Open`-only, so a round that can't
  be completed strands its pool permanently. Pairs badly with the item above.
- **`cancelRound` refund loop is griefable**: one entrant that reverts on receiving ETH blocks
  every other entrant's refund, and the loop is unbounded in gas.
- **shadcn**: skipped in favor of plain Tailwind (npm wasn't available at scaffold time). Fine
  to add.
- **Operator trust / board bias**: see the fairness-scheme trust boundary above. v2 idea is
  entrants contributing entropy (e.g. a hash submitted at `enter()`) XORed into `boardSeed`.
- **Envio indexer** for a persistent leaderboard/activity feed — not started, not blocking.

## How to run it

```bash
# contracts (via WSL — see gotchas above)
cd contracts && forge test -vv

# server
cd server && npm install && npm run dev     # :8787, needs .env (see .env.example)

# web
cd web && npm install && npm run dev        # :3000, needs .env.local (see .env.example)
```

Create + start a round (two steps, see "bug #2" above for why):
```bash
curl -X POST http://localhost:8787/api/rounds -H "Content-Type: application/json" \
  -d '{"width":9,"height":9,"mineCount":10,"entryFeeWei":"10000000000000000","minPlayers":2}'
curl -X POST http://localhost:8787/api/rounds/<roundId>/start
```

## Key files to read, in order

1. `contracts/src/MinesweeperTournament.sol` — the whole design lives in its NatSpec.
2. `contracts/test/MerkleInterop.t.sol` — differential test pinning the contract's hashing and
   neighbour-count rule to the TypeScript's. Read before changing either side.
2. `server/src/roundManager.ts` — the broker's actual logic + why it's structured this way.
3. `server/src/merkle.ts` — must stay byte-identical to the contract's hashing.
4. `web/app/page.tsx` — how the frontend wires broker WS + onchain events together.
5. `README.md` — shorter version of this file, kept in sync; update both if either changes.
