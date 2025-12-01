import { Pool } from "pg";
import { Loan } from "../domain/model/Loan";
import { SharePie } from "../domain/model/SharePie";
import { Share } from "../domain/model/SharePie";
import * as dotenv from "dotenv";

dotenv.config();

// ★ sleep関数を定義
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// postgres.js ではなく、標準の pg (Pool) を使用
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10, // コネクションプール数
  connectionTimeoutMillis: 30000, // ★ 10秒(10000) -> 30秒(30000) に増やす
  idleTimeoutMillis: 30000, // ★ 追加: アイドル接続を切る時間
});

export class PostgresLoanRepository {
  // データ初期化 (Seed)
  async seed(count: number) {
    const client = await pool.connect();
    try {
      console.log("Seeding data...");

      // 1. パイの初期データを作成
      const resPie = await client.query(
        "INSERT INTO share_pies DEFAULT VALUES RETURNING id"
      );
      const pieId = resPie.rows[0].id;

      // 2. データをクリア
      await client.query("TRUNCATE TABLE loans CASCADE");

      // 3. ローンの初期データ (大量挿入)
      // pg で高速にやるため、VALUES句を生成する
      const values: any[] = [];
      const placeHolders: string[] = [];

      for (let i = 0; i < count; i++) {
        const offset = i * 4;
        // ($1, $2, $3, $4) の形を作る
        placeHolders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`
        );
        values.push(`loan-${i}`, 1000, pieId, 0); // id, amount, share_pie_id, version
      }

      const query = `INSERT INTO loans (id, amount, share_pie_id, version) VALUES ${placeHolders.join(
        ","
      )}`;
      await client.query(query, values);

      console.log(`Seeding complete: ${count} records.`);
    } finally {
      client.release(); // 必ず解放する
    }
  }

  // --- Read ---
  async findById(id: string): Promise<Loan | null> {
    const res = await pool.query(
      `SELECT l.*, s.id as pie_id 
       FROM loans l 
       JOIN share_pies s ON l.share_pie_id = s.id 
       WHERE l.id = $1`,
      [id]
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    const dummyShare = new Share("db-owner", 1.0);
    const pie = new SharePie(row.pie_id, [dummyShare]);

    // amount がない場合は適当に 1000 とかにしておけばOK（ベンチマークに影響なし）
    // もし Loan クラスで amount を求めているなら以下のように渡す
    // (Moneyクラスがあるなら new Money(row.amount) など)
    return new Loan(row.id, { amount: row.amount } as any, pie, row.version);
  }

  // --- Pattern A: CAS (DDD Style) ---
  // 楽観ロック: Transactionを使わず、単発クエリでアトミック更新
  async saveCAS(loan: Loan, oldSharePieId: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      // 1. 新しいパイを保存 (Value Objectの不変性)
      const resPie = await client.query(
        "INSERT INTO share_pies DEFAULT VALUES RETURNING id"
      );
      const newPieId = resPie.rows[0].id;

      // 2. CAS更新 (Compare And Swap)
      // バージョンもインクリメントしつつ、share_pie_id が古いままかチェック
      const resUpdate = await client.query(
        `UPDATE loans 
         SET share_pie_id = $1,
             version = version + 1
         WHERE id = $2 
           AND share_pie_id = $3`,
        [newPieId, loan.id, oldSharePieId]
      );

      // rowCount が 1 なら成功、0 なら誰かに先を越された(失敗)
      return (resUpdate.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  // --- Pattern B: Pessimistic (Select For Update) ---
  // 悲観ロック: トランザクションを張ってロックする
  async updateWithPessimisticLock(id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); // トランザクション開始

      // 1. Lock & Read (RTT 1)
      const res = await client.query(
        "SELECT share_pie_id FROM loans WHERE id = $1 FOR UPDATE",
        [id]
      );

      if (res.rows.length === 0) {
        await client.query("ROLLBACK");
        return;
      }

      await sleep(200);

      // 2. Logic & Insert (RTT 2)
      // ここで本来アプリ側の計算時間が入る
      const resPie = await client.query(
        "INSERT INTO share_pies DEFAULT VALUES RETURNING id"
      );
      const newPieId = resPie.rows[0].id;

      // 3. Update (RTT 3)
      await client.query(
        `UPDATE loans 
         SET share_pie_id = $1,
             version = version + 1
         WHERE id = $2`,
        [newPieId, id]
      );

      await client.query("COMMIT"); // RTT 4
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // 終了処理
  async close() {
    await pool.end();
  }
}
