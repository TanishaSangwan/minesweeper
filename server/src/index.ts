import cors from "cors";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { env } from "./env.js";
import { RoundManager, type ServerMessage } from "./roundManager.js";

type Address = `0x${string}`;

const app = express();
app.use(cors());
app.use(express.json());

const rounds = new RoundManager();
// Bring back any round that was live when this process last stopped, before accepting
// traffic — otherwise its board layout is gone and its pool is stranded (see store.ts).
await rounds.restore();
rounds.wireChainEvents();

// Admin-only in a real deploy (put behind auth). Opens a round for entries and generates the
// board (kept secret in memory) — does NOT commit the root onchain yet, so players still have
// a window to call `enter` before the pool used for reward-per-tile math is locked in.
app.post("/api/rounds", async (req, res) => {
  try {
    const { width, height, mineCount, entryFeeWei, minPlayers } = req.body as {
      width: number;
      height: number;
      mineCount: number;
      entryFeeWei: string;
      minPlayers: number;
    };
    const roundId = await rounds.createRound({ width, height, mineCount }, BigInt(entryFeeWei), minPlayers);
    res.json({ roundId: roundId.toString() });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// Admin-only. Call once enough players have entered — locks entries, commits the board's
// Merkle root onchain, and opens play. Reverts (propagated as 400) if the contract's own
// `minPlayers` threshold hasn't been met yet.
app.post("/api/rounds/:id/start", async (req, res) => {
  try {
    await rounds.startRound(BigInt(req.params.id));
    res.json({ started: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// Public: dimensions + tile counts only, never the mine layout — the frontend needs this to
// lay out the grid before any tile has been clicked.
app.get("/api/rounds/:id", (req, res) => {
  try {
    const info = rounds.getPublicInfo(BigInt(req.params.id));
    res.json(info);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

const server = app.listen(env.port, () => {
  console.log(`minesweeper broker listening on :${env.port}`);
});

// One socket per connected player; roundId + player address come in on the query string
// (swap for a signed-message/session auth check before this leaves hackathon-land — as is,
// nothing stops a client from claiming someone else's address here, which matters for the
// private mine-hit channel).
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket: WebSocket, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const roundId = url.searchParams.get("roundId");
  const player = url.searchParams.get("player") as Address | null;
  if (!roundId || !player) {
    socket.close(1008, "roundId and player query params are required");
    return;
  }

  const roundIdBig = BigInt(roundId);
  try {
    rounds.registerSocket(roundIdBig, player, socket);
  } catch (err) {
    socket.close(1008, (err as Error).message);
    return;
  }

  socket.on("message", (raw) => {
    let msg: { type: string; tileIndex?: number; flagged?: boolean };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      const err: ServerMessage = { type: "error", message: "invalid JSON" };
      socket.send(JSON.stringify(err));
      return;
    }

    if (msg.type === "click" && typeof msg.tileIndex === "number") {
      const response = rounds.handleClick(roundIdBig, player, msg.tileIndex);
      socket.send(JSON.stringify(response));
      return;
    }

    if (msg.type === "flag" && typeof msg.tileIndex === "number") {
      const flagged = Boolean(msg.flagged);
      const response = rounds.handleFlag(roundIdBig, player, msg.tileIndex, flagged);
      // Flags are visible to everyone, including the player who set them.
      rounds.broadcast(roundIdBig, response);
      return;
    }

    const err: ServerMessage = { type: "error", message: `unknown message type: ${msg.type}` };
    socket.send(JSON.stringify(err));
  });
});
