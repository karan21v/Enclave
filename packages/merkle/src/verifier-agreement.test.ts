import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chainHash, GENESIS } from "./chain.js";
import { encodeEventLeaf, inclusionProof, merkleRoot } from "./merkle.js";

// tools/verify-transcript.mjs deliberately reimplements this construction from
// the spec instead of importing it, so a bug here cannot hide behind the same
// bug there. That only buys anything if something actually compares the two --
// otherwise they drift apart silently and the comment saying "if they disagree,
// that disagreement is the finding" describes a check nobody runs.
//
// This is that check. It drives the real verifier as a subprocess and asserts
// it agrees with this package on inputs this package produced.

const VERIFIER = new URL("../../../tools/verify-transcript.mjs", import.meta.url).pathname;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

interface Ev {
  seq: number;
  epoch: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

function buildTranscript(count: number) {
  const events: Ev[] = Array.from({ length: count }, (_, i) => ({
    seq: i,
    epoch: Math.floor(i / 50),
    nonce: new Uint8Array(randomBytes(12)),
    ciphertext: new Uint8Array(randomBytes(16 + i)),
  }));

  let prev = GENESIS;
  const hashes = events.map(
    (e) => (prev = chainHash(prev, e.seq, e.epoch, e.nonce, e.ciphertext)),
  );
  const leaves = events.map(encodeEventLeaf);

  return {
    leaves,
    transcript: {
      roomId: "agreement-test",
      treeSize: count,
      merkleRoot: b64(merkleRoot(leaves)),
      events: events.map((e, i) => ({
        seq: e.seq,
        epoch: e.epoch,
        nonce: b64(e.nonce),
        ciphertext: b64(e.ciphertext),
        hash: b64(hashes[i]),
      })),
    },
  };
}

function runVerifier(transcript: unknown, proof?: unknown): number {
  const dir = mkdtempSync(join(tmpdir(), "enclave-verify-"));
  try {
    const tPath = join(dir, "transcript.json");
    writeFileSync(tPath, JSON.stringify(transcript));

    const args = [VERIFIER, tPath];
    if (proof !== undefined) {
      const pPath = join(dir, "proof.json");
      writeFileSync(pPath, JSON.stringify(proof));
      args.push(pPath);
    }

    return spawnSync(process.execPath, args, { encoding: "utf8" }).status ?? -1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the standalone verifier accepts what this package produces", () => {
  // awkward sizes on purpose -- powers of two, either side, and a prime. A
  // split-rule mismatch between the two implementations shows up here first.
  for (const n of [1, 2, 3, 4, 5, 8, 9, 16, 17, 31]) {
    const { transcript } = buildTranscript(n);
    assert.equal(runVerifier(transcript), 0, `n=${n} rejected`);
  }
});

test("the standalone verifier accepts our inclusion proofs, at every index", () => {
  for (const n of [1, 2, 3, 5, 8, 9, 17]) {
    const { leaves, transcript } = buildTranscript(n);

    for (let i = 0; i < n; i++) {
      const p = inclusionProof(leaves, i);
      const proof = {
        roomId: transcript.roomId,
        seq: i,
        merkleRoot: transcript.merkleRoot,
        proof: { index: p.index, treeSize: p.treeSize, siblings: p.siblings.map(b64) },
        leaf: transcript.events[i],
      };

      assert.equal(runVerifier(transcript, proof), 0, `n=${n} i=${i} rejected`);
    }
  }
});

// If these ever pass, the verifier stopped verifying.
test("the standalone verifier rejects a tampered ciphertext", () => {
  const { transcript } = buildTranscript(9);
  const b = Buffer.from(transcript.events[4].ciphertext, "base64");
  b[0] ^= 1;
  transcript.events[4].ciphertext = b.toString("base64");

  assert.notEqual(runVerifier(transcript), 0);
});

test("the standalone verifier rejects a forged root on an otherwise valid chain", () => {
  const { transcript } = buildTranscript(9);
  const b = Buffer.from(transcript.merkleRoot, "base64");
  b[0] ^= 1;
  transcript.merkleRoot = b.toString("base64");

  assert.notEqual(runVerifier(transcript), 0);
});

test("the standalone verifier rejects a dropped event", () => {
  const { transcript } = buildTranscript(9);
  transcript.events.splice(6, 1);

  assert.notEqual(runVerifier(transcript), 0);
});
