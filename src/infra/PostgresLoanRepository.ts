import * as postgres from "postgres";
import { Loan } from "../domain/model/Loan";
import { SharePie } from "../domain/model/SharePie";
import * as dotenv from "dotenv";

dotenv.config();

// SSL接続が必要な場合が多いので require: true
const sql = postgres(process.env.DATABASE_URL!, {
  ssl: "require",
  max: 50, // 並列数に合わせる
});

export class PostgresLoanRepository {
  // データ初期化 (Seed)
  async seed(count: number) {
    // 1. パイの初期データ
    const [pie] = await sql`
      insert into share_pies default values returning id
    `;

    // 2. ローンの初期データ (大量挿入)
    const loans = Array.from({ length: count }).map((_, i) => ({
      id: `loan-${i}`,
      amount: 1000,
      share_pie_id: pie?.id,
      version: 0,
    }));

    await sql`truncate table loans cascade`;
    await sql`insert into loans ${sql(loans)}`;
  }

  // --- Read ---
  async findById(id: string): Promise<Loan | null> {
    const result = await sql`
      select l.*, s.id as pie_id 
      from loans l 
      join share_pies s on l.share_pie_id = s.id 
      where l.id = ${id}
    `;

    if (result.length === 0) return null;
    const row = result[0];

    // 再構築 (簡易版)
    const pie = new SharePie(row?.pie_id, []);
    return new Loan(row?.id, pie, row?.version);
  }

  // --- Pattern A: CAS (DDD Style) ---
  // 楽観ロック: Transactionを使わず、単発クエリの原子性を利用する
  async saveCAS(loan: Loan, oldSharePieId: string): Promise<boolean> {
    // 1. 新しいパイを保存 (Insert)
    const [newPie] = await sql`
      insert into share_pies default values returning id
    `;

    // 2. CAS更新 (Update where old_id)
    // ここが命。更新件数が0なら失敗とみなす
    const result = await sql`
      update loans 
      set share_pie_id = ${newPie?.id},
          version = version + 1
      where id = ${loan.id} 
        and share_pie_id = ${oldSharePieId}
    `;

    return result.count > 0;
  }

  // --- Pattern B: Pessimistic (Select For Update) ---
  // 悲観ロック: トランザクションを張り、ロックを取得する
  // ※ベンチマークロジック側で tx を回すのは難しいので、
  //   ここでは「ロックして更新して終わる」一連の流れを1メソッドで定義します
  //   (実際のアプリではUseCaseでTransaction管理しますが、測定のため)
  async updateWithPessimisticLock(id: string): Promise<void> {
    await sql.begin(async (sql) => {
      // 1. Lock & Read
      const [row] = await sql`
        select share_pie_id from loans 
        where id = ${id} 
        for update
      `;

      if (!row) return; // 存在しない場合

      // 2. App Logic Simulation (RTTの影響を見るため)
      // Node.js側での処理時間を擬似的に待つならここに sleep を入れるが
      // 今回は「通信RTT」が主役なので、あえて何もしない（DBとの往復回数勝負）

      // 3. New Pie Insert
      const [newPie] = await sql`
        insert into share_pies default values returning id
      `;

      // 4. Update
      await sql`
        update loans 
        set share_pie_id = ${newPie?.id},
            version = version + 1
        where id = ${id}
      `;
    });
  }

  // コネクション切断用
  async close() {
    await sql.end();
  }
}
