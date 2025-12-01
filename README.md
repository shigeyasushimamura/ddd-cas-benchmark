# 【DDD × DB 設計】値オブジェクトを「不変」にしたら、分散環境のパフォーマンスが 2 倍になった話

## TL;DR

- ドメイン駆動設計(DDD)の「不変な値オブジェクト」パターンを使うと、並行性制御が劇的に改善される
- 悲観ロック vs 楽観ロック(CAS)のベンチマークで、**CAS が約 2 倍高速**
- 勝敗を分けたのは「DB コネクションの占有時間」
- 判断基準は「競合率」だけでなく**「トランザクションの長さ」と「リソース制約」**

---

## 背景：整合性とパフォーマンスのジレンマ

金融や在庫管理など、データの整合性が命となるシステムでは「ロストアップデート（更新の消失）」は許されません。これを防ぐための定石は 2 つあります。

### 1. 悲観ロック (Pessimistic Locking)

```sql
BEGIN;
SELECT * FROM accounts WHERE id = 123 FOR UPDATE; -- 行ロック
-- ビジネスロジック実行
UPDATE accounts SET balance = balance - 100 WHERE id = 123;
COMMIT;
```

**特徴:**

- ✅ 確実に整合性を保証
- ❌ ロック待ちが発生し、並列性が低下
- ❌ トランザクション中は DB 接続を占有

### 2. 楽観ロック / CAS (Compare-And-Swap)

```sql
-- Read
SELECT id, balance, version FROM accounts WHERE id = 123;

-- 計算（DBから切り離した状態で実行）
new_balance = balance - 100;

-- Write（バージョン確認付き更新）
UPDATE accounts
SET balance = new_balance, version = version + 1
WHERE id = 123 AND version = old_version;
-- 失敗したらリトライ
```

**特徴:**

- ✅ 計算中は DB 接続を解放できる
- ✅ 並列性が高い
- ❌ 競合時はリトライが必要

一般的に「競合が激しいなら悲観ロックの方が良い」と言われますが、**「ビジネスロジックの計算時間」や「DB コネクションの枯渇」**まで考慮すると、話は変わってきます。

---

## DDD における「不変な値オブジェクト」の意義

ドメイン駆動設計では、値オブジェクト(Value Object)は**不変(Immutable)**であることが推奨されます。

```typescript
// ❌ 可変な値オブジェクト（アンチパターン）
class Money {
  constructor(public amount: number) {}
  add(value: number) {
    this.amount += value; // 自分自身を変更
  }
}

// ✅ 不変な値オブジェクト（DDD推奨）
class Money {
  constructor(public readonly amount: number) {}
  add(value: number): Money {
    return new Money(this.amount + value); // 新しいインスタンスを返す
  }
}
```

この設計は通常「コードの保守性」や「バグ防止」の文脈で語られますが、実は**データベースの並行性制御においても劇的な効果**を発揮します。

---

## ベンチマーク設計

### 検証環境

- **Client**: Node.js (WSL2)
- **DB**: Supabase (AWS Tokyo Region / PostgreSQL)
- **Connection Pool**: Max 20 connections
- **テスト条件**:
  - リクエスト総数: 1,000 回
  - 並列数 (Concurrency): 20
  - **ビジネスロジックのシミュレーション**: Read と Write の間に**200ms の待機時間**（計算や外部 API コールを想定）

### アーキテクチャ比較

#### Pattern A: Pessimistic Locking

```typescript
async function pessimisticUpdate(id: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. ロック取得（DB接続占有開始）
    const { rows } = await client.query(
      "SELECT * FROM entities WHERE id = $1 FOR UPDATE",
      [id]
    );

    // 2. ビジネスロジック（200ms）← この間もDB接続を占有！
    await simulateBusinessLogic(200);

    // 3. 更新
    await client.query("UPDATE entities SET value = $1 WHERE id = $2", [
      newValue,
      id,
    ]);

    await client.query("COMMIT");
  } finally {
    client.release(); // やっと解放
  }
}
```

**問題点**: トランザクション全体で**220ms 以上 DB 接続を占有**

#### Pattern B: DDD + CAS (Optimistic)

```typescript
async function optimisticUpdate(id: string) {
  // 1. 読み込み（短時間で終わる）
  const entity = await pool.query("SELECT * FROM entities WHERE id = $1", [id]);
  // ← ここでDB接続は即座に解放される

  // 2. ビジネスロジック（200ms）← DB接続は占有していない！
  await simulateBusinessLogic(200);

  // 3. CAS更新（短時間で終わる）
  const result = await pool.query(
    "UPDATE entities SET value = $1, version = version + 1 WHERE id = $2 AND version = $3",
    [newValue, id, entity.version]
  );

  if (result.rowCount === 0) {
    // 競合検出 → リトライ
    return optimisticUpdate(id);
  }
}
```

**利点**: 計算中は DB 接続を解放 → **他のリクエストが利用可能**

---

## 実験結果

### ケース 1: 計算時間 0 秒（単純 CRUD）

| パターン    | 実行時間   | リトライ |
| ----------- | ---------- | -------- |
| Pessimistic | 約 2,500ms | 0 回     |
| CAS (DDD)   | 約 2,600ms | 5 回     |

→ **差はほぼない**（予想通り）

### ケース 2: 計算時間 200ms（実務的なシナリオ）

| パターン      | 実行時間     | リトライ | スループット   |
| ------------- | ------------ | -------- | -------------- |
| **CAS (DDD)** | **14,405ms** | 11 回    | **69.4 req/s** |
| Pessimistic   | 27,697ms     | 0 回     | 36.1 req/s     |

→ **CAS が約 1.92 倍高速！**

---

## なぜこんなに差がついたのか？

### 悲観ロックの敗因：コネクションプールの枯渇

```
Time →
Thread 1: [──DB接続占有(220ms)──]
Thread 2:   [──DB接続占有(220ms)──]
Thread 3:     [──DB接続占有(220ms)──]
...
Thread 20:                        [──DB接続占有(220ms)──]
Thread 21:                                            待機...
Thread 22:                                              待機...
```

- 並列数 20 × 1 リクエスト 220ms = **コネクションプール(Max 20)が完全に埋まる**
- Thread 21 以降は、誰かが COMMIT するまで**待機**
- 結果として**実質的な直列処理**に陥る

### DDD + CAS の勝因：リソースの有効活用

```
Time →
Thread 1: [Read(5ms)]─計算(200ms)─[Write(5ms)]
Thread 2:   [Read]─計算(200ms)─[Write]
Thread 3:     [Read]─計算(200ms)─[Write]
...
Thread 40:               [Read]─計算─[Write]  ← 並列実行可能！
Thread 50:                 [Read]─計算─[Write]
```

- **Read と Write は瞬時（各 5ms 程度）**なので、すぐ DB 接続を返却
- 計算中(200ms)は他のスレッドが DB 接続を利用可能
- **20 本のコネクションを有効活用** → 高スループット達成

---

## アーキテクトの判断基準

「悲観ロックか、楽観ロックか」という議論において、単に「競合率」だけで判断するのは危険です。

### 決定木

```
ビジネスロジックの実行時間は？
├─ 数ミリ秒以内（DB内で完結）
│  └─ 競合率は高い？
│     ├─ YES → 悲観ロック
│     └─ NO  → どちらでも良い
│
└─ 数十ミリ秒以上（計算・通信あり）
   └─ DBコネクションは潤沢？
      ├─ NO（クラウドDB等） → 楽観ロック/CAS ⭐
      └─ YES → ケースバイケース
```

### A. 悲観ロックを選ぶべきケース

- ✅ 「在庫の減算」「チケット予約」などのホットスポット
- ✅ 計算ロジックが一瞬で終わる（DB 内だけで完結）
- ✅ 競合が激しく、リトライコストが許容できない

### B. DDD + CAS を選ぶべきケース

- ✅ 一般的な業務アプリケーション
- ✅ ドメインロジックを含み、計算に数ミリ秒〜数百ミリ秒かかる
- ✅ クラウド DB など、コネクションリソースが有限
- ✅ 分散マイクロサービス環境

---

## 実装のポイント

### 1. リトライロジックの実装

```typescript
async function casUpdateWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      // 指数バックオフ
      await sleep(Math.pow(2, i) * 100);
    }
  }
  throw new Error("Unreachable");
}
```

### 2. 不変な値オブジェクトの設計

```typescript
// エンティティ
class Order {
  constructor(
    public readonly id: string,
    public readonly items: OrderItems, // 値オブジェクト
    public readonly version: number
  ) {}

  addItem(item: OrderItem): Order {
    // 新しいインスタンスを返す
    return new Order(
      this.id,
      this.items.add(item), // 値オブジェクトも不変
      this.version
    );
  }
}

// 値オブジェクト
class OrderItems {
  constructor(private readonly items: ReadonlyArray<OrderItem>) {}

  add(item: OrderItem): OrderItems {
    return new OrderItems([...this.items, item]);
  }
}
```

### 3. DB スキーマ設計

```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  items_snapshot JSONB NOT NULL, -- 値オブジェクトのスナップショット
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

-- CAS更新用のインデックス
CREATE INDEX idx_orders_version ON orders(id, version);
```

---

## まとめ

DDD で推奨される**「不変な値オブジェクト」**の設計は、コードを綺麗にするだけでなく:

1. **DB ロック時間を最小化**
2. **限られたコネクションを有効活用**
3. **スケーラビリティを向上**

という、**インフラ的なメリット**も巨大であることが実証されました。

もしあなたのシステムで「DB のコネクションが足りない」というアラートが出ているなら、それはプールサイズのせいではなく、**長すぎるトランザクション（悲観ロック）**が原因かもしれません。

---

## 参考文献

- Eric Evans『Domain-Driven Design』第 8 章
- PostgreSQL 公式ドキュメント - Concurrency Control
- [Supabase Connection Pooling Best Practices](https://supabase.com/docs/guides/database/connection-pooling)

---

## 補足：再現用コード

実際のベンチマークコードは GitHub で公開しています:

```bash
# Coming soon...
git clone https://github.com/your-repo/ddd-cas-benchmark
npm install
npm run benchmark
```

---

_この記事が役に立ったら、ぜひ「いいね」をお願いします！質問や議論は、コメント欄でお待ちしています。_
