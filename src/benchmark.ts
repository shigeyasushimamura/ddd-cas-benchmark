import { Loan } from "./domain/model/Loan";
import { InMemoryLoanRepository } from "./infra/InMemoryLoanRepository";
import { Table } from "console-table-printer";

// 設定定数
const TOTAL_REQUESTS = 5000; // 各シナリオのリクエスト数
const CONCURRENCY = 50; // 並列数
const DATA_SIZE = 100; // データの総数 (loan-0 ~ loan-99)

type DistributionType = "Extreme" | "Hotspot" | "Random";
type Mode = "Naive" | "CAS" | "Pessimistic";

// IDセレクター（どのIDを更新するか決める）
function getId(distribution: DistributionType): string {
  const total = DATA_SIZE;

  switch (distribution) {
    case "Extreme":
      // 全員が loan-0 にアクセス
      return "loan-0";

    case "Hotspot":
      // 80%の確率で 上位20% (0~19) にアクセス
      // 20%の確率で 下位80% (20~99) にアクセス
      const isHot = Math.random() < 0.8;
      if (isHot) {
        const id = Math.floor(Math.random() * (total * 0.2));
        return `loan-${id}`;
      } else {
        const id = Math.floor(Math.random() * (total * 0.8)) + total * 0.2;
        return `loan-${id}`;
      }

    case "Random":
      // 完全にランダム
      const randId = Math.floor(Math.random() * total);
      return `loan-${randId}`;
  }
}

// リポジトリの準備（データ投入）
async function seedRepository(repo: InMemoryLoanRepository) {
  // 内部実装（MapなのかDBなのか）を知らなくても、
  // 「DATA_SIZE分のデータを用意してくれ」と頼むだけにする
  repo.seed(DATA_SIZE);
}

// 汎用ベンチマークランナー
async function runScenario(
  mode: Mode,
  distribution: DistributionType,
  repo: InMemoryLoanRepository
) {
  await seedRepository(repo); // データ初期化

  let totalRetries = 0;
  const start = performance.now();

  const tasks = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    tasks.push(
      (async () => {
        const targetId = getId(distribution);

        // --- Logic Switch ---
        if (mode === "Naive") {
          const loan = await repo.findById(targetId);
          if (loan) {
            loan.changeShare({} as any);
            await repo.saveNaive(loan);
          }
        } else if (mode === "CAS") {
          let success = false;
          while (!success) {
            const loan = await repo.findById(targetId);
            if (!loan) break;
            const oldVer = loan.version;
            loan.changeShare({} as any);
            success = await repo.saveCAS(loan, oldVer);
            if (!success) totalRetries++;
          }
        } else if (mode === "Pessimistic") {
          await repo.lock(targetId);
          try {
            const loan = await repo.findById(targetId);
            if (loan) {
              loan.changeShare({} as any);
              await repo.saveNaive(loan);
            }
          } finally {
            repo.unlock(targetId);
          }
        }
      })()
    );

    // Concurrency Control
    if (tasks.length >= CONCURRENCY) {
      await Promise.all(tasks);
      tasks.length = 0;
    }
  }
  await Promise.all(tasks);

  const end = performance.now();

  // データ整合性チェック (簡易版: 合計バージョン数の一致確認)
  // 本当は全IDなめるべきだが、ここでは代表的なズレを見る
  let actualTotalVersion = 0;
  for (let i = 0; i < DATA_SIZE; i++) {
    const l = await repo.findById(`loan-${i}`);
    if (l) actualTotalVersion += l.version;
  }

  return {
    Scenario: distribution,
    Mode: mode,
    Time: (end - start).toFixed(0) + "ms",
    LostUpdates: TOTAL_REQUESTS - actualTotalVersion,
    Retries: totalRetries,
  };
}

async function main() {
  console.log(
    `\n=== BENCHMARK SUITE: ${TOTAL_REQUESTS} reqs, ${CONCURRENCY} threads, ${DATA_SIZE} records ===\n`
  );
  const repo = new InMemoryLoanRepository();
  const results = [];

  // 1. Extreme (一点集中)
  results.push(await runScenario("Naive", "Extreme", repo));
  results.push(await runScenario("CAS", "Extreme", repo));
  results.push(await runScenario("Pessimistic", "Extreme", repo));

  // 2. Hotspot (現実的)
  results.push(await runScenario("Naive", "Hotspot", repo));
  results.push(await runScenario("CAS", "Hotspot", repo));
  results.push(await runScenario("Pessimistic", "Hotspot", repo));

  // 3. Random (分散)
  results.push(await runScenario("Naive", "Random", repo));
  results.push(await runScenario("CAS", "Random", repo));
  results.push(await runScenario("Pessimistic", "Random", repo));

  const p = new Table();
  p.addRows(results);
  p.printTable();
}

main();
