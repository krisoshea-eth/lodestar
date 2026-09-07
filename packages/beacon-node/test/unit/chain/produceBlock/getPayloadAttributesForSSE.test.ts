import {describe, expect, it} from "vitest";
import {getConfig} from "@lodestar/config/test-utils";
import {ExecutionStatus, PayloadStatus, type ProtoBlock} from "@lodestar/fork-choice";
import {ForkName, ZERO_HASH_HEX} from "@lodestar/params";
import {BeaconStateView, isStatePostBellatrix, isStatePostGloas} from "@lodestar/state-transition";
import {fromHex, toRootHex} from "@lodestar/utils";
import {getPayloadAttributesForSSE} from "../../../../src/chain/produceBlock/produceBlockBody.js";
import {getMockedBeaconChain} from "../../../mocks/mockedBeaconChain.js";
import {createCachedBeaconStateTest} from "../../../utils/cachedBeaconState.js";
import {generateState, zeroProtoBlock} from "../../../utils/state.js";

const safeBlockHash = toRootHex(Buffer.alloc(32, 1));
const finalizedBlockHash = toRootHex(Buffer.alloc(32, 2));
const parentBlockHash = toRootHex(Buffer.alloc(32, 3));

describe("getPayloadAttributesForSSE", () => {
  for (const fork of [ForkName.gloas, ForkName.heze] as const) {
    it.each([PayloadStatus.FULL, PayloadStatus.EMPTY])(
      `includes ${fork} execution hashes when extending %s`,
      (status) => {
        const {emit} = setup(fork, status);
        const attributes = emit();
        if (!("safeBlockHash" in attributes)) throw Error("Expected post-Gloas attributes");

        expect(toRootHex(attributes.safeBlockHash)).toBe(safeBlockHash);
        expect(toRootHex(attributes.finalizedBlockHash)).toBe(finalizedBlockHash);
        expect(toRootHex(attributes.parentBlockHash)).toBe(parentBlockHash);
      }
    );
  }

  it("refreshes the safe hash while finality remains unchanged", () => {
    const {emit, safeBlock} = setup(ForkName.gloas, PayloadStatus.EMPTY);
    const first = emit();
    safeBlock.parentBlockHash = toRootHex(Buffer.alloc(32, 4));
    const second = emit();
    if (!("safeBlockHash" in first) || !("safeBlockHash" in second)) throw Error("Expected post-Gloas attributes");

    expect(toRootHex(first.safeBlockHash)).toBe(safeBlockHash);
    expect(toRootHex(second.safeBlockHash)).toBe(safeBlock.parentBlockHash);
    expect(toRootHex(second.finalizedBlockHash)).toBe(finalizedBlockHash);
  });

  it("leaves the pre-Gloas event shape unchanged", () => {
    const {chain, emit} = setup(ForkName.fulu, PayloadStatus.FULL);
    const attributes = emit();

    expect(attributes).not.toHaveProperty("safeBlockHash");
    expect(attributes).not.toHaveProperty("finalizedBlockHash");
    expect(attributes).toHaveProperty("parentBlockNumber");
    expect(chain.forkChoice.getConfirmedBlock).not.toHaveBeenCalled();
    expect(chain.forkChoice.getFinalizedBlock).not.toHaveBeenCalled();
  });
});

function setup(fork: ForkName.fulu | ForkName.gloas | ForkName.heze, payloadStatus: PayloadStatus) {
  const config = getConfig(fork);
  const chain = getMockedBeaconChain();
  const safeBlock: ProtoBlock = {
    ...zeroProtoBlock,
    executionStatus: ExecutionStatus.Valid,
    executionPayloadNumber: 1,
    executionPayloadGasLimit: 30_000_000,
    slot: 1,
    blockRoot: toRootHex(Buffer.alloc(32, 5)),
    executionPayloadBlockHash: toRootHex(Buffer.alloc(32, 6)),
    parentBlockHash: safeBlockHash,
    payloadStatus,
  };
  const finalizedBlock: ProtoBlock = {
    ...zeroProtoBlock,
    executionStatus: ExecutionStatus.Valid,
    executionPayloadNumber: 1,
    executionPayloadGasLimit: 30_000_000,
    slot: 1,
    blockRoot: toRootHex(Buffer.alloc(32, 7)),
    executionPayloadBlockHash: toRootHex(Buffer.alloc(32, 8)),
    parentBlockHash: finalizedBlockHash,
    payloadStatus,
  };
  const parentBlock: ProtoBlock = {
    ...zeroProtoBlock,
    executionStatus: ExecutionStatus.Valid,
    executionPayloadNumber: 1,
    executionPayloadBlockHash: parentBlockHash,
    executionPayloadGasLimit: 30_000_000,
    parentBlockHash,
    payloadStatus,
  };
  chain.forkChoice.getConfirmedRoot.mockReturnValue(safeBlock.blockRoot);
  chain.forkChoice.getConfirmedBlock.mockReturnValue(safeBlock);
  chain.forkChoice.getFinalizedBlock.mockReturnValue(finalizedBlock);
  chain.forkChoice.getBlockHexDefaultStatus.mockReturnValue(null);
  chain.forkChoice.getBlockHexAndBlockHash.mockReturnValue(parentBlock);

  const state = generateState({}, config, true);
  if ("latestBlockHash" in state && payloadStatus === PayloadStatus.FULL) {
    state.latestExecutionPayloadBid.blockHash = fromHex(parentBlockHash);
    state.latestBlockHash = fromHex(parentBlockHash);
  }
  const prepareState = new BeaconStateView(createCachedBeaconStateTest(state, config));
  if (!isStatePostBellatrix(prepareState)) throw Error("Expected post-Bellatrix state");
  if (fork !== ForkName.fulu && !isStatePostGloas(prepareState)) throw Error("Expected Gloas state");
  const emit = () =>
    getPayloadAttributesForSSE(fork, chain, {
      prepareState,
      prepareSlot: 1,
      parentBlockRoot: fromHex(ZERO_HASH_HEX),
      parentBlockHash: fromHex(parentBlockHash),
      feeRecipient: "0x0000000000000000000000000000000000000000",
    });
  return {chain, emit, safeBlock};
}
