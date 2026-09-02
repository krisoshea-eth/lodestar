import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ForkName} from "@lodestar/params";
import {ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {PayloadOrchestrator} from "../../../src/services/payloadOrchestrator.js";
import {EnginePayloadSource, type PayloadSourceEngine} from "../../../src/services/payloadSource.js";
import {PayloadStore} from "../../../src/services/payloadStore.js";

describe("payload build pipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers({now: 1_000});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepares, retrieves, and retains complete payload material", async () => {
    const executionPayload = ssz.gloas.ExecutionPayload.defaultValue();
    executionPayload.blockHash = Uint8Array.from({length: 32}, () => 4);
    const blobsBundle = ssz.gloas.BlobsBundle.defaultValue();
    const executionRequests = ssz.gloas.ExecutionRequests.defaultValue();
    const executionPayloadValue = 12_345_678_901_234_567_890n;
    const notifyForkchoiceUpdate = vi.fn().mockResolvedValue("0x0102030405060708");
    const getPayload = vi.fn().mockResolvedValue({
      executionPayload,
      blobsBundle,
      executionRequests,
      executionPayloadValue,
    });
    const source = new EnginePayloadSource("engine-0", {
      notifyForkchoiceUpdate,
      getPayload,
    } as unknown as PayloadSourceEngine);
    const orchestrator = new PayloadOrchestrator(source, {maxActiveJobs: 1, getPayloadTimeout: 50});
    const store = new PayloadStore();
    const parentBlockRoot = Uint8Array.from({length: 32}, () => 5);
    const controller = new AbortController();

    const payloadPromise = orchestrator.run(
      {
        id: "slot-10-full",
        request: {
          fork: ForkName.gloas,
          forkchoiceState: {
            headBlockHash: `0x${"11".repeat(32)}`,
            safeBlockHash: `0x${"22".repeat(32)}`,
            finalizedBlockHash: `0x${"33".repeat(32)}`,
          },
          payloadAttributes: ssz.gloas.PayloadAttributes.defaultValue(),
          custodyColumns: [0, 3, 127],
        },
        getPayloadAt: 1_100,
      },
      controller.signal
    );

    await vi.advanceTimersByTimeAsync(100);
    const payload = await payloadPromise;
    const stored = store.add({slot: 10, parentBlockRoot, payload});

    expect(notifyForkchoiceUpdate).toHaveBeenCalledOnce();
    expect(getPayload).toHaveBeenCalledWith(ForkName.gloas, "0x0102030405060708", expect.any(AbortSignal));
    expect(stored.status).toBe("stored");
    expect(stored.record.payload).toBe(payload);
    expect(stored.record.payload.executionPayload).toBe(executionPayload);
    expect(stored.record.payload.blobsBundle).toBe(blobsBundle);
    expect(stored.record.payload.executionRequests).toBe(executionRequests);
    expect(stored.record.payload.executionPayloadValue).toBe(executionPayloadValue);
    expect(store.get(toRootHex(executionPayload.blockHash))).toBe(stored.record);
  });
});
