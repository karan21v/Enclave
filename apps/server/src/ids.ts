import { randomBytes } from "node:crypto";

// no login, so knowing the id is what gets you into the room -- sequential ids
// would let anyone walk through every room and scrape metadata
export function newRoomId(): string {
  return randomBytes(16).toString("base64url");
}
