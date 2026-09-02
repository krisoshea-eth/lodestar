import {describe, expect, it, vi} from "vitest";
import {SecretKey} from "@chainsafe/lodestar-z/blst";
import {createBeaconConfig} from "@lodestar/config";
import {getConfig} from "@lodestar/config/test-utils";
import {ForkName} from "@lodestar/params";
import type {RootHex} from "@lodestar/types";
import {ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {BidLedger} from "../../../src/services/bidLedger.js";
import {BidPublisher} from "../../../src/services/bidPublisher.js";
import {BidSelector} from "../../../src/services/bidSelector.js";
import {BuilderSigner} from "../../../src/services/builderSigner.js";
import {EnvelopePublisher} from "../../../src/services/envelopePublisher.js";
import {createExecutionPayloadBid} from "../../../src/services/executionPayloadBid.js";
import {createExecutionPayloadEnvelopeMaterial} from "../../../src/services/executionPayloadEnvelope.js";
import type {BuiltPayload} from "../../../src/services/payloadSource.js";
import {PayloadStore} from "../../../src/services/payloadStore.js";
import {getApiClientStub, mockApiResponse} from "../utils/apiStub.js";

describe("Builder lifecycle component pipeline", () => {
  it("retains, bids, matches, and assembles an exact payload reveal", async () => {
    const config = createBeaconConfig(getConfig(ForkName.gloas), Buffer.alloc(32, 1));
    const signer = new BuilderSigner(config, keypair(Buffer.alloc(32, 2)));
    const builderIndex = 7;
    const slot = 10;
    const parentBlockRoot = Buffer.alloc(32, 3);
    const payload = createBuiltPayload();
    const blockHash = toRootHex(payload.executionPayload.blockHash);
    const store = new PayloadStore();
    store.add({slot, parentBlockRoot, payload});

    const bid = createExecutionPayloadBid({
      fork: ForkName.gloas,
      slot,
      parentBlockRoot,
      builderIndex,
      feeRecipient: Buffer.alloc(20, 4),
      value: 5,
      payload,
    });
    const api = getApiClientStub();
    Object.assign(api.beacon, {
      publishExecutionPayloadBid: vi.fn(),
      publishExecutionPayloadEnvelope: vi.fn(),
    });
    api.beacon.publishExecutionPayloadBid.mockResolvedValue(mockApiResponse({}));
    api.beacon.publishExecutionPayloadEnvelope.mockResolvedValue(mockApiResponse({}));
    const ledger = new BidLedger();
    const publisher = new BidPublisher({
      api,
      signer,
      ledger,
      builderIndex,
      hasPayload: (identity) => {
        const stored = store.get(identity.blockHash);
        return (
          stored !== null &&
          stored.slot === identity.slot &&
          toRootHex(stored.parentBlockRoot) === identity.parentBlockRoot &&
          toRootHex(stored.payload.executionPayload.parentHash) === identity.parentBlockHash
        );
      },
    });
    const signedBid = await publisher.publish(bid, new AbortController().signal);

    const block = ssz.gloas.SignedBeaconBlock.defaultValue();
    block.message.slot = slot;
    block.message.body.signedExecutionPayloadBid = signedBid;
    const blockRoot = toRootHex(config.getForkTypes(slot).BeaconBlock.hashTreeRoot(block.message));
    const selector = new BidSelector({
      config,
      ledger,
      builderIndex,
      getRetainedPayloadIdentity: retainedIdentity(store, blockHash),
    });
    const selection = selector.match({blockRoot, slot, version: ForkName.gloas, block});
    if (selection.status !== "selected") {
      throw Error(`Expected selected bid, got ${selection.reason}`);
    }

    const stored = store.get(blockHash);
    if (stored === null) {
      throw Error("Expected retained payload");
    }
    const material = createExecutionPayloadEnvelopeMaterial({
      blockRoot,
      builderIndex,
      selectedBid: selection.bid,
      payload: stored.payload,
    });
    const envelopePublisher = new EnvelopePublisher({
      api,
      signer,
      ledger,
      builderIndex,
      hasSelection: (identity) =>
        identity.slot === selection.bid.slot &&
        identity.parentBlockHash === selection.bid.parentBlockHash &&
        identity.parentBlockRoot === selection.bid.parentBlockRoot &&
        identity.blockHash === selection.bid.blockHash &&
        identity.blockRoot === selection.blockRoot,
    });
    const publication = await envelopePublisher.publish(material, new AbortController().signal);
    if (publication.status !== "published") {
      throw Error("Expected envelope publication");
    }

    expect(api.beacon.publishExecutionPayloadBid).toHaveBeenCalledOnce();
    expect(api.beacon.publishExecutionPayloadEnvelope).toHaveBeenCalledOnce();
    expect(selection.bid.wonBlockRoots).toEqual([blockRoot]);
    expect(publication.signedEnvelope.message.payload).toBe(payload.executionPayload);
    expect(publication.signedEnvelope.message.executionRequests).toBe(payload.executionRequests);
  });
});

function createBuiltPayload(): BuiltPayload<ForkName.gloas> {
  const executionPayload = ssz.gloas.ExecutionPayload.defaultValue();
  executionPayload.slotNumber = 10;
  executionPayload.parentHash = Buffer.alloc(32, 5);
  executionPayload.blockHash = Buffer.alloc(32, 6);
  return {
    sourceId: "engine",
    fork: ForkName.gloas,
    executionPayload,
    executionRequests: ssz.gloas.ExecutionRequests.defaultValue(),
    blobsBundle: ssz.gloas.BlobsBundle.defaultValue(),
    executionPayloadValue: 10n,
  };
}

function retainedIdentity(store: PayloadStore, blockHash: RootHex) {
  return (hash: RootHex) => {
    const stored = store.get(hash);
    if (stored === null) {
      return null;
    }
    return {
      slot: stored.slot,
      parentBlockHash: toRootHex(stored.payload.executionPayload.parentHash),
      parentBlockRoot: toRootHex(stored.parentBlockRoot),
      blockHash,
    };
  };
}

function keypair(secretKeyBytes: Uint8Array) {
  const secretKey = SecretKey.fromBytes(secretKeyBytes);
  return {secretKey, publicKey: secretKey.toPublicKey()};
}
