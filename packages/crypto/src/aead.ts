import type { Bytes } from "./bytes.js";

export const NONCE_BYTES = 12;

export interface Sealed {
  nonce: Bytes;
  ciphertext: Bytes;
}

export async function seal(keyBytes: Bytes, plaintext: Bytes): Promise<Sealed> {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);

  // fresh nonce every time. reuse under the same key cancels out the keystream
  // and leaks the auth subkey -- confidentiality and forgery both go at once
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);

  return { nonce, ciphertext: new Uint8Array(ct) };
}

// throws on a bad tag. that means tampering, don't swallow it as a parse error.
export async function open(keyBytes: Bytes, nonce: Bytes, ciphertext: Bytes): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  return new Uint8Array(pt);
}
