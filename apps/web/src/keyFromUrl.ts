import {
  fromBase64Url,
  generateRoomKey,
  KEY_BYTES,
  toBase64Url,
  type Bytes,
} from "@enclave/crypto";

// after the # so it never goes to the server
export function readKeyFromUrl(): Bytes | null {
  const m = window.location.hash.match(/[#&]k=([A-Za-z0-9_-]+)/);
  if (!m) return null;

  try {
    const bytes = fromBase64Url(m[1]);
    return bytes.length === KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

export function newRoomUrl(roomId: string): string {
  return `/room/${roomId}#k=${toBase64Url(generateRoomKey())}`;
}
