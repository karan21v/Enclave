import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { prisma } from "./db.js";
import { appendEvent, replayEvents, RoomFullError, toBase64 } from "./events.js";
import { broadcast, join, leave, memberCount } from "./rooms.js";

const MAX_PAYLOAD = 1024 * 1024; // a 100MB "update" is an attack, not an edit
const HEARTBEAT_MS = 30_000;

// Token bucket, per connection. Yjs sends about one update per keystroke and a
// fast typist is ~10/s, so 25/s never touches real editing. Pasting a big block
// is one update, not many. Per connection and not per room -- two people typing
// shouldn't have to share.
const RATE_PER_SEC = 25;
const BURST = 100;

interface Client extends WebSocket {
  roomId?: string;
  isAlive?: boolean;
  tokens?: number;
  lastRefill?: number;
}

// refills from the clock, not a timer -- nothing has to wake an idle socket up
// to give it its allowance back
function takeToken(ws: Client): boolean {
  const now = Date.now();
  const elapsed = (now - (ws.lastRefill ?? now)) / 1000;

  ws.tokens = Math.min(BURST, (ws.tokens ?? BURST) + elapsed * RATE_PER_SEC);
  ws.lastRefill = now;

  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}

export function attachWebSockets(server: Server) {
  // noServer because Fastify owns the http server -- we only want to grab /ws
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const roomId = url.searchParams.get("room");
    if (!roomId) {
      // still plain HTTP at this point, so a raw response is the right reply
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // check the room exists before upgrading, otherwise typos and scanners
    // create phantom rooms in memory
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, roomId, url);
    });
  });

  wss.on("connection", async (ws: Client, _req: unknown, roomId: string, url: URL) => {
    ws.roomId = roomId;
    ws.isAlive = true;
    ws.tokens = BURST;
    ws.lastRefill = Date.now();
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    join(roomId, ws);

    // client tells us the last seq it has, we send everything after.
    // sending too much is fine -- Yjs updates are idempotent, so re-applying
    // something they already have is a no-op.
    const after = Number(url.searchParams.get("after") ?? -1);
    const backlog = await replayEvents(roomId, Number.isFinite(after) ? after : -1);

    ws.send(
      JSON.stringify({
        t: "sync",
        events: backlog.map((e) => ({
          seq: e.seq,
          epoch: e.epoch,
          nonce: toBase64(e.nonce),
          payload: toBase64(e.payload),
        })),
      }),
    );

    announcePresence(roomId);

    ws.on("message", async (raw) => {
      let msg: { t?: string; payload?: string; epoch?: number; nonce?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore junk frames
      }

      if (msg.t !== "update" || typeof msg.payload !== "string") return;

      // drop it, don't disconnect. a real client that briefly outruns the
      // budget still has the update in its own doc -- killing the socket turns
      // a burst into lost work.
      if (!takeToken(ws)) {
        ws.send(JSON.stringify({ t: "error", message: "rate limited" }));
        return;
      }

      try {
        const payload = Uint8Array.from(Buffer.from(msg.payload, "base64"));
        const nonce = msg.nonce
          ? Uint8Array.from(Buffer.from(msg.nonce, "base64"))
          : new Uint8Array(0);

        const stored = await appendEvent(roomId, payload, msg.epoch ?? 0, nonce);

        broadcast(
          roomId,
          JSON.stringify({
            t: "update",
            seq: stored.seq,
            epoch: stored.epoch,
            nonce: toBase64(stored.nonce),
            payload: msg.payload,
          }),
          ws,
        );

        // tell the sender what seq it got, so it can resume from there
        ws.send(JSON.stringify({ t: "ack", seq: stored.seq }));
      } catch (err) {
        if (err instanceof RoomFullError) {
          ws.send(JSON.stringify({ t: "error", message: "room is full" }));
          return; // expected, not a server fault -- don't log it as one
        }
        ws.send(JSON.stringify({ t: "error", message: "append failed" }));
        console.error("append failed", err);
      }
    });

    ws.on("close", () => {
      leave(roomId, ws);
      announcePresence(roomId);
    });
  });

  // TCP won't tell us about a closed laptop lid for minutes, so ping and drop
  // anything that didn't answer last round
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<Client>) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on("close", () => clearInterval(heartbeat));

  function announcePresence(roomId: string) {
    const msg = JSON.stringify({ t: "presence", count: memberCount(roomId) });
    for (const ws of wss.clients as Set<Client>) {
      if (ws.roomId === roomId && ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  return wss;
}
