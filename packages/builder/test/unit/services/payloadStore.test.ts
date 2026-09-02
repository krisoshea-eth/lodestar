import {describe, expect, it} from "vitest";
import {ForkName, type ForkPostGloas} from "@lodestar/params";
import {type Root, ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import type {BuiltPayload} from "../../../src/services/payloadSource.js";
import {PayloadStore, PayloadStoreError, PayloadStoreErrorCode} from "../../../src/services/payloadStore.js";

describe("PayloadStore", () => {
  it("derives the key and preserves exact payload material", () => {
    const store = new PayloadStore();
    const payload = getBuiltPayload(ForkName.gloas, 1);
    const parentBlockRoot = getRoot(2);

    const result = store.add({slot: 10, parentBlockRoot, payload});
    const blockHash = toRootHex(payload.executionPayload.blockHash);

    expect(result.status).toBe("stored");
    expect(result.record.blockHash).toBe(blockHash);
    expect(result.record.parentBlockRoot).toBe(parentBlockRoot);
    expect(result.record.payload).toBe(payload);
    expect(result.record.payload.blobsBundle).toBe(payload.blobsBundle);
    expect(result.record.payload.executionRequests).toBe(payload.executionRequests);
    expect(result.record.payload.executionPayloadValue).toBe(12_345_678_901_234_567_890n);
    expect(store.get(blockHash)).toBe(result.record);
  });

  it("preserves the first record for an existing block hash", () => {
    const store = new PayloadStore();
    const firstPayload = getBuiltPayload(ForkName.gloas, 1);
    const duplicatePayload = getBuiltPayload(ForkName.gloas, 1);
    duplicatePayload.executionPayloadValue = 1n;
    const first = store.add({slot: 10, parentBlockRoot: getRoot(2), payload: firstPayload});

    const duplicate = store.add({slot: 11, parentBlockRoot: getRoot(3), payload: duplicatePayload});

    expect(duplicate.status).toBe("already_stored");
    expect(duplicate.record).toBe(first.record);
    expect(duplicate.record.payload).toBe(firstPayload);
    expect(store.size).toBe(1);
  });

  it("fails closed when unexpired records reach the capacity bound", () => {
    const store = new PayloadStore({maxEntries: 1});
    store.add({slot: 10, parentBlockRoot: getRoot(2), payload: getBuiltPayload(ForkName.gloas, 1)});

    const error = getPayloadStoreError(() =>
      store.add({slot: 10, parentBlockRoot: getRoot(3), payload: getBuiltPayload(ForkName.gloas, 4)})
    );

    expect(error.type).toEqual({
      code: PayloadStoreErrorCode.CAPACITY_REACHED,
      blockHash: toRootHex(getRoot(4)),
      maxEntries: 1,
    });
    expect(store.size).toBe(1);
  });

  it("prunes only after the configured retention boundary", () => {
    const store = new PayloadStore({keepSlots: 2});
    const payload = getBuiltPayload(ForkName.gloas, 1);
    const blockHash = toRootHex(payload.executionPayload.blockHash);
    store.add({slot: 5, parentBlockRoot: getRoot(2), payload});

    expect(store.prune(7)).toBe(0);
    expect(store.get(blockHash)).not.toBeNull();
    expect(store.prune(8)).toBe(1);
    expect(store.get(blockHash)).toBeNull();
  });

  it("deletes an exact retained record", () => {
    const store = new PayloadStore();
    const payload = getBuiltPayload(ForkName.gloas, 1);
    const blockHash = toRootHex(payload.executionPayload.blockHash);
    store.add({slot: 10, parentBlockRoot: getRoot(2), payload});

    expect(store.delete(blockHash)).toBe(true);
    expect(store.delete(blockHash)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("retains post-Gloas fork material without narrowing it", () => {
    const store = new PayloadStore();
    const payload = getBuiltPayload(ForkName.heze, 1);

    const result = store.add({slot: 10, parentBlockRoot: getRoot(2), payload});

    expect(result.record.payload).toBe(payload);
    expect(result.record.payload.fork).toBe(ForkName.heze);
  });

  it.each([
    ["maxEntries", 0, {maxEntries: 0}],
    ["keepSlots", -1, {keepSlots: -1}],
    ["maxEntries", 1.5, {maxEntries: 1.5}],
  ] as const)("rejects an invalid %s option", (option, value, options) => {
    const error = getPayloadStoreError(() => new PayloadStore(options));

    expect(error.type).toEqual({
      code: PayloadStoreErrorCode.INVALID_OPTION,
      option,
      value,
    });
  });
});

function getBuiltPayload<F extends ForkPostGloas>(fork: F, blockHashByte: number): BuiltPayload<F> {
  const executionPayload = ssz[fork].ExecutionPayload.defaultValue();
  executionPayload.blockHash = getRoot(blockHashByte);
  return {
    sourceId: "engine-0",
    fork,
    executionPayload,
    blobsBundle: ssz[fork].BlobsBundle.defaultValue(),
    executionRequests: ssz[fork].ExecutionRequests.defaultValue(),
    executionPayloadValue: 12_345_678_901_234_567_890n,
  };
}

function getRoot(byte: number): Root {
  return Uint8Array.from({length: 32}, () => byte);
}

function getPayloadStoreError(fn: () => unknown): PayloadStoreError {
  try {
    fn();
    throw Error("Expected PayloadStoreError");
  } catch (error) {
    if (!(error instanceof PayloadStoreError)) {
      throw error;
    }
    return error;
  }
}
