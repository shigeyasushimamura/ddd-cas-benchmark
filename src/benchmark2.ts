import { Loan } from "./domain/model/Loan";
import { Table } from "console-table-printer";
import { InMemoryLoanRepository } from "./infra/InMemoryLoanRepository";

// === 設定: ここで「CAS有利」な状況を作る ===
const TOTAL_REQUESTS = 2000;
const CONCURRENCY = 50;
const DATA_SIZE = 2000; // データ数を多くして競合率を下げる (Random Access)

// ★ RTT (Round Trip Time): リモートDBへの通信遅延
// AWSの東京-大阪間や、アプリ-DB間のレイテンシを想定 (20ms)
const RTT_MS = 20;

// ★ Heavy Logic: アプリ側での計算時間 (外部APIコールなど)
const LOGIC_MS = 0;

const repo = new InMemoryLoanRepository();

// 遅延シミュレーター
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// RTT発生ラッパー
async function withRTT<T>(fn: () => Promise<T>): Promise<T> {
  await sleep(RTT_MS); // 行き
  const result = await fn();
  await sleep(RTT_MS); // 帰り (データ受信)
  return result;
}

// データ準備
async function seed(count: number) {
  repo.seed(count);
}

// --- ロジック A: CAS (Optimistic) ---
// 特徴: DBとの対話回数が最小限 (Read -> Write)
async function runCAS() {
  await seed(DATA_SIZE);
  let retries = 0;
  const start = performance.now();

  const tasks = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    tasks.push(
      (async () => {
        const targetId = `loan-${Math.floor(Math.random() * DATA_SIZE)}`;

        let success = false;
        while (!success) {
          // 1. Read (1 RTT)
          const loan = await withRTT(() => repo.findById(targetId));
          if (!loan) break;

          const oldVer = loan.version;

          // 2. Logic (No DB access)
          if (LOGIC_MS > 0) await sleep(LOGIC_MS);
          loan.changeShare({} as any);

          // 3. Write (1 RTT) - CAS Check included
          // ※ INSERT + UPDATE を1トランザクションで送る想定で 1 RTTとする
          success = await withRTT(() => repo.saveCAS(loan, oldVer));

          if (!success) retries++;
        }
      })()
    );

    if (tasks.length >= CONCURRENCY) {
      await Promise.all(tasks);
      tasks.length = 0;
    }
  }
  await Promise.all(tasks);

  return {
    Mode: "DDD + CAS",
    Environment: `RTT=${RTT_MS}ms`,
    Time: (performance.now() - start).toFixed(0) + "ms",
    Retries: retries,
    RTT_Count_Per_Req: "~2",
  };
}

// --- ロジック B: Pessimistic (Transaction/Lock) ---
// 特徴: トランザクション制御のため通信回数が多い
async function runPessimistic() {
  await seed(DATA_SIZE);
  const start = performance.now();

  const tasks = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    tasks.push(
      (async () => {
        const targetId = `loan-${Math.floor(Math.random() * DATA_SIZE)}`;

        // 1. Begin & Lock (1 RTT)
        // ※ SELECT FOR UPDATE は実質ロック確保まで待たされる + 通信
        await withRTT(() => repo.lock(targetId));

        try {
          // 2. Read (1 RTT)
          // ※ 同じTx内なら早いが、通信は発生する想定
          const loan = await withRTT(() => repo.findById(targetId));
          if (!loan) return;

          // 3. Logic (Holding Lock...)
          if (LOGIC_MS > 0) await sleep(LOGIC_MS);
          loan.changeShare({} as any);

          // 4. Write (1 RTT)
          await withRTT(() => repo.saveNaive(loan));
        } finally {
          // 5. Commit & Unlock (1 RTT)
          // ※ コミット完了を待つ必要がある
          await withRTT(async () => repo.unlock(targetId));
        }
      })()
    );

    if (tasks.length >= CONCURRENCY) {
      await Promise.all(tasks);
      tasks.length = 0;
    }
  }
  await Promise.all(tasks);

  return {
    Mode: "Pessimistic",
    Environment: `RTT=${RTT_MS}ms`,
    Time: (performance.now() - start).toFixed(0) + "ms",
    Retries: 0,
    RTT_Count_Per_Req: "~4",
  };
}

async function main() {
  console.log(`\n=== BENCHMARK 2: Remote DB Simulation ===`);
  console.log(
    `Requests: ${TOTAL_REQUESTS}, Concurrency: ${CONCURRENCY}, DataSize: ${DATA_SIZE} (Random Access)\n`
  );

  const resultCAS = await runCAS();
  const resultPessimistic = await runPessimistic();

  const p = new Table();
  p.addRows([resultCAS, resultPessimistic]);
  p.printTable();
}

main();
