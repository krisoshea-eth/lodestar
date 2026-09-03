import type {ForkPostGloas} from "@lodestar/params";
import {
  type BlobsBundle,
  type ExecutionPayload,
  type ExecutionRequests,
  type Root,
  type RootHex,
  type Slot,
  ssz,
} from "@lodestar/types";
import {LodestarError, toRootHex} from "@lodestar/utils";

// NOTE: BuiltPayload will migrate to payloadSource.ts when the payload source lands; the store
// holds it here for now.
export type BuiltPayload<F extends ForkPostGloas = ForkPostGloas> = {
  sourceId: string;
  fork: F;
  executionPayload: ExecutionPayload<F>;
  executionRequests: ExecutionRequests<F>;
  blobsBundle: BlobsBundle<F>;
  /** Value of the payload to the fee recipient in wei, as reported by the execution client */
  executionPayloadValue: bigint;
};

export type StorePayloadInput<F extends ForkPostGloas = ForkPostGloas> = {
  slot: Slot;
  parentBlockRoot: Root;
  payload: BuiltPayload<F>;
};

export type StoredPayload<F extends ForkPostGloas = ForkPostGloas> = StorePayloadInput<F> & {
  blockHash: RootHex;
};

type SerializedStoredPayload<F extends ForkPostGloas = ForkPostGloas> = {
  slot: Slot;
  parentBlockRoot: Root;
  blockHash: RootHex;
  sourceId: string;
  fork: F;
  executionPayload: Uint8Array;
  executionRequests: Uint8Array;
  blobsBundle: Uint8Array;
  executionPayloadValue: bigint;
};

export type StorePayloadResult =
  | {status: "stored"; record: StoredPayload}
  | {status: "already_stored"; record: StoredPayload};

export type PayloadStoreOptions = {
  maxEntries?: number;
  keepSlots?: number;
};

export enum PayloadStoreErrorCode {
  INVALID_OPTION = "PAYLOAD_STORE_ERROR_INVALID_OPTION",
  CAPACITY_REACHED = "PAYLOAD_STORE_ERROR_CAPACITY_REACHED",
}

export type PayloadStoreErrorType =
  | {
      code: PayloadStoreErrorCode.INVALID_OPTION;
      option: keyof PayloadStoreOptions;
      value: number;
    }
  | {
      code: PayloadStoreErrorCode.CAPACITY_REACHED;
      blockHash: RootHex;
      maxEntries: number;
    };

export class PayloadStoreError extends LodestarError<PayloadStoreErrorType> {}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_KEEP_SLOTS = 2;

export class PayloadStore {
  private readonly byBlockHash = new Map<RootHex, SerializedStoredPayload>();
  private readonly maxEntries: number;
  private readonly keepSlots: number;

  constructor({maxEntries = DEFAULT_MAX_ENTRIES, keepSlots = DEFAULT_KEEP_SLOTS}: PayloadStoreOptions = {}) {
    this.assertOption("maxEntries", maxEntries, 1);
    this.assertOption("keepSlots", keepSlots, 0);
    this.maxEntries = maxEntries;
    this.keepSlots = keepSlots;
  }

  add<F extends ForkPostGloas>(input: StorePayloadInput<F>): StorePayloadResult {
    const blockHash = toRootHex(input.payload.executionPayload.blockHash);
    const existing = this.byBlockHash.get(blockHash);
    if (existing !== undefined) {
      return {status: "already_stored", record: deserializeStoredPayload(existing)};
    }

    if (this.byBlockHash.size >= this.maxEntries) {
      throw new PayloadStoreError(
        {code: PayloadStoreErrorCode.CAPACITY_REACHED, blockHash, maxEntries: this.maxEntries},
        `Payload store capacity reached blockHash=${blockHash} maxEntries=${this.maxEntries}`
      );
    }

    const forkTypes = ssz[input.payload.fork];
    const record: SerializedStoredPayload<F> = {
      slot: input.slot,
      parentBlockRoot: Uint8Array.from(input.parentBlockRoot),
      blockHash,
      sourceId: input.payload.sourceId,
      fork: input.payload.fork,
      executionPayload: forkTypes.ExecutionPayload.serialize(input.payload.executionPayload),
      executionRequests: forkTypes.ExecutionRequests.serialize(input.payload.executionRequests),
      blobsBundle: forkTypes.BlobsBundle.serialize(input.payload.blobsBundle),
      executionPayloadValue: input.payload.executionPayloadValue,
    };
    this.byBlockHash.set(blockHash, record);
    return {status: "stored", record: deserializeStoredPayload(record)};
  }

  get(blockHash: RootHex): StoredPayload | null {
    const record = this.byBlockHash.get(blockHash);
    return record === undefined ? null : deserializeStoredPayload(record);
  }

  has(blockHash: RootHex): boolean {
    return this.byBlockHash.has(blockHash);
  }

  delete(blockHash: RootHex): boolean {
    return this.byBlockHash.delete(blockHash);
  }

  prune(currentSlot: Slot): number {
    let removed = 0;
    for (const [blockHash, {slot}] of this.byBlockHash) {
      if (slot + this.keepSlots < currentSlot) {
        this.byBlockHash.delete(blockHash);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.byBlockHash.size;
  }

  private assertOption(option: keyof PayloadStoreOptions, value: number, minimum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new PayloadStoreError(
        {code: PayloadStoreErrorCode.INVALID_OPTION, option, value},
        `Invalid payload store option option=${option} value=${value}`
      );
    }
  }
}

function deserializeStoredPayload<F extends ForkPostGloas>(record: SerializedStoredPayload<F>): StoredPayload<F> {
  const forkTypes = ssz[record.fork];
  return {
    slot: record.slot,
    parentBlockRoot: Uint8Array.from(record.parentBlockRoot),
    blockHash: record.blockHash,
    payload: {
      sourceId: record.sourceId,
      fork: record.fork,
      executionPayload: forkTypes.ExecutionPayload.deserialize(record.executionPayload),
      executionRequests: forkTypes.ExecutionRequests.deserialize(record.executionRequests),
      blobsBundle: forkTypes.BlobsBundle.deserialize(record.blobsBundle),
      executionPayloadValue: record.executionPayloadValue,
    },
  };
}
