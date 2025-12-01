import { PostgresLoanRepository } from "./infra/PostgresLoanRepository";
import { Table } from "console-table-printer";
import { Share } from "./domain/model/SharePie";
import { SharePie } from "./domain/model/SharePie";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LOGIC_TIME = 200; // 50msの計算時間をシミュレーション

const TOTAL_REQUESTS = 1000; // リアル通信なので少し減らす
const CONCURRENCY = 20; // Supabaseの接続数制限に注意
const DATA_SIZE = 1000; // Random Access用

const repo = new PostgresLoanRepository();

async function runRealCAS() {
  await repo.seed(DATA_SIZE);
  let retries = 0;
  const start = performance.now();

  const tasks = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    tasks.push(
      (async () => {
        const targetId = `loan-${Math.floor(Math.random() * DATA_SIZE)}`;

        let success = false;
        while (!success) {
          // 1. Read
          const loan = await repo.findById(targetId);
          if (!loan) break;

          const oldPieId = loan.sharePie.id!; // DB上のID

          // ★★★ 計算時間のシミュレーション (DB接続を掴んでいない！) ★★★
          await sleep(LOGIC_TIME);

          const newShares = [new Share("new-owner", 1.0)];
          const newPie = new SharePie(null, newShares);
          loan.changeShare(newPie);

          success = await repo.saveCAS(loan, oldPieId);
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
    Mode: "Real CAS",
    Time: (performance.now() - start).toFixed(0) + "ms",
    Retries: retries,
  };
}

async function runRealPessimistic() {
  await repo.seed(DATA_SIZE);
  const start = performance.now();

  const tasks = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    tasks.push(
      (async () => {
        const targetId = `loan-${Math.floor(Math.random() * DATA_SIZE)}`;
        // ロック取得から更新まで一気にやる
        await repo.updateWithPessimisticLock(targetId);
      })()
    );

    if (tasks.length >= CONCURRENCY) {
      await Promise.all(tasks);
      tasks.length = 0;
    }
  }
  await Promise.all(tasks);

  return {
    Mode: "Real Pessimistic",
    Time: (performance.now() - start).toFixed(0) + "ms",
    Retries: 0,
  };
}

async function main() {
  console.log(`\n=== REAL BENCHMARK (Supabase): ${TOTAL_REQUESTS} reqs ===\n`);

  try {
    const res1 = await runRealCAS();
    console.log("CAS Done.");
    const res2 = await runRealPessimistic();
    console.log("Pessimistic Done.");

    const p = new Table();
    p.addRows([res1, res2]);
    p.printTable();
  } finally {
    await repo.close();
  }
}

main();
