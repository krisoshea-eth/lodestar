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

/**
 * Offers a fixed share of the payload value, bounded by the configured limits and the
 * builder's coverable balance. Independent of competing bids.
 */
export class ProportionalBidPolicy implements BidPolicy {
  constructor(private readonly opts: ProportionalBidPolicyOpts) {
    assertValue(opts.shareBps, "shareBps");
    if (opts.shareBps > 10_000) {
      throw Error(`Invalid shareBps=${opts.shareBps}, must be within [0, 10000]`);
    }

    assertValue(opts.fixedCostGwei, "fixedCostGwei");
    assertValue(opts.minValueGwei, "minValueGwei");

    if (opts.maxValueGwei !== undefined) {
      assertValue(opts.maxValueGwei, "maxValueGwei");
      if (opts.maxValueGwei < opts.minValueGwei) {
        throw Error(
          `Invalid maxValueGwei=${opts.maxValueGwei}, must be greater than or equal to minValueGwei=${opts.minValueGwei}`
        );
      }
    }
  }

  computeValue({payloadValueGwei, coverableGwei}: BidContext): number | null {
    assertValue(payloadValueGwei, "payloadValueGwei");
    assertValue(coverableGwei, "coverableGwei");

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

function assertValue(value: number, field: keyof ProportionalBidPolicyOpts | keyof BidContext): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Error(`Invalid ${field}=${value}, must be a non-negative safe integer`);
  }
}
