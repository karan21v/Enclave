#!/usr/bin/env node
// Standalone transcript verifier for Enclave.
//
//   node tools/verify-transcript.mjs transcript.json [proof.json]
//
// Zero dependencies, one file, nothing imported from the app. That is
// deliberate on two counts. A verifier that needs the server's cooperation
// verifies nothing, and a verifier that reuses the implementation it is
// checking shares that implementation's bugs -- so the hashing below is written
// out again from the spec rather than imported from @enclave/merkle. If the two
// ever disagree, that disagreement is the finding.
//
// What this proves, without trusting the server:
//   * every event hashes to the chain hash stored beside it
//   * the chain runs unbroken from genesis with no gap or reorder
//   * the events reproduce the Merkle root the server published
//   * (with proof.json) a single event is in the log under that root
//
// What it cannot prove: that the log is *complete*. A server that never wrote
// an event down produces a perfectly valid transcript without it. Detecting
// omission needs a second party's view, or a root published somewhere the
// server cannot rewrite.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
const GENESIS = new Uint8Array(32);

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return Uint8Array.from(h.digest());
};

const b64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const hex = (b) => Buffer.from(b).toString("hex");
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const leafHash = (data) => sha256(Uint8Array.of(LEAF_PREFIX), data);
const nodeHash = (l, r) => sha256(Uint8Array.of(NODE_PREFIX), l, r);

function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function mth(hashes) {
  if (hashes.length === 0) return sha256();
  if (hashes.length === 1) return hashes[0];
  const k = splitPoint(hashes.length);
  return nodeHash(mth(hashes.slice(0, k)), mth(hashes.slice(k)));
}

// seq | epoch | nonceLen | nonce | ciphertext -- all big-endian u32.
function encodeLeaf(e) {
  const nonce = b64(e.nonce);
  const ciphertext = b64(e.ciphertext);

  const header = Buffer.alloc(12);
  header.writeUInt32BE(e.seq, 0);
  header.writeUInt32BE(e.epoch, 4);
  header.writeUInt32BE(nonce.length, 8);

  return Uint8Array.from(Buffer.concat([header, nonce, ciphertext]));
}

// sha256(prevHash | seq | epoch | nonce | ciphertext)
function chainHash(prev, e) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(e.seq, 0);
  header.writeUInt32BE(e.epoch, 4);

  return sha256(prev, header, b64(e.nonce), b64(e.ciphertext));
}

function verifyInclusion(leafData, proof, root) {
  const { index, treeSize } = proof;
  if (!Number.isInteger(index) || !Number.isInteger(treeSize)) return false;
  if (index < 0 || treeSize <= 0 || index >= treeSize) return false;

  let fn = index;
  let sn = treeSize - 1;
  let acc = leafHash(leafData);

  for (const sibling of proof.siblings.map(b64)) {
    if (sn === 0) return false;

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

  return sn === 0 && same(acc, root);
}

// --- report ----------------------------------------------------------------

let failures = 0;
const pass = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

function main() {
  const [transcriptPath, proofPath] = process.argv.slice(2);
  if (!transcriptPath) {
    console.error("usage: node tools/verify-transcript.mjs <transcript.json> [proof.json]");
    process.exit(2);
  }

  const t = JSON.parse(readFileSync(transcriptPath, "utf8"));
  const events = t.events ?? [];

  console.log(`\ntranscript: ${transcriptPath}`);
  console.log(`room:       ${t.roomId}`);
  console.log(`events:     ${events.length}\n`);

  console.log("hash chain");
  if (events.length === 0) {
    pass("empty log, nothing to chain");
  } else {
    let prev = GENESIS;
    let broken = false;

    for (const [i, e] of events.entries()) {
      if (e.seq !== i) {
        fail(`event ${i} claims seq ${e.seq} -- gap or reorder`);
        broken = true;
        break;
      }

      const expected = chainHash(prev, e);
      if (!same(expected, b64(e.hash))) {
        fail(`event ${e.seq} hash mismatch`);
        console.log(`        stored   ${e.hash}`);
        console.log(`        computed ${Buffer.from(expected).toString("base64")}`);
        broken = true;
        break;
      }
      prev = b64(e.hash);
    }

    if (!broken) {
      pass(`${events.length} events chain unbroken from genesis`);
      pass(`head ${hex(prev).slice(0, 16)}…`);
    }
  }

  console.log("\nmerkle root");
  const computed = mth(events.map((e) => leafHash(encodeLeaf(e))));
  if (t.merkleRoot === undefined) {
    fail("transcript declares no root to check against");
  } else if (same(computed, b64(t.merkleRoot))) {
    pass(`recomputed root matches: ${hex(computed).slice(0, 16)}…`);
  } else {
    fail("recomputed root does not match the published root");
    console.log(`        published  ${t.merkleRoot}`);
    console.log(`        recomputed ${Buffer.from(computed).toString("base64")}`);
  }

  if (t.treeSize !== undefined && t.treeSize !== events.length) {
    fail(`treeSize says ${t.treeSize} but ${events.length} events were supplied`);
  }

  if (proofPath) {
    console.log("\ninclusion proof");
    const p = JSON.parse(readFileSync(proofPath, "utf8"));
    const ok = verifyInclusion(encodeLeaf(p.leaf), p.proof, b64(p.merkleRoot));

    if (ok) {
      pass(`event ${p.leaf.seq} is in the log under root ${p.merkleRoot.slice(0, 12)}…`);
      pass(`path length ${p.proof.siblings.length} for a log of ${p.proof.treeSize}`);
    } else {
      fail(`event ${p.leaf.seq} does NOT verify against the published root`);
    }

    if (same(b64(p.merkleRoot), computed)) {
      pass("proof root matches the transcript root");
    } else {
      fail("proof is against a different root than the transcript -- different logs");
    }
  }

  console.log(failures === 0 ? "\nVERIFIED\n" : `\nFAILED (${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
