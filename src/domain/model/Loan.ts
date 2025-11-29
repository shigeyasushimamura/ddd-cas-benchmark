import { Money } from "./Money";
import { SharePie } from "./SharePie";

export class Loan {
  constructor(
    public readonly id: string,
    public readonly amount: Money,
    public sharePie: SharePie, // ここが参照
    // ベンチマーク計測用に「何回目の更新か」を持つ
    public readonly version: number = 0
  ) {}

  // シェアを変更するビジネスロジック
  changeShare(newPie: SharePie): void {
    this.sharePie = newPie;
    (this as any).version = this.version + 1;
  }
}
