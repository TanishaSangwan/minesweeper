// Hand-maintained to match contracts/src/MinesweeperTournament.sol exactly.
// TODO once `forge build` has run: replace this with the generated ABI from
// contracts/out/MinesweeperTournament.sol/MinesweeperTournament.json so the two can never
// drift silently. Kept in sync with web/lib/abi.ts — update both together.
export const minesweeperTournamentAbi = [
  {
    type: "constructor",
    inputs: [{ name: "initialOwner", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "nextRoundId",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "createRound",
    inputs: [
      { name: "entryFee", type: "uint256" },
      { name: "totalSafeTiles", type: "uint16" },
      { name: "minPlayers", type: "uint16" },
    ],
    outputs: [{ name: "roundId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "enter",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "cancelRound",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "startRound",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "merkleRoot", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "revealSafeTile",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "tileIndex", type: "uint16" },
      { name: "nonce", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "revealBoard",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "isMine", type: "bool[]" },
      { name: "boardSeed", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "roundInfo",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [
      { name: "entryFee", type: "uint256" },
      { name: "totalSafeTiles", type: "uint16" },
      { name: "revealedSafeTiles", type: "uint16" },
      { name: "minPlayers", type: "uint16" },
      { name: "pool", type: "uint256" },
      { name: "rewardPerTile", type: "uint256" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "state", type: "uint8" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "entrantsOf",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "finalBoardOf",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ type: "bool[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hasEntered",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tileRevealed",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint16" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "RoundCreated",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "entryFee", type: "uint256", indexed: false },
      { name: "totalSafeTiles", type: "uint16", indexed: false },
      { name: "minPlayers", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Entered",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "pool", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoundCancelled",
    inputs: [{ name: "roundId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "RoundStarted",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "merkleRoot", type: "bytes32", indexed: false },
      { name: "rewardPerTile", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TileRevealed",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "tileIndex", type: "uint16", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "reward", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoundFinished",
    inputs: [{ name: "roundId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "BoardRevealed",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "boardSeed", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "InvalidState", inputs: [] },
  { type: "error", name: "WrongEntryFee", inputs: [] },
  { type: "error", name: "AlreadyEntered", inputs: [] },
  { type: "error", name: "NotEnoughPlayers", inputs: [] },
  { type: "error", name: "TileAlreadyRevealed", inputs: [] },
  { type: "error", name: "InvalidProof", inputs: [] },
  { type: "error", name: "BoardMismatch", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
] as const;
