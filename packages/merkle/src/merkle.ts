import { createHash } from "node:crypto";

export type Bytes = Uint8Array<ArrayBuffer>;

// Domain separation, RFC 6962 section 2.1. Leaves and internal nodes are hashed
// under different prefixes on purpose.
//
// Without this, leafHash(x) and nodeHash(l, r) live in the same space, so an
// attacker can hand you an internal node and claim it is a leaf. Its two
// children are a valid "preimage" you never committed to, and the proof checks
// out. One byte closes it.
const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

function sha256(...parts: Uint8Array[]): Bytes {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return Uint8Array.from(h.digest());
}

/** MTH({}) = SHA256(""), per RFC 6962. An empty log still has a well-defined root. */
export function emptyRoot(): Bytes {
  return sha256();
}

export function leafHash(data: Uint8Array): Bytes {
  return sha256(Uint8Array.of(LEAF_PREFIX), data);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Bytes {
  return sha256(Uint8Array.of(NODE_PREFIX), left, right);
}

// Largest power of two strictly less than n. The RFC 6962 split point.
//
// This is what keeps the tree unbalanced rather than padded. The obvious
// alternative -- duplicate the final node until the level is even -- is
// CVE-2012-2459: with a duplicated tail, the leaf sets [a, b, c] and
// [a, b, c, c] produce an identical root, so a proof for one is a proof for
// the other. Promoting the odd node instead means every distinct leaf list has
// a distinct root.
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Merkle Tree Hash over already-hashed leaves. */
function mth(hashes: Bytes[]): Bytes {
  if (hashes.length === 0) return emptyRoot();
  if (hashes.length === 1) return hashes[0];

  const k = splitPoint(hashes.length);
  return nodeHash(mth(hashes.slice(0, k)), mth(hashes.slice(k)));
}

/** Root over raw leaf data. Leaf hashing is applied here, callers pass content. */
export function merkleRoot(leaves: Uint8Array[]): Bytes {
  return mth(leaves.map(leafHash));
}

export interface InclusionProof {
  /** Position of the proven leaf in the log. */
  index: number;
  /** Total leaves at the time the proof was made. Fixes the tree shape. */
  treeSize: number;
  /** Sibling hashes, leaf level first. No direction flags -- see verifyInclusion. */
  siblings: Bytes[];
}

function path(m: number, hashes: Bytes[]): Bytes[] {
  if (hashes.length <= 1) return [];

  const k = splitPoint(hashes.length);
  if (m < k) {
    return [...path(m, hashes.slice(0, k)), mth(hashes.slice(k))];
  }
  return [...path(m - k, hashes.slice(k)), mth(hashes.slice(0, k))];
}

export function inclusionProof(leaves: Uint8Array[], index: number): InclusionProof {
  if (index < 0 || index >= leaves.length) {
    throw new RangeError(`index ${index} outside log of ${leaves.length}`);
  }

  return {
    index,
    treeSize: leaves.length,
    siblings: path(index, leaves.map(leafHash)),
  };
}

// Constant-time compare. A verifier that bails on the first differing byte
// leaks how much of a forged root was correct, which is enough to grind one out
// byte by byte given enough attempts.
function equalHashes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Recompute the root from a leaf and its audit path, and compare to `root`.
 *
 * The critical property: which side each sibling goes on is derived from
 * (index, treeSize), never read from the proof. A proof carrying its own
 * left/right flags would let a hostile server pick the combination that makes
 * a forged leaf land on the honest root. Here the shape of the tree is fixed by
 * two integers the verifier already has to agree on.
 */
export function verifyInclusion(
  leafData: Uint8Array,
  proof: InclusionProof,
  root: Uint8Array,
): boolean {
  const { index, treeSize, siblings } = proof;

  if (!Number.isInteger(index) || !Number.isInteger(treeSize)) return false;
  if (index < 0 || treeSize <= 0 || index >= treeSize) return false;

  // fn/sn walk the leaf index and the last index up the tree together; their
  // low bits say whether the current node is a left or a right child.
  let fn = index;
  let sn = treeSize - 1;
  let acc = leafHash(leafData);

  for (const sibling of siblings) {
    if (sn === 0) return false; // path longer than the tree is tall

    if ((fn & 1) === 1 || fn === sn) {
      acc = nodeHash(sibling, acc);
      while (fn !== 0 && (fn & 1) === 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      acc = nodeHash(acc, sibling);
    }

    fn >>= 1;
    sn >>= 1;
  }

  // sn !== 0 means the path ran out before reaching the root: too few siblings.
  return sn === 0 && equalHashes(acc, root);
}

/**
 * Canonical byte encoding of one event for use as a Merkle leaf.
 *
 * The nonce is length-prefixed. Without it, `nonce ‖ ciphertext` is ambiguous:
 * a 12-byte nonce with an n-byte ciphertext and a 13-byte nonce with an
 * (n-1)-byte ciphertext can serialise identically, so two different events
 * could share a leaf hash. Fixed-width fields go first so the parse is
 * unambiguous left to right.
 */
export interface EventLeaf {
  seq: number;
  epoch: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function encodeEventLeaf(e: EventLeaf): Bytes {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(e.seq, 0);
  header.writeUInt32BE(e.epoch, 4);
  header.writeUInt32BE(e.nonce.length, 8);

  const out = new Uint8Array(header.length + e.nonce.length + e.ciphertext.length);
  out.set(header, 0);
  out.set(e.nonce, header.length);
  out.set(e.ciphertext, header.length + e.nonce.length);
  return out;
}
