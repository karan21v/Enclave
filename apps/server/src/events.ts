// chainHash lives in @enclave/merkle, not here. The standalone verifier has to
// compute the identical hash without importing anything server-side, and two
// copies of a hash construction is two things to keep in step. There are
// exactly two: this package, and tools/verify-transcript.mjs, which
// reimplements it deliberately. verifier-agreement.test.ts holds them together.
import { chainHash, GENESIS } from "@enclave/merkle";
import { prisma } from "./db.js";

// Prisma gives back Uint8Array for Bytes columns and newer @types/node made
// Buffer generic, so they don't unify. <ArrayBuffer> because Prisma won't take
// SharedArrayBuffer-backed views.
export type Bytes = Uint8Array<ArrayBuffer>;

export interface StoredEvent {
  seq: number;
  epoch: number;
  nonce: Bytes;
  payload: Bytes;
  hash: Bytes;
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

// Nothing authenticates a writer -- knowing the room id is enough to append.
// Fine locally, not fine on a small database, so rooms are finite. 50k is way
// past any real session and works out ~9MB at ~176 bytes/event. Env-tunable
// because the right ceiling is really a property of whatever database you
// deployed against.
export const MAX_EVENTS_PER_ROOM = Number(process.env.MAX_EVENTS_PER_ROOM ?? 50_000);

export class RoomFullError extends Error {
  constructor(roomId: string) {
    super(`room ${roomId} has reached ${MAX_EVENTS_PER_ROOM} events`);
    this.name = "RoomFullError";
  }
}

// One append at a time per room. Two clients racing both read "last seq is 7",
// both write 8, one dies on the unique constraint and the hash chain forks.
// TODO: only works single-process. needs a Postgres advisory lock before this
// can run on more than one instance.
const appendChains = new Map<string, Promise<unknown>>();
const tails = new Map<string, { seq: number; hash: Bytes }>();

async function loadTail(roomId: string) {
  const cached = tails.get(roomId);
  if (cached) return cached;

  const last = await prisma.event.findFirst({
    where: { roomId },
    orderBy: { seq: "desc" },
  });

  const tail = last
    ? { seq: last.seq, hash: Uint8Array.from(last.hash) }
    : { seq: -1, hash: GENESIS };

  tails.set(roomId, tail);
  return tail;
}

// payload is opaque here -- it's ciphertext from the client and this never
// looks inside
export async function appendEvent(
  roomId: string,
  payload: Bytes,
  epoch = 0,
  nonce: Bytes = new Uint8Array(0),
): Promise<StoredEvent> {
  const prev = appendChains.get(roomId) ?? Promise.resolve();

  const next = prev.then(async (): Promise<StoredEvent> => {
    const tail = await loadTail(roomId);
    const seq = tail.seq + 1;

    // has to be in here, against the same tail the hash chains off. checking
    // outside lets two appends race past the cap.
    if (seq >= MAX_EVENTS_PER_ROOM) throw new RoomFullError(roomId);

    const hash = chainHash(tail.hash, seq, epoch, nonce, payload);

    await prisma.event.create({
      data: { roomId, seq, epoch, nonce, ciphertext: payload, hash },
    });

    tails.set(roomId, { seq, hash });
    return { seq, epoch, nonce, payload, hash };
  });

  // swallow the rejection on the stored chain, otherwise one failed append
  // wedges every later one for this room
  appendChains.set(
    roomId,
    next.catch(() => undefined),
  );

  return next;
}

export async function replayEvents(roomId: string, afterSeq: number): Promise<StoredEvent[]> {
  const rows = await prisma.event.findMany({
    where: { roomId, seq: { gt: afterSeq } },
    orderBy: { seq: "asc" },
  });

  return rows.map((r) => ({
    seq: r.seq,
    epoch: r.epoch,
    nonce: Uint8Array.from(r.nonce),
    payload: Uint8Array.from(r.ciphertext),
    hash: Uint8Array.from(r.hash),
  }));
}

export function forgetRoomCache(roomId: string) {
  tails.delete(roomId);
  appendChains.delete(roomId);
}
