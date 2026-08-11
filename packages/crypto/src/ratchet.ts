import { open, seal, type Sealed } from "./aead.js";
import type { Bytes } from "./bytes.js";
import { advanceChain, messageKeyFrom, rootChainKey } from "./keys.js";

export const MESSAGES_PER_EPOCH = 50;

export interface SealedUpdate extends Sealed {
  epoch: number;
}

// Symmetric hash ratchet. New epoch every 50 messages, chain[n+1] = HKDF(chain[n]).
// One-way, so grabbing the epoch-3 key doesn't get you epoch 2.
//
// Doesn't help if someone gets the room key out of the URL though -- that's
// long-lived and the whole chain comes off it. Proper forward secrecy needs
// ephemeral DH per epoch, which means both people online at once.
export class Ratchet {
  private chains = new Map<number, Bytes>();
  private msgKeys = new Map<number, Bytes>();
  private epoch = 0;
  private sentThisEpoch = 0;

  constructor(private readonly roomKey: Bytes) {}

  private async chainKey(epoch: number): Promise<Bytes> {
    const cached = this.chains.get(epoch);
    if (cached) return cached;

    // walk forward from whatever we already have
    let known = epoch;
    while (known > 0 && !this.chains.has(known - 1)) known--;

    let key =
      known === 0
        ? this.chains.get(0) ?? (await rootChainKey(this.roomKey))
        : this.chains.get(known - 1)!;

    if (known === 0) this.chains.set(0, key);

    for (let e = known === 0 ? 0 : known - 1; e < epoch; e++) {
      key = await advanceChain(key);
      this.chains.set(e + 1, key);
    }

    return this.chains.get(epoch)!;
  }

  private async messageKey(epoch: number): Promise<Bytes> {
    const cached = this.msgKeys.get(epoch);
    if (cached) return cached;

    const key = await messageKeyFrom(await this.chainKey(epoch));
    this.msgKeys.set(epoch, key);
    return key;
  }

  async encrypt(plaintext: Bytes): Promise<SealedUpdate> {
    if (this.sentThisEpoch >= MESSAGES_PER_EPOCH) {
      this.epoch++;
      this.sentThisEpoch = 0;
    }

    const key = await this.messageKey(this.epoch);
    const sealed = await seal(key, plaintext);
    this.sentThisEpoch++;

    return { ...sealed, epoch: this.epoch };
  }

  async decrypt(epoch: number, nonce: Bytes, ciphertext: Bytes): Promise<Bytes> {
    // peer might be ahead of us, catch up rather than reject
    if (epoch > this.epoch) {
      this.epoch = epoch;
      this.sentThisEpoch = 0;
    }

    return open(await this.messageKey(epoch), nonce, ciphertext);
  }

  // Dropping old keys is what actually buys the forward secrecy -- caching
  // everything forever means a memory dump hands over the whole session.
  // TODO: can't call this mid-session yet, a reconnecting client replays old
  // events and needs those epochs. only wired up on teardown.
  forgetBefore(epoch: number) {
    for (const e of this.chains.keys()) if (e < epoch) this.chains.delete(e);
    for (const e of this.msgKeys.keys()) if (e < epoch) this.msgKeys.delete(e);
  }

  get currentEpoch() {
    return this.epoch;
  }
}
