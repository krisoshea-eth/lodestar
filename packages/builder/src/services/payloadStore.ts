import type {ForkPostGloas} from "@lodestar/params";
import type {Root, RootHex, Slot} from "@lodestar/types";
import {LodestarError, toRootHex} from "@lodestar/utils";
import type {BuiltPayload} from "./payloadSource.js";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_KEEP_SLOTS = 2;

export type PayloadStoreOptions = {
  maxEntries?: number;
  keepSlots?: number;
};

export type StorePayloadInput<F extends ForkPostGloas = ForkPostGloas> = {
  slot: Slot;
  parentBlockRoot: Root;
  payload: BuiltPayload<F>;
};

export type StoredPayload<F extends ForkPostGloas = ForkPostGloas> = StorePayloadInput<F> & {
  blockHash: RootHex;
};

export type StorePayloadResult =
  | {status: "stored"; record: StoredPayload}
  | {status: "already_stored"; record: StoredPayload};

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

/** Bounded in-memory retention for complete payload material produced by a local payload source. */
export class PayloadStore {
  private readonly records = new Map<RootHex, StoredPayload>();
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
    const existing = this.records.get(blockHash);
    if (existing !== undefined) {
      return {status: "already_stored", record: existing};
    }

    if (this.records.size >= this.maxEntries) {
      throw new PayloadStoreError(
        {code: PayloadStoreErrorCode.CAPACITY_REACHED, blockHash, maxEntries: this.maxEntries},
        `Payload store capacity reached blockHash=${blockHash} maxEntries=${this.maxEntries}`
      );
    }

    const record: StoredPayload<F> = {...input, blockHash};
    this.records.set(blockHash, record);
    return {status: "stored", record};
  }

  get(blockHash: RootHex): StoredPayload | null {
    return this.records.get(blockHash) ?? null;
  }

  delete(blockHash: RootHex): boolean {
    return this.records.delete(blockHash);
  }

  prune(currentSlot: Slot): number {
    let removed = 0;
    for (const [blockHash, record] of this.records) {
      if (record.slot + this.keepSlots < currentSlot) {
        this.records.delete(blockHash);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.records.size;
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
