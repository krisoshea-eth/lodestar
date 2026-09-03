import {describe, expect, it} from "vitest";
import {ForkName, type ForkPostGloas} from "@lodestar/params";
import {type Root, ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {
  type BuiltPayload,
  PayloadStore,
  PayloadStoreError,
  PayloadStoreErrorCode,
} from "../../../src/services/payloadStore.js";
import {mockBuiltPayload} from "../utils/payload.js";

describe("PayloadStore", () => {
  it("derives the key and preserves exact payload material", () => {
    const store = new PayloadStore();
    const payload = mockBuiltPayload({fork: ForkName.gloas, blockHash: getRoot(1)});
    const parentBlockRoot = getRoot(2);

    const result = store.add({slot: 10, parentBlockRoot, payload});
    const blockHash = toRootHex(payload.executionPayload.blockHash);

    expect(result.status).toBe("stored");
    expect(result.record.blockHash).toBe(blockHash);
    expect(result.record.parentBlockRoot).toEqual(parentBlockRoot);
    expect(result.record.parentBlockRoot).not.toBe(parentBlockRoot);
    expectPayloadsEqual(result.record.payload, payload);
    expect(result.record.payload).not.toBe(payload);
    expect(store.has(blockHash)).toBe(true);
    expect(store.get(blockHash)).toEqual(result.record);
    expect(store.get(blockHash)).not.toBe(result.record);
  });

  it("preserves the first record for an existing block hash", () => {
    const store = new PayloadStore();
    const firstPayload = mockBuiltPayload({fork: ForkName.gloas, blockHash: getRoot(1), valueGwei: 2});
    const duplicatePayload = mockBuiltPayload({fork: ForkName.gloas, blockHash: getRoot(1), valueGwei: 1});
    const first = store.add({slot: 10, parentBlockRoot: getRoot(2), payload: firstPayload});

    const duplicate = store.add({slot: 11, parentBlockRoot: getRoot(3), payload: duplicatePayload});

    expect(duplicate.status).toBe("already_stored");
    expect(duplicate.record).toEqual(first.record);
    expect(duplicate.record).not.toBe(first.record);
    expectPayloadsEqual(duplicate.record.payload, firstPayload);
    expect(store.size).toBe(1);
  });

  it("does not expose mutable retained payload material", () => {
    const store = new PayloadStore();
    const payload = mockBuiltPayload({fork: ForkName.gloas, blockHash: getRoot(1)});
    const parentBlockRoot = getRoot(2);
    const result = store.add({slot: 10, parentBlockRoot, payload});
    const blockHash = result.record.blockHash;

    payload.executionPayload.parentHash[0] = 9;
    parentBlockRoot[0] = 9;
    expect(store.get(blockHash)?.payload.executionPayload.parentHash[0]).toBe(1);
    expect(store.get(blockHash)?.parentBlockRoot[0]).toBe(2);

    result.record.payload.executionPayload.parentHash[0] = 8;
    result.record.parentBlockRoot[0] = 8;
    expect(store.get(blockHash)?.payload.executionPayload.parentHash[0]).toBe(1);
    expect(store.get(blockHash)?.parentBlockRoot[0]).toBe(2);
  });

  it("fails closed when unexpired records reach the capacity bound", () => {
    const store = new PayloadStore({maxEntries: 1});
    store.add({
      slot: 10,
      parentBlockRoot: getRoot(2),
      payload: mockBuiltPayload({fork: ForkName.gloas, blockHash: getRoot(1)}),
    });

    const error = getPayloadStoreError(() =>
      store.add({
        slot: 10,
        parentBlockRoot: getRoot(3),
        payload: mockBuiltPayload({fork: ForkName.gloas, blockHash: getRoot(4)}),
      })
    );

    expect(error.type).toEqual({
      code: PayloadStoreErrorCode.CAPACITY_REACHED,
      blockHash: toRootHex(getRoot(4)),
      maxEntries: 1,
    });
    expect(store.size).toBe(1);
  });

  it("stores and prunes payloads by slot", () => {
    const store = new PayloadStore();
    const payload = mockBuiltPayload({fork: ForkName.gloas, blockHash: getRoot(1)});
    const blockHash = toRootHex(payload.executionPayload.blockHash);
    store.add({slot: 5, parentBlockRoot: getRoot(2), payload});
    expect(store.has(blockHash)).toBe(true);
    expect(store.get(blockHash)?.slot).toEqual(5);
    expect(store.prune(7)).toBe(0);
    expect(store.has(blockHash)).toBe(true);
    expect(store.prune(8)).toBe(1);
    expect(store.has(blockHash)).toBe(false);
    expect(store.get(blockHash)).toBeNull();
  });

  it("deletes an exact retained record", () => {
    const store = new PayloadStore();
    const payload = mockBuiltPayload({fork: ForkName.gloas, blockHash: getRoot(1)});
    const blockHash = toRootHex(payload.executionPayload.blockHash);
    store.add({slot: 10, parentBlockRoot: getRoot(2), payload});

    expect(store.delete(blockHash)).toBe(true);
    expect(store.delete(blockHash)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("retains Heze payload material without narrowing it", () => {
    const store = new PayloadStore();
    const payload = mockBuiltPayload({fork: ForkName.heze, blockHash: getRoot(1)});

    const result = store.add({slot: 10, parentBlockRoot: getRoot(2), payload});

    expectPayloadsEqual(result.record.payload, payload);
    expect(result.record.payload).not.toBe(payload);
    expect(result.record.payload.fork).toBe(ForkName.heze);
  });

  it.each([
    ["maxEntries", 0, {maxEntries: 0}],
    ["keepSlots", -1, {keepSlots: -1}],
    ["maxEntries", 1.5, {maxEntries: 1.5}],
    ["keepSlots", Number.MAX_SAFE_INTEGER + 1, {keepSlots: Number.MAX_SAFE_INTEGER + 1}],
  ] as const)("rejects an invalid %s option", (option, value, options) => {
    const error = getPayloadStoreError(() => new PayloadStore(options));

    expect(error.type).toEqual({
      code: PayloadStoreErrorCode.INVALID_OPTION,
      option,
      value,
    });
  });
});

function getRoot(byte: number): Root {
  return Uint8Array.from({length: 32}, () => byte);
}

function expectPayloadsEqual<F extends ForkPostGloas>(actual: BuiltPayload<F>, expected: BuiltPayload<F>): void {
  const forkTypes = ssz[expected.fork];
  expect(actual.sourceId).toBe(expected.sourceId);
  expect(actual.fork).toBe(expected.fork);
  expect(actual.executionPayloadValue).toBe(expected.executionPayloadValue);
  expect(forkTypes.ExecutionPayload.equals(actual.executionPayload, expected.executionPayload)).toBe(true);
  expect(forkTypes.ExecutionRequests.equals(actual.executionRequests, expected.executionRequests)).toBe(true);
  expect(forkTypes.BlobsBundle.equals(actual.blobsBundle, expected.blobsBundle)).toBe(true);
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
