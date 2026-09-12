import type {Root, RootHex, Slot} from "@lodestar/types";
import type {BuiltPayload} from "./payloadSource.js";

export type StoredPayload = {
  slot: Slot;
  parentBlockRoot: Root;
  blockHash: RootHex;
  payload: BuiltPayload;
};

/** Keep payloads for this many slots after their target slot, late blocks may still commit to them */
const KEEP_SLOTS = 2;

export class PayloadStore {
  private readonly byBlockHash = new Map<RootHex, StoredPayload>();

  add(payload: StoredPayload): void {
    this.byBlockHash.set(payload.blockHash, payload);
  }

  get(blockHash: RootHex): StoredPayload | null {
    return this.byBlockHash.get(blockHash) ?? null;
  }

  has(blockHash: RootHex): boolean {
    return this.byBlockHash.has(blockHash);
  }

  prune(currentSlot: Slot): void {
    for (const [blockHash, {slot}] of this.byBlockHash) {
      if (slot + KEEP_SLOTS < currentSlot) {
        this.byBlockHash.delete(blockHash);
      }
    }
  }

  get size(): number {
    return this.byBlockHash.size;
  }
}
