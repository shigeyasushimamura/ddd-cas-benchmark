import { Loan } from "../domain/model/Loan";
import { Mutex } from "./Mutex";

// 遅延のシミュレーション設定
const MIN_LATENCY_MS = 1;
const MAX_LATENCY_MS = 5;

export class InMemoryLoanRepository {
  // DBストレージ
  private store = new Map<string, { loan: Loan; shareId: string }>();

  // ★ ロック機構を追加
  private mutex = new Mutex();

  async lock(id: string) {
    // DBへの通信遅延はここには入れない（ロック取得自体は管理機構の話なので）
    await this.mutex.lock(id);
  }

  async unlock(id: string) {
    this.mutex.unlock(id);
  }

  constructor() {
    this.reset();
  }
  seed(count: number): void {
    this.store.clear();
    for (let i = 0; i < count; i++) {
      const id = `loan-${i}`;
      const initialLoan = new Loan(id, {} as any, 0); // version 0

      this.store.set(id, {
        loan: initialLoan,
        shareId: "init",
      });
    }
  }

  reset() {
    this.store.clear();
    // 初期データ投入 (Version 0)
    const initialLoan = new Loan("loan-1", {} as any, 0);
    this.store.set("loan-1", { loan: initialLoan, shareId: "init" });
  }

  private async randomDelay() {
    const ms = Math.floor(
      Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS + 1) + MIN_LATENCY_MS
    );
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 読み込み
  async findById(id: string): Promise<Loan | null> {
    await this.randomDelay();
    const data = this.store.get(id);
    if (!data) return null;
    // オブジェクトの参照渡しを防ぐため、コピー（Deep Copy的挙動）して返す
    return new Loan(data.loan.id, data.loan.sharePie, data.loan.version);
  }

  // パターンA: ナイーブな上書き (No Check)
  async saveNaive(loan: Loan): Promise<void> {
    await this.randomDelay();
    // ★ ここで何もチェックせずに上書きする
    this.store.set(loan.id, { loan: loan, shareId: "updated" });
  }

  // パターンB: CAS更新 (Check version)
  // oldVersion は「読み込んだ時のバージョン」
  async saveCAS(loan: Loan, oldVersion: number): Promise<boolean> {
    await this.randomDelay();
    const currentData = this.store.get(loan.id);

    if (!currentData) return false;

    // ★ 比較 (Compare)
    if (currentData.loan.version !== oldVersion) {
      return false; // 失敗！誰かが先に更新している
    }

    // ★ 交換 (Swap)
    this.store.set(loan.id, { loan: loan, shareId: "updated" });
    return true;
  }
}
