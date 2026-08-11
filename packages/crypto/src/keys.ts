import type { Bytes } from "./bytes.js";

export const KEY_BYTES = 32;

// separate info strings so a chain key and a message key off the same input
// come out unrelated
const CHAIN_INFO = "enclave-chain";
const MSG_INFO = "enclave-msg";

const encoder = new TextEncoder();

export function generateRoomKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// empty salt is fine here, the input is already a full-entropy random key
async function hkdf(input: Bytes, info: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", input, "HKDF", false, ["deriveBits"]);

  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
    key,
    KEY_BYTES * 8,
  );

  return new Uint8Array(bits);
}

export function advanceChain(chainKey: Bytes): Promise<Bytes> {
  return hkdf(chainKey, CHAIN_INFO);
}

// chain keys never encrypt anything themselves, they only produce the next
// chain key and this
export function messageKeyFrom(chainKey: Bytes): Promise<Bytes> {
  return hkdf(chainKey, MSG_INFO);
}

export function rootChainKey(roomKey: Bytes): Promise<Bytes> {
  return hkdf(roomKey, CHAIN_INFO);
}
