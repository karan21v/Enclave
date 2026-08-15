import type { WebSocket } from "ws";
import { forgetRoomCache } from "./events.js";
import { forgetTouch } from "./reaper.js";

// Presence lives in memory on purpose -- it's only true while this process is
// up, and writing it to Postgres would mean a write per connect/disconnect plus
// stale rows to clean after every crash.
// Downside: two server instances can't see each other's members. Would need
// Redis pub/sub to scale out.
const rooms = new Map<string, Set<WebSocket>>();

export function join(roomId: string, ws: WebSocket) {
  let members = rooms.get(roomId);
  if (!members) {
    members = new Set();
    rooms.set(roomId, members);
  }
  members.add(ws);
}

export function leave(roomId: string, ws: WebSocket) {
  const members = rooms.get(roomId);
  if (!members) return;

  members.delete(ws);

  if (members.size === 0) {
    rooms.delete(roomId);
    forgetRoomCache(roomId);
    forgetTouch(roomId);
  }
}

export function broadcast(roomId: string, msg: string, except: WebSocket) {
  const members = rooms.get(roomId);
  if (!members) return;

  for (const ws of members) {
    if (ws === except) continue;
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(msg);
  }
}

export function memberCount(roomId: string): number {
  return rooms.get(roomId)?.size ?? 0;
}
