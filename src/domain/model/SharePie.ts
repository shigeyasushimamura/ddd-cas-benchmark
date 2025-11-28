import { Money } from "./Money";

export class Share {
  constructor(public readonly owner: string, public readonly ratio: number) {}
}

export class SharePie {
  // IDを持つ（DB保存用）。新規作成時はnull
  constructor(
    public readonly id: string | null,
    public readonly shares: Share[]
  ) {
    const total = shares.reduce((sum, s) => sum + s.ratio, 0);
    if (Math.abs(total - 1.0) > 0.001) throw new Error("Must be 100%");
  }

  prorate(amount: Money): Map<string, Money> {
    const distribution = new Map<string, Money>();
    this.shares.forEach((s) =>
      distribution.set(s.owner, amount.multiply(s.ratio))
    );
    return distribution;
  }
}
