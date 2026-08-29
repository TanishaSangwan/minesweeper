# Agent handoff — Minesweeper Tournament on Monad

Read this before touching anything. It's written for a cold-start agent picking up this
project with no prior context — not a changelog, a briefing.

## What this is

A real-money, real-time multiplayer Minesweeper built for a Monad hackathon. Multiple players
share one board and race to reveal tiles:
- Safe reveal → instant onchain payout to that player, tile removed for **everyone**.
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
2. Per tile `i`: `nonce_i = keccak256(boardSeed, i)`, `leaf_i = keccak256(tileIndex_i, isMine_i, nonce_i)`.
3. Only the Merkle **root** goes onchain at `startRound` (the commitment).
4. A tile click only ever gets that *one* tile's `(nonce_i, proof)` — never `boardSeed` or any
   other tile's nonce, so no click leaks info about the rest of the board.
5. `revealBoard` (after the round ends) publishes `boardSeed` + full layout; the contract
   re-derives every leaf, rebuilds the root itself, and **reverts if it doesn't match** —
   the check is enforced by the contract, not just claimed.

**Trust boundary, stated plainly**: this proves the board wasn't changed after commitment. It
does **not** prove the layout was unbiased — `server/` still generates it. Fixing that needs
player-contributed entropy folded into `boardSeed` (not built — see "Left to do" below).

`server/src/merkle.ts` mirrors the contract's exact hashing (sorted-pair, odd-node-promoted,
`abi.encode`-style leaf construction) byte-for-byte. If you touch the Merkle logic in the
contract, you **must** update `merkle.ts` to match or every proof breaks. `web/lib/abi.ts` and
`server/src/abi.ts` are hand-maintained duplicates of the contract ABI — keep both in sync (or
better, replace both with the generated ABI from `contracts/out/.../MinesweeperTournament.json`
once you're set up to regenerate it).

## Deployed state (Monad testnet, chain id 10143)

- Contract: `0xb5018a829a81de6c1d37343428dac5503ebd8db2` — verified on Monadscan + MonadVision.
  Deployed via CREATE2 through the canonical CreateX factory (`0xba5Ed...ba5Ed`) using an
  Alchemy Agent Wallet session.
- `owner()` is a **separate** operator keypair (not the Alchemy session) generated locally via
  `cast wallet new` — this is who `server/`'s ongoing admin calls (`createRound`/`startRound`/
  `revealBoard`) sign with. Its private key lives only in `server/.env` (gitignored, not in
  this doc, not in git history). It never touches player funds — only `onlyOwner` admin calls.
- An earlier deploy at `0x13908659c9cd15f74619def7bddb5d1a2dcf4bd1` is **abandoned** (had two
  real bugs, see below) — don't use it, don't "fix it in place," it's dead.
- `server/.env` / `web/.env.local` hold the live RPC URLs, contract address, and operator key.
  Both are gitignored. `*.env.example` in each dir show the shape without secrets.

**If you redeploy**: CreateX *guards* the salt you pass — the actual CREATE2 address is **not**
the naive `computeCreate2Address(salt, initCodeHash)` prediction. Read the real address back
off the `OwnershipTransferred` event in the deploy tx's receipt instead of trusting the
prediction (bit me once already — see git history around the first deploy attempt).

## Two real bugs found by testing against the live chain (not just `forge test`) — why the code looks the way it does

1. **`revealSafeTile` didn't check `hasEntered`.** Anyone could claim reward without ever
   paying the entry fee. Fixed with a `NotEntered` require + regression test. If you add new
   payout paths, check entry-gating again — it's easy to forget.
2. **`createRound` → `startRound` fired back-to-back with no wait for confirmation.**
   `startRound` read the not-yet-mined round as a zeroed struct and divided by zero. Fixed by
   (a) `chain.ts`'s admin-call helper now waits for the tx receipt before returning, and (b)
   splitting the API into two real steps — `POST /api/rounds` opens entries, `POST
   /api/rounds/:id/start` locks + commits, with an actual gap between them for players to
   `enter`. **Do not re-collapse these into one call** — that's what caused the bug.

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
2. `server/src/roundManager.ts` — the broker's actual logic + why it's structured this way.
3. `server/src/merkle.ts` — must stay byte-identical to the contract's hashing.
4. `web/app/page.tsx` — how the frontend wires broker WS + onchain events together.
5. `README.md` — shorter version of this file, kept in sync; update both if either changes.
