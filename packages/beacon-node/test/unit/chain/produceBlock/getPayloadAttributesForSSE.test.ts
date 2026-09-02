import {describe, expect, it} from "vitest";
import {getConfig} from "@lodestar/config/test-utils";
import {ProtoBlock} from "@lodestar/fork-choice";
import {ForkName, ZERO_HASH_HEX} from "@lodestar/params";
import {BeaconStateView, isStatePostGloas} from "@lodestar/state-transition";
import {gloas} from "@lodestar/types";
import {fromHex, toRootHex} from "@lodestar/utils";
import {getPayloadAttributesForSSE} from "../../../../src/chain/produceBlock/produceBlockBody.js";
import {getMockedBeaconChain} from "../../../mocks/mockedBeaconChain.js";
import {createCachedBeaconStateTest} from "../../../utils/cachedBeaconState.js";
import {generateState, zeroProtoBlock} from "../../../utils/state.js";

describe("getPayloadAttributesForSSE", () => {
  it("includes post-Gloas safe and finalized execution block hashes", () => {
    const config = getConfig(ForkName.gloas);
    const chain = getMockedBeaconChain();
    const safeBlockHash = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const finalizedBlockHash = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const parentBlockHash = "0x3333333333333333333333333333333333333333333333333333333333333333";
    const safeBlock = {...zeroProtoBlock, blockRoot: "0xsafe", parentBlockHash: safeBlockHash} as ProtoBlock;
    const finalizedBlock = {
      ...zeroProtoBlock,
      blockRoot: "0xfinalized",
      parentBlockHash: finalizedBlockHash,
    } as ProtoBlock;
    const parentBlock = {
      ...zeroProtoBlock,
      executionPayloadBlockHash: parentBlockHash,
      executionPayloadGasLimit: 30_000_000,
      parentBlockHash,
    } as ProtoBlock;
    chain.forkChoice.getConfirmedRoot.mockReturnValue(safeBlock.blockRoot);
    chain.forkChoice.getConfirmedBlock.mockReturnValue(safeBlock);
    chain.forkChoice.getFinalizedBlock.mockReturnValue(finalizedBlock);
    chain.forkChoice.getBlockHexDefaultStatus.mockReturnValue(null);
    chain.forkChoice.getBlockHexAndBlockHash.mockReturnValue(parentBlock);

    const state = generateState({}, config, true);
    const prepareState = new BeaconStateView(createCachedBeaconStateTest(state, config));
    if (!isStatePostGloas(prepareState)) {
      throw new Error("Expected Gloas state");
    }
    const attributes = getPayloadAttributesForSSE(ForkName.gloas, chain, {
      prepareState,
      prepareSlot: 1,
      parentBlockRoot: fromHex(ZERO_HASH_HEX),
      parentBlockHash: fromHex(parentBlockHash),
      feeRecipient: "0x0000000000000000000000000000000000000000",
    }) as gloas.SSEPayloadAttributes;

    expect(toRootHex(attributes.safeBlockHash)).toBe(safeBlockHash);
    expect(toRootHex(attributes.finalizedBlockHash)).toBe(finalizedBlockHash);
  });
});
