import {describe, expect, it} from "vitest";
import {
  BidPolicyError,
  BidPolicyErrorCode,
  ProportionalBidPolicy,
  type ProportionalBidPolicyOpts,
} from "../../../src/services/bidPolicy.js";

describe("ProportionalBidPolicy", () => {
  it("offers a share of the payload value", () => {
    const policy = new ProportionalBidPolicy({shareBps: 9000, fixedCostGwei: 0, minValueGwei: 0});
    expect(policy.computeValue({payloadValueGwei: 1_000_000, coverableGwei: 10_000_000})).toEqual(900_000);
  });

  it("deducts the fixed cost", () => {
    const policy = new ProportionalBidPolicy({shareBps: 10_000, fixedCostGwei: 100, minValueGwei: 0});
    expect(policy.computeValue({payloadValueGwei: 1_000, coverableGwei: 10_000})).toEqual(900);
  });

  it("never bids below the minimum value", () => {
    const policy = new ProportionalBidPolicy({shareBps: 5000, fixedCostGwei: 0, minValueGwei: 800});
    expect(policy.computeValue({payloadValueGwei: 1_000, coverableGwei: 10_000})).toEqual(800);
  });

  it("never bids below zero", () => {
    const policy = new ProportionalBidPolicy({shareBps: 5000, fixedCostGwei: 1_000, minValueGwei: 0});
    expect(policy.computeValue({payloadValueGwei: 100, coverableGwei: 10_000})).toEqual(0);
  });

  it("caps at the maximum value", () => {
    const policy = new ProportionalBidPolicy({shareBps: 10_000, fixedCostGwei: 0, minValueGwei: 0, maxValueGwei: 500});
    expect(policy.computeValue({payloadValueGwei: 1_000, coverableGwei: 10_000})).toEqual(500);
  });

  it("declines if the builder cannot cover the value", () => {
    const policy = new ProportionalBidPolicy({shareBps: 10_000, fixedCostGwei: 0, minValueGwei: 0});
    expect(policy.computeValue({payloadValueGwei: 1_000, coverableGwei: 999})).toBeNull();
  });

  it("rejects an invalid share", () => {
    expectOptionError({shareBps: 10_001, fixedCostGwei: 0, minValueGwei: 0}, "shareBps", 10_001);
  });

  it("rejects an invalid min and max configuration", () => {
    expectOptionError({shareBps: 10_000, fixedCostGwei: 0, minValueGwei: 1, maxValueGwei: 0}, "maxValueGwei", 0);
  });

  for (const {field, value} of [
    {field: "shareBps", value: 1.5},
    {field: "shareBps", value: Number.NaN},
    {field: "fixedCostGwei", value: -1},
    {field: "fixedCostGwei", value: Number.POSITIVE_INFINITY},
    {field: "minValueGwei", value: Number.MAX_SAFE_INTEGER + 1},
    {field: "maxValueGwei", value: 1.5},
  ] satisfies {field: keyof ProportionalBidPolicyOpts; value: number}[]) {
    it(`rejects invalid ${field}=${value}`, () => {
      expectOptionError({...validOpts(), [field]: value}, field, value);
    });
  }

  for (const {field, value} of [
    {field: "payloadValueGwei", value: -1},
    {field: "payloadValueGwei", value: 1.5},
    {field: "payloadValueGwei", value: Number.NaN},
    {field: "payloadValueGwei", value: Number.MAX_SAFE_INTEGER + 1},
    {field: "coverableGwei", value: -1},
    {field: "coverableGwei", value: Number.POSITIVE_INFINITY},
  ] as const) {
    it(`rejects invalid ${field}=${value}`, () => {
      const policy = new ProportionalBidPolicy(validOpts());
      const context = {payloadValueGwei: 100, coverableGwei: 100, [field]: value};
      expect(() => policy.computeValue(context)).toThrowError(
        new BidPolicyError(
          {code: BidPolicyErrorCode.INVALID_CONTEXT, field, value},
          `Invalid Bid policy context field=${field} value=${value}: must be a non-negative safe integer`
        )
      );
    });
  }

  it("computes a full-value bid without unsafe intermediate arithmetic", () => {
    const policy = new ProportionalBidPolicy({...validOpts(), shareBps: 10_000});
    expect(
      policy.computeValue({payloadValueGwei: Number.MAX_SAFE_INTEGER, coverableGwei: Number.MAX_SAFE_INTEGER})
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});

function validOpts(): ProportionalBidPolicyOpts {
  return {shareBps: 5000, fixedCostGwei: 0, minValueGwei: 0};
}

function expectOptionError(
  opts: ProportionalBidPolicyOpts,
  field: keyof ProportionalBidPolicyOpts,
  value: number
): void {
  expect(() => new ProportionalBidPolicy(opts)).toThrowError(BidPolicyError);
  try {
    new ProportionalBidPolicy(opts);
    throw Error("Expected BidPolicyError");
  } catch (error) {
    if (!(error instanceof BidPolicyError)) {
      throw error;
    }
    expect(error.type).toEqual({code: BidPolicyErrorCode.INVALID_OPTION, field, value});
  }
}
