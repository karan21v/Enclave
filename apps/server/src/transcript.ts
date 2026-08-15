import {
  encodeEventLeaf,
  inclusionProof,
  merkleRoot,
  type InclusionProof,
} from "@enclave/merkle";
import { prisma } from "./db.js";
import { toBase64, type Bytes } from "./events.js";

interface Row {
  seq: number;
  epoch: number;
  nonce: Bytes;
  ciphertext: Bytes;
  hash: Bytes;
}

async function loadRows(roomId: string): Promise<Row[]> {
  const rows = await prisma.event.findMany({
    where: { roomId },
    orderBy: { seq: "asc" },
  });

  return rows.map((r) => ({
    seq: r.seq,
    epoch: r.epoch,
    nonce: Uint8Array.from(r.nonce),
    ciphertext: Uint8Array.from(r.ciphertext),
    hash: Uint8Array.from(r.hash),
  }));
}

// The tree is rebuilt from rows on every call rather than cached or stored.
// O(n) hashing per request, which is fine at the size a two-person room reaches
// and wrong at scale -- the fix is a stored tree with incremental appends, and
// it is not built because nothing here needs it yet.
const leavesOf = (rows: Row[]) => rows.map(encodeEventLeaf);

export interface TranscriptExport {
  roomId: string;
  treeSize: number;
  merkleRoot: string;
  events: {
    seq: number;
    epoch: number;
    nonce: string;
    ciphertext: string;
    hash: string;
  }[];
}

/**
 * Everything a verifier needs, and nothing it has to trust us for. The
 * ciphertext is included because the leaf commits to it -- a transcript you
 * cannot re-hash is not checkable. It stays unreadable without the room key,
 * which is not ours to hand out.
 */
export async function exportTranscript(roomId: string): Promise<TranscriptExport> {
  const rows = await loadRows(roomId);

  return {
    roomId,
    treeSize: rows.length,
    merkleRoot: toBase64(merkleRoot(leavesOf(rows))),
    events: rows.map((r) => ({
      seq: r.seq,
      epoch: r.epoch,
      nonce: toBase64(r.nonce),
      ciphertext: toBase64(r.ciphertext),
      hash: toBase64(r.hash),
    })),
  };
}

export interface ProofResponse {
  roomId: string;
  seq: number;
  merkleRoot: string;
  proof: { index: number; treeSize: number; siblings: string[] };
  leaf: { seq: number; epoch: number; nonce: string; ciphertext: string };
}

/**
 * Prove one event is in the log without shipping the other n-1 events. This is
 * the whole reason the tree exists alongside the hash chain: the chain can only
 * be checked by replaying all of it, so proving a single event costs O(n) and
 * discloses every other event. An audit path costs O(log n) and discloses the
 * siblings' hashes and nothing else.
 */
export async function proveEvent(roomId: string, seq: number): Promise<ProofResponse | null> {
  const rows = await loadRows(roomId);

  // seq is assigned contiguously from 0, so index and seq coincide today. Look
  // it up anyway -- if a gap ever appears, silently proving the wrong event is
  // far worse than failing.
  const index = rows.findIndex((r) => r.seq === seq);
  if (index === -1) return null;

  const leaves = leavesOf(rows);
  const proof: InclusionProof = inclusionProof(leaves, index);
  const row = rows[index];

  return {
    roomId,
    seq,
    merkleRoot: toBase64(merkleRoot(leaves)),
    proof: {
      index: proof.index,
      treeSize: proof.treeSize,
      siblings: proof.siblings.map(toBase64),
    },
    leaf: {
      seq: row.seq,
      epoch: row.epoch,
      nonce: toBase64(row.nonce),
      ciphertext: toBase64(row.ciphertext),
    },
  };
}
