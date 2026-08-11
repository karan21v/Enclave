import { Ratchet, type Bytes } from "@enclave/crypto";
import * as Y from "yjs";

// marks updates that came off the network so we don't bounce them back
const REMOTE = Symbol("remote");

type Status = "connecting" | "open" | "closed";

interface Options {
  roomId: string;
  roomKey: Bytes;
  onStatus?: (s: Status) => void;
  onPresence?: (count: number) => void;
  onTamper?: () => void;
}

export class RoomSync {
  readonly doc = new Y.Doc();

  private ws: WebSocket | null = null;
  private ratchet: Ratchet;
  private lastSeq = -1;
  private closed = false;
  private retryDelay = 500;
  private retryTimer: number | null = null;

  // encrypting is async but doc.on("update") isn't, so queue sends to keep
  // them ordered
  private sendQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: Options) {
    this.ratchet = new Ratchet(opts.roomKey);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.queueSend(update as Bytes);
    });

    // deferred on purpose. if we get destroyed before this runs (StrictMode
    // remount, or someone navigating straight back out) no socket is opened at
    // all. connecting in the constructor leaked -- destroy() hit a CONNECTING
    // socket, browsers abort those instead of closing them, so no close frame
    // ever reached the server and it sat on a socket nobody owned.
    queueMicrotask(() => {
      if (!this.closed) this.connect();
    });
  }

  private connect() {
    if (this.closed) return;
    this.opts.onStatus?.("connecting");

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${location.host}/ws?room=${encodeURIComponent(
      this.opts.roomId,
    )}&after=${this.lastSeq}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.closed) {
        ws.close();
        return;
      }
      this.retryDelay = 500;
      this.opts.onStatus?.("open");
    };

    ws.onmessage = (ev) => {
      if (this.closed) return;
      void this.handleMessage(ev.data);
    };

    ws.onclose = () => {
      if (this.closed) return;
      this.opts.onStatus?.("closed");
      this.scheduleReconnect();
    };

    // error is always followed by close, keep reconnect logic in one place
    ws.onerror = () => ws.close();
  }

  private async handleMessage(raw: unknown) {
    if (typeof raw !== "string") return;

    let msg: {
      t?: string;
      seq?: number;
      count?: number;
      epoch?: number;
      nonce?: string;
      payload?: string;
      events?: Array<{ seq: number; epoch: number; nonce: string; payload: string }>;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      case "sync": {
        // decrypt first, then apply in one transaction -- can't await inside
        // doc.transact, and batching keeps Monaco from re-rendering per event
        const updates: Uint8Array[] = [];

        for (const e of msg.events ?? []) {
          const update = await this.decrypt(e.epoch, e.nonce, e.payload);
          if (!update) continue;
          updates.push(update);
          this.lastSeq = Math.max(this.lastSeq, e.seq);
        }

        this.doc.transact(() => {
          for (const u of updates) Y.applyUpdate(this.doc, u, REMOTE);
        }, REMOTE);
        break;
      }

      case "update": {
        if (typeof msg.payload !== "string") return;
        const update = await this.decrypt(msg.epoch ?? 0, msg.nonce ?? "", msg.payload);
        if (update) Y.applyUpdate(this.doc, update, REMOTE);
        if (typeof msg.seq === "number") this.lastSeq = Math.max(this.lastSeq, msg.seq);
        break;
      }

      case "ack":
        if (typeof msg.seq === "number") this.lastSeq = Math.max(this.lastSeq, msg.seq);
        break;

      case "presence":
        if (typeof msg.count === "number") this.opts.onPresence?.(msg.count);
        break;
    }
  }

  private async decrypt(epoch: number, nonce: string, payload: string) {
    try {
      return await this.ratchet.decrypt(epoch, base64ToBytes(nonce), base64ToBytes(payload));
    } catch {
      // GCM rejected it -- wrong key or someone changed the bytes. either way
      // worth showing rather than skipping quietly.
      this.opts.onTamper?.();
      return null;
    }
  }

  private queueSend(update: Bytes) {
    this.sendQueue = this.sendQueue
      .then(async () => {
        if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;

        const sealed = await this.ratchet.encrypt(update);

        this.ws.send(
          JSON.stringify({
            t: "update",
            epoch: sealed.epoch,
            nonce: bytesToBase64(sealed.nonce),
            payload: bytesToBase64(sealed.ciphertext),
          }),
        );
      })
      .catch((err) => console.error("send failed", err));
  }

  private scheduleReconnect() {
    if (this.closed || this.retryTimer !== null) return;

    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelay);

    // back off so a server restart doesn't get hammered by everyone at once
    this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
  }

  destroy() {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ratchet.forgetBefore(Number.MAX_SAFE_INTEGER);
    this.doc.destroy();
  }
}

// TODO: binary frames instead of base64, this costs ~33% on the wire. also
// worth batching updates on a timer -- right now every keystroke is its own
// event, which leaks typing rhythm even with the payload encrypted.
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(value: string): Bytes {
  const s = atob(value);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
