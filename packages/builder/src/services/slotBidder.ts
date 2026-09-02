import {ForkName, MIN_DEPOSIT_AMOUNT} from "@lodestar/params";
import {computeEpochAtSlot} from "@lodestar/state-transition";
import type {BuilderIndex, BuilderStatus, ExecutionAddress, Root, RootHex, Slot, heze} from "@lodestar/types";
import {LodestarError, toRootHex} from "@lodestar/utils";
import type {BidLedger} from "./bidLedger.js";
import type {BidPolicy} from "./bidPolicy.js";
import type {BidPublisher} from "./bidPublisher.js";
import {createExecutionPayloadBid} from "./executionPayloadBid.js";
import type {PayloadBuildJob, PayloadOrchestrator} from "./payloadOrchestrator.js";
import type {BuildRequest, BuiltPayload} from "./payloadSource.js";
import type {PayloadStore} from "./payloadStore.js";

const WEI_PER_GWEI = 1_000_000_000n;

function isBuiltPayloadFor<F extends ForkName.gloas | ForkName.heze>(
  payload: BuiltPayload,
  fork: F
): payload is BuiltPayload<F> {
  return payload.fork === fork;
}

type SlotBuildJob<F extends ForkName.gloas | ForkName.heze> = Omit<PayloadBuildJob, "request"> & {
  request: BuildRequest<F>;
};

type CommonSlotBidInput<F extends ForkName.gloas | ForkName.heze> = {
  fork: F;
  slot: Slot;
  parentBlockRoot: Root;
  proposerFeeRecipient: ExecutionAddress;
  job: SlotBuildJob<F>;
};

export type GloasSlotBidInput = CommonSlotBidInput<ForkName.gloas>;

export type HezeSlotBidInput = CommonSlotBidInput<ForkName.heze> & {
  inclusionListBits: heze.ExecutionPayloadBid["inclusionListBits"];
};

export type SlotBidInput = GloasSlotBidInput | HezeSlotBidInput;

type MatchedSlotBidInput =
  | {fork: ForkName.gloas; input: GloasSlotBidInput; payload: BuiltPayload<ForkName.gloas>}
  | {fork: ForkName.heze; input: HezeSlotBidInput; payload: BuiltPayload<ForkName.heze>};

export type SlotBidderModules = {
  orchestrator: Pick<PayloadOrchestrator, "run">;
  store: Pick<PayloadStore, "add">;
  policy: BidPolicy;
  ledger: Pick<BidLedger, "getUnsettledValueGwei" | "hasSubmitted">;
  publisher: Pick<BidPublisher, "publish">;
  getBuilderStatus: () => {status: BuilderStatus | undefined; balance: number | undefined};
  builderIndex: BuilderIndex;
};

export type SlotBidderOptions = {
  minOperatingBalanceGwei: number;
};

export type SlotBidResult =
  | {status: "published"; blockHash: RootHex; sourceId: string; valueGwei: number}
  | {
      status: "not_published";
      reason: "already_submitted" | "unknown_status" | "inactive" | "low_balance" | "policy_declined";
    };

export enum SlotBidderErrorCode {
  INVALID_OPTION = "SLOT_BIDDER_ERROR_INVALID_OPTION",
  INPUT_FORK_MISMATCH = "SLOT_BIDDER_ERROR_INPUT_FORK_MISMATCH",
  SLOT_MISMATCH = "SLOT_BIDDER_ERROR_SLOT_MISMATCH",
  PARENT_ROOT_MISMATCH = "SLOT_BIDDER_ERROR_PARENT_ROOT_MISMATCH",
  PAYLOAD_FORK_MISMATCH = "SLOT_BIDDER_ERROR_PAYLOAD_FORK_MISMATCH",
  PAYLOAD_PARENT_MISMATCH = "SLOT_BIDDER_ERROR_PAYLOAD_PARENT_MISMATCH",
  INVALID_BUILDER_BALANCE = "SLOT_BIDDER_ERROR_INVALID_BUILDER_BALANCE",
  UNSAFE_PAYLOAD_VALUE = "SLOT_BIDDER_ERROR_UNSAFE_PAYLOAD_VALUE",
}

export type SlotBidderErrorType =
  | {
      code: SlotBidderErrorCode.INVALID_OPTION;
      option: keyof SlotBidderOptions;
      value: number;
    }
  | {
      code: SlotBidderErrorCode.INPUT_FORK_MISMATCH;
      fork: SlotBidInput["fork"];
      requestFork: SlotBidInput["fork"];
    }
  | {
      code: SlotBidderErrorCode.SLOT_MISMATCH;
      slot: Slot;
      requestSlot: Slot;
      payloadSlot?: Slot;
    }
  | {
      code: SlotBidderErrorCode.PARENT_ROOT_MISMATCH;
      parentBlockRoot: RootHex;
      requestParentBlockRoot: RootHex;
    }
  | {
      code: SlotBidderErrorCode.PAYLOAD_FORK_MISMATCH;
      fork: SlotBidInput["fork"];
      payloadFork: SlotBidInput["fork"];
    }
  | {
      code: SlotBidderErrorCode.PAYLOAD_PARENT_MISMATCH;
      expectedParentBlockHash: RootHex;
      payloadParentBlockHash: RootHex;
    }
  | {
      code: SlotBidderErrorCode.INVALID_BUILDER_BALANCE;
      balance: number;
    }
  | {
      code: SlotBidderErrorCode.UNSAFE_PAYLOAD_VALUE;
      executionPayloadValue: bigint;
    };

export class SlotBidderError extends LodestarError<SlotBidderErrorType> {}

/** Coordinates one fully resolved payload-build input through retention and one-shot bid publication. */
export class SlotBidder {
  constructor(
    private readonly modules: SlotBidderModules,
    private readonly options: SlotBidderOptions
  ) {
    if (
      !Number.isSafeInteger(options.minOperatingBalanceGwei) ||
      options.minOperatingBalanceGwei < MIN_DEPOSIT_AMOUNT
    ) {
      throw new SlotBidderError(
        {
          code: SlotBidderErrorCode.INVALID_OPTION,
          option: "minOperatingBalanceGwei",
          value: options.minOperatingBalanceGwei,
        },
        `Invalid Slot bidder option minOperatingBalanceGwei=${options.minOperatingBalanceGwei}`
      );
    }
  }

  async run(input: SlotBidInput, signal: AbortSignal): Promise<SlotBidResult> {
    signal.throwIfAborted();
    this.assertInput(input);
    if (this.hasSubmitted(input)) {
      return {status: "not_published", reason: "already_submitted"};
    }

    const matched = this.matchPayload(input, await this.modules.orchestrator.run(input.job, signal));
    const {payload} = matched;
    if (this.hasSubmitted(input)) {
      return {status: "not_published", reason: "already_submitted"};
    }

    const {status, balance} = this.modules.getBuilderStatus();
    if (status === undefined || balance === undefined) {
      return {status: "not_published", reason: "unknown_status"};
    }
    if (status !== "active") {
      return {status: "not_published", reason: "inactive"};
    }
    if (!Number.isSafeInteger(balance) || balance < 0) {
      throw new SlotBidderError(
        {code: SlotBidderErrorCode.INVALID_BUILDER_BALANCE, balance},
        `Invalid Builder balance balance=${balance}`
      );
    }
    if (balance < this.options.minOperatingBalanceGwei) {
      return {status: "not_published", reason: "low_balance"};
    }

    const payloadValueGweiBigint = payload.executionPayloadValue / WEI_PER_GWEI;
    if (payloadValueGweiBigint < 0n || payloadValueGweiBigint > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SlotBidderError(
        {
          code: SlotBidderErrorCode.UNSAFE_PAYLOAD_VALUE,
          executionPayloadValue: payload.executionPayloadValue,
        },
        `Execution payload value exceeds the safe Gwei range executionPayloadValue=${payload.executionPayloadValue}`
      );
    }

    const unsettledValueGwei = this.modules.ledger.getUnsettledValueGwei(computeEpochAtSlot(input.slot));
    const coverableGwei = Math.max(balance - MIN_DEPOSIT_AMOUNT - unsettledValueGwei, 0);
    const valueGwei = this.modules.policy.computeValue({
      payloadValueGwei: Number(payloadValueGweiBigint),
      coverableGwei,
    });
    if (valueGwei === null) {
      return {status: "not_published", reason: "policy_declined"};
    }

    signal.throwIfAborted();
    this.modules.store.add({slot: input.slot, parentBlockRoot: input.parentBlockRoot, payload});

    const bid =
      matched.fork === ForkName.heze
        ? createExecutionPayloadBid({
            fork: matched.fork,
            slot: matched.input.slot,
            parentBlockRoot: matched.input.parentBlockRoot,
            builderIndex: this.modules.builderIndex,
            feeRecipient: matched.input.proposerFeeRecipient,
            value: valueGwei,
            payload: matched.payload,
            inclusionListBits: matched.input.inclusionListBits,
          })
        : createExecutionPayloadBid({
            fork: matched.fork,
            slot: matched.input.slot,
            parentBlockRoot: matched.input.parentBlockRoot,
            builderIndex: this.modules.builderIndex,
            feeRecipient: matched.input.proposerFeeRecipient,
            value: valueGwei,
            payload: matched.payload,
          });

    await this.modules.publisher.publish(bid, signal);
    return {
      status: "published",
      blockHash: toRootHex(payload.executionPayload.blockHash),
      sourceId: payload.sourceId,
      valueGwei,
    };
  }

  private hasSubmitted(input: SlotBidInput): boolean {
    return this.modules.ledger.hasSubmitted(
      input.slot,
      input.job.request.forkchoiceState.headBlockHash,
      toRootHex(input.parentBlockRoot)
    );
  }

  private assertInput(input: SlotBidInput): void {
    if (input.job.request.fork !== input.fork) {
      throw new SlotBidderError(
        {
          code: SlotBidderErrorCode.INPUT_FORK_MISMATCH,
          fork: input.fork,
          requestFork: input.job.request.fork,
        },
        `Build request fork does not match Slot bidder input fork=${input.fork} requestFork=${input.job.request.fork}`
      );
    }

    const requestSlot = input.job.request.payloadAttributes.slotNumber;
    if (requestSlot !== input.slot) {
      throw new SlotBidderError(
        {code: SlotBidderErrorCode.SLOT_MISMATCH, slot: input.slot, requestSlot},
        `Build request slot does not match Slot bidder input slot=${input.slot} requestSlot=${requestSlot}`
      );
    }

    const parentBlockRoot = toRootHex(input.parentBlockRoot);
    const requestParentBlockRoot = toRootHex(input.job.request.payloadAttributes.parentBeaconBlockRoot);
    if (requestParentBlockRoot !== parentBlockRoot) {
      throw new SlotBidderError(
        {code: SlotBidderErrorCode.PARENT_ROOT_MISMATCH, parentBlockRoot, requestParentBlockRoot},
        `Build request parent root does not match Slot bidder input parentBlockRoot=${parentBlockRoot} requestParentBlockRoot=${requestParentBlockRoot}`
      );
    }
  }

  private matchPayload(input: SlotBidInput, payload: BuiltPayload): MatchedSlotBidInput {
    if (input.fork === ForkName.gloas && isBuiltPayloadFor(payload, input.fork)) {
      this.assertPayload(input, payload);
      return {fork: input.fork, input, payload};
    }
    if (input.fork === ForkName.heze && isBuiltPayloadFor(payload, input.fork)) {
      this.assertPayload(input, payload);
      return {fork: input.fork, input, payload};
    }

    throw new SlotBidderError(
      {code: SlotBidderErrorCode.PAYLOAD_FORK_MISMATCH, fork: input.fork, payloadFork: payload.fork},
      `Built payload fork does not match Slot bidder input fork=${input.fork} payloadFork=${payload.fork}`
    );
  }

  private assertPayload<F extends ForkName.gloas | ForkName.heze>(
    input: CommonSlotBidInput<F>,
    payload: BuiltPayload<F>
  ): void {
    if (payload.executionPayload.slotNumber !== input.slot) {
      throw new SlotBidderError(
        {
          code: SlotBidderErrorCode.SLOT_MISMATCH,
          slot: input.slot,
          requestSlot: input.job.request.payloadAttributes.slotNumber,
          payloadSlot: payload.executionPayload.slotNumber,
        },
        `Built payload slot does not match Slot bidder input slot=${input.slot} payloadSlot=${payload.executionPayload.slotNumber}`
      );
    }

    const expectedParentBlockHash = input.job.request.forkchoiceState.headBlockHash;
    const payloadParentBlockHash = toRootHex(payload.executionPayload.parentHash);
    if (payloadParentBlockHash !== expectedParentBlockHash) {
      throw new SlotBidderError(
        {code: SlotBidderErrorCode.PAYLOAD_PARENT_MISMATCH, expectedParentBlockHash, payloadParentBlockHash},
        `Built payload parent does not match requested head expectedParentBlockHash=${expectedParentBlockHash} payloadParentBlockHash=${payloadParentBlockHash}`
      );
    }
  }
}
