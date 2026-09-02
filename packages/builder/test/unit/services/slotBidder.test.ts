import {describe, expect, it, vi} from "vitest";
import {ForkName, MIN_DEPOSIT_AMOUNT} from "@lodestar/params";
import type {RootHex, heze} from "@lodestar/types";
import {ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {BidLedger} from "../../../src/services/bidLedger.js";
import type {BidPolicy} from "../../../src/services/bidPolicy.js";
import type {BidPublisher} from "../../../src/services/bidPublisher.js";
import type {PayloadOrchestrator} from "../../../src/services/payloadOrchestrator.js";
import type {BuiltPayload} from "../../../src/services/payloadSource.js";
import {PayloadStore} from "../../../src/services/payloadStore.js";
import {
  type GloasSlotBidInput,
  type HezeSlotBidInput,
  SlotBidder,
  SlotBidderError,
  SlotBidderErrorCode,
  type SlotBidderModules,
} from "../../../src/services/slotBidder.js";

const SLOT = 64;
const PARENT_BLOCK_ROOT = Buffer.alloc(32, 1);
const PARENT_BLOCK_HASH = toRootHex(Buffer.alloc(32, 2));
const BLOCK_HASH = toRootHex(Buffer.alloc(32, 3));
const FEE_RECIPIENT = Buffer.alloc(20, 4);

describe("SlotBidder", () => {
  it("builds, retains, and publishes one Gloas bid", async () => {
    const payload = builtPayload(ForkName.gloas);
    const {bidder, modules, publish, store} = setup(payload);

    const result = await bidder.run(gloasInput(), new AbortController().signal);

    expect(result).toEqual({status: "published", blockHash: BLOCK_HASH, sourceId: "engine-0", valueGwei: 7});
    expect(modules.orchestrator.run).toHaveBeenCalledOnce();
    expect(modules.policy.computeValue).toHaveBeenCalledWith({payloadValueGwei: 10, coverableGwei: 100});
    expect(store.get(BLOCK_HASH)?.payload).toBe(payload);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toMatchObject({
      slot: SLOT,
      parentBlockRoot: PARENT_BLOCK_ROOT,
      blockHash: Buffer.alloc(32, 3),
      feeRecipient: FEE_RECIPIENT,
      builderIndex: 9,
      value: 7,
      executionPayment: 0n,
    });
  });

  it("preserves Heze inclusion-list bits", async () => {
    const payload = builtPayload(ForkName.heze);
    const inclusionListBits = ssz.heze.ExecutionPayloadBid.defaultValue().inclusionListBits;
    inclusionListBits.set(2, true);
    const {bidder, publish} = setup(payload);

    await bidder.run(hezeInput(inclusionListBits), new AbortController().signal);

    const bid = publish.mock.calls[0][0] as heze.ExecutionPayloadBid;
    expect(bid.inclusionListBits).toBe(inclusionListBits);
  });

  it.each([
    [{status: undefined, balance: undefined}, "unknown_status"],
    [{status: "pending" as const, balance: MIN_DEPOSIT_AMOUNT + 100}, "inactive"],
    [{status: "active" as const, balance: MIN_DEPOSIT_AMOUNT - 1}, "low_balance"],
  ])("does not publish when Builder state is unavailable", async (builderStatus, reason) => {
    const {bidder, publish, store} = setup(builtPayload(ForkName.gloas), {builderStatus});

    await expect(bidder.run(gloasInput(), new AbortController().signal)).resolves.toEqual({
      status: "not_published",
      reason,
    });
    expect(store.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not retain or publish when policy declines", async () => {
    const {bidder, modules, publish, store} = setup(builtPayload(ForkName.gloas), {policyValue: null});

    await expect(bidder.run(gloasInput(), new AbortController().signal)).resolves.toEqual({
      status: "not_published",
      reason: "policy_declined",
    });
    expect(modules.policy.computeValue).toHaveBeenCalledOnce();
    expect(store.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not rebuild or republish a submitted variant", async () => {
    const input = gloasInput();
    const ledger = new BidLedger();
    ledger.recordBid({
      slot: input.slot,
      parentBlockHash: input.job.request.forkchoiceState.headBlockHash,
      parentBlockRoot: toRootHex(input.parentBlockRoot),
      blockHash: BLOCK_HASH,
      valueGwei: 7,
    });
    const {bidder, modules, publish, store} = setup(builtPayload(ForkName.gloas), {ledger});

    await expect(bidder.run(input, new AbortController().signal)).resolves.toEqual({
      status: "not_published",
      reason: "already_submitted",
    });
    expect(modules.orchestrator.run).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes only once when duplicate calls share an in-flight build", async () => {
    const input = gloasInput();
    const {bidder, publish} = setup(builtPayload(ForkName.gloas));

    const results = await Promise.all([
      bidder.run(input, new AbortController().signal),
      bidder.run(input, new AbortController().signal),
    ]);

    expect(results).toEqual([
      {status: "published", blockHash: BLOCK_HASH, sourceId: "engine-0", valueGwei: 7},
      {status: "not_published", reason: "already_submitted"},
    ]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("subtracts unsettled wins from coverable balance", async () => {
    const ledger = new BidLedger();
    const prior = {slot: SLOT, parentBlockHash: rootHex(6), parentBlockRoot: rootHex(7), blockHash: rootHex(8)};
    ledger.recordBid({...prior, valueGwei: 40});
    ledger.recordWin(prior, rootHex(9));
    const {bidder, modules} = setup(builtPayload(ForkName.gloas), {ledger});

    await bidder.run(gloasInput(), new AbortController().signal);

    expect(modules.policy.computeValue).toHaveBeenCalledWith({payloadValueGwei: 10, coverableGwei: 60});
  });

  it("preserves the configured operating balance when computing coverable value", async () => {
    const minOperatingBalanceGwei = MIN_DEPOSIT_AMOUNT + 25;
    const {bidder, modules} = setup(builtPayload(ForkName.gloas), {
      builderStatus: {status: "active", balance: minOperatingBalanceGwei + 100},
      minOperatingBalanceGwei,
    });

    await bidder.run(gloasInput(), new AbortController().signal);

    expect(modules.policy.computeValue).toHaveBeenCalledWith({payloadValueGwei: 10, coverableGwei: 100});
  });

  it("rejects an input whose slot does not match its payload attributes", async () => {
    const input = gloasInput();
    input.job.request.payloadAttributes.slotNumber++;
    const {bidder, modules} = setup(builtPayload(ForkName.gloas));

    await expectSlotBidderError(bidder.run(input, new AbortController().signal), {
      code: SlotBidderErrorCode.SLOT_MISMATCH,
      slot: SLOT,
      requestSlot: SLOT + 1,
    });
    expect(modules.orchestrator.run).not.toHaveBeenCalled();
  });

  it("rejects an input whose parent root does not match its payload attributes", async () => {
    const input = gloasInput();
    input.job.request.payloadAttributes.parentBeaconBlockRoot = Buffer.alloc(32, 5);
    const {bidder, modules} = setup(builtPayload(ForkName.gloas));

    await expectSlotBidderError(bidder.run(input, new AbortController().signal), {
      code: SlotBidderErrorCode.PARENT_ROOT_MISMATCH,
      parentBlockRoot: toRootHex(PARENT_BLOCK_ROOT),
      requestParentBlockRoot: rootHex(5),
    });
    expect(modules.orchestrator.run).not.toHaveBeenCalled();
  });

  it("rejects a payload built on another parent", async () => {
    const payload = builtPayload(ForkName.gloas);
    payload.executionPayload.parentHash = Buffer.alloc(32, 6);
    const {bidder, publish, store} = setup(payload);

    await expectSlotBidderError(bidder.run(gloasInput(), new AbortController().signal), {
      code: SlotBidderErrorCode.PAYLOAD_PARENT_MISMATCH,
      expectedParentBlockHash: PARENT_BLOCK_HASH,
      payloadParentBlockHash: rootHex(6),
    });
    expect(store.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects a payload whose fork does not match the requested fork", async () => {
    const {bidder, publish, store} = setup(builtPayload(ForkName.heze));

    await expectSlotBidderError(bidder.run(gloasInput(), new AbortController().signal), {
      code: SlotBidderErrorCode.PAYLOAD_FORK_MISMATCH,
      fork: ForkName.gloas,
      payloadFork: ForkName.heze,
    });
    expect(store.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects a payload value that cannot be represented safely in Gwei", async () => {
    const payload = builtPayload(ForkName.gloas);
    payload.executionPayloadValue = (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1_000_000_000n;
    const {bidder, publish, store} = setup(payload);

    await expectSlotBidderError(bidder.run(gloasInput(), new AbortController().signal), {
      code: SlotBidderErrorCode.UNSAFE_PAYLOAD_VALUE,
      executionPayloadValue: payload.executionPayloadValue,
    });
    expect(store.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("forwards cancellation to the payload orchestrator", async () => {
    const controller = new AbortController();
    const {bidder, modules} = setup(builtPayload(ForkName.gloas));
    controller.abort();

    await expect(bidder.run(gloasInput(), controller.signal)).rejects.toMatchObject({name: "AbortError"});
    expect(modules.orchestrator.run).not.toHaveBeenCalled();
  });

  it("does not retain or publish when cancelled after the payload resolves", async () => {
    const controller = new AbortController();
    const {bidder, modules, publish, store} = setup(builtPayload(ForkName.gloas));
    vi.mocked(modules.orchestrator.run).mockImplementation(async () => {
      controller.abort();
      return builtPayload(ForkName.gloas);
    });

    await expect(bidder.run(gloasInput(), controller.signal)).rejects.toMatchObject({name: "AbortError"});
    expect(store.size).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([MIN_DEPOSIT_AMOUNT - 1, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid minimum operating balance %s",
    (minOperatingBalanceGwei) => {
      const {modules} = setupModules(builtPayload(ForkName.gloas));
      expect(() => new SlotBidder(modules, {minOperatingBalanceGwei})).toThrowError(SlotBidderError);
    }
  );
});

function setup(
  payload: BuiltPayload,
  opts: {
    builderStatus?: ReturnType<SlotBidderModules["getBuilderStatus"]>;
    policyValue?: number | null;
    ledger?: BidLedger;
    minOperatingBalanceGwei?: number;
  } = {}
) {
  const {modules, publish, store} = setupModules(payload, opts);
  return {
    bidder: new SlotBidder(modules, {minOperatingBalanceGwei: opts.minOperatingBalanceGwei ?? MIN_DEPOSIT_AMOUNT}),
    modules,
    publish,
    store,
  };
}

function setupModules(
  payload: BuiltPayload,
  opts: {
    builderStatus?: ReturnType<SlotBidderModules["getBuilderStatus"]>;
    policyValue?: number | null;
    ledger?: BidLedger;
  } = {}
) {
  const orchestrator = {
    run: vi.fn<PayloadOrchestrator["run"]>().mockResolvedValue(payload),
  };
  const store = new PayloadStore();
  const policy = {
    computeValue: vi
      .fn<BidPolicy["computeValue"]>()
      .mockReturnValue(opts.policyValue === undefined ? 7 : opts.policyValue),
  };
  const ledger = opts.ledger ?? new BidLedger();
  const publish = vi.fn<BidPublisher["publish"]>().mockImplementation(async (bid) => {
    expect(store.get(toRootHex(bid.blockHash))).not.toBeNull();
    ledger.recordBid({
      slot: bid.slot,
      parentBlockHash: toRootHex(bid.parentBlockHash),
      parentBlockRoot: toRootHex(bid.parentBlockRoot),
      blockHash: toRootHex(bid.blockHash),
      valueGwei: bid.value,
    });
    const signed = ssz.gloas.SignedExecutionPayloadBid.defaultValue();
    signed.message = bid;
    return signed;
  });
  const modules: SlotBidderModules = {
    orchestrator,
    store,
    policy,
    ledger,
    publisher: {publish},
    getBuilderStatus: () => opts.builderStatus ?? {status: "active", balance: MIN_DEPOSIT_AMOUNT + 100},
    builderIndex: 9,
  };
  return {modules, publish, store};
}

function gloasInput(): GloasSlotBidInput {
  const payloadAttributes = ssz.gloas.PayloadAttributes.defaultValue();
  payloadAttributes.slotNumber = SLOT;
  payloadAttributes.parentBeaconBlockRoot = PARENT_BLOCK_ROOT;
  return {
    fork: ForkName.gloas,
    slot: SLOT,
    parentBlockRoot: PARENT_BLOCK_ROOT,
    proposerFeeRecipient: FEE_RECIPIENT,
    job: {
      id: "slot-64-gloas",
      request: {
        fork: ForkName.gloas,
        forkchoiceState: {
          headBlockHash: PARENT_BLOCK_HASH,
          safeBlockHash: rootHex(10),
          finalizedBlockHash: rootHex(11),
        },
        payloadAttributes,
        custodyColumns: [0, 1],
      },
      getPayloadAt: 1_000,
    },
  };
}

function hezeInput(inclusionListBits: heze.ExecutionPayloadBid["inclusionListBits"]): HezeSlotBidInput {
  const payloadAttributes = ssz.heze.PayloadAttributes.defaultValue();
  payloadAttributes.slotNumber = SLOT;
  payloadAttributes.parentBeaconBlockRoot = PARENT_BLOCK_ROOT;
  return {
    fork: ForkName.heze,
    slot: SLOT,
    parentBlockRoot: PARENT_BLOCK_ROOT,
    proposerFeeRecipient: FEE_RECIPIENT,
    inclusionListBits,
    job: {
      id: "slot-64-heze",
      request: {
        fork: ForkName.heze,
        forkchoiceState: {
          headBlockHash: PARENT_BLOCK_HASH,
          safeBlockHash: rootHex(10),
          finalizedBlockHash: rootHex(11),
        },
        payloadAttributes,
        custodyColumns: [0, 1],
      },
      getPayloadAt: 1_000,
    },
  };
}

function builtPayload(fork: ForkName.gloas): BuiltPayload<ForkName.gloas>;
function builtPayload(fork: ForkName.heze): BuiltPayload<ForkName.heze>;
function builtPayload(fork: ForkName.gloas | ForkName.heze): BuiltPayload {
  if (fork === ForkName.heze) {
    const executionPayload = ssz.heze.ExecutionPayload.defaultValue();
    executionPayload.slotNumber = SLOT;
    executionPayload.parentHash = Buffer.alloc(32, 2);
    executionPayload.blockHash = Buffer.alloc(32, 3);
    return {
      sourceId: "engine-0",
      fork,
      executionPayload,
      executionRequests: ssz.heze.ExecutionRequests.defaultValue(),
      blobsBundle: ssz.heze.BlobsBundle.defaultValue(),
      executionPayloadValue: 10_000_000_000n,
    };
  }

  const executionPayload = ssz.gloas.ExecutionPayload.defaultValue();
  executionPayload.slotNumber = SLOT;
  executionPayload.parentHash = Buffer.alloc(32, 2);
  executionPayload.blockHash = Buffer.alloc(32, 3);
  return {
    sourceId: "engine-0",
    fork,
    executionPayload,
    executionRequests: ssz.gloas.ExecutionRequests.defaultValue(),
    blobsBundle: ssz.gloas.BlobsBundle.defaultValue(),
    executionPayloadValue: 10_000_000_000n,
  };
}

async function expectSlotBidderError(promise: Promise<unknown>, type: SlotBidderError["type"]): Promise<void> {
  try {
    await promise;
    throw Error("Expected SlotBidderError");
  } catch (error) {
    if (!(error instanceof SlotBidderError)) {
      throw error;
    }
    expect(error.type).toEqual(type);
  }
}

function rootHex(value: number): RootHex {
  return toRootHex(Buffer.alloc(32, value));
}
