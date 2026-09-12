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
    executionPayload.slotNumber = 10;
    executionPayload.blockHash = Uint8Array.from({length: 32}, () => 4);
    executionPayload.parentHash = Uint8Array.from({length: 32}, () => 1);
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
    const payloadAttributes = ssz.gloas.PayloadAttributes.defaultValue();
    payloadAttributes.slotNumber = executionPayload.slotNumber;
    payloadAttributes.parentBeaconBlockRoot = parentBlockRoot;
    const controller = new AbortController();

    const payloadPromise = orchestrator.run(
      {
        id: "slot-10-full",
        request: {
          fork: ForkName.gloas,
          forkchoiceState: {
            headBlockHash: toRootHex(executionPayload.parentHash),
            safeBlockHash: `0x${"22".repeat(32)}`,
            finalizedBlockHash: `0x${"33".repeat(32)}`,
          },
          payloadAttributes,
          custodyColumns: [0, 3, 127],
        },
        getPayloadAt: 1_100,
      },
      controller.signal
    );

    await vi.advanceTimersByTimeAsync(100);
    const payload = await payloadPromise;
    const blockHash = toRootHex(executionPayload.blockHash);
    const storedPayload = {slot: 10, parentBlockRoot, blockHash, payload};
    store.add(storedPayload);
    const stored = store.get(blockHash);

    expect(notifyForkchoiceUpdate).toHaveBeenCalledOnce();
    expect(getPayload).toHaveBeenCalledWith(ForkName.gloas, "0x0102030405060708", expect.any(AbortSignal));
    expect(stored).toMatchObject({slot: 10, parentBlockRoot, blockHash});
    expect(stored?.payload).toBe(payload);
    expect(stored?.payload.executionPayload).toBe(executionPayload);
    expect(stored?.payload.blobsBundle).toBe(blobsBundle);
    expect(stored?.payload.executionRequests).toBe(executionRequests);
    expect(stored?.payload.executionPayloadValue).toBe(executionPayloadValue);
  });
});
