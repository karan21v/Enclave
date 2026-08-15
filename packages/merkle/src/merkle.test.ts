import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  emptyRoot,
  encodeEventLeaf,
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  verifyInclusion,
} from "./merkle.js";

const data = (s: string) => new TextEncoder().encode(s);
const leaves = (n: number) => Array.from({ length: n }, (_, i) => data(`event-${i}`));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// --- structure -------------------------------------------------------------

// Every other test in this file checks the implementation against itself, and
// would pass just as happily if the whole construction were wrong. These two
// values come from outside it: RFC 6962 fixes the empty root at SHA256("") and
// the empty leaf at SHA256(0x00). If a refactor ever changes the hashing, these
// are the tests that notice.
test("known answers: empty root and empty leaf match RFC 6962", () => {
  assert.equal(
    hex(emptyRoot()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    hex(leafHash(new Uint8Array(0))),
    "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  );
});

test("empty log has the RFC 6962 empty root", () => {
  assert.equal(hex(emptyRoot()), hex(Uint8Array.from(createHash("sha256").digest())));
});

// Distinctness is a stronger claim than "each leaf verifies": it says the tree
// shape is a function of n, so no two log lengths can collide on a root.
test("every leaf count from 1 to 64 gives a distinct root", () => {
  const seen = new Map<string, number>();
  for (let n = 1; n <= 64; n++) {
    const root = hex(merkleRoot(leaves(n)));
    assert.equal(seen.get(root), undefined, `n=${n} collided with n=${seen.get(root)}`);
    seen.set(root, n);
  }
});

test("single leaf root is the leaf hash, not a node hash", () => {
  assert.equal(hex(merkleRoot([data("only")])), hex(leafHash(data("only"))));
});

test("two leaves combine under the node prefix", () => {
  const expected = nodeHash(leafHash(data("a")), leafHash(data("b")));
  assert.equal(hex(merkleRoot([data("a"), data("b")])), hex(expected));
});

test("root is deterministic and order sensitive", () => {
  assert.equal(hex(merkleRoot(leaves(9))), hex(merkleRoot(leaves(9))));

  const swapped = leaves(9);
  [swapped[2], swapped[5]] = [swapped[5], swapped[2]];
  assert.notEqual(hex(merkleRoot(leaves(9))), hex(merkleRoot(swapped)));
});

// --- the attacks the design exists to stop ---------------------------------

test("domain separation: an internal node cannot pose as a leaf", () => {
  // Without distinct prefixes, root([a,b]) would equal leafHash of the
  // concatenated children, letting an attacker claim a two-leaf subtree is a
  // single leaf whose content they never committed to.
  const root = merkleRoot([data("a"), data("b")]);
  const forgedLeafContent = new Uint8Array([...leafHash(data("a")), ...leafHash(data("b"))]);

  assert.notEqual(hex(leafHash(forgedLeafContent)), hex(root));
});

test("odd nodes are promoted, not duplicated (CVE-2012-2459)", () => {
  // A tree that pads by duplicating its final leaf gives [a,b,c] and [a,b,c,c]
  // the same root, so one proof serves both logs.
  const three = [data("a"), data("b"), data("c")];
  const padded = [...three, data("c")];

  assert.notEqual(hex(merkleRoot(three)), hex(merkleRoot(padded)));
});

test("leaf encoding is unambiguous across the nonce boundary", () => {
  // Unprefixed, these two events serialise to identical bytes: the nonce grows
  // by one and the ciphertext shrinks by one.
  const a = encodeEventLeaf({ seq: 1, epoch: 0, nonce: data("AAAA"), ciphertext: data("BBBB") });
  const b = encodeEventLeaf({ seq: 1, epoch: 0, nonce: data("AAAAB"), ciphertext: data("BBB") });

  assert.notEqual(hex(a), hex(b));
});

test("seq and epoch are bound into the leaf", () => {
  const base = { nonce: data("n"), ciphertext: data("c") };
  const one = encodeEventLeaf({ ...base, seq: 1, epoch: 0 });

  assert.notEqual(hex(one), hex(encodeEventLeaf({ ...base, seq: 2, epoch: 0 })));
  assert.notEqual(hex(one), hex(encodeEventLeaf({ ...base, seq: 1, epoch: 1 })));
});

// --- inclusion proofs ------------------------------------------------------

test("every leaf verifies at every tree size up to 33", () => {
  for (let size = 1; size <= 33; size++) {
    const log = leaves(size);
    const root = merkleRoot(log);

    for (let i = 0; i < size; i++) {
      const proof = inclusionProof(log, i);
      assert.ok(
        verifyInclusion(log[i], proof, root),
        `leaf ${i} of ${size} failed to verify`,
      );
    }
  }
});

test("proof size is logarithmic", () => {
  const log = leaves(1024);
  assert.equal(inclusionProof(log, 500).siblings.length, 10);
});

test("proof for one leaf does not verify another", () => {
  const log = leaves(16);
  const root = merkleRoot(log);
  const proof = inclusionProof(log, 4);

  assert.ok(!verifyInclusion(log[5], proof, root));
});

test("tampering with a sibling breaks the proof", () => {
  const log = leaves(16);
  const root = merkleRoot(log);
  const proof = inclusionProof(log, 7);

  proof.siblings[1][0] ^= 0xff;
  assert.ok(!verifyInclusion(log[7], proof, root));
});

test("a lied-about index breaks the proof", () => {
  // Directions are derived from index/treeSize, so moving the claimed position
  // reshapes the recomputation and the root no longer matches.
  const log = leaves(16);
  const root = merkleRoot(log);
  const proof = inclusionProof(log, 7);

  assert.ok(!verifyInclusion(log[7], { ...proof, index: 6 }, root));
});

test("a tree size that changes the path shape breaks the proof", () => {
  const log = leaves(16);
  const root = merkleRoot(log);
  const proof = inclusionProof(log, 7);

  // 8 makes leaf 7 the last leaf of the whole tree, so the 4-sibling path now
  // runs off the top and verification refuses it.
  assert.ok(!verifyInclusion(log[7], { ...proof, treeSize: 8 }, root));
});

test("treeSize fixes path shape, it is not itself a commitment", () => {
  // Worth stating explicitly, because it is easy to assume otherwise: leaf 7
  // sits in the full left subtree D[0:8] whether the log holds 15 leaves or 16,
  // so both sizes drive an identical recomputation and this proof verifies
  // under either claim. treeSize constrains the shape of the walk; the thing
  // that actually pins down *which* log you are talking about is the root you
  // check against. Anyone relying on treeSize as an authenticated count would
  // be relying on something the proof never established.
  const log = leaves(16);
  const proof = inclusionProof(log, 7);

  assert.ok(verifyInclusion(log[7], { ...proof, treeSize: 15 }, merkleRoot(log)));
});

test("truncated and padded proofs are rejected", () => {
  const log = leaves(16);
  const root = merkleRoot(log);
  const proof = inclusionProof(log, 7);

  assert.ok(!verifyInclusion(log[7], { ...proof, siblings: proof.siblings.slice(1) }, root));
  assert.ok(
    !verifyInclusion(log[7], { ...proof, siblings: [...proof.siblings, leafHash(data("x"))] }, root),
  );
});

test("an event added later does not verify against the old root", () => {
  const log = leaves(8);
  const root = merkleRoot(log);
  const grown = [...log, data("event-8")];
  const proof = inclusionProof(grown, 8);

  assert.ok(verifyInclusion(grown[8], proof, merkleRoot(grown)));
  assert.ok(!verifyInclusion(grown[8], proof, root));
});

test("out of range indices are refused rather than proven", () => {
  const log = leaves(4);
  assert.throws(() => inclusionProof(log, 4), RangeError);
  assert.throws(() => inclusionProof(log, -1), RangeError);

  const root = merkleRoot(log);
  assert.ok(!verifyInclusion(log[0], { index: 4, treeSize: 4, siblings: [] }, root));
  assert.ok(!verifyInclusion(log[0], { index: 0, treeSize: 0, siblings: [] }, root));
  assert.ok(!verifyInclusion(log[0], { index: 1.5, treeSize: 4, siblings: [] }, root));
});
