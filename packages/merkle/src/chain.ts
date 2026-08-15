import { createHash } from "node:crypto";
import type { Bytes } from "./merkle.js";

// The raw fields the server stores. Deliberately not "and its hash" -- a
// verifier that reads the server's hash column is checking the server's
// arithmetic against itself. Everything here is recomputed from these bytes.
export interface TranscriptEvent {
  seq: number;
  epoch: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

// first event chains off 32 zero bytes
export const GENESIS: Bytes = new Uint8Array(32);

// sha256(prevHash || seq || epoch || nonce || ciphertext)
// seq and epoch are inside the hash so events cannot be reordered or relabelled
// and still chain.
export function chainHash(
  prev: Uint8Array,
  seq: number,
  epoch: number,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Bytes {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(seq, 0);
  header.writeUInt32BE(epoch, 4);

  return Uint8Array.from(
    createHash("sha256")
      .update(prev)
      .update(header)
      .update(nonce)
      .update(ciphertext)
      .digest(),
  );
}

export interface ChainResult {
  ok: boolean;
  /** recomputed hash per event, in order. empty when the chain is broken. */
  hashes: Bytes[];
  /** first thing found wrong, in log order */
  error?: string;
}

// Walks the log from genesis and rebuilds every hash. Gaps are checked
// explicitly: a missing seq breaks the chain anyway, but saying "gap at 4" is
// more useful than "hash mismatch at 5".
export function verifyChain(events: readonly TranscriptEvent[]): ChainResult {
  const hashes: Bytes[] = [];
  let prev = GENESIS;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    if (e.seq !== i) {
      return { ok: false, hashes: [], error: `expected seq ${i}, found ${e.seq}` };
    }

    prev = chainHash(prev, e.seq, e.epoch, e.nonce, e.ciphertext);
    hashes.push(prev);
  }

  return { ok: true, hashes };
}
