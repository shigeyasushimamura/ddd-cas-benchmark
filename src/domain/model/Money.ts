export class Money {
  constructor(public readonly amount: number) {}

  multiply(ratio: number): Money {
    return new Money(Math.floor(this.amount * ratio));
  }
}
