# テスト・パフォーマンス・運用ガイド

TMS Web Service の開発時テスト方針、パフォーマンス特性、DB容量管理、スキーママイグレーション戦略をまとめる。

ポータビリティ境界の全体像は [architecture.md](./architecture.md)、インデックス設計の詳細は [data-model.md](./data-model.md) を参照。

---

## 1. テスト方針

### 1.1. 基本原則

- **TDD前提**で開発する。
- ドメイン層は純粋関数中心に設計し、`Storage` インターフェースをモックして単体テストする。
- HTTP/DB に依存しないため、ドメインテストは高速かつ決定的に実行できる。

### 1.2. テストランナー

| 環境 | ランナー | 備考 |
|---|---|---|
| 全体 | **Vitest** | TypeScript ネイティブ対応 |
| Workers統合テスト | `@cloudflare/vitest-pool-workers` | D1バインディング含む実環境テスト |

Workers pool を使うことで、D1 を含めたエンドツーエンド統合テストをローカルで実行可能。

### 1.3. Storage アダプタの契約テスト

D1 / libSQL / better-sqlite3 の全アダプタ実装に**同一テストスイート**を通し、移植性を機械的に保証する。

```typescript
// 契約テストの構造（イメージ）
describe.each(adapters)('Storage contract: %s', (createAdapter) => {
  it('creates and retrieves a test case', async () => { /* ... */ });
  it('UPDATE...LIMIT works correctly', async () => { /* ... */ });
  it('DELETE...LIMIT works correctly', async () => { /* ... */ });
  // ...全メソッドの振る舞い検証
});
```

**`UPDATE...LIMIT` / `DELETE...LIMIT` の互換チェック:**

- D1 はサポート済み（commit の冪等バッチ・パージで使用）。
- 古い libSQL / SQLite ビルドでは `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` が無効な場合があり、同一 SQL が動かない。
- 契約テストにこの互換チェックを必ず含め、移植先で早期に検知する。

---

## 2. パフォーマンス特性

### 2.1. ワークロード分析

TMS は典型的な CRUD アプリケーションであり、ワークロードは **I/O バウンド**。

体感レスポンスの支配要因：

| 要因 | 影響度 | 制御方法 |
|---|---|---|
| コールドスタート | 高 | Workers の軽量ランタイムで最小化 |
| エッジ配置 | 高 | Workers の既定動作 |
| DB I/O（D1 往復） | 高 | Smart Placement / インデックス設計 |
| アプリ CPU 処理 | **数%以下** | 最適化の余地なし |

### 2.2. 結論

- アプリの CPU 処理は全体レイテンシの数%以下であり、**実装言語の変更による体感改善はほぼゼロ**。
- Cloudflare Workers + TypeScript + Hono は、体感速度とオンプレ移植性を両立する最適解。
- 追加最適化はすべてポータビリティ境界（アダプタ裏）に隔離する。

---

## 3. 標準最適化（移植性非破壊）

ポータビリティ境界を壊さず、全環境で有効な施策：

| 施策 | 効果 |
|---|---|
| インデックス設計 | クエリ性能。詳細は [data-model.md](./data-model.md) のインデックス一覧参照 |
| SSR + HTMX | 最小ペイロード。クライアント JS を極限まで削減 |
| エッジ配置 | ユーザ近傍での応答（Workers 既定動作） |

---

## 4. DB 容量・肥大化対策

`TestCaseObservation` と `TestCaseHistory` は変化点・デルタ化しても長期的に増大する。SQLite は行 DELETE だけではファイルが縮まない。環境別に対処する。

### 4.1. 共通要件：定期パージ

**保持ポリシー（MVP から設定）:**

| 基準 | 既定値 | 備考 |
|---|---|---|
| 時間基準 | committed 観測 **90日** | MVP から適用 |
| 件数基準（top-N 変化点） | 実測後に決定 | 時間基準と併用 |

**不変条件:**

各 `(test_case_id, origin)` につき、直近の committed 観測を**最低1件は期間に関わらず必ず残す**（per-origin 強化）。これを破ると drift 判定・構造化 Diff の基準が消失する。

**パージ実行の制約:**

```sql
-- パージの削除述語（イメージ）
DELETE FROM TestCaseObservation
WHERE id IN (
  SELECT o.id FROM TestCaseObservation o
  JOIN SyncSession s ON o.sync_token = s.token
  WHERE s.status = 'committed'           -- committed のみ対象
    AND o.created_at < :threshold
    AND o.id NOT IN (                     -- 最低1件保持
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY test_case_id, origin
          ORDER BY created_at DESC
        ) AS rn
        FROM TestCaseObservation o2
        JOIN SyncSession s2 ON o2.sync_token = s2.token
        WHERE s2.status = 'committed'
      ) WHERE rn = 1
    )
  LIMIT :batch_size                       -- 小バッチ
);
```

- `DELETE...LIMIT N` の小バッチ反復で実行。
- 1 Cron 実行あたりクエリ数 **1,000 未満**に抑え、複数実行に分割継続。
- 30 秒タイムアウト・単一ライタ長時間占有を回避。
- 削除・残置の両述語に **`status='committed'` フィルタ**を強制（未確定観測を survivor に誤認しない）。

### 4.2. D1（クラウド）固有の対策

| 項目 | 対応 |
|---|---|
| VACUUM | **非対応**（D1 はストレージを自前管理。VACUUM を公開 PRAGMA に持たない） |
| 物理リクラメーション | 行 DELETE または DB シャーディング |
| 容量上限 | **1データベース 10GB のハード上限**（到達で全書き込み拒否＝即死） |
| 監視 | Cron で容量を概算監視し、しきい値到達前に警告/shard 判断 |
| シャード単位 | **project 別 / 時間レンジ別**（org 別ではない — 増加の真因は単一 project 内の時系列増加） |
| パージ実行 | **Cloudflare Cron Triggers** の scheduled Worker |

### 4.3. オンプレ（libSQL / better-sqlite3）固有の対策

| 項目 | 対応 |
|---|---|
| auto_vacuum | `PRAGMA auto_vacuum=INCREMENTAL`（**DB 初期化時・テーブル作成前**に設定） |
| 実行タイミング | パージ後に `PRAGMA incremental_vacuum` でファイルサイズ回収 |
| 設定場所 | アダプタの**接続初期化フック**（共通マイグレーションには書かない） |
| パージ実行 | OS の cron / スケジューラから `Storage` のパージ操作を呼ぶ |

### 4.4. 設計の要約

```
定期パージ ─── 共通要件（Storage インターフェース）
                │
        ┌───────┴────────┐
     D1アダプタ        オンプレアダプタ
     └─ Cron Worker     └─ cron + incremental_vacuum
```

アプリ本体はパージ操作のインターフェースのみ知る。VACUUM はオンプレアダプタ専用の実装詳細。

---

## 5. オプション最適化（CF 固有・アダプタ裏に隔離）

MVPでは実装しない（設計上のフック確保のみ）。すべてポータビリティ境界の内側。

| 施策 | 概要 | オンプレ代替 |
|---|---|---|
| Cache API / KV | 読みキャッシュ | インメモリ LRU / Redis |
| Smart Placement | Worker を D1 近傍に自動配置 | N/A（ランタイム設定 `placement = { mode = "smart" }`。コードではない） |
| Cloudflare Queues | 書き込み直列化キュー（衛星からの高頻度 Write をバッチ化） | 別キュー or 直接 Write |

**Queues について:**

D1（SQLite）は単一ライタのため、超高頻度バッチ Write は BusyTimeout を招き得る。将来、衛星と D1 の間に Queues を挟み Write をバッチ・直列化するアーキテクチャを採れるよう、取り込み経路を `Storage` / `Ingest` インターフェースの裏に閉じておく。

---

## 6. スキーマ・マイグレーション戦略

### 6.1. Single Source of Truth

```
Drizzle Kit（スキーマ定義）
    │
    ├─▶ SQL マイグレーションファイル（3アダプタ共通）
    │
    ├─▶ 適用: wrangler d1 migrations apply   ← クラウド
    └─▶ 適用: Drizzle migrator               ← オンプレ（better-sqlite3 / libSQL）
```

- Drizzle Kit をスキーマ定義＋マイグレーション生成の唯一のソースとする。
- 生成される SQL マイグレーションファイルは全アダプタ共通。
- 適用ランナーのみ環境別に分ける。

### 6.2. 環境固有 PRAGMA の隔離

`PRAGMA auto_vacuum=INCREMENTAL` のように「テーブル作成前・空 DB 時に必須」の設定は、**共通マイグレーションに書かない**。

```typescript
// オンプレアダプタの接続初期化フック
function initializeConnection(db: Database) {
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('PRAGMA journal_mode = WAL');
  // D1 では何もしない（no-op）
}
```

共通 SQL 資産を汚さず、各環境の前提条件を満たす。

### 6.3. Enum の扱い

SQLite には enum 型がないため、列の性質に応じて防御レベルを分ける。

| 列の性質 | 例 | 防御 | 理由 |
|---|---|---|---|
| **安定列**（値が増えない） | `status`, `category`, `ownership`, `role`, `action` | CHECK 制約 + Zod | 二重防御で整合性保証 |
| **流動列**（将来値が増える） | `origin`, メタ分類 | Zod のみ | ALTER 頻度を抑制 |

```sql
-- 安定列: CHECK制約の例
CREATE TABLE TestCase (
  ...
  status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'archived')),
  ownership TEXT NOT NULL CHECK(ownership IN ('machine', 'human')),
  ...
);
```

### 6.4. 生成列の後付け昇格

`metadata` / `parameters` 内のホットなフィルタ条件（例: `tags`）は、SQLite Generated Column + 索引へ昇格可能。

```sql
-- 後付けマイグレーション例
ALTER TABLE TestCase ADD COLUMN tags_generated TEXT
  GENERATED ALWAYS AS (json_extract(metadata, '$.tags')) VIRTUAL;
CREATE INDEX idx_testcase_tags ON TestCase(project_id, tags_generated);
```

- D1 ネイティブ機能として運用中 DB に適用可能。
- フルテーブルスキャンを回避し、JSON 列のフィルタ性能を改善。
