# contracts/

Foundry project for `MinesweeperTournament.sol` — see the contract's NatSpec header for the
full commit-reveal fairness scheme.

## Setup (once Foundry is installed)

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup

forge install --no-git OpenZeppelin/openzeppelin-contracts
forge install --no-git foundry-rs/forge-std
```

## Test

```bash
forge test -vv
```

## Deploy

Preferred path: deploy via the Alchemy Agent Wallet session (monskills `wallet` skill) using
CREATE2 through the canonical CreateX factory (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`) —
gives a deterministic address and doesn't require handling a raw private key.

Fallback (local/anvil or a throwaway testnet key):

```bash
PRIVATE_KEY=0x... forge script script/Deploy.s.sol \
  --rpc-url monad_testnet \
  --broadcast
```

Monad testnet: chain id `10143`, RPC `https://testnet-rpc.monad.xyz`.
Monad mainnet: chain id `143`, RPC `https://rpc.monad.xyz`.

## Verify

**Always use the monskills verification API first** (verifies on MonadVision, Socialscan and
Monadscan in one call) — see the monskills `scaffold` skill for the exact `curl` invocation
(`standardJsonInput` from `forge verify-contract --show-standard-json-input`, plus the
`metadata` field from `out/MinesweeperTournament.sol/MinesweeperTournament.json`). Only fall
back to `forge verify-contract --verifier sourcify` if the API fails.

## Gas notes (Monad-specific — see monskills `gas` skill)

Monad charges `gas_limit * price_per_gas`, not gas actually used — so the frontend/backend
submitting `revealSafeTile` and `enter` should set explicit, tight gas limits rather than
trusting a wallet's `eth_estimateGas` fallback, especially since `revealSafeTile` will
legitimately revert whenever two players race the same tile (a reverted `eth_estimateGas`
call can make some wallets fall back to a very high limit, which the loser of the race would
then pay for). `server/src/chain.ts` and the frontend's tx-building code hardcode limits for
`enter`, `revealSafeTile`, `startRound`, and `revealBoard` for this reason.
