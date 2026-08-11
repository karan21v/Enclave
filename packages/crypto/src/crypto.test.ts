import assert from "node:assert/strict";
import { test } from "node:test";

import { equalBytes, fromBase64Url, toBase64Url } from "./bytes.js";
import { open, seal } from "./aead.js";
import { generateRoomKey } from "./keys.js";
import { MESSAGES_PER_EPOCH, Ratchet } from "./ratchet.js";

const text = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

test("base64url round trip", () => {
  const bytes = generateRoomKey();
  assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
});

test("base64url output is url safe", () => {
  // 200 runs because +/ only turn up for some byte patterns
  for (let i = 0; i < 200; i++) {
    const encoded = toBase64Url(generateRoomKey());
    assert.ok(!/[+/=]/.test(encoded), `unsafe chars: ${encoded}`);
  }
});

test("equalBytes", () => {
  assert.ok(equalBytes(text("abc"), text("abc")));
  assert.ok(!equalBytes(text("abc"), text("abd")));
  assert.ok(!equalBytes(text("abc"), text("abcd")));
});

test("seal/open round trip", async () => {
  const key = generateRoomKey();
  const sealed = await seal(key, text("const x = 1;"));
  assert.equal(str(await open(key, sealed.nonce, sealed.ciphertext)), "const x = 1;");
});

test("plaintext isn't sitting in the ciphertext", async () => {
  const sealed = await seal(generateRoomKey(), text("password123"));
  assert.ok(!str(sealed.ciphertext).includes("password123"));
});

test("flipped bit in ciphertext fails to open", async () => {
  const key = generateRoomKey();
  const sealed = await seal(key, text("hello"));
  sealed.ciphertext[0] ^= 1;

  // whole reason we're using GCM -- tampering throws instead of decrypting
  // to garbage
  await assert.rejects(() => open(key, sealed.nonce, sealed.ciphertext));
});

test("flipped bit in nonce fails to open", async () => {
  const key = generateRoomKey();
  const sealed = await seal(key, text("hello"));
  sealed.nonce[0] ^= 1;
  await assert.rejects(() => open(key, sealed.nonce, sealed.ciphertext));
});

test("wrong key fails to open", async () => {
  const sealed = await seal(generateRoomKey(), text("hello"));
  await assert.rejects(() => open(generateRoomKey(), sealed.nonce, sealed.ciphertext));
});

test("nonces don't repeat", async () => {
  const key = generateRoomKey();
  const seen = new Set<string>();

  for (let i = 0; i < 500; i++) {
    const { nonce } = await seal(key, text("x"));
    const enc = toBase64Url(nonce);
    assert.ok(!seen.has(enc), "nonce repeat, this breaks GCM completely");
    seen.add(enc);
  }
});

test("two ratchets on one room key can read each other", async () => {
  const roomKey = generateRoomKey();
  const alice = new Ratchet(roomKey);
  const bob = new Ratchet(roomKey);

  const sealed = await alice.encrypt(text("hi bob"));
  assert.equal(str(await bob.decrypt(sealed.epoch, sealed.nonce, sealed.ciphertext)), "hi bob");
});

test("different room key can't read it", async () => {
  const alice = new Ratchet(generateRoomKey());
  const eve = new Ratchet(generateRoomKey());

  const sealed = await alice.encrypt(text("secret"));
  await assert.rejects(() => eve.decrypt(sealed.epoch, sealed.nonce, sealed.ciphertext));
});

test("epoch rolls over after MESSAGES_PER_EPOCH", async () => {
  const r = new Ratchet(generateRoomKey());

  assert.equal((await r.encrypt(text("x"))).epoch, 0);
  for (let i = 1; i < MESSAGES_PER_EPOCH; i++) await r.encrypt(text("x"));
  assert.equal((await r.encrypt(text("x"))).epoch, 1);
});

test("older epochs still decrypt after the peer moved on", async () => {
  const roomKey = generateRoomKey();
  const alice = new Ratchet(roomKey);
  const bob = new Ratchet(roomKey);

  const early = await alice.encrypt(text("first"));

  for (let i = 0; i < MESSAGES_PER_EPOCH + 5; i++) await alice.encrypt(text("x"));
  const late = await alice.encrypt(text("later"));
  assert.ok(late.epoch > early.epoch);

  // bob sees the new one first, then has to go back for a replayed old one
  assert.equal(str(await bob.decrypt(late.epoch, late.nonce, late.ciphertext)), "later");
  assert.equal(str(await bob.decrypt(early.epoch, early.nonce, early.ciphertext)), "first");
});

test("same plaintext encrypts differently across epochs", async () => {
  const r = new Ratchet(generateRoomKey());

  const first = await r.encrypt(text("same input"));
  for (let i = 0; i < MESSAGES_PER_EPOCH; i++) await r.encrypt(text("x"));
  const later = await r.encrypt(text("same input"));

  assert.notEqual(toBase64Url(first.ciphertext), toBase64Url(later.ciphertext));
});

test("forgetBefore only clears the cache, not the material", async () => {
  const roomKey = generateRoomKey();
  const alice = new Ratchet(roomKey);
  const bob = new Ratchet(roomKey);

  const early = await alice.encrypt(text("old message"));
  for (let i = 0; i < MESSAGES_PER_EPOCH + 1; i++) await alice.encrypt(text("x"));
  const late = await alice.encrypt(text("new message"));

  await bob.decrypt(late.epoch, late.nonce, late.ciphertext);
  bob.forgetBefore(late.epoch);

  // bob still has the room key so he can just re-derive. this is the limit of
  // ratcheting off a long-lived root -- asserting it so nobody claims otherwise
  assert.equal(
    str(await bob.decrypt(early.epoch, early.nonce, early.ciphertext)),
    "old message",
  );
});
