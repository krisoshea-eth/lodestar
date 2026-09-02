import {LodestarError} from "@lodestar/utils";

export type BidContext = {
  /** Value of the payload to the builder's fee recipient, as reported by the execution client */
  payloadValueGwei: number;
  /** Builder balance that can back a bid, excess over the minimum and unsettled payments */
  coverableGwei: number;
};

/** Decides how much to pay the proposer for a payload, null means do not bid */
export interface BidPolicy {
  computeValue(ctx: BidContext): number | null;
}

export type ProportionalBidPolicyOpts = {
  /** Share of the payload value offered to the proposer, in basis points */
  shareBps: number;
  /** Fixed amount deducted from the share, e.g. to cover operating cost */
  fixedCostGwei: number;
  /** Never bid below this value */
  minValueGwei: number;
  /** Never bid above this value */
  maxValueGwei?: number;
};

type BidPolicyOption = keyof ProportionalBidPolicyOpts;
type BidPolicyContextField = keyof BidContext;

export enum BidPolicyErrorCode {
  INVALID_OPTION = "BID_POLICY_ERROR_INVALID_OPTION",
  INVALID_CONTEXT = "BID_POLICY_ERROR_INVALID_CONTEXT",
}

export type BidPolicyErrorType =
  | {
      code: BidPolicyErrorCode.INVALID_OPTION;
      field: BidPolicyOption;
      value: number;
    }
  | {
      code: BidPolicyErrorCode.INVALID_CONTEXT;
      field: BidPolicyContextField;
      value: number;
    };

export class BidPolicyError extends LodestarError<BidPolicyErrorType> {}

/**
 * Offers a fixed share of the payload value, bounded by the configured limits and the
 * builder's coverable balance. Independent of competing bids.
 */
export class ProportionalBidPolicy implements BidPolicy {
  constructor(private readonly opts: ProportionalBidPolicyOpts) {
    assertOption(opts.shareBps, "shareBps");
    if (opts.shareBps > 10_000) {
      throw invalidOption("shareBps", opts.shareBps, "must be within [0, 10000]");
    }

    assertOption(opts.fixedCostGwei, "fixedCostGwei");
    assertOption(opts.minValueGwei, "minValueGwei");

    if (opts.maxValueGwei !== undefined) {
      assertOption(opts.maxValueGwei, "maxValueGwei");
      if (opts.maxValueGwei < opts.minValueGwei) {
        throw invalidOption(
          "maxValueGwei",
          opts.maxValueGwei,
          `must be greater than or equal to minValueGwei=${opts.minValueGwei}`
        );
      }
    }
  }

  computeValue({payloadValueGwei, coverableGwei}: BidContext): number | null {
    assertContext(payloadValueGwei, "payloadValueGwei");
    assertContext(coverableGwei, "coverableGwei");

    const proportionalValue = Number((BigInt(payloadValueGwei) * BigInt(this.opts.shareBps)) / 10_000n);
    const share = proportionalValue - this.opts.fixedCostGwei;
    let value = Math.max(this.opts.minValueGwei, share);
    if (this.opts.maxValueGwei !== undefined) {
      value = Math.min(value, this.opts.maxValueGwei);
    }
    if (value > coverableGwei) {
      return null;
    }
    return value;
  }
}

function assertOption(value: number, field: BidPolicyOption): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidOption(field, value, "must be a non-negative safe integer");
  }
}

function invalidOption(field: BidPolicyOption, value: number, reason: string): BidPolicyError {
  return new BidPolicyError(
    {code: BidPolicyErrorCode.INVALID_OPTION, field, value},
    `Invalid Bid policy option field=${field} value=${value}: ${reason}`
  );
}

function assertContext(value: number, field: BidPolicyContextField): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BidPolicyError(
      {code: BidPolicyErrorCode.INVALID_CONTEXT, field, value},
      `Invalid Bid policy context field=${field} value=${value}: must be a non-negative safe integer`
    );
  }
}
