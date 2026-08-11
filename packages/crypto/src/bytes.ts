// WebCrypto won't take SharedArrayBuffer-backed views, so pin the backing store
export type Bytes = Uint8Array<ArrayBuffer>;

// base64url -- plain base64's +/= get mangled in a URL
export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Bytes {
  const s = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// checks every byte even after a mismatch. === bails on the first difference,
// which leaks how many leading bytes were right and lets you forge a tag one
// byte at a time.
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
