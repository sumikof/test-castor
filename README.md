# TMS Web Service

Agentic QA プラットフォームのハブとなる、構造化テストケース管理 Web サービス。
Cloudflare Workers + Hono + Drizzle ORM + Zod + Hono JSX(SSR) + HTMX で構築し、
オンプレ(Node.js + libSQL / better-sqlite3)にも同一アプリを移植可能な設計。

> デプロイ手順（Cloudflare / オンプレ）は別タスクで整備する。現時点では開発コマンドのみ記載する。

## ドキュメント

設計・仕様の正本は `docs/` 配下、実装計画・決定事項は `docs/superpowers/` 配下を参照。

| ドキュメント | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | プラットフォーム全体像・レイヤ構成・技術スタック |
| [docs/data-model.md](docs/data-model.md) | エンティティ定義・関係・状態機械 |
| [docs/api-reference.md](docs/api-reference.md) | REST API 仕様（索引・共通仕様） |
| [docs/sync-protocol.md](docs/sync-protocol.md) | 衛星同期プロトコル（start/chunk/commit） |
| [docs/auth-security.md](docs/auth-security.md) | 認証・認可・セキュリティ |
| [docs/operations.md](docs/operations.md) | テスト方針・パフォーマンス・DB 運用 |
| [docs/usecase.md](docs/usecase.md) | ユースケース（操作フロー） |
| [docs/screens.md](docs/screens.md) | 画面一覧・画面遷移図 |
| [docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md](docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md) | MVP 構築スペック（決定の正本） |

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `npm install` | 依存パッケージのインストール（postinstall で htmx を `public/` に配置） |
| `npm run dev` | `wrangler dev` でローカル起動 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | Vitest（node pool）: 単体テスト・better-sqlite3/libSQL 契約テスト |
| `npm run test:workers` | Vitest（workers pool, `@cloudflare/vitest-pool-workers`）: 統合テスト・D1 契約テスト |
| `npm test` | `test:unit` → `test:workers` を順に実行 |
| `npm run db:generate` | `drizzle-kit generate` でマイグレーション SQL を生成 |
