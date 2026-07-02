# TMS Web Service MVP 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** docs/ の設計どおりの TMS Web Service MVP(17画面・全API・衛星同期プロトコル・認証/RBAC・Cron運用、CF Workers + Node の2エントリ)を構築する。

**Architecture:** 単一パッケージのレイヤードモノリス。依存方向は `http → domain → storage(interface)` の一方向で、CF 固有物は adapters と entry/workers.ts のみに置く。UI は Hono JSX SSR + HTMX(ドメイン層を直接呼ぶ)、DB は Drizzle(SQLite 方言)で D1 / better-sqlite3 / libSQL の3アダプタを同一契約テストで検証する。

**Tech Stack:** TypeScript(strict/ESM), Hono ^4, Zod ^4, Drizzle ORM ^0.44 + drizzle-kit, Cloudflare Workers(wrangler ^4, D1), better-sqlite3 ^12, @libsql/client, @hono/node-server, HTMX 2(自己ホスト), Vitest ~3.2 + @cloudflare/vitest-pool-workers

## Global Constraints

**GC-1 ドキュメント参照義務(ユーザー要件・必須):** 各タスクの実装前に、そのタスクの **Docs** 欄に列挙された docs/ 配下の設計ドキュメントを必ず読むこと。実装中は docs/ を正として整合性を確認しながら進め、コードと設計の食い違いを見つけた場合は勝手にコード側で解決せず、タスク報告で乖離を明示すること。**「Docs 欄のドキュメントと実装の整合を確認した」ことがすべてのタスクの完了条件に含まれる。**

- 決定の正本: `docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md`(以下「スペック」。D-01〜D-14 の決定番号で参照)。スペックと docs/ の記述が異なる箇所(例: DELETE の位置づけ、Idempotency-Key)はスペックが優先
- GC-2 TDD: 全タスクでテストを先に書き、失敗を確認してから実装する
- GC-3 日時は全て epoch ms の INTEGER。`Date.now()` を使い、テストでは固定クロックを注入する
- GC-4 エラー応答は統一スキーマ `{error:{code,message,details?,retryable}}`(api-reference.md「統一エラースキーマ」)以外を返さない
- GC-5 Storage の全メソッドは第一引数に `orgScope` を取る(auth-security.md「テナント境界」)
- GC-6 `src/schemas` `src/domain` `src/http` から `@cloudflare/workers-types` や D1 型を import しない(ポータビリティ境界)
- GC-7 依存パッケージは Task 1 の package.json に列挙したもののみ。追加はタスク報告で理由を明示
- GC-8 UI の全要素に docs/screens/ の各画面仕様で定義された data-testid を付与する
- GC-9 コミットは Conventional Commits(feat:/test:/fix:/docs:)で頻繁に行う
- GC-10 検証コマンド: `npm run typecheck` / `npm run test:unit`(node pool)/ `npm run test:workers`(workers pool)/ `npm test`(全部)

## ファイル構造(全体マップ)

```
package.json / tsconfig.json / wrangler.jsonc / drizzle.config.ts
vitest.config.ts(unit: node pool)/ vitest.workers.config.ts(workers pool)
migrations/                     # drizzle-kit generate の出力(3アダプタ共通)
public/htmx.min.js  public/app.css
src/
├── schemas/enums.ts limits.ts errors.ts entities.ts api.ts sync.ts
├── domain/testcase-rules.ts history-delta.ts gherkin.ts diff.ts cursor.ts
├── storage/schema.ts interface.ts drizzle-storage.ts
│   └── adapters/d1.ts better-sqlite3.ts libsql.ts
├── auth/interface.ts password.ts session-sign.ts token.ts webcrypto-auth.ts
├── ratelimit/interface.ts memory.ts
├── http/app.ts config.ts
│   ├── middleware/error.ts authn.ts scope.ts rbac.ts csrf.ts
│   ├── api/setup.ts auth.ts users.ts projects.ts tokens.ts testcases.ts sync.ts
│   └── ui/layout.tsx flash.ts auth-pages.tsx projects-pages.tsx
│       testcase-list.tsx testcase-detail.tsx testcase-form.tsx
│       tokens-pages.tsx users-pages.tsx profile-page.tsx
├── maintenance/purge.ts sweep.ts
└── entry/workers.ts node.ts maintenance-cli.ts
tests/
├── unit/…  ├── contract/storage-contract.ts + ランナー3本  └── integration/…
```

依存パッケージ(正確な指定):

```json
"dependencies": {
  "hono": "^4.8.0", "zod": "^4.0.0", "drizzle-orm": "^0.44.0",
  "@hono/zod-validator": "^0.7.0"
},
"optionalDependencies": {
  "better-sqlite3": "^12.0.0", "@libsql/client": "^0.15.0", "@hono/node-server": "^1.15.0"
},
"devDependencies": {
  "typescript": "^5.8.0", "vitest": "~3.2.0", "@cloudflare/vitest-pool-workers": "^0.8.0",
  "wrangler": "^4.0.0", "@cloudflare/workers-types": "^4.20260601.0",
  "drizzle-kit": "^0.31.0", "@types/better-sqlite3": "^7.6.0", "@types/node": "^22.0.0",
  "htmx.org": "^2.0.0"
}
```

---

### Task 1: プロジェクト scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `drizzle.config.ts`, `vitest.config.ts`, `vitest.workers.config.ts`, `tests/integration/setup-migrations.ts`, `.gitignore`, `src/entry/workers.ts`(仮), `public/app.css`(空で作成), `README.md`(骨子)
- Test: `tests/unit/smoke.test.ts`

**Interfaces:**
- Produces: npm スクリプト `typecheck` / `test:unit` / `test:workers` / `test` / `dev` / `db:generate`。後続全タスクがこの上で動く

**Docs:** `docs/architecture.md`(レイヤ構成・技術スタック)、`docs/operations.md` §1(テストランナー)、スペック「リポジトリ構造」

- [ ] **Step 1: package.json / tsconfig.json / .gitignore を作成**

```json
// package.json
{
  "name": "tms-web-service",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run --config vitest.config.ts",
    "test:workers": "vitest run --config vitest.workers.config.ts",
    "test": "npm run test:unit && npm run test:workers",
    "db:generate": "drizzle-kit generate",
    "postinstall": "node -e \"require('fs').copyFileSync(require.resolve('htmx.org/dist/htmx.min.js'),'public/htmx.min.js')\""
  }
}
```

(dependencies/devDependencies は上の「依存パッケージ」の内容をそのまま貼る。)

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "jsx": "react-jsx", "jsxImportSource": "hono/jsx",
    "types": ["@cloudflare/workers-types", "node"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`.gitignore`: `node_modules/`, `dist/`, `.wrangler/`, `public/htmx.min.js`, `*.sqlite`, `*.sqlite-*`

- [ ] **Step 2: wrangler.jsonc / drizzle.config.ts を作成**

```jsonc
// wrangler.jsonc
{
  "name": "tms-web-service",
  "main": "src/entry/workers.ts",
  "compatibility_date": "2026-06-01",
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "d1_databases": [
    { "binding": "DB", "database_name": "tms", "database_id": "REPLACE_ON_DEPLOY", "migrations_dir": "migrations" }
  ],
  "triggers": { "crons": ["0 * * * *"] },
  "vars": { "SESSION_TTL_MS": "604800000" }
  // SESSION_SIGNING_KEYS は secret: wrangler secret put SESSION_SIGNING_KEYS(形式は Task 6 参照)
}
```

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/storage/schema.ts',
  out: './migrations',
});
```

- [ ] **Step 3: vitest 設定2本と workers 用マイグレーション適用 setup を作成**

```ts
// vitest.config.ts(node pool: unit + better-sqlite3/libsql 契約テスト)
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts', 'tests/contract/better-sqlite3.test.ts', 'tests/contract/libsql.test.ts'] },
});
```

```ts
// vitest.workers.config.ts(workers pool: 統合 + D1 契約テスト)
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      include: ['tests/integration/**/*.test.ts', 'tests/contract/d1.test.ts'],
      setupFiles: ['./tests/integration/setup-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
```

```ts
// tests/integration/setup-migrations.ts
import { applyD1Migrations, env } from 'cloudflare:test';
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    ASSETS: Fetcher;
    SESSION_TTL_MS: string;
    SESSION_SIGNING_KEYS?: string;
  }
}
```

- [ ] **Step 4: 仮エントリと失敗するスモークテストを書く**

```ts
// src/entry/workers.ts(仮 — Task 8 以降で本実装に置換)
export default {
  async fetch(): Promise<Response> {
    return new Response('tms: not implemented yet', { status: 501 });
  },
};
```

```ts
// tests/unit/smoke.test.ts
import { describe, it, expect } from 'vitest';
describe('scaffold', () => {
  it('runs typescript tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: `npm install` を実行し、`npm run test:unit` が PASS、`npm run typecheck` がエラー0 であることを確認**

Run: `npm install && npm run test:unit && npm run typecheck`
Expected: smoke.test.ts 1 passed / tsc エラーなし
(注: `npm run test:workers` は migrations/ が空のためまだ実行しない。Task 3 以降で有効化)

- [ ] **Step 6: README.md 骨子を作成(タイトル、docs/ への参照、開発コマンド一覧のみ。デプロイ手順は Task 23 で完成させる)し、コミット**

```bash
git add -A && git commit -m "feat: scaffold TMS web service (hono/drizzle/vitest/wrangler)"
```

---

### Task 2: Zod スキーマ正本(schemas/)

**Files:**
- Create: `src/schemas/enums.ts`, `src/schemas/limits.ts`, `src/schemas/errors.ts`, `src/schemas/entities.ts`, `src/schemas/api.ts`, `src/schemas/sync.ts`
- Test: `tests/unit/schemas.test.ts`

**Interfaces:**
- Produces(後続全タスクが import する正本):
  - `ROLES/STATUSES/CATEGORIES/OWNERSHIPS/HISTORY_ACTIONS/SYNC_SESSION_STATUSES`(as const 配列)と対応する型 `Role/Status/Category/Ownership/HistoryAction`
  - `LIMITS`(D-07 の全数値)、`passwordSchema`(D-06)、`emailSchema`、`originSchema`
  - `ERROR_CODES`(api-reference.md の11コード)、`type ErrorCode`
  - 入力スキーマ: `setupInput, loginInput, changePasswordInput, createUserInput, patchUserInput, resetPasswordInput, createProjectInput, patchProjectInput, createTokenInput, createTestCaseInput, patchTestCaseInput, bulkInput, listTestCasesQuery, syncStartInput, syncChunkInput`
  - `parametersSchema`(`[{name?, inputs, expected}]`)、`observationSchema`(observed 固定キーセット+バイト上限)

**Docs:** `docs/data-model.md`(全エンティティの列と enum)、`docs/apis/*.md`(各リクエスト仕様)、`docs/api-reference.md`(エラーコード・origin 正規化規約)、`docs/sync-protocol.md`(observed 固定キーセット・512文字制約)、スペック D-06/D-07

- [ ] **Step 1: 失敗するテストを書く**

```ts
// tests/unit/schemas.test.ts
import { describe, it, expect } from 'vitest';
import { passwordSchema, originSchema, LIMITS } from '../../src/schemas/limits';
import { createTestCaseInput, bulkInput } from '../../src/schemas/api';
import { observationSchema } from '../../src/schemas/sync';

describe('schemas', () => {
  it('password: 8..128 文字(D-06)', () => {
    expect(passwordSchema.safeParse('a'.repeat(7)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(8)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
  it('origin: 小文字英数と -_. のみ・最大128(api-reference)', () => {
    expect(originSchema.safeParse('discovery-v1').success).toBe(true);
    expect(originSchema.safeParse('Discovery').success).toBe(false);
    expect(originSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
  it('testcase 作成: 必須は title/category/given/when/then、status 既定 draft', () => {
    const r = createTestCaseInput.safeParse({
      title: 't', category: 'normal', given: 'g', when: 'w', then: 't',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.status).toBe('draft');
    expect(createTestCaseInput.safeParse({ title: 't', category: 'bad', given: 'g', when: 'w', then: 't' }).success).toBe(false);
  });
  it('bulk: ids は 1..100 件、action は approve/archive/restore', () => {
    expect(bulkInput.safeParse({ ids: [], action: 'approve' }).success).toBe(false);
    expect(bulkInput.safeParse({ ids: Array.from({ length: 101 }, (_, i) => `id-${i}`), action: 'approve' }).success).toBe(false);
    expect(bulkInput.safeParse({ ids: ['a'], action: 'restore' }).success).toBe(true);
  });
  it('observation: external_ref/fingerprint は printable ASCII ≤512、observed のバイト上限を検証(D-07)', () => {
    const ok = observationSchema.safeParse({
      external_ref: 'com.example.T#m', fingerprint: 'sha256:abc',
      observed: { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1.0' },
    });
    expect(ok.success).toBe(true);
    expect(observationSchema.safeParse({ external_ref: '日本語', fingerprint: 'f', observed: { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1' } }).success).toBe(false);
    const big = { title: 'x'.repeat(LIMITS.observedBytes), given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1' };
    expect(observationSchema.safeParse({ external_ref: 'r', fingerprint: 'f', observed: big }).success).toBe(false);
  });
});
```

- [ ] **Step 2: `npm run test:unit` で FAIL(モジュール未作成)を確認**

- [ ] **Step 3: schemas を実装**

```ts
// src/schemas/enums.ts
export const ROLES = ['admin', 'editor', 'viewer'] as const;
export const STATUSES = ['draft', 'approved', 'archived'] as const;
export const CATEGORIES = ['normal', 'abnormal', 'boundary', 'error_handling'] as const;
export const OWNERSHIPS = ['machine', 'human'] as const;
export const HISTORY_ACTIONS = ['created', 'updated', 'status_changed', 'imported'] as const;
export const SYNC_SESSION_STATUSES = ['active', 'committed', 'expired'] as const;
export const BULK_ACTIONS = ['approve', 'archive', 'restore'] as const;
export type Role = (typeof ROLES)[number];
export type Status = (typeof STATUSES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Ownership = (typeof OWNERSHIPS)[number];
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];
export type BulkAction = (typeof BULK_ACTIONS)[number];
```

```ts
// src/schemas/limits.ts — スペック D-06 / D-07 の正本
import { z } from 'zod';

export const LIMITS = {
  name: 100,            // 組織名・表示名・プロジェクト名・トークン名
  email: 254,
  title: 200,
  target: 512,
  gwt: 10_000,          // given / when / then 各
  parametersBytes: 100 * 1024,
  metadataBytes: 10 * 1024,
  observedBytes: 256 * 1024,
  repoUrl: 2_000,
  passwordMin: 8,
  passwordMax: 128,
  externalRef: 512,
  fingerprint: 512,
  origin: 128,
  bulkMax: 100,
} as const;

export const jsonByteMax = (max: number) => (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length <= max;

export const nameSchema = z.string().min(1).max(LIMITS.name);
export const emailSchema = z.string().min(3).max(LIMITS.email).email();
export const passwordSchema = z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax);
export const originSchema = z.string().min(1).max(LIMITS.origin).regex(/^[a-z0-9\-_.]+$/);
export const printableAscii = (max: number) => z.string().min(1).max(max).regex(/^[\x20-\x7e]+$/);
export const repoUrlSchema = z.string().max(LIMITS.repoUrl).url().refine((u) => /^https?:\/\//.test(u), 'http/https のみ');
```

```ts
// src/schemas/errors.ts — api-reference.md「安定エラーコード」の正本
export const ERROR_CODES = [
  'VALIDATION_FAILED', 'OCC_CONFLICT', 'DUPLICATE_SYNC_SESSION', 'CROSS_TENANT',
  'NOT_FOUND', 'SESSION_EXPIRED', 'RATE_LIMITED', 'UNAUTHORIZED',
  'SETUP_ALREADY_COMPLETE', 'PRECONDITION_REQUIRED', 'NO_DRIFT', 'FORBIDDEN',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
// FORBIDDEN は role 超過(auth-security.md 能力マトリクスの 403)用。
// HTTP ステータス対応は http/middleware/error.ts が持つ。
```

```ts
// src/schemas/entities.ts — parameters / metadata / source_ref の構造正本
import { z } from 'zod';
import { LIMITS, jsonByteMax } from './limits';

export const parametersSchema = z
  .array(z.object({ name: z.string().max(LIMITS.name).optional(), inputs: z.unknown(), expected: z.unknown() }))
  .refine(jsonByteMax(LIMITS.parametersBytes), `parameters は ${LIMITS.parametersBytes} bytes 以内`);
export const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine(jsonByteMax(LIMITS.metadataBytes), `metadata は ${LIMITS.metadataBytes} bytes 以内`);
export const sourceRefSchema = z.record(z.string(), z.unknown());
export const confidenceSchema = z.number().min(0).max(1);
```

```ts
// src/schemas/api.ts — 全 API 入力の正本(各 apis/*.md のリクエスト仕様と1:1)
import { z } from 'zod';
import { CATEGORIES, STATUSES, ROLES, BULK_ACTIONS, OWNERSHIPS } from './enums';
import { nameSchema, emailSchema, passwordSchema, repoUrlSchema, LIMITS } from './limits';
import { parametersSchema, metadataSchema, sourceRefSchema, confidenceSchema } from './entities';

export const setupInput = z.object({
  organization_name: nameSchema,
  admin_email: emailSchema,
  admin_password: passwordSchema,
  admin_display_name: nameSchema,
});
export const loginInput = z.object({ email: emailSchema, password: z.string().min(1).max(LIMITS.passwordMax) });
export const changePasswordInput = z.object({ current_password: z.string().min(1), new_password: passwordSchema });
export const createUserInput = z.object({ email: emailSchema, password: passwordSchema, display_name: nameSchema, role: z.enum(ROLES) });
export const patchUserInput = z.object({ role: z.enum(ROLES).optional(), display_name: nameSchema.optional() });
export const resetPasswordInput = z.object({ new_password: passwordSchema });
export const createProjectInput = z.object({ name: nameSchema, repo_url: repoUrlSchema.optional() });
export const patchProjectInput = z.object({ name: nameSchema.optional(), repo_url: repoUrlSchema.nullable().optional() });
export const createTokenInput = z.object({ name: nameSchema });

export const createTestCaseInput = z.object({
  title: z.string().min(1).max(LIMITS.title),
  target: z.string().max(LIMITS.target).optional(),
  category: z.enum(CATEGORIES),
  given: z.string().min(1).max(LIMITS.gwt),
  when: z.string().min(1).max(LIMITS.gwt),
  then: z.string().min(1).max(LIMITS.gwt),
  parameters: parametersSchema.optional(),
  status: z.enum(STATUSES).default('draft'),
  confidence: confidenceSchema.optional(),
  source_ref: sourceRefSchema.optional(),
  metadata: metadataSchema.optional(),
});
// PATCH: キー未指定=不変 / null=クリア(api-reference.md「PATCH セマンティクス」)
export const patchTestCaseInput = z.object({
  title: z.string().min(1).max(LIMITS.title).optional(),
  target: z.string().max(LIMITS.target).nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  given: z.string().min(1).max(LIMITS.gwt).optional(),
  when: z.string().min(1).max(LIMITS.gwt).optional(),
  then: z.string().min(1).max(LIMITS.gwt).optional(),
  parameters: parametersSchema.nullable().optional(),
  status: z.enum(STATUSES).optional(),
  confidence: confidenceSchema.nullable().optional(),
  source_ref: sourceRefSchema.nullable().optional(),
  metadata: metadataSchema.nullable().optional(),
});
export const bulkInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(LIMITS.bulkMax),
  action: z.enum(BULK_ACTIONS),
});
const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true');
export const listTestCasesQuery = z.object({
  status: z.enum(STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
  ownership: z.enum(OWNERSHIPS).optional(),
  drift: boolParam.optional(),
  is_stale: boolParam.optional(),
  target: z.string().max(LIMITS.target).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const pageQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
```

```ts
// src/schemas/sync.ts — sync-protocol.md「観測データの仕様」の正本
import { z } from 'zod';
import { originSchema, printableAscii, LIMITS, jsonByteMax } from './limits';
import { parametersSchema, sourceRefSchema, confidenceSchema } from './entities';

export const observedSchema = z
  .object({
    title: z.string().min(1).max(LIMITS.title),
    given: z.string().min(1).max(LIMITS.gwt),
    when: z.string().min(1).max(LIMITS.gwt),
    then: z.string().min(1).max(LIMITS.gwt),
    parameters: parametersSchema,
    source_ref: sourceRefSchema,
    schema_version: z.string().min(1).max(32),
  })
  .refine(jsonByteMax(LIMITS.observedBytes), `observed は ${LIMITS.observedBytes} bytes 以内`);

export const observationSchema = z.object({
  external_ref: printableAscii(LIMITS.externalRef),
  fingerprint: printableAscii(LIMITS.fingerprint),
  observed: observedSchema,
  confidence: confidenceSchema.optional(),
  source_ref: sourceRefSchema.optional(),
});
export const syncStartInput = z.object({ origin: originSchema });
export const MAX_CHUNK_SIZE = 500; // sync-protocol.md「1 chunk ≤500 観測」
export const syncChunkInput = z.object({ observations: z.array(observationSchema).min(1).max(MAX_CHUNK_SIZE) });
```

- [ ] **Step 4: `npm run test:unit` PASS、`npm run typecheck` エラー0 を確認**

- [ ] **Step 5: Docs 欄のドキュメントと突き合わせ(enum 値・必須/任意・上限値が docs/apis/*.md、docs/sync-protocol.md と一致するか読み合わせ)、確認後コミット**

```bash
git add src/schemas tests/unit/schemas.test.ts && git commit -m "feat: add zod schema single-source (enums/limits/api/sync inputs)"
```

### Task 3: Drizzle スキーマとマイグレーション

**Files:**
- Create: `src/storage/schema.ts`, `tests/helpers/apply-migrations-node.ts`
- Create(生成): `migrations/0000_*.sql`(`npm run db:generate` の出力)
- Test: `tests/unit/schema-ddl.test.ts`

**Interfaces:**
- Produces: 全テーブル定義と行型 `OrganizationRow / UserRow / SessionRow / ProjectRow / TestCaseRow / TestCaseIdentityRow / TestCaseObservationRow / SyncSessionRow / SyncStagingRow / ApiTokenRow / TestCaseHistoryRow`(`typeof <table>.$inferSelect`)。`migrationStatements()`(node アダプタ・テストがマイグレーション SQL を適用するためのヘルパ)

**Docs:** `docs/data-model.md`(全テーブル・全インデックス・CHECK 制約・複合不変条件)、`docs/operations.md` §6(enum 二重防御・マイグレーション戦略)、スペック「データベース」(D-01/D-05 の追加列)

**実装ノート(docs との差分・タスク報告に明記すること):**
- `test_case_observations.confidence REAL?` を追加する。data-model.md の表には無いが、sync-protocol.md の chunk リクエストが `confidence` を受け取り、commit 工程1 で canonical に引き継ぐために保存が必要(観測の `observed` 固定キーセットには含められないため列で持つ)
- カーソルページング用に `ix_tc_project_created (project_id, created_at)` を追加する(api-reference.md のタイブレーカー `(created_at, id)` を効かせる)

- [ ] **Step 1: 失敗するテストを書く**

```ts
// tests/unit/schema-ddl.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrationStatements } from '../helpers/apply-migrations-node';

describe('DDL(生成マイグレーション)', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    for (const stmt of migrationStatements()) db.exec(stmt);
  });
  const insertBase = () => {
    db.exec(`INSERT INTO organizations (id,name,created_at,updated_at) VALUES ('o1','org',1,1)`);
    db.exec(`INSERT INTO projects (id,organization_id,name,created_at,updated_at) VALUES ('p1','o1','proj',1,1)`);
  };
  it('11 テーブルが作成される', () => {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name);
    for (const t of ['organizations','users','sessions','projects','test_cases','test_case_identities',
      'test_case_observations','sync_sessions','sync_staging','api_tokens','test_case_history']) {
      expect(names).toContain(t);
    }
  });
  it('CHECK: 不正 status を拒否する(data-model「enum 二重防御」)', () => {
    insertBase();
    expect(() => db.exec(
      `INSERT INTO test_cases (id,project_id,title,category,given,"when","then",status,ownership,created_origin,version,is_stale,drift,created_at)
       VALUES ('t1','p1','x','normal','g','w','t','bogus','human','manual',1,0,0,1)`,
    )).toThrow(/CHECK/);
  });
  it('CHECK: approved + machine は到達不能(複合不変条件)', () => {
    insertBase();
    expect(() => db.exec(
      `INSERT INTO test_cases (id,project_id,title,category,given,"when","then",status,ownership,created_origin,version,is_stale,drift,created_at)
       VALUES ('t1','p1','x','normal','g','w','t','approved','machine','manual',1,0,0,1)`,
    )).toThrow(/CHECK/);
  });
  it('部分一意索引: 同一 (project,origin) の active セッションは1つ(uq_active_session)', () => {
    insertBase();
    db.exec(`INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s1','p1','discovery-v1','active',1,10)`);
    expect(() => db.exec(
      `INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s2','p1','discovery-v1','active',1,10)`,
    )).toThrow(/UNIQUE/);
    // committed が居ても新 active は作れる
    db.exec(`UPDATE sync_sessions SET status='committed' WHERE token='s1'`);
    db.exec(`INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s3','p1','discovery-v1','active',1,10)`);
  });
  it('冪等一意制約: 観測の (external_ref,origin,sync_token,fingerprint)', () => {
    insertBase();
    db.exec(`INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s1','p1','o','active',1,10)`);
    const ins = `INSERT INTO test_case_observations (id,external_ref,project_id,fingerprint,observed,sync_token,origin,created_at)
                 VALUES (?,?,?,?,?,?,?,?)`;
    db.prepare(ins).run('ob1', 'ref', 'p1', 'fp', '{}', 's1', 'o', 1);
    expect(() => db.prepare(ins).run('ob2', 'ref', 'p1', 'fp', '{}', 's1', 'o', 2)).toThrow(/UNIQUE/);
  });
});
```

```ts
// tests/helpers/apply-migrations-node.ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
export function migrationStatements(dir = path.join(process.cwd(), 'migrations')): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .flatMap((text) => text.split('--> statement-breakpoint'));
}
```

- [ ] **Step 2: `npm run test:unit` で FAIL(migrations/ 不在)を確認**

- [ ] **Step 3: `src/storage/schema.ts` を実装**

```ts
import { sqliteTable, text, integer, real, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  displayName: text('display_name').notNull(),
  role: text('role').notNull(),
  lastLoginAt: integer('last_login_at'), // スペック D-05
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('uq_users_org_email').on(t.organizationId, t.email),
  check('ck_users_role', sql`${t.role} IN ('admin','editor','viewer')`),
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('ix_sessions_user').on(t.userId)]);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  repoUrl: text('repo_url'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const testCases = sqliteTable('test_cases', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  title: text('title').notNull(),
  target: text('target'),
  category: text('category').notNull(),
  given: text('given').notNull(),
  when: text('when').notNull(),
  then: text('then').notNull(),
  parameters: text('parameters'), // JSON 文字列
  status: text('status').notNull().default('draft'),
  isStale: integer('is_stale').notNull().default(0),
  ownership: text('ownership').notNull(),
  mirrorOrigin: text('mirror_origin'),
  drift: integer('drift').notNull().default(0),
  fingerprint: text('fingerprint'),
  version: integer('version').notNull().default(1),
  confidence: real('confidence'),
  sourceRef: text('source_ref'), // JSON
  createdOrigin: text('created_origin').notNull(),
  metadata: text('metadata'), // JSON
  humanUpdatedAt: integer('human_updated_at'),
  systemUpdatedAt: integer('system_updated_at'),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  index('ix_tc_project_status').on(t.projectId, t.status),
  index('ix_tc_project_category').on(t.projectId, t.category),
  index('ix_tc_project_stale').on(t.projectId, t.isStale),
  index('ix_tc_project_drift').on(t.projectId, t.drift),
  index('ix_tc_project_created').on(t.projectId, t.createdAt),
  check('ck_tc_status', sql`${t.status} IN ('draft','approved','archived')`),
  check('ck_tc_category', sql`${t.category} IN ('normal','abnormal','boundary','error_handling')`),
  check('ck_tc_ownership', sql`${t.ownership} IN ('machine','human')`),
  // status IN ('approved','archived') ⇒ ownership='human' の同値表現
  check('ck_tc_status_ownership', sql`${t.status} = 'draft' OR ${t.ownership} = 'human'`),
]);

export const testCaseIdentities = sqliteTable('test_case_identities', {
  id: text('id').primaryKey(),
  testCaseId: text('test_case_id').notNull().references(() => testCases.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  origin: text('origin').notNull(),
  externalRef: text('external_ref').notNull(),
  isStale: integer('is_stale').notNull().default(0),
  lastSeenSyncToken: text('last_seen_sync_token'),
  lastSeenAt: integer('last_seen_at'),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('uq_identity').on(t.projectId, t.origin, t.externalRef),
  index('ix_identity_lastseen').on(t.projectId, t.origin, t.lastSeenSyncToken),
  index('ix_identity_rollup').on(t.testCaseId, t.isStale, t.lastSeenAt),
]);

export const testCaseObservations = sqliteTable('test_case_observations', {
  id: text('id').primaryKey(),
  testCaseId: text('test_case_id'), // 新規ケースは commit 工程で backfill(data-model)
  externalRef: text('external_ref').notNull(),
  projectId: text('project_id').notNull().references(() => projects.id),
  fingerprint: text('fingerprint').notNull(),
  observed: text('observed').notNull(), // JSON(固定キーセット)
  syncToken: text('sync_token').notNull(),
  origin: text('origin').notNull(),
  confidence: real('confidence'), // 実装ノート参照(docs 差分)
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('uq_obs_idem').on(t.externalRef, t.origin, t.syncToken, t.fingerprint),
  index('ix_obs_tc_time').on(t.testCaseId, t.createdAt),
  index('ix_obs_project_token').on(t.projectId, t.syncToken),
  index('ix_obs_ref_origin_time').on(t.projectId, t.origin, t.externalRef, t.createdAt),
]);

export const syncSessions = sqliteTable('sync_sessions', {
  token: text('token').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  origin: text('origin').notNull(),
  status: text('status').notNull().default('active'),
  startedAt: integer('started_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  committedAt: integer('committed_at'), // 以下4列はスペック D-01
  createdCount: integer('created_count'),
  changedCount: integer('changed_count'),
  staledCount: integer('staled_count'),
}, (t) => [
  uniqueIndex('uq_active_session').on(t.projectId, t.origin).where(sql`${t.status} = 'active'`),
  index('ix_sync_project_committed').on(t.projectId, t.status, t.committedAt),
  check('ck_sync_status', sql`${t.status} IN ('active','committed','expired')`),
]);

export const syncStaging = sqliteTable('sync_staging', {
  syncToken: text('sync_token').notNull().references(() => syncSessions.token),
  externalRef: text('external_ref').notNull(),
  newTestCaseId: text('new_test_case_id').notNull(),
}, (t) => [uniqueIndex('uq_staging').on(t.syncToken, t.externalRef)]);

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  tokenHash: text('token_hash').notNull(),
  name: text('name').notNull(),
  lastUsedAt: integer('last_used_at'),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
}, (t) => [uniqueIndex('uq_token_hash').on(t.tokenHash)]);

export const testCaseHistory = sqliteTable('test_case_history', {
  id: text('id').primaryKey(),
  testCaseId: text('test_case_id').notNull().references(() => testCases.id),
  actor: text('actor').notNull(), // 'user:<id>' | 'token:<id>'
  action: text('action').notNull(),
  delta: text('delta').notNull(), // JSON {field:{before,after}}
  createdAt: integer('created_at').notNull(),
}, (t) => [
  index('ix_history_tc_time').on(t.testCaseId, t.createdAt),
  check('ck_history_action', sql`${t.action} IN ('created','updated','status_changed','imported')`),
]);

export type OrganizationRow = typeof organizations.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type TestCaseRow = typeof testCases.$inferSelect;
export type TestCaseIdentityRow = typeof testCaseIdentities.$inferSelect;
export type TestCaseObservationRow = typeof testCaseObservations.$inferSelect;
export type SyncSessionRow = typeof syncSessions.$inferSelect;
export type SyncStagingRow = typeof syncStaging.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type TestCaseHistoryRow = typeof testCaseHistory.$inferSelect;
```

- [ ] **Step 4: `npm run db:generate` を実行してマイグレーションを生成し、出力 SQL に CHECK 制約と `WHERE "status" = 'active'` 付き部分一意索引が含まれることを目視確認**

Run: `npm run db:generate && cat migrations/0000_*.sql`
Expected: `CHECK`, `CREATE UNIQUE INDEX ... WHERE` を含む DDL

- [ ] **Step 5: `npm run test:unit` PASS を確認(DDL テスト5件)**

- [ ] **Step 6: data-model.md の表と読み合わせ(列名・NULL 可否・インデックス12種の網羅)を行い、確認後コミット**

```bash
git add src/storage/schema.ts migrations tests && git commit -m "feat: add drizzle schema + initial migration (11 tables, checks, partial unique index)"
```

---

### Task 4: Storage インターフェースと共有実装・better-sqlite3 アダプタ・契約テスト基盤

このタスクでは Storage の**コア部分**(org/user/session/project/token)を定義・実装する。テストケース系・同期系メソッドは Task 12〜16 で同じパターンでインターフェースと契約テストに追記していく。

**Files:**
- Create: `src/storage/interface.ts`, `src/storage/drizzle-storage.ts`, `src/storage/adapters/better-sqlite3.ts`
- Create: `tests/contract/storage-contract.ts`(共通スイート), `tests/contract/better-sqlite3.test.ts`
- Test: 上記契約テスト

**Interfaces:**
- Consumes: Task 3 の schema / 行型、Task 2 の enum 型
- Produces:
  - `interface OrgScope { organizationId: string }`
  - `interface Storage`(下記メソッド群。後続タスクで拡張)
  - `type StorageDriver = { db: DrizzleSqliteDb; batch(queries: AnyQuery[]): Promise<void>; rawExec(sqlText: string): Promise<void> }`
  - `createDrizzleStorage(driver: StorageDriver): Storage`(3アダプタ共有の本体)
  - `createBetterSqlite3Storage(path?: string): { storage: Storage; rawExec: (s: string) => Promise<void> }`(生成時にマイグレーション自動適用)
  - `runStorageContract(name: string, factory: () => Promise<ContractCtx>)`(契約スイート)

**Docs:** `docs/data-model.md`(各エンティティの意味論・パスワード仕様の PHC は Task 6)、`docs/auth-security.md`(トークン照合述語・last_used_at 間引き)、`docs/operations.md` §1.3(契約テスト・UPDATE/DELETE...LIMIT 互換チェック)、`docs/apis/projects.md` / `docs/apis/users.md` / `docs/apis/tokens.md`(応答フィールド)、スペック D-05

- [ ] **Step 1: インターフェースを定義**

```ts
// src/storage/interface.ts
import type {
  OrganizationRow, UserRow, SessionRow, ProjectRow, ApiTokenRow,
} from './schema';
import type { Role } from '../schemas/enums';

export interface OrgScope { organizationId: string }

export interface SetupParams {
  orgName: string; adminEmail: string; adminPasswordHash: string; adminDisplayName: string; now: number;
}
export interface CreateUserParams {
  email: string; passwordHash: string; displayName: string; role: Role; now: number;
}

export interface Storage {
  // --- setup / organization ---
  countOrganizations(): Promise<number>;
  /** 組織+admin を単一トランザクションで作成(apis/setup.md 業務ルール) */
  setupOrganization(p: SetupParams): Promise<{ organization: OrganizationRow; user: UserRow }>;

  // --- users ---
  /** ログイン用。email はorg内一意(MVPは単一org運用)。global 検索で LIMIT 1 */
  findUserForLogin(email: string): Promise<UserRow | null>;
  getUser(scope: OrgScope, id: string): Promise<UserRow | null>;
  listUsers(scope: OrgScope): Promise<UserRow[]>;
  createUser(scope: OrgScope, p: CreateUserParams): Promise<UserRow | 'email_taken'>;
  updateUser(scope: OrgScope, id: string, patch: { role?: Role; displayName?: string }, now: number): Promise<UserRow | null>;
  countAdmins(scope: OrgScope): Promise<number>;
  setUserPassword(scope: OrgScope, userId: string, passwordHash: string, now: number): Promise<void>;
  touchLastLogin(scope: OrgScope, userId: string, now: number): Promise<void>;

  // --- sessions(署名検証は Auth 層。ここは DB 存在・失効のみ)---
  createSession(row: SessionRow): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  deleteSession(id: string): Promise<void>;
  deleteUserSessions(userId: string, exceptSessionId?: string): Promise<void>;

  // --- projects ---
  listProjects(scope: OrgScope): Promise<Array<ProjectRow & { testcaseCount: number }>>; // D-05: 非archived件数
  getProject(scope: OrgScope, pid: string): Promise<ProjectRow | null>;
  createProject(scope: OrgScope, p: { name: string; repoUrl?: string | null }, now: number): Promise<ProjectRow>;
  updateProject(scope: OrgScope, pid: string, patch: { name?: string; repoUrl?: string | null }, now: number): Promise<ProjectRow | null>;

  // --- api tokens ---
  createApiToken(scope: OrgScope, pid: string, name: string, tokenHash: string, now: number): Promise<ApiTokenRow>;
  listApiTokens(scope: OrgScope, pid: string): Promise<ApiTokenRow[]>;
  /** 冪等ソフト失効(apis/tokens.md)。存在しなければ null */
  revokeApiToken(scope: OrgScope, pid: string, tokenId: string, now: number): Promise<ApiTokenRow | null>;
  /** 認証述語: token_hash 完全一致 AND revoked_at IS NULL(auth-security.md) */
  findApiTokenByHash(tokenHash: string): Promise<(ApiTokenRow & { organizationId: string }) | null>;
  /** best-effort 間引き更新: 前回更新から thresholdMs 経過時のみ書く */
  touchTokenLastUsed(tokenId: string, now: number, thresholdMs: number): Promise<void>;
}
```

- [ ] **Step 2: 契約テスト(失敗する)を書く**

```ts
// tests/contract/storage-contract.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { Storage } from '../../src/storage/interface';

export interface ContractCtx {
  storage: Storage;
  rawExec(sqlText: string): Promise<void>;
}
const WIPE_ORDER = [
  'test_case_history', 'test_case_observations', 'sync_staging', 'sync_sessions',
  'test_case_identities', 'test_cases', 'api_tokens', 'sessions', 'projects', 'users', 'organizations',
];

export function runStorageContract(name: string, factory: () => Promise<ContractCtx>) {
  describe(`Storage contract: ${name}`, () => {
    let ctx: ContractCtx;
    let scope: { organizationId: string };
    const now = 1_700_000_000_000;

    beforeEach(async () => {
      ctx = await factory();
      for (const t of WIPE_ORDER) await ctx.rawExec(`DELETE FROM ${t}`);
      const r = await ctx.storage.setupOrganization({
        orgName: 'org', adminEmail: 'admin@example.com',
        adminPasswordHash: '$pbkdf2-sha256$i=1$x$y', adminDisplayName: 'Admin', now,
      });
      scope = { organizationId: r.organization.id };
    });

    it('setup: org と admin を作成し countOrganizations=1', async () => {
      expect(await ctx.storage.countOrganizations()).toBe(1);
      const admin = await ctx.storage.findUserForLogin('admin@example.com');
      expect(admin?.role).toBe('admin');
    });

    it('users: 作成・一覧・email 重複は email_taken・ロール更新', async () => {
      const u = await ctx.storage.createUser(scope, {
        email: 'e@example.com', passwordHash: 'h', displayName: 'E', role: 'editor', now,
      });
      expect(u).not.toBe('email_taken');
      expect(await ctx.storage.createUser(scope, {
        email: 'e@example.com', passwordHash: 'h', displayName: 'E2', role: 'viewer', now,
      })).toBe('email_taken');
      expect((await ctx.storage.listUsers(scope)).length).toBe(2);
      expect(await ctx.storage.countAdmins(scope)).toBe(1);
      const upd = await ctx.storage.updateUser(scope, (u as any).id, { role: 'admin' }, now + 1);
      expect(upd?.role).toBe('admin');
      expect(upd?.updatedAt).toBe(now + 1);
      expect(await ctx.storage.countAdmins(scope)).toBe(2);
    });

    it('users: 他 org のユーザーは scope 越しに見えない(テナント境界)', async () => {
      const other = await ctx.storage.setupOrganization({
        orgName: 'org2', adminEmail: 'a2@example.com', adminPasswordHash: 'h', adminDisplayName: 'A2', now,
      });
      expect(await ctx.storage.getUser(scope, other.user.id)).toBeNull();
      expect((await ctx.storage.listUsers(scope)).some((u) => u.id === other.user.id)).toBe(false);
    });

    it('sessions: 作成・取得・本人全削除(except 指定)', async () => {
      const admin = (await ctx.storage.findUserForLogin('admin@example.com'))!;
      await ctx.storage.createSession({ id: 's1', userId: admin.id, expiresAt: now + 1000, createdAt: now });
      await ctx.storage.createSession({ id: 's2', userId: admin.id, expiresAt: now + 1000, createdAt: now });
      expect((await ctx.storage.getSession('s1'))?.userId).toBe(admin.id);
      await ctx.storage.deleteUserSessions(admin.id, 's2');
      expect(await ctx.storage.getSession('s1')).toBeNull();
      expect(await ctx.storage.getSession('s2')).not.toBeNull();
    });

    it('projects: 作成・一覧(testcaseCount=0)・更新(repoUrl null クリア)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'payment', repoUrl: 'https://x' }, now);
      const list = await ctx.storage.listProjects(scope);
      expect(list[0]?.testcaseCount).toBe(0);
      const upd = await ctx.storage.updateProject(scope, p.id, { repoUrl: null }, now + 1);
      expect(upd?.repoUrl).toBeNull();
    });

    it('tokens: 発行・hash 照合・失効で照合不可(認証述語)・失効は冪等', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'pr' }, now);
      const t = await ctx.storage.createApiToken(scope, p.id, 'discovery-ci', 'HASH1', now);
      const found = await ctx.storage.findApiTokenByHash('HASH1');
      expect(found?.id).toBe(t.id);
      expect(found?.organizationId).toBe(scope.organizationId);
      await ctx.storage.revokeApiToken(scope, p.id, t.id, now + 5);
      expect(await ctx.storage.findApiTokenByHash('HASH1')).toBeNull();
      const again = await ctx.storage.revokeApiToken(scope, p.id, t.id, now + 9);
      expect(again?.revokedAt).toBe(now + 5); // 冪等: 最初の失効時刻を保持
    });

    it('tokens: last_used_at は閾値内の連続更新を間引く', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'pr' }, now);
      const t = await ctx.storage.createApiToken(scope, p.id, 'n', 'H', now);
      await ctx.storage.touchTokenLastUsed(t.id, now + 1000, 60_000);
      await ctx.storage.touchTokenLastUsed(t.id, now + 2000, 60_000); // 間引かれる
      const [row] = await ctx.storage.listApiTokens(scope, p.id);
      expect(row?.lastUsedAt).toBe(now + 1000);
      await ctx.storage.touchTokenLastUsed(t.id, now + 62_000, 60_000);
      const [row2] = await ctx.storage.listApiTokens(scope, p.id);
      expect(row2?.lastUsedAt).toBe(now + 62_000);
    });

    it('UPDATE...LIMIT / DELETE...LIMIT が動作する(operations.md §1.3 移植互換)', async () => {
      const admin = (await ctx.storage.findUserForLogin('admin@example.com'))!;
      for (let i = 0; i < 3; i++) {
        await ctx.storage.createSession({ id: `L${i}`, userId: admin.id, expiresAt: now, createdAt: now });
      }
      await ctx.rawExec(`UPDATE sessions SET expires_at = 1 WHERE user_id = '${admin.id}' LIMIT 2`);
      await ctx.rawExec(`DELETE FROM sessions WHERE expires_at = 1 LIMIT 2`);
    });
  });
}
```

```ts
// tests/contract/better-sqlite3.test.ts
import { runStorageContract } from './storage-contract';
import { createBetterSqlite3Storage } from '../../src/storage/adapters/better-sqlite3';
runStorageContract('better-sqlite3', async () => createBetterSqlite3Storage(':memory:'));
```

- [ ] **Step 3: `npm run test:unit` で FAIL を確認**

- [ ] **Step 4: 共有実装とアダプタを実装**

```ts
// src/storage/drizzle-storage.ts(抜粋 — このタスクのメソッドを全て実装する)
import { and, eq, ne, isNull, count, sql } from 'drizzle-orm';
import {
  organizations, users, sessions, projects, apiTokens, testCases,
  type SessionRow,
} from './schema';
import type { Storage, OrgScope, SetupParams, CreateUserParams } from './interface';

// 3アダプタの差(batch/transaction/raw)を吸収する薄いドライバ
export type AnyQuery = { run(): unknown };
export interface StorageDriver {
  db: any; // drizzle sqlite database(sync/async 両対応のため any。adapters 内でのみ生成)
  batch(queries: AnyQuery[]): Promise<void>;
  rawExec(sqlText: string): Promise<void>;
}
const uuid = () => crypto.randomUUID();

export function createDrizzleStorage(driver: StorageDriver): Storage {
  const { db } = driver;
  return {
    async countOrganizations() {
      const [r] = await db.select({ n: count() }).from(organizations);
      return r?.n ?? 0;
    },
    async setupOrganization(p: SetupParams) {
      const org = { id: uuid(), name: p.orgName, createdAt: p.now, updatedAt: p.now };
      const user = {
        id: uuid(), organizationId: org.id, email: p.adminEmail, passwordHash: p.adminPasswordHash,
        displayName: p.adminDisplayName, role: 'admin', lastLoginAt: null, createdAt: p.now, updatedAt: p.now,
      };
      await driver.batch([db.insert(organizations).values(org), db.insert(users).values(user)]);
      return { organization: org, user } as any;
    },
    async findUserForLogin(email) {
      const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return u ?? null;
    },
    async getUser(scope, id) {
      const [u] = await db.select().from(users)
        .where(and(eq(users.id, id), eq(users.organizationId, scope.organizationId)));
      return u ?? null;
    },
    async listUsers(scope) {
      return db.select().from(users).where(eq(users.organizationId, scope.organizationId)).orderBy(users.createdAt);
    },
    async createUser(scope: OrgScope, p: CreateUserParams) {
      const row = {
        id: uuid(), organizationId: scope.organizationId, email: p.email, passwordHash: p.passwordHash,
        displayName: p.displayName, role: p.role, lastLoginAt: null, createdAt: p.now, updatedAt: p.now,
      };
      try {
        await db.insert(users).values(row).run();
      } catch (e: any) {
        if (String(e?.message ?? e).includes('UNIQUE')) return 'email_taken';
        throw e;
      }
      return row as any;
    },
    async updateUser(scope, id, patch, now) {
      await db.update(users)
        .set({ ...(patch.role ? { role: patch.role } : {}), ...(patch.displayName ? { displayName: patch.displayName } : {}), updatedAt: now })
        .where(and(eq(users.id, id), eq(users.organizationId, scope.organizationId))).run();
      return this.getUser(scope, id);
    },
    async countAdmins(scope) {
      const [r] = await db.select({ n: count() }).from(users)
        .where(and(eq(users.organizationId, scope.organizationId), eq(users.role, 'admin')));
      return r?.n ?? 0;
    },
    async setUserPassword(scope, userId, passwordHash, now) {
      await db.update(users).set({ passwordHash, updatedAt: now })
        .where(and(eq(users.id, userId), eq(users.organizationId, scope.organizationId))).run();
    },
    async touchLastLogin(scope, userId, now) {
      await db.update(users).set({ lastLoginAt: now })
        .where(and(eq(users.id, userId), eq(users.organizationId, scope.organizationId))).run();
    },
    async createSession(row: SessionRow) { await db.insert(sessions).values(row).run(); },
    async getSession(id) {
      const [s] = await db.select().from(sessions).where(eq(sessions.id, id));
      return s ?? null;
    },
    async deleteSession(id) { await db.delete(sessions).where(eq(sessions.id, id)).run(); },
    async deleteUserSessions(userId, exceptSessionId) {
      const cond = exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
        : eq(sessions.userId, userId);
      await db.delete(sessions).where(cond).run();
    },
    async listProjects(scope) {
      const rows = await db
        .select({
          project: projects,
          testcaseCount: sql<number>`(SELECT COUNT(*) FROM ${testCases} tc WHERE tc.project_id = ${projects.id} AND tc.status != 'archived')`,
        })
        .from(projects).where(eq(projects.organizationId, scope.organizationId)).orderBy(projects.createdAt);
      return rows.map((r: any) => ({ ...r.project, testcaseCount: Number(r.testcaseCount) }));
    },
    async getProject(scope, pid) {
      const [p] = await db.select().from(projects)
        .where(and(eq(projects.id, pid), eq(projects.organizationId, scope.organizationId)));
      return p ?? null;
    },
    async createProject(scope, p, now) {
      const row = { id: uuid(), organizationId: scope.organizationId, name: p.name, repoUrl: p.repoUrl ?? null, createdAt: now, updatedAt: now };
      await db.insert(projects).values(row).run();
      return row as any;
    },
    async updateProject(scope, pid, patch, now) {
      await db.update(projects)
        .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}), updatedAt: now })
        .where(and(eq(projects.id, pid), eq(projects.organizationId, scope.organizationId))).run();
      return this.getProject(scope, pid);
    },
    async createApiToken(scope, pid, name, tokenHash, now) {
      const row = { id: uuid(), projectId: pid, tokenHash, name, lastUsedAt: null, createdAt: now, revokedAt: null };
      await db.insert(apiTokens).values(row).run();
      return row as any;
    },
    async listApiTokens(scope, pid) {
      return db.select().from(apiTokens).where(eq(apiTokens.projectId, pid)).orderBy(apiTokens.createdAt);
    },
    async revokeApiToken(scope, pid, tokenId, now) {
      await db.update(apiTokens).set({ revokedAt: now })
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.projectId, pid), isNull(apiTokens.revokedAt))).run();
      const [row] = await db.select().from(apiTokens)
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.projectId, pid)));
      return row ?? null;
    },
    async findApiTokenByHash(tokenHash) {
      const [r] = await db
        .select({ token: apiTokens, organizationId: projects.organizationId })
        .from(apiTokens)
        .innerJoin(projects, eq(projects.id, apiTokens.projectId))
        .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)));
      return r ? { ...r.token, organizationId: r.organizationId } : null;
    },
    async touchTokenLastUsed(tokenId, now, thresholdMs) {
      await db.update(apiTokens).set({ lastUsedAt: now })
        .where(and(
          eq(apiTokens.id, tokenId),
          sql`(${apiTokens.lastUsedAt} IS NULL OR ${apiTokens.lastUsedAt} <= ${now - thresholdMs})`,
        )).run();
    },
  } satisfies Storage;
}
```

注: `getUser` / `listApiTokens` 等の project 系メソッドは pid の org 所属を**呼び出し側ミドルウェア**(Task 7 の scope resolver)が事前検証する契約。Storage 側は scope 引数を必ず受け取り org 条件を適用できる形を保つ(GC-5)。

```ts
// src/storage/adapters/better-sqlite3.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createDrizzleStorage, type AnyQuery } from '../drizzle-storage';
import { migrationStatements } from '../../../tests/helpers/apply-migrations-node';

export function createBetterSqlite3Storage(path = ':memory:') {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // operations.md §4.3: auto_vacuum はテーブル作成前(空DB時)に設定
  if ((sqlite.pragma('page_count', { simple: true }) as number) <= 1) {
    sqlite.pragma('auto_vacuum = INCREMENTAL');
  }
  for (const stmt of migrationStatements()) sqlite.exec(stmt);
  const db = drizzle(sqlite);
  const storage = createDrizzleStorage({
    db,
    async batch(queries: AnyQuery[]) {
      sqlite.transaction(() => { for (const q of queries) q.run(); })();
    },
    async rawExec(sqlText: string) { sqlite.exec(sqlText); },
  });
  return { storage, rawExec: async (s: string) => sqlite.exec(s), sqlite };
}
```

実装後に `migrationStatements` を `src/storage/migrations-loader.ts` に移し、tests/helpers はそれを re-export する形に整理する(src から tests への import を残さないため)。

- [ ] **Step 5: `npm run test:unit` PASS(契約テスト 8件 × better-sqlite3)、`npm run typecheck` エラー0**

- [ ] **Step 6: docs との整合確認(トークン照合述語・間引き更新・テナント境界が auth-security.md / data-model.md の記述どおりか)後、コミット**

```bash
git add src/storage tests/contract tests/helpers && git commit -m "feat: storage interface + shared drizzle impl + better-sqlite3 adapter with contract tests"
```

### Task 5: D1 / libSQL アダプタ(契約テスト横展開)

**Files:**
- Create: `src/storage/adapters/d1.ts`, `src/storage/adapters/libsql.ts`
- Test: `tests/contract/d1.test.ts`(workers pool), `tests/contract/libsql.test.ts`(node pool)

**Interfaces:**
- Consumes: Task 4 の `createDrizzleStorage` / `runStorageContract`
- Produces: `createD1Storage(d1: D1Database): { storage: Storage; rawExec }`、`createLibsqlStorage(url?: string): Promise<{ storage: Storage; rawExec }>`

**Docs:** `docs/operations.md` §1.3(3アダプタ同一スイート)・§6.2(環境固有 PRAGMA の隔離)、`docs/architecture.md`「ポータビリティ境界」

- [ ] **Step 1: 2本のランナーテストを書く(失敗確認)**

```ts
// tests/contract/d1.test.ts
import { env } from 'cloudflare:test';
import { runStorageContract } from './storage-contract';
import { createD1Storage } from '../../src/storage/adapters/d1';
runStorageContract('d1', async () => createD1Storage(env.DB)); // マイグレーションは setup-migrations.ts が適用済み
```

```ts
// tests/contract/libsql.test.ts
import { runStorageContract } from './storage-contract';
import { createLibsqlStorage } from '../../src/storage/adapters/libsql';
runStorageContract('libsql', async () => createLibsqlStorage(':memory:'));
```

- [ ] **Step 2: アダプタを実装**

```ts
// src/storage/adapters/d1.ts
import { drizzle } from 'drizzle-orm/d1';
import { createDrizzleStorage, type AnyQuery } from '../drizzle-storage';

export function createD1Storage(d1: D1Database) {
  const db = drizzle(d1);
  const storage = createDrizzleStorage({
    db,
    async batch(queries: AnyQuery[]) {
      if (queries.length === 0) return;
      await (db as any).batch(queries); // D1: batch = 単一トランザクション(sync-protocol.md「原子性の保証」)
    },
    async rawExec(sqlText: string) { await d1.exec(sqlText); },
  });
  return { storage, rawExec: (s: string) => d1.exec(s).then(() => undefined) };
}
```

```ts
// src/storage/adapters/libsql.ts
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { createDrizzleStorage, type AnyQuery } from '../drizzle-storage';
import { migrationStatements } from '../migrations-loader';

export async function createLibsqlStorage(url = ':memory:') {
  const client = createClient({ url: url === ':memory:' ? ':memory:' : `file:${url}` });
  for (const stmt of migrationStatements()) {
    const trimmed = stmt.trim();
    if (trimmed) await client.executeMultiple(trimmed);
  }
  const db = drizzle(client);
  const storage = createDrizzleStorage({
    db,
    async batch(queries: AnyQuery[]) {
      if (queries.length === 0) return;
      await (db as any).batch(queries);
    },
    async rawExec(sqlText: string) { await client.executeMultiple(sqlText); },
  });
  return { storage, rawExec: (s: string) => client.executeMultiple(s).then(() => undefined) };
}
```

- [ ] **Step 3: `npm test`(unit + workers 両方)で契約スイートが 3 アダプタ全てで PASS することを確認**

Run: `npm test`
Expected: `Storage contract: better-sqlite3` / `libsql`(node pool)、`Storage contract: d1`(workers pool)が全件 PASS。**`UPDATE...LIMIT` テストが libSQL で失敗した場合は operations.md §1.3 の想定どおりの検知**なので、報告して指示を仰ぐ(黙って skip しない)

- [ ] **Step 4: コミット**

```bash
git add src/storage/adapters tests/contract && git commit -m "feat: d1 + libsql storage adapters passing shared contract suite"
```

---

### Task 6: 認証プリミティブ(auth/)

**Files:**
- Create: `src/auth/interface.ts`, `src/auth/password.ts`, `src/auth/session-sign.ts`, `src/auth/token.ts`, `src/auth/webcrypto-auth.ts`
- Test: `tests/unit/auth-password.test.ts`, `tests/unit/auth-session-sign.test.ts`, `tests/unit/auth-token.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Auth {
    hashPassword(plain: string): Promise<string>;              // PHC string
    verifyPassword(plain: string, phc: string): Promise<{ ok: boolean; needsRehash: boolean }>;
    newSessionId(): string;                                     // 32B ランダム(base64url)
    signSessionId(id: string): Promise<string>;                 // "<keyId>.<id>.<sig>"
    verifySignedSessionId(value: string): Promise<string | null>;
    newApiToken(): string;                                      // "tms_" + base64url(32B)
    hashApiToken(plain: string): Promise<string>;               // hex(SHA-256)
    newCsrfToken(): string;                                     // 32B base64url
  }
  createWebcryptoAuth(cfg: { signingKeys: Record<string, string>; activeKeyId: string; pbkdf2Iterations?: number }): Auth
  ```
- Consumes: なし(WebCrypto のみ。Workers / Node 20+ 両対応)

**Docs:** `docs/auth-security.md`(PHC 形式・PBKDF2 600k・署名鍵の keyId ローテーション・トークン生成仕様)、`docs/data-model.md`「パスワードハッシュ仕様」「セッション管理の不変条件」

**実装ノート:**
- PHC 形式は `$pbkdf2-sha256$i=<iter>$<salt-b64>$<hash-b64>`。verify はプレフィックスで dispatch し、未知形式は `{ok:false}`。`needsRehash` は iter が現行設定未満のとき true(透過再ハッシュは呼び出し側 = Task 8 のログイン処理が行う)
- 署名は HMAC-SHA256。`signingKeys` は `{"k1": "<secret>"}` 形式の JSON を env `SESSION_SIGNING_KEYS` から読む(Task 7 config)。検証は値中の keyId で鍵を引く(ローテーション対応)
- テストの PBKDF2 は `pbkdf2Iterations: 1000` を注入して高速化(既定は 600_000)
- 比較はすべて定数時間比較(`crypto.subtle.timingSafeEqual` は無いので、HMAC 再計算値同士を比較する方式で実装)

- [ ] **Step 1: 失敗するテストを書く**(hash→verify 往復 / 誤パスワード否認 / iter=999 で needsRehash / 署名往復 / 改竄・未知 keyId で null / `tms_` プレフィックスとハッシュの hex64 桁)

```ts
// tests/unit/auth-password.test.ts(要点)
const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
it('round-trip', async () => {
  const phc = await auth.hashPassword('correct horse');
  expect(phc.startsWith('$pbkdf2-sha256$i=1000$')).toBe(true);
  expect((await auth.verifyPassword('correct horse', phc)).ok).toBe(true);
  expect((await auth.verifyPassword('wrong', phc)).ok).toBe(false);
});
it('needsRehash: 旧 iter を検知', async () => {
  const old = createWebcryptoAuth({ signingKeys: { k1: 's' }, activeKeyId: 'k1', pbkdf2Iterations: 500 });
  const phc = await old.hashPassword('pw');
  expect((await auth.verifyPassword('pw', phc)).needsRehash).toBe(true);
});
// auth-session-sign.test.ts: sign→verify 往復 / 署名改竄→null / 未知 keyId→null / 別鍵で検証(ローテーション)
// auth-token.test.ts: newApiToken が /^tms_[A-Za-z0-9_-]{43,}$/ / hashApiToken が同一入力で同一 hex64
```

- [ ] **Step 2: FAIL 確認 → 実装 → PASS 確認**(`npm run test:unit`)

- [ ] **Step 3: docs 整合確認(PHC 形式・イテレーション数・ソルト 16B・トークン 32B/base64url/プレフィックスが auth-security.md と一致)後、コミット**

```bash
git add src/auth tests/unit && git commit -m "feat: auth primitives (pbkdf2 phc, signed session ids, api tokens)"
```

### Task 7: HTTP 基盤(config・統一エラー・認証/RBAC/スコープ/CSRF ミドルウェア・レートリミッタ)

**Files:**
- Create: `src/http/config.ts`, `src/http/errors.ts`, `src/http/app.ts`, `src/http/middleware/error.ts`, `src/http/middleware/authn.ts`, `src/http/middleware/scope.ts`, `src/http/middleware/csrf.ts`, `src/ratelimit/interface.ts`, `src/ratelimit/memory.ts`
- Modify: `src/schemas/errors.ts`(`'INTERNAL'` を ERROR_CODES に追加。予期しない 500 用)
- Test: `tests/unit/middleware-authn.test.ts`, `tests/unit/middleware-csrf.test.ts`, `tests/unit/ratelimit.test.ts`

**Interfaces:**
- Consumes: Task 4/6 の `Storage` / `Auth`
- Produces(後続の全ルートが使う):
  ```ts
  // src/http/config.ts
  interface AppConfig {
    sessionTtlMs: number;              // env SESSION_TTL_MS 既定 604800000(D-08: 7日)
    signingKeys: Record<string, string>; activeKeyId: string;  // env SESSION_SIGNING_KEYS = {"k1":"secret"}(JSON)
    pbkdf2Iterations: number;          // 既定 600000
    loginRateLimit: { windowMs: number; max: number };   // D-14: 900000 / 5
    syncRateLimit: { windowMs: number; max: number };    // D-14: 60000 / 120
    observationRetentionMs: number;    // 既定 90日
    identityTtlMs: number;             // rollup TTL 既定 90日
  }
  function loadConfig(env: Record<string, string | undefined>): AppConfig
  // 開発時フォールバック: SESSION_SIGNING_KEYS 未設定なら {"dev":"dev-insecure-key"} を使い console.warn

  // src/http/errors.ts
  class AppError extends Error { constructor(code: ErrorCode, status: number, message: string, details?: unknown, retryable?: boolean) }

  // src/http/app.ts
  interface AppDeps {
    storage: Storage; auth: Auth; config: AppConfig;
    loginLimiter: RateLimiter; syncLimiter: RateLimiter; now(): number;
  }
  type Actor =
    | { kind: 'user'; user: UserRow; sessionId: string }
    | { kind: 'token'; token: ApiTokenRow & { organizationId: string } };
  type AppEnv = { Variables: { deps: AppDeps; actor: Actor; project: ProjectRow } };
  function createApp(deps: AppDeps): Hono<AppEnv>   // onError/notFound/静的以外の全ルートを組み立てる(各 Task で追記)
  const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 } as const;

  // src/http/middleware/authn.ts
  function requireAuth(opts: { modes: Array<'session' | 'token'>; minRole?: Role }): MiddlewareHandler<AppEnv>
  // src/http/middleware/scope.ts
  function resolveProject(): MiddlewareHandler<AppEnv>  // :pid → c.set('project', row)
  // src/http/middleware/csrf.ts
  function csrfProtect(): MiddlewareHandler<AppEnv>
  const SESSION_COOKIE = 'session'; const CSRF_COOKIE = 'csrf';
  function sessionCookieHeader(value: string): string  // `session=...; HttpOnly; Secure; SameSite=Lax; Path=/`

  // src/ratelimit/interface.ts
  interface RateLimiter { limit(key: string, opts?: { consume?: boolean }): Promise<{ allowed: boolean; retryAfterSec?: number }> }
  // src/ratelimit/memory.ts
  function createMemoryRateLimiter(cfg: { windowMs: number; max: number }): RateLimiter
  ```

**Docs:** `docs/auth-security.md`(三段AND・能力マトリクス・RBAC 表・IDOR 404/403・CSRF)、`docs/api-reference.md`(統一エラースキーマ・安定コード)、スペック D-08/D-09/D-14

**振る舞い仕様(テストがこのまま検証する):**

| ケース | 結果 |
|---|---|
| Cookie なし / 署名不正 / DB に無い / `expires_at <= now` | 401 `UNAUTHORIZED`(失効セッションは行削除) |
| Bearer 不正 / 失効済みトークン | 401 `UNAUTHORIZED` |
| **有効な** token だが modes に token が無い(UI 専用ルート等) | 403 `FORBIDDEN`(能力マトリクスの「禁止 → 403」) |
| session actor だが modes が token のみ | 401 `UNAUTHORIZED` |
| role 不足(viewer が editor ルート) | 403 `FORBIDDEN` |
| token actor の役割チェック | token に role は無い。`modes:['token']` を含むルートのみ到達可(auth-security 能力マトリクス) |
| session actor: `:pid` が自 org に無い | 404 `NOT_FOUND`(存在隠蔽) |
| token actor: `token.projectId !== :pid` | 403 `CROSS_TENANT`(sync-protocol.md エラー表) |
| POST/PATCH/DELETE で session actor が CSRF 不一致/欠落 | 403 `FORBIDDEN`。token actor は対象外(D-09) |
| AppError | `{error:{code,message,details,retryable}}` で該当 status |
| ZodError(zValidator hook 経由) | 422 `VALIDATION_FAILED` + `details:[{path,msg}]` |
| 予期しない例外 | 500 `INTERNAL`(メッセージは"internal error"固定・詳細はログのみ) |

- [ ] **Step 1: 失敗するテストを書く**(tiny Hono app に requireAuth/resolveProject/csrfProtect を装着し、better-sqlite3 storage + 実 Auth で上の表を1行ずつ検証。ratelimit は fake clock で window/max/retryAfter を検証)

```ts
// tests/unit/middleware-authn.test.ts(骨子 — 表の全行をテストにする)
import { Hono } from 'hono';
import { createBetterSqlite3Storage } from '../../src/storage/adapters/better-sqlite3';
import { createWebcryptoAuth } from '../../src/auth/webcrypto-auth';
import { requireAuth } from '../../src/http/middleware/authn';
import { resolveProject } from '../../src/http/middleware/scope';
import { errorMiddleware } from '../../src/http/middleware/error';

const auth = createWebcryptoAuth({ signingKeys: { k1: 's' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
async function makeCtx() {
  const { storage } = createBetterSqlite3Storage(':memory:');
  const now = 1_700_000_000_000;
  const deps = { storage, auth, now: () => now, config: testConfig(), loginLimiter: allowAll(), syncLimiter: allowAll() };
  const app = new Hono<any>();
  app.use('*', async (c, next) => { c.set('deps', deps); await next(); });
  app.onError(errorMiddleware);
  app.get('/whoami', requireAuth({ modes: ['session'], minRole: 'viewer' }), (c) => c.json({ id: (c.get('actor') as any).user.id }));
  app.get('/p/:pid/x', requireAuth({ modes: ['session', 'token'], minRole: 'viewer' }), resolveProject(), (c) => c.json({ pid: (c.get('project') as any).id }));
  app.post('/admin-only', requireAuth({ modes: ['session'], minRole: 'admin' }), (c) => c.json({ ok: true }));
  return { app, storage, deps, now };
}
// …セットアップ→セッション行を直接 createSession で作成→署名 Cookie を組み立てて fetch、表の各行を assert
```

- [ ] **Step 2: FAIL 確認 → 実装**

実装の要点(コードで示す):

```ts
// src/http/middleware/error.ts
import type { Context } from 'hono';
import { AppError } from '../errors';
export function errorMiddleware(err: unknown, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? undefined, retryable: err.retryable } }, err.status as any);
  }
  console.error(JSON.stringify({ level: 'error', msg: String(err), stack: (err as Error)?.stack }));
  return c.json({ error: { code: 'INTERNAL', message: 'internal error', retryable: true } }, 500);
}
// zValidator 用 hook(各ルートで使用):
export const zodHook = (result: any, c: Context) => {
  if (!result.success) {
    const details = result.error.issues.map((i: any) => ({ path: i.path.join('.'), msg: i.message }));
    throw new AppError('VALIDATION_FAILED', 422, 'validation failed', details);
  }
};
```

```ts
// src/http/middleware/authn.ts(骨子)
export function requireAuth(opts: { modes: Array<'session' | 'token'>; minRole?: Role }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (bearer) {
      const hash = await deps.auth.hashApiToken(bearer);
      const token = await deps.storage.findApiTokenByHash(hash); // 失効は述語内包
      if (!token) throw new AppError('UNAUTHORIZED', 401, 'invalid token');
      // 認証は有効 → ルートが token を許可しないなら「禁止」= 403(能力マトリクス)
      if (!opts.modes.includes('token')) throw new AppError('FORBIDDEN', 403, 'token not allowed for this route');
      await deps.storage.touchTokenLastUsed(token.id, deps.now(), 60_000); // best-effort
      c.set('actor', { kind: 'token', token });
      return next();
    }
    if (!opts.modes.includes('session')) throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const raw = getCookie(c, SESSION_COOKIE);
    const sid = raw ? await deps.auth.verifySignedSessionId(raw) : null;   // 1) 署名
    const session = sid ? await deps.storage.getSession(sid) : null;      // 2) DB 存在
    if (!session) throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    if (session.expiresAt <= deps.now()) {                                // 3) 未失効
      await deps.storage.deleteSession(session.id);
      throw new AppError('UNAUTHORIZED', 401, 'session expired');
    }
    const user = await deps.storage.getUserById(session.userId);          // org 不問の内部取得(下記ノート)
    if (!user) throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    if (opts.minRole && ROLE_RANK[user.role as Role] < ROLE_RANK[opts.minRole]) {
      throw new AppError('FORBIDDEN', 403, 'insufficient role');
    }
    c.set('actor', { kind: 'user', user, sessionId: session.id });
    await next();
  };
}
```

ノート: セッション→ユーザー解決は org が判明する前なので、Storage に内部用 `getUserById(id)`(scope なし・authn 専用)を1つ追加する。追加時は interface.ts の JSDoc に「authn ミドルウェア専用。API ハンドラでは使用禁止(GC-5)」と明記し、契約テストにも1ケース足す。

```ts
// src/http/middleware/scope.ts(骨子)
export function resolveProject(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    const pid = c.req.param('pid');
    if (actor.kind === 'token') {
      if (actor.token.projectId !== pid) throw new AppError('CROSS_TENANT', 403, 'project scope mismatch');
      const project = await deps.storage.getProject({ organizationId: actor.token.organizationId }, pid);
      if (!project) throw new AppError('CROSS_TENANT', 403, 'project scope mismatch');
      c.set('project', project);
    } else {
      const project = await deps.storage.getProject({ organizationId: actor.user.organizationId }, pid);
      if (!project) throw new AppError('NOT_FOUND', 404, 'not found'); // 存在隠蔽
      c.set('project', project);
    }
    await next();
  };
}
// orgScope ヘルパ(全ハンドラが使用): actor から {organizationId} を得る
export function orgScopeOf(actor: Actor): OrgScope { … }
```

```ts
// src/http/middleware/csrf.ts(骨子)— D-09
export function csrfProtect(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (actor?.kind === 'user' && ['POST', 'PATCH', 'DELETE', 'PUT'].includes(c.req.method)) {
      const cookie = getCookie(c, CSRF_COOKIE);
      let submitted = c.req.header('x-csrf-token');
      if (!submitted) {
        const ct = c.req.header('content-type') ?? '';
        if (ct.includes('form')) submitted = (await c.req.parseBody())['_csrf'] as string | undefined;
      }
      if (!cookie || !submitted || cookie !== submitted) throw new AppError('FORBIDDEN', 403, 'csrf token mismatch');
    }
    await next();
  };
}
```

```ts
// src/ratelimit/memory.ts
export function createMemoryRateLimiter(cfg: { windowMs: number; max: number }, clock: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { resetAt: number; count: number }>();
  return {
    async limit(key, opts = {}) {
      const now = clock();
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) { b = { resetAt: now + cfg.windowMs, count: 0 }; buckets.set(key, b); }
      if (b.count >= cfg.max) return { allowed: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
      if (opts.consume !== false) b.count += 1;
      return { allowed: true };
    },
  };
}
```

`createApp(deps)` は `deps` 注入ミドルウェア → `/api/v1` ルート群(以後のタスクで追記)→ onError/notFound を組み立てる。CF の Rate Limiting binding アダプタは作らない(D-14 の 15 分窓は binding の固定窓(10s/60s)で表現できないため、全環境でメモリ実装を使う。best-effort 位置づけは auth-security.md と整合。この判断をタスク報告に記載)。

- [ ] **Step 3: `npm run test:unit` PASS / typecheck 0 → docs 整合確認(能力マトリクス・エラー表と1行ずつ突合)→ コミット**

```bash
git add src/http src/ratelimit src/schemas/errors.ts src/storage tests/unit && git commit -m "feat: http foundation (config, unified errors, authn/rbac/scope/csrf, rate limiter)"
```

### Task 8: セットアップ API + 認証 API(+ 統合テストハーネス)

**Files:**
- Create: `src/http/api/setup.ts`, `src/http/api/auth.ts`, `src/http/api/serializers.ts`, `tests/integration/helpers.ts`
- Modify: `src/http/app.ts`(ルート登録)
- Test: `tests/integration/auth.test.ts`

**Interfaces:**
- Consumes: Task 7 の全ミドルウェア・`AppDeps`
- Produces:
  - ルート: `POST /api/v1/setup`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`, `PATCH /api/v1/auth/password`
  - `serializers.ts`: `toUserJson(row): { id, email, display_name, role, created_at, updated_at, last_login_at }`、`toOrganizationJson(row)`(以後のタスクでシリアライザを追記していく)
  - テストハーネス: `makeTestApp()`(D1 storage + 固定クロック + iter=1000 の Auth + メモリリミッタで `createApp` を構築。`setNow/advance` 付き)、`wipe(rawExec)`、`cookiesFrom(res)/cookieHeader(jar)`、`setupAndLogin(app)`(setup→login して `{ jar, csrf, user }` を返す)、`loginAs(app, email, password)`

**Docs:** `docs/apis/setup.md`(前提条件・409)、`docs/apis/auth.md`(全エンドポイントの入出力・副作用)、`docs/auth-security.md`(セッション不変条件・ブルートフォース防御)、スペック D-05(last_login_at)/D-08/D-09/D-14

**振る舞い(docs の当該ページと1:1。統合テストで全行検証):**

| ルート | 要点 |
|---|---|
| POST /setup | Organization 0件時のみ。既存なら 409 `SETUP_ALREADY_COMPLETE`。org+admin 同時作成、201 で `{organization, user}`。認証不要。(並行 setup の競合窓は単一デプロイ操作なので許容 — コードコメントに明記) |
| POST /auth/login | 認証不要。`loginLimiter` を key=`login:<email>:<ip>`(ip は `CF-Connecting-IP` ?? `'local'`)で **consume:false チェック** → 超過なら 429 + `Retry-After`。認証失敗時のみ consume。成功時: needsRehash なら透過再ハッシュ保存 → `touchLastLogin` → セッション新規発行(ID 再発行 = 固定攻撃対策)→ `Set-Cookie: session=<signed>` と `csrf=<token>`(共に `HttpOnly; Secure; SameSite=Lax; Path=/`)→ 200 `{user}`。失敗は存在有無を漏らさない統一 401 |
| POST /auth/logout | session 必須 + CSRF。セッション行削除、両 Cookie を Max-Age=0 で削除、204 |
| GET /auth/me | session 必須。`{id, email, display_name, role, organization_id}` |
| PATCH /auth/password | session 必須 + CSRF。現在 PW 不一致 → 401。成功: 新ハッシュ保存 + **自セッション以外を全削除** + 200 `{message:"password_changed"}` |

- [ ] **Step 1: `tests/integration/helpers.ts` とテストを書く(FAIL 確認)**

テストケース一覧(それぞれ独立の it として実装):
1. setup 201 → 2回目 409 / パスワード7文字は 422(details に path)
2. login 成功で session+csrf の Set-Cookie 2本(属性込み)と user JSON / `users.last_login_at` が更新される(storage 直読で確認)
3. 誤パスワード・未知 email はどちらも同一形状の 401
4. 誤パスワード5回 → 6回目は 429 + Retry-After ヘッダ / **正しいパスワードの試行は consume しない**(4回失敗→成功→失敗でまだ 429 にならない)
5. me: Cookie なし 401 / あり 200
6. logout 204 → 直後の me 401
7. password 変更: current 不一致 401 / 成功後、**他セッションは 401・自セッションは 200**、旧 PW で login 不可・新 PW で可
8. CSRF: `x-csrf-token` 無しの PATCH /auth/password → 403(token 認証には不要である検証は Task 11 の sync 系で実施)

- [ ] **Step 2: 実装(ルート+シリアライザ+app.ts 登録)**

```ts
// src/http/api/auth.ts(login の骨子)
export const authRoutes = new Hono<AppEnv>()
  .post('/login', zValidator('json', loginInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const { email, password } = c.req.valid('json');
    const ip = c.req.header('cf-connecting-ip') ?? 'local';
    const key = `login:${email}:${ip}`;
    const gate = await deps.loginLimiter.limit(key, { consume: false });
    if (!gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSec ?? 60));
      throw new AppError('RATE_LIMITED', 429, 'too many attempts', undefined, true);
    }
    const user = await deps.storage.findUserForLogin(email);
    const result = user?.passwordHash ? await deps.auth.verifyPassword(password, user.passwordHash) : { ok: false, needsRehash: false };
    if (!user || !result.ok) {
      await deps.loginLimiter.limit(key); // 失敗のみ consume(D-14)
      console.warn(JSON.stringify({ event: 'auth_failure', email, ip, at: deps.now() })); // D-11 構造化ログ
      throw new AppError('UNAUTHORIZED', 401, 'invalid email or password');
    }
    const scope = { organizationId: user.organizationId };
    if (result.needsRehash) await deps.storage.setUserPassword(scope, user.id, await deps.auth.hashPassword(password), deps.now());
    await deps.storage.touchLastLogin(scope, user.id, deps.now());
    const sid = deps.auth.newSessionId();
    await deps.storage.createSession({ id: sid, userId: user.id, expiresAt: deps.now() + deps.config.sessionTtlMs, createdAt: deps.now() });
    setCookie(c, SESSION_COOKIE, await deps.auth.signSessionId(sid), COOKIE_ATTRS);
    setCookie(c, CSRF_COOKIE, deps.auth.newCsrfToken(), COOKIE_ATTRS);
    return c.json({ user: toUserJson(user) });
  });
// logout / me / password は同パターン。password 変更は deleteUserSessions(user.id, actor.sessionId)
```

- [ ] **Step 3: `npm run test:workers` PASS / typecheck 0**

- [ ] **Step 4: apis/setup.md・apis/auth.md と応答フィールド名を1つずつ突合(整合確認)し、コミット**

```bash
git add src/http tests/integration && git commit -m "feat: setup + auth apis (login rate limit, session issuance, csrf, password change)"
```

---

### Task 9: ユーザー管理 API

**Files:**
- Create: `src/http/api/users.ts`
- Modify: `src/http/app.ts`(登録), `src/http/api/serializers.ts`
- Test: `tests/integration/users.test.ts`

**Interfaces:**
- Consumes: Task 7/8 の全部品
- Produces: `GET/POST /api/v1/users`, `GET/PATCH /api/v1/users/:id`, `POST /api/v1/users/:id/reset-password`(すべて `requireAuth({modes:['session'], minRole:'admin'})` + csrfProtect)

**Docs:** `docs/apis/users.md`(全入出力・副作用)、`docs/screens/admin/S-18-user-list.md` / `S-19-user-create-edit.md`(UI が期待するフィールド)、スペック D-05(last_login_at)/D-13-7(最後の admin 保護)

**振る舞い:**
- 一覧は `{items:[...]}`。各 item に `last_login_at`(null 可)を含む(D-05)
- POST: email 重複(Storage が `'email_taken'`)→ 422 `VALIDATION_FAILED`(details: `[{path:'email', msg:'already exists'}]`)
- PATCH: role 変更時は対象ユーザーの**全**セッション削除(except なし)。**最後の admin の降格は 422**(message: `"cannot demote the last admin"`)(D-13-7)
- reset-password: 対象の全セッション削除 + 200 `{message:"password_reset"}`。パスワードポリシー適用(D-06)
- 他 org のユーザー ID への GET/PATCH → 404(存在隠蔽)

- [ ] **Step 1: 統合テストを書く(FAIL)** — ケース: admin 一覧に last_login_at / editor での GET /users → 403 / 作成→そのユーザーで login 可 / email 重複 422 / role 変更で対象の既存セッション 401 化 / **admin が1人の状態で自分を editor に PATCH → 422** / admin 2人なら降格可 / reset-password 後に旧 PW 不可・対象セッション無効 / 他 org ユーザー 404
- [ ] **Step 2: 実装(users.ts は zValidator + serializers + AppError のみで構成。ロジックは Storage 呼び出しと上記ガード)**
- [ ] **Step 3: `npm run test:workers` PASS / typecheck 0**
- [ ] **Step 4: apis/users.md と突合(特に PATCH の副作用文言)後、コミット**

```bash
git add src/http tests/integration && git commit -m "feat: user management api (last-admin guard, session invalidation)"
```

### Task 10: プロジェクト API

**Files:**
- Create: `src/http/api/projects.ts`
- Modify: `src/http/app.ts`, `src/http/api/serializers.ts`(`toProjectJson(row, testcaseCount?)`)
- Test: `tests/integration/projects.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/projects`(viewer↑・session)、`POST /api/v1/projects`(admin・session+CSRF)、`PATCH /api/v1/projects/:pid`(admin・session+CSRF・`resolveProject()` 使用)
- テストヘルパ追記: `createProject(app, adminCtx, name)`(以後のタスクが使う)

**Docs:** `docs/apis/projects.md`、`docs/screens/main/S-06-project-list.md`(testcase_count の用途)、スペック D-05

**振る舞い:**
- 一覧: `{items:[{id,name,repo_url,testcase_count,created_at,updated_at}]}`(作成日昇順)。**`testcase_count` は非 archived 件数**(D-05)
- POST: 201。PATCH: PATCH セマンティクス(`repo_url: null` でクリア)、200
- editor/viewer の POST/PATCH → 403 `FORBIDDEN`。他 org の :pid → 404

- [ ] **Step 1: 統合テスト(FAIL)** — 一覧空 `{items:[]}` / 作成→一覧に testcase_count=0 / repo_url null クリア / editor 403 / 不正 URL 422 / 他 org 404(2つ目の org を setupOrganization で直接作って検証)
- [ ] **Step 2: 実装 → PASS / typecheck 0**
- [ ] **Step 3: apis/projects.md と突合後、コミット**

```bash
git add src/http tests/integration && git commit -m "feat: projects api with testcase_count"
```

---

### Task 11: API トークン管理 API + トークン認証の疎通

**Files:**
- Create: `src/http/api/tokens.ts`
- Modify: `src/http/app.ts`, `src/http/api/serializers.ts`(`toTokenJson(row)` — token_hash は**絶対に**含めない)
- Test: `tests/integration/tokens.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/projects/:pid/tokens`、`GET /api/v1/projects/:pid/tokens`、`DELETE /api/v1/projects/:pid/tokens/:id`(全て admin・session+CSRF・resolveProject)
- テストヘルパ追記: `issueToken(app, adminCtx, pid, name): Promise<string>`(平文を返す。同期プロトコルのテストで使用)

**Docs:** `docs/apis/tokens.md`(発行1回限り・Cache-Control)、`docs/auth-security.md`「API トークン認証」「平文の隔離」、`docs/screens/project-settings/S-16-api-token-list.md` / `S-17-token-issue-result.md`

**振る舞い:**
- 発行: 201 `{id,name,token,created_at}` + `Cache-Control: no-store`。`token` は `tms_` プレフィックスの平文でこの応答限り。DB にはハッシュのみ
- 一覧: `{items:[{id,name,created_at,revoked_at,last_used_at}]}` — 平文・ハッシュは決して返さない
- 失効: 200 `{id,name,revoked_at}`。冪等(再実行は最初の revoked_at を返す)
- **トークン認証の疎通確認**: このタスクで `GET /api/v1/projects/:pid/testcases` はまだ無いので、検証用に `GET /api/v1/projects/:pid/tokens` を有効な Bearer で叩き **403 `FORBIDDEN`** になること(トークン管理は session 専用 = 能力マトリクスの「token 管理禁止 → 403」)、および Task 13 実装後に Bearer GET が通ることを確認する旨をテストコメントに明記

- [ ] **Step 1: 統合テスト(FAIL)** — 発行応答に平文+no-store / 一覧に平文が無い / 発行した平文で Bearer 認証すると `findApiTokenByHash` が解決する(storage 直検証)/ 失効後は Bearer 401(認証述語)/ 失効の冪等性 / editor 403 / **有効な Bearer で tokens API に触ると 403**
- [ ] **Step 2: 実装 → PASS / typecheck 0**
- [ ] **Step 3: apis/tokens.md・auth-security.md「平文の隔離」と突合(ログ・エラーに平文が乗らないこと)後、コミット**

```bash
git add src/http tests/integration && git commit -m "feat: api token management (issue-once plaintext, soft revoke)"
```

### Task 12: テストケース ドメインルール(純関数)

**Files:**
- Create: `src/domain/testcase-rules.ts`, `src/domain/history-delta.ts`, `src/domain/gherkin.ts`, `src/domain/diff.ts`, `src/domain/cursor.ts`
- Test: `tests/unit/testcase-rules.test.ts`, `tests/unit/gherkin.test.ts`, `tests/unit/diff-cursor.test.ts`

**Interfaces:**
- Produces(Task 13/14/18/19 が使用):
  ```ts
  const HUMAN_FIELDS = ['title','target','category','given','when','then','parameters','status','confidence','metadata'] as const; // data-model「人間所有列」
  function canTransition(from: Status, to: Status): boolean; // 遷移マトリクス。from===to は true(no-op)
  type FieldChange = { before: unknown; after: unknown };
  function computeHumanPatch(current: TestCaseRow, patch: PatchInput):
    | { ok: true; changes: Record<string, FieldChange>; columnValues: Record<string, unknown>;
        ownershipTransition: boolean; statusChange: { from: Status; to: Status } | null }
    | { ok: false; error: 'invalid_transition' };
  // changes は「実際に値が変わる」フィールドのみ(同値は含めない)。PATCH セマンティクス(undefined=不変 / null=クリア)適用済み。
  // ownershipTransition = current.ownership==='machine' && changes が1つ以上(不可逆 machine→human。data-model)
  function applyBulkAction(row: TestCaseRow, action: BulkAction):
    | { kind: 'update'; newStatus: Status; ownershipTransition: boolean }
    | { kind: 'skip' }                        // 既に対象状態 / restore対象外
    | { kind: 'error'; code: 'VALIDATION_FAILED'; message: string }; // approve on archived(apis/testcases.md)
  function buildHistoryEntries(p: { changes; statusChange; actor: string; now: number }):
    Array<{ action: HistoryAction; delta: Record<string, FieldChange> }>;
  // status 変更 → action='status_changed'(delta は status のみ)、他フィールド変更 → action='updated'。両方あれば2エントリ(UC-21 の履歴例と同形)
  function structuredDiff(canonical: GwtP, observed: GwtP): Record<string, FieldChange>; // given/when/then/parameters の4フィールド。parameters は JSON 等値比較
  function renderGherkin(tc: { title; given; when; then; parameters }): string; // S-13 のレンダリング仕様に一致させる(Examples 表含む)
  function encodeCursor(c: { createdAt: number; id: string }): string; // base64url(JSON)
  function decodeCursor(s: string): { createdAt: number; id: string } | null; // 不正入力は null(=先頭から)
  ```

**Docs:** `docs/data-model.md`「canonical 状態機械」「状態遷移の許可マトリクス」「列の二分」、`docs/apis/testcases.md`(bulk 各アクションの業務ルール・PATCH 副作用)、`docs/screens/testcase/S-13-gherkin-view.md`(表示形式)、`docs/usecase.md` UC-21(履歴の見え方)

- [ ] **Step 1: 失敗するテストを書く** — 最低限:
  - 遷移マトリクス全組合せ(6許可・archived→approved 拒否・同値 no-op 許可)
  - computeHumanPatch: machine 行への実変更で ownershipTransition=true / 同値 PATCH で changes 空・遷移なし / `target:null` でクリアが changes に載る / status 不正遷移で `invalid_transition` / status 変更と title 変更の複合
  - applyBulkAction: approve×(draft→update+ownershipTransition, approved→skip, archived→error) / archive×(draft→update, archived→skip) / restore×(archived→update, draft→skip)
  - buildHistoryEntries: title+status 同時変更 → `updated` と `status_changed` の2エントリ
  - structuredDiff: given/then のみ差分 → 2キー / parameters の順序同一 JSON は差分なし
  - renderGherkin: S-13 の例と一致(parameters ありは Examples 表)
  - cursor: encode→decode 往復 / 壊れた base64 は null
- [ ] **Step 2: FAIL → 実装 → PASS(`npm run test:unit`)/ typecheck 0**
- [ ] **Step 3: data-model の遷移表と1行ずつ突合 → コミット**

```bash
git add src/domain tests/unit && git commit -m "feat: testcase domain rules (transitions, patch semantics, bulk, gherkin, diff, cursor)"
```

---

### Task 13: テストケース Storage 拡張 + 読み取り系 API(作成含む)

**Files:**
- Modify: `src/storage/interface.ts`, `src/storage/drizzle-storage.ts`, `tests/contract/storage-contract.ts`(スイート追記)
- Create: `src/http/api/testcases.ts`
- Modify: `src/http/app.ts`, `src/http/api/serializers.ts`
- Test: `tests/integration/testcases-read.test.ts`

**Interfaces:**
- Produces(Storage 追加分):
  ```ts
  interface TestCaseFilters { status?: Status; category?: Category; ownership?: Ownership; drift?: boolean; isStale?: boolean; target?: string }
  interface Page { cursor?: string; limit: number }
  interface Paged<T> { items: T[]; total: number; nextCursor: string | null; hasMore: boolean }
  createTestCaseManual(scope, pid, row: NewTestCaseColumns, history: NewHistoryEntry, now): Promise<TestCaseRow>; // batch[tc INSERT, history INSERT]
  getTestCase(scope, pid, id): Promise<TestCaseRow | null>;
  listTestCases(scope, pid, f: TestCaseFilters, page: Page): Promise<Paged<TestCaseRow>>;   // total は正確値(D-03)
  listHistory(scope, pid, id, page: Page): Promise<Paged<TestCaseHistoryRow & { actorDisplay: string }>>; // D-04
  ```
- Produces(ルート): `POST /testcases`(editor・session+CSRF)、`GET /testcases`、`GET /testcases/:id`(+`?format=gherkin`)、`GET /testcases/:id/history`(読み取りは viewer・session|token)
- `toTestCaseJson(row)`: JSON 列を parse し、**`updated_at = max(human_updated_at, system_updated_at, created_at)`**(D-05)。一覧 item はドキュメントのフィールド表どおりのサブセット

**Docs:** `docs/apis/testcases.md`(一覧クエリ・全フィールド表・作成の業務ルール)、`docs/api-reference.md`(カーソルページング・コレクション応答)、スペック D-03/D-04/D-05

**実装の要点:**
- 並び順は `created_at DESC, id DESC`。カーソル述語は `(created_at < :c) OR (created_at = :c AND id < :id)`。`next_cursor` は最終アイテムから生成、`has_more` は limit+1 件フェッチで判定、`total` は同フィルタの COUNT
- `target` は `LIKE '%' || :target || '%'`(部分一致)。LIKE メタ文字(`%_`)はエスケープする
- actor_display の解決 SQL(D-04): `LEFT JOIN users u ON h.actor = 'user:' || u.id LEFT JOIN api_tokens t ON h.actor = 'token:' || t.id` → `COALESCE(u.display_name, t.name, h.actor)`
- 手動作成: `ownership='human'`, `created_origin='manual'`, `version=1`, `human_updated_at=now`, `fingerprint=null`(=drift 未評価)。履歴 action は `created`(delta は `{}`)
- ETag: 単体 GET / 作成応答に `ETag: W/"<version>"`
- Bearer(token actor)は同一 project の GET 系のみ許可。POST は session 専用ルート宣言(能力マトリクス)

- [ ] **Step 1: 契約テスト追記(3アダプタで自動再検証)** — create→get 往復 / フィルタ各種(status・ownership・target 部分一致・drift/isStale の 0/1)/ ページング(3件を limit 2 で2ページ・total=3 固定・重複無し)/ 他 project の id は null / actorDisplay が display_name に解決・存在しない actor は生値
- [ ] **Step 2: 統合テスト(FAIL)** — POST 201+ETag+全フィールド / GET 一覧 `{items,total,next_cursor,has_more}` / クエリ `?status=draft&ownership=human&target=Payment` / `?drift=true` / gherkin が text/plain / history に actor_display / viewer は GET 可・POST 403 / **Bearer で GET 可・POST は 403**(能力マトリクス)/ 他 org 404
- [ ] **Step 3: 実装(Storage → ルート)→ 全テスト PASS / typecheck 0**
- [ ] **Step 4: apis/testcases.md のフィールド表と応答 JSON を1列ずつ突合 → コミット**

```bash
git add src/storage src/http tests && git commit -m "feat: testcase storage + read apis (list filters, exact total, cursor paging, history actor_display, gherkin)"
```

### Task 14: テストケース書き込み系 API(OCC・一括・accept-fingerprint・diff/identities/observations)

**Files:**
- Modify: `src/storage/interface.ts`, `src/storage/drizzle-storage.ts`, `tests/contract/storage-contract.ts`(追記), `src/http/api/testcases.ts`, `src/http/api/serializers.ts`
- Create: `tests/integration/testcases-write.test.ts`, `tests/integration/helpers-seed.ts`
- Test: 上記

**Interfaces:**
- Produces(Storage 追加分):
  ```ts
  type PatchResult = { kind: 'ok'; row: TestCaseRow } | { kind: 'conflict' } | { kind: 'not_found' };
  patchTestCase(scope, pid, id, p: {
    expectedVersion: number;
    columnValues: Record<string, unknown>;      // domain.computeHumanPatch の出力
    ownershipTransition: boolean;
    historyEntries: Array<{ action: HistoryAction; delta: object; actor: string }>;
    now: number;
  }): Promise<PatchResult>;
  // 単一 UPDATE: SET …, version=version+1, human_updated_at=:now, ownership=(遷移時 'human')
  //   WHERE id=:id AND project_id=:pid AND version=:expected — 変更行数 0 なら存在確認して conflict/not_found を判別。
  //   history INSERT と同一 batch(machine→human は「同一文・同一トランザクション」= data-model)
  archiveTestCase(scope, pid, id, actor: string, now): Promise<TestCaseRow | null>; // 冪等・OCC なし(D-02)。未archived時のみ UPDATE+history
  bulkAction(scope, pid, ids: string[], action: BulkAction, actor: string, now): Promise<{
    updated: number; skipped: number; errors: Array<{ id: string; code: string; message: string }>;
  }>; // SELECT → domain.applyBulkAction → batch[UPDATE×n, history×n]。OCC なし(apis/testcases.md)
  acceptFingerprint(scope, pid, id, expectedVersion: number, actor: string, now):
    Promise<{ kind: 'ok'; row: TestCaseRow } | { kind: 'conflict' } | { kind: 'no_drift' } | { kind: 'not_found' }>;
  listIdentities(scope, pid, id): Promise<TestCaseIdentityRow[]>;
  listObservations(scope, pid, id, p: { origin?: string; cursor?: string; limit: number }): Promise<Paged<TestCaseObservationRow>>; // committed セッション由来のみ(JOIN sync_sessions.status='committed')
  getLatestCommittedObservation(scope, pid, id): Promise<TestCaseObservationRow | null>; // mirror_origin の最新(diff/accept-fingerprint 用)
  ```
- Produces(ルート): `PATCH /testcases/:id`、`DELETE /testcases/:id`、`POST /testcases/bulk`、`POST /testcases/:id/accept-fingerprint`(editor・session+CSRF)/ `GET /testcases/:id/identities`・`/observations`・`/diff`(viewer・session|token)
- `tests/integration/helpers-seed.ts`: `seedCommittedObservation(rawExec, { pid, testCaseId, externalRef, origin, fingerprint, observed, at })` — committed の sync_sessions 行 + observations 行 + identities 行を **rawExec の INSERT** で直接作る(Task 15 の同期実装に依存せず drift/diff/observations をテストするため)

**Docs:** `docs/apis/testcases.md`(PATCH/bulk/accept-fingerprint/diff の全仕様・エラー表)、`docs/api-reference.md`(OCC・PATCH セマンティクス・If-Match)、`docs/data-model.md`(OCC・履歴不変条件)、スペック D-02

**振る舞い(統合テストで全行検証):**

| ケース | 結果 |
|---|---|
| PATCH に If-Match なし | 428 `PRECONDITION_REQUIRED` |
| If-Match が `"3"` でも `W/"3"` でも受理 | version=3 として比較 |
| version 不一致 | 409 `OCC_CONFLICT` |
| machine 行に実変更 PATCH | ownership が human に遷移・version+1・履歴に updated(+status なら status_changed) |
| 同値 no-op PATCH | 200 現行値・version 不変・ownership 不変・履歴なし |
| status: archived→approved | 422 `VALIDATION_FAILED`(遷移マトリクス違反) |
| DELETE | archive と同義・冪等(2回目も 200)・OCC 不要(D-02) |
| bulk approve: [draft, approved済, archived] | updated=1 / skipped=1 / errors=1(archived) |
| bulk approve で machine 行 | human に遷移(履歴各1件以上) |
| bulk restore: archived → draft | updated。非 archived は skipped |
| accept-fingerprint: drift 行 | 200 `{id, fingerprint(最新観測値), drift:false, version+1, updated_at}`・履歴 `status_changed`(apis/testcases.md の指定どおり) |
| accept-fingerprint: drift なし | 422 `NO_DRIFT` |
| GET diff: drift 行 | `{has_drift:true, origin, observed_at, canonical, latest_observation, diff}`(差分フィールドのみ) |
| GET diff: drift なし | `{has_drift:false, origin:null, observed_at:null, canonical, latest_observation:null, diff:null}` |
| GET observations | committed のみ(seed で active セッション由来を混ぜて除外を検証)・origin フィルタ・ページング |
| GET identities | `{items:[{id,origin,external_ref,is_stale,last_seen_at,created_at}]}` |

- [ ] **Step 1: 契約テスト追記**(patchTestCase の ok/conflict/not_found・archive 冪等・bulk 混在・acceptFingerprint 4分岐・listObservations committed フェンス)→ 3アダプタ FAIL 確認
- [ ] **Step 2: 統合テスト追記(FAIL)** — 上表の全行(drift 系は `seedCommittedObservation` + rawExec で `test_cases.drift=1, fingerprint='old', mirror_origin='discovery-v1'` を直接セットして作る)
- [ ] **Step 3: Storage → ルートの順で実装 → 全 PASS / typecheck 0**
- [ ] **Step 4: apis/testcases.md のエラー表・副作用と1行ずつ突合 → コミット**

```bash
git add src/storage src/http tests && git commit -m "feat: testcase write apis (occ patch, archive alias, bulk, accept-fingerprint, diff)"
```

### Task 15: 同期プロトコル前半(start / chunk・出現台帳)

**⚠ 設計上の重要ノート(実装前に必ず読むこと):**
sync-protocol.md には次の緊張関係がある。(a) chunk は「直前の観測と指紋が異なる時だけ」観測行を作る(変化点のみ記録 = 容量設計の根幹)。(b) commit 工程3/4 は「今回セッションの観測に現れた external_ref」で last_seen / stale を判定する。**変化なしのケースは観測行が作られないため、(b) をそのまま実装すると毎回 stale に誤判定される。**
本計画はこれを **出現台帳 `sync_seen`(sync_token, external_ref の2列・一意)** で解決する: chunk は (1) 変化点のみ観測 INSERT、(2) 受信した全 ref を sync_seen に INSERT(ON CONFLICT DO NOTHING)。工程3/4 の参照元を観測ではなく sync_seen にする。これで「chunk は追記専用・canonical/identity 不可侵」「変化点のみ記録」「stale 正確性」の3不変条件がすべて成立する。sync_seen は SyncStaging と同じセッション寿命の作業データ(確定/失効後にパージ)。**data-model.md / sync-protocol.md への追記が必要な差分として Task 23 で文書化する。タスク報告にも明記すること。**

**Files:**
- Modify: `src/storage/schema.ts`(`sync_seen` テーブル追加)→ `npm run db:generate` で追加マイグレーション、`src/schemas/sync.ts`(observation に任意 `category` を追加 — 下記ノート)、`src/storage/interface.ts`, `src/storage/drizzle-storage.ts`, `tests/contract/storage-contract.ts`
- Create: `src/http/api/sync.ts`
- Modify: `src/http/app.ts`
- Test: `tests/integration/sync-start-chunk.test.ts`

**もう1つの docs ギャップ(このタスクで解決):** observed 固定キーセットに `category` が無いが、UC-07 は「カテゴリ: Discovery が判定」とし、`test_cases.category` は NOT NULL。→ **observation のトップレベルに任意フィールド `category`(enum)を追加**し、canonical 生成(Task 16 工程1)で使用(未指定は `'normal'`)。ミラー昇格では category を変更しない。Task 23 の docs 反映リストに追加。

**Interfaces:**
- Produces(Storage 追加分):
  ```ts
  syncExpireLapsed(scope, pid, origin: string | null, now: number): Promise<void>; // 遅延評価: active かつ expires_at<=now を expired に(origin null = プロジェクト全体)
  syncStart(scope, pid, p: { token: string; origin: string; now: number; slidingMs: number }):
    Promise<{ kind: 'created'; session: SyncSessionRow } | { kind: 'conflict' }>; // UNIQUE 違反捕捉で conflict
  syncGetSession(scope, pid, token: string): Promise<SyncSessionRow | null>;
  syncTouchExpiry(token: string, expiresAt: number): Promise<void>;
  syncAppendObservations(scope, pid, session: SyncSessionRow, obs: ChunkObservation[], now: number):
    Promise<Array<{ external_ref: string; outcome: 'inserted' | 'duplicate' }>>;
  // 手順: ①対象 ref 群の「最新観測 fingerprint」を1クエリで取得(per (ref, origin)。committed か当セッション由来に限定 = committed-JOIN フェンス)
  //       ②fingerprint が異なる/初出の ref のみ観測 INSERT 候補に。1文 ≤16 行に分割・ON CONFLICT DO NOTHING
  //       ③全 ref を sync_seen へ INSERT ON CONFLICT DO NOTHING(≤16 行/文)
  //       ④観測 INSERT された ref → 'inserted'、それ以外 → 'duplicate'
  ```
- Produces(ルート): `POST /api/v1/projects/:pid/sync/start`、`POST /api/v1/projects/:pid/sync/:token/chunk`(いずれも `requireAuth({modes:['token']})` + `resolveProject()` + syncLimiter)
- `SLIDING_MS = 10 * 60_000`(sync-protocol「スライディング失効」)

**Docs:** `docs/sync-protocol.md`(start/chunk の全仕様・エラー表・スライディング失効・D1 制約)、`docs/data-model.md`(SyncSession / TestCaseObservation / 一意制約)、`docs/api-reference.md`(origin 正規化・Idempotency-Key = D-10 で受理のみ)

**振る舞い(統合テストで検証):**

| ケース | 結果 |
|---|---|
| start(有効 Bearer) | 201 `{sync_token, expires_at, server_time, max_chunk_size:500}` |
| 同一 (project, origin) の active が既存 | 409 `DUPLICATE_SYNC_SESSION` |
| 別 origin なら並行 start 可 | 201 |
| 期限切れ active が居る状態で start | 旧セッションを expired に倒して 201(遅延評価) |
| chunk 正常 | 200 `{accepted, received:[{external_ref, outcome}]}`・`expires_at` が +10分 延長 |
| 同一 chunk 再送 | 全件 `duplicate`・観測行は増えない・sync_seen は冪等 |
| 変化なし ref の別セッション再送 | 観測行は増えない(変化点のみ)が sync_seen には記録 |
| token と別プロジェクトの :pid | 403 `CROSS_TENANT` |
| 存在しない/expired セッションへの chunk | 410 `SESSION_EXPIRED`(committed への chunk も 410。sync-protocol「committed 後は受け付けない」) |
| observations >500 / observed >256KB / 大文字 origin | 422 `VALIDATION_FAILED` |
| syncLimiter 超過(トークン別 120/分 = D-14) | 429 + Retry-After |
| Idempotency-Key ヘッダ | 受理して無視(D-10。コードコメントに明記) |

- [ ] **Step 1: schema に sync_seen を追加し `npm run db:generate` → DDL テスト(Task 3 のテストにテーブル存在+一意制約の2ケース追記)が PASS。同時に `tests/contract/storage-contract.ts` の `WIPE_ORDER` と統合テストヘルパの wipe リストの先頭側(`sync_staging` の直前)に `'sync_seen'` を追加する(Task 4 時点ではテーブルが無いため、このタスクで追加するのが正しいタイミング)**

```ts
export const syncSeen = sqliteTable('sync_seen', {
  syncToken: text('sync_token').notNull().references(() => syncSessions.token),
  externalRef: text('external_ref').notNull(),
}, (t) => [uniqueIndex('uq_seen').on(t.syncToken, t.externalRef)]);
```

- [ ] **Step 2: 契約テスト追記(FAIL)** — syncStart created/conflict/遅延評価 / touchExpiry / appendObservations の inserted→duplicate・16行超の分割(40件一括で正しく全件入る)・committed フェンス(active な他セッションの観測は「最新指紋」比較の対象にならない)
- [ ] **Step 3: 統合テスト(FAIL)** — 上表の全行
- [ ] **Step 4: 実装(Storage → ルート)→ 全 PASS / typecheck 0**
- [ ] **Step 5: sync-protocol.md の該当節と1行ずつ突合(特にエラー表)→ コミット**

```bash
git add src/storage src/schemas src/http migrations tests && git commit -m "feat: sync start/chunk with change-point observations and seen-ledger"
```

---

### Task 16: 同期プロトコル後半(commit 8工程・サマリー永続化・GET sync/status)

**Files:**
- Modify: `src/storage/interface.ts`, `src/storage/drizzle-storage.ts`, `src/http/api/sync.ts`, `tests/contract/storage-contract.ts`
- Create: `src/domain/sync-commit.ts`(工程の述語・SQL 組み立ての純粋部分), `tests/integration/sync-commit.test.ts`
- Test: 上記

**Interfaces:**
- Produces(Storage 追加分):
  ```ts
  syncCommitWindow(scope, pid, token: string, p: { now: number; identityTtlMs: number; windowLimit: number }):
    Promise<{ more: boolean }>;
  // 工程0〜7を実行。工程0の UUID は JS で採番し INSERT ... ON CONFLICT DO NOTHING(SQLite に uuid() は無い)。
  // 工程3〜7 は「変更が起きる行だけに絞る WHERE + LIMIT :windowLimit」で反復し、
  //   1回の呼び出しの総文数が windowLimit 基準を超えたら more:true で返す(再呼び出しで続きから収束)
  syncFinalize(scope, pid, token: string, now: number):
    Promise<{ createdCount: number; changedCount: number; staledCount: number; alreadyCommitted: boolean }>;
  // D-01: COUNT 3本(staging / DISTINCT ref in observations(:T) / last_seen_sync_token != :T)と
  //   UPDATE sync_sessions SET status='committed', committed_at, *_count WHERE token=:T AND status='active' を1 batch で。
  //   既に committed なら保存済みカウントを返す(冪等)
  syncMappings(scope, pid, token: string): Promise<Array<{ external_ref: string; test_case_id: string; outcome: 'created' | 'updated' | 'unchanged' }>>;
  // created=staging に有る / updated=観測(:T)が有る(staging 除く) / unchanged=sync_seen のみ。
  // staled は mappings に含めず staled_count で報告(mappings は「送られてきた ref」のマップのため。解釈を docs 反映リストへ)
  syncStatus(scope, pid): Promise<{
    origins: Array<{ origin: string; last_committed_at: number; last_summary: { created: number; changed: number; staled: number } }>;
    current: { unreviewed: number; drift: number; stale: number };
  }>; // D-01
  ```
- Produces(ルート): `POST /sync/:token/commit`(token 認証)、`GET /sync/status`(session|token・viewer)

**Docs:** `docs/sync-protocol.md`「Commit 8工程パイプライン」(各工程の SQL 述語をそのまま実装する。ただし工程3/4 の参照元は Task 15 ノートのとおり sync_seen)、「不変条件とエラーハンドリング」「D1 制約への対応まとめ」、`docs/data-model.md`(ミラー昇格ガード・drift 条件・rollup TTL・archived の再観測)、スペック D-01/D-13-6

**工程の実装対応表(sync-protocol.md → 実装):**

| 工程 | 内容 | 冪等ガード |
|---|---|---|
| 0 | 新規 ref 抽出(identity に無い ref)→ JS で UUID 採番 → sync_staging INSERT | ON CONFLICT DO NOTHING(再開時同一 id に収束) |
| 1 | staging から test_cases INSERT(`status='draft', ownership='machine', mirror_origin=:O, created_origin=:O, category=観測の category ?? 'normal', fingerprint=NULL, 内容は空`)+ **history INSERT(action='imported', actor='token:<apiTokenId>', delta={})** | NOT EXISTS |
| 2 | staging から test_case_identities INSERT | ON CONFLICT DO NOTHING |
| 3 | **sync_seen(:T)** に出現した identity → `last_seen_sync_token=:T, last_seen_at=:now, is_stale=0` | 再設定冪等 |
| 4 | 当該 origin で `last_seen_sync_token != :T` → `is_stale=1` | 再設定冪等 |
| 5 | ミラー昇格: `ownership='machine' AND status != 'archived' AND mirror_origin=:O` の canonical へ、当該 origin の最新観測(committed OR :T)の title/given/when/then/parameters/fingerprint/confidence/source_ref を相関サブクエリ UPDATE。`WHERE fingerprint IS NOT 最新観測指紋` を追加(再実行 no-op 化) | WHERE 述語 |
| 6 | drift 記録: `ownership='human' AND status != 'archived' AND mirror_origin=:O AND fingerprint IS NOT NULL AND fingerprint != 最新committed観測指紋` → `drift=1` | 再設定冪等 |
| 7 | rollup: sync-protocol.md の SQL どおり(TTL=identityTtlMs、`status NOT IN ('approved','archived')` 保護)。`WHERE is_stale != <計算値>` を付け変更行のみ書く | 純関数 |
| 8 | finalize(上記 syncFinalize。カウント3本と同一 batch で committed 遷移) | `AND status='active'` |

**commit ルートの流れ:** 遅延評価(期限切れ→expired)→ セッション検証(無し/expired → 410、committed → 保存済みカウント+mappings で 200 即応)→ スライディング延長 → `syncCommitWindow`(more:true なら 202 `{status:'in_progress', more:true, ...}` で返し、衛星が再送)→ more:false なら `syncFinalize` → `syncMappings` → 200 `{status:'completed', staled_count, more:false, mappings}`(レスポンス形は sync-protocol.md の例に一致させる)

- [ ] **Step 1: 契約テスト追記(FAIL)** — 工程0の再実行で同一 UUID / commit window の more 分岐 / finalize 冪等(2回目 alreadyCommitted) / mappings 3種
- [ ] **Step 2: 統合テスト(FAIL)** — 以下を全て:
  1. **ハッピーパス(小規模)**: start→chunk(2件)→commit → 201/200/200、canonical 2件が draft/machine で内容ミラー済み・identity 2件・history imported 2件・`GET sync/status` が `created=2`・`current.unreviewed=2`
  2. **無変化再同期**: 再 start→同一指紋 chunk→commit → 観測行数不変・stale にならない(sync_seen の効果)・staled_count=0
  3. **machine 行の変化**: 新指紋で再同期 → canonical 内容・fingerprint が更新(ミラー)・version 不変(システム列は bump しない)
  4. **human 行の drift**: PATCH で human 化 → 新指紋で再同期 → 内容は不変・`drift=1`・`GET diff` が差分を返す
  5. **stale と復帰**: ref A/B 登録後、B だけで再同期 → A の identity/canonical が stale → 次の同期で A 再出現 → stale 解除
  6. **approved 保護**: approved 済みを同期から外しても canonical.is_stale=false(rollup 保護。identity は stale になる)
  7. **archived の再観測**: archived を同期に含めても status/内容不変・観測のみ記録
  8. **commit 冪等**: commit 2連打 → 同一応答・canonical/history 重複なし
  9. **mid-commit 再開**: `windowLimit:1` を注入した deps で commit → 202/more:true を数回 → 最終 200・結果は一括実行と完全一致
  10. **rollup TTL**: last_seen_at が TTL 超の凍結 identity を seed → 集約から除外される
- [ ] **Step 3: 実装 → 全 PASS / typecheck 0**
- [ ] **Step 4: sync-protocol.md の工程 SQL・エラー表・応答例と1行ずつ突合(工程3/4 の sync_seen 置換と mappings の staled 解釈は差分としてタスク報告に記載)→ コミット**

```bash
git add src/storage src/domain src/http tests && git commit -m "feat: sync commit pipeline (8 steps, windowed resume, summary persistence) + sync status api"
```

## UI タスク共通事項(Task 17〜21)

- **各画面の要素・data-testid・状態・エラー表示の正本は `docs/screens/<group>/<S-xx>.md`。**タスク着手時に対象画面のドキュメントを必ず読み、要素カタログの data-testid を全て実装する(GC-1/GC-8)。計画には構造とパターンのみ書く
- UI ルートは `requirePageAuth({minRole})`(authn と同型だが 401 の代わりに `/login?flash=session_expired` へ 302、403 はエラーページ描画)を使う。実装は Task 17
- フォームは `<input type="hidden" name="_csrf" value={csrf}>` を必ず含む(D-09)。HTMX は `<body hx-headers='{"X-CSRF-Token":"<csrf>"}'>` で全リクエストに自動付与
- 通常フォーム POST は PRG(303 リダイレクト+`?flash=`)。HTMX リクエスト(`HX-Request` ヘッダで判定)にはフラグメント HTML を返す
- ビジネスロジックは API ルートと共有する。Task 17 で `src/domain/services/` に薄いサービス関数(login 等)を抽出し、API ルートをそれ経由にリファクタしてから UI が同じ関数を呼ぶ(内部 HTTP 往復はしない=承認済みアプローチ A)
- SSR スモークテスト(workers pool)は「セッション Cookie 付き GET → 200 + 画面ドキュメントの主要 data-testid が HTML に含まれる」+「フォーム POST → 302 → 反映」を画面ごとに最低1本
- 除外(MVP後)を画面に置かない: S-02 のリセットリンクはヒント文言に置換(D-13-2)、S-08 の「前へ」ボタン無し(D-03)、ソート UI 無し、S-09 のボタンは「作成」のみ(D-13-3)、S-13 のエクスポートボタン無し

### Task 17: UI 基盤 + 認証画面(S-01 セットアップ / S-02 ログイン)

**Files:**
- Create: `src/http/ui/layout.tsx`(共通レイアウト・グローバルヘッダー・プロジェクトコンテキストヘッダー・パンくず・トースト), `src/http/ui/flash.ts`(`?flash=` キー→日本語文言表), `src/http/ui/auth-pages.tsx`, `src/http/middleware/page-auth.ts`(`requirePageAuth`・`ensureCsrfCookie`), `src/domain/services/auth-service.ts`, `public/app.css`(全画面分の最小クラスレス CSS + バッジ/Diff/トースト)
- Modify: `src/http/app.ts`(UI ルート登録・`GET /` の振り分け), `src/http/api/auth.ts`(auth-service 抽出リファクタ)
- Test: `tests/integration/ui-auth.test.ts`

**ルート:** `GET /`(org 0件→`/setup`、未ログイン→`/login`、ログイン済→`/projects` へ 302 = D-13-1/8)、`GET|POST /setup`、`GET|POST /login`、`POST /logout`

**Docs:** `docs/screens/auth/S-01-setup.md`、`docs/screens/auth/S-02-login.md`、`docs/screens.md`「共通レイアウト」、スペック D-13-1/2/5/8

- [ ] **Step 1: SSR スモークテスト(FAIL)** — `GET /` が org 無しで /setup へ 302 / setup フォーム POST → org 作成され /login へ / login 成功 → /projects へ 302 + Set-Cookie / 失敗 → 200 でエラー文言(S-02 の `error-message` testid)/ ログイン済みで /login → /projects へ 302 / logout POST(CSRF 付き)→ /login / `?flash=session_expired` の文言表示
- [ ] **Step 2: layout.tsx を実装**(骨子):

```tsx
export const Layout = (p: {
  title: string; user?: UserRow | null; csrf?: string;
  project?: ProjectRow | null; breadcrumb?: Array<{ label: string; href?: string }>;
  flash?: { kind: 'success' | 'error' | 'warn'; text: string } | null; children: unknown;
}) => (
  <html lang="ja"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{p.title} - TMS</title><link rel="stylesheet" href="/app.css" />
    <script src="/htmx.min.js" defer></script>
  </head>
  <body hx-headers={p.csrf ? JSON.stringify({ 'X-CSRF-Token': p.csrf }) : undefined}>
    {p.user && <GlobalHeader user={p.user} csrf={p.csrf} />}
    {p.project && p.user && <ProjectContextHeader project={p.project} user={p.user} />}
    {p.breadcrumb && <Breadcrumb items={p.breadcrumb} />}
    {p.flash && <div class={`toast toast-${p.flash.kind}`} data-testid="toast">{p.flash.text}</div>}
    <main>{p.children}</main>
    <div id="dialog-root"></div>
  </body></html>
);
```

- [ ] **Step 3: auth-service 抽出 → API テストが引き続き PASS することを確認 → 認証ページ実装 → スモーク PASS**
- [ ] **Step 4: S-01/S-02 の要素カタログと突合(全 testid・バリデーション文言)→ コミット**

```bash
git add src/http src/domain public tests && git commit -m "feat: ui foundation (layout, page auth, csrf embed, flash) + setup/login screens"
```

### Task 18: プロジェクト画面(S-06 一覧 / S-07 作成ダイアログ)

**Files:**
- Create: `src/http/ui/projects-pages.tsx`
- Modify: `src/http/app.ts`
- Test: `tests/integration/ui-projects.test.ts`

**ルート:** `GET /projects`(一覧+空状態)、`GET /projects/new`(HX-Request ならダイアログフラグメント)、`POST /projects`(admin。成功→ /projects へ 303 + flash)

**Docs:** `docs/screens/main/S-06-project-list.md`(testcase_count 列・空状態)、`docs/screens/main/S-07-project-create-dialog.md`(キーボード操作含む)

- [ ] Step 1: スモークテスト(FAIL): 一覧に project 名と testcase_count / 空状態文言 / admin のみ「新規プロジェクト」ボタン(viewer には無い)/ ダイアログフラグメント取得 / POST 作成 → 一覧反映 / editor の POST → 403
- [ ] Step 2: 実装 → PASS → S-06/S-07 と突合 → コミット `feat: project list/create ui`

### Task 19: テストケース一覧(S-08)+ 一括操作確認(S-15)

**Files:**
- Create: `src/http/ui/testcase-list.tsx`(ページ+一覧フラグメント+同期サマリーパネル+一括操作バー+S-15 ダイアログ)
- Modify: `src/http/app.ts`, 必要なら `src/domain/services/testcase-service.ts` を抽出
- Test: `tests/integration/ui-testcase-list.test.ts`

**ルート:**
- `GET /projects/:pid/testcases` — クエリ(status/category/ownership/drift/is_stale/target/cursor)をそのまま `listTestCases` + `syncStatus` に渡して描画。`HX-Request` なら一覧セクションのみのフラグメント
- `POST /projects/:pid/testcases/bulk-ui` — フォーム(`ids[]`+`action`+`_csrf`)→ bulkAction → 303 back with flash「N件を承認しました(スキップM件)」

**構造(S-08 のワイヤーフレームどおり):** 同期サマリーパネル(origin 別最終同期・新規/drift/stale 件数。各数字は該当フィルタへのリンク = sync/status の値)/ フィルタフォーム(`hx-get` + `hx-push-url` でフラグメント差し替え)/ 件数表示(total = D-03)/ 行: タイトル・target・category・status バッジ・ownership バッジ・drift/stale バッジ・チェックボックス / 一括操作バー(選択時表示は最小 JS: htmx ではなく `<details>`+CSS でなく、チェック変更で JS 3行の inline script を許容 — S-08 の仕様に従う)/ ページング「次へ」「先頭に戻る」リンク(cursor を URL クエリに載せる)

**Docs:** `docs/screens/testcase/S-08-testcase-list.md`(要素カタログが最大の画面。全 testid を実装)、`docs/screens/testcase/S-15-bulk-operation-confirm.md`(action 別文言・部分失敗トースト)、スペック D-01/D-03

- [ ] Step 1: スモークテスト(FAIL): フィルタ付き GET で該当行のみ / バッジ表示(drift/stale/machine)/ total 表示 / 同期サマリーパネルに sync/status の値(Task 16 のハッピーパスを流用して seed)/ 「次へ」リンクに next_cursor / 一括承認 POST → 全件 approved + flash 文言 / HX-Request でフラグメントのみ返る(`<html>` を含まない)
- [ ] Step 2: 実装 → PASS → S-08/S-15 と突合 → コミット `feat: testcase list ui (filters, sync summary, bulk)`

### Task 20: テストケース作成/詳細/編集 + タブ(S-09〜S-14)

**Files:**
- Create: `src/http/ui/testcase-form.tsx`(S-09 作成 / S-11 編集 — 同一フォーム部品), `src/http/ui/testcase-detail.tsx`(S-10 詳細 + S-12 Diff / S-13 Gherkin / S-14 履歴 / Identity タブ)
- Modify: `src/http/app.ts`
- Test: `tests/integration/ui-testcase-detail.test.ts`

**ルート:**
- `GET /projects/:pid/testcases/new` / `POST /projects/:pid/testcases`(作成 → 詳細へ 303。「作成」ボタン1つ = D-13-3。パラメータ行は `<template>`+最小 inline JS で追加削除(S-09 仕様))
- `GET /projects/:pid/testcases/:id`(詳細。status 操作ボタン群は data-model の遷移マトリクスに従い出し分け。machine 行には編集時警告 = S-11)
- `GET .../edit` / `POST .../edit`(hidden で version を持ち、OCC 409 なら「更新が競合しました…」トースト+再読込導線 = S-11 のエラー状態)
- `POST .../status`(フォーム: to=approved|draft|archived。遷移不可は 422 相当のエラートースト)
- `POST .../accept-fingerprint`(S-12 から。version hidden 持参)
- タブフラグメント: `GET .../tabs/diff|gherkin|history|identities`(HX-Request で部分描画・`hx-push-url`。**Diff タブは drift 無しでも選択可で「差分はありません」= D-13-4**)

**Docs:** `docs/screens/testcase/S-09〜S-14 の6ファイル`(要素・状態・確認ダイアログ・警告文言)、`docs/data-model.md`(遷移マトリクス)、スペック D-13-3/4

- [ ] Step 1: スモークテスト(FAIL): 作成フォーム POST → 詳細に全フィールド / machine 行の編集画面に警告文言 / 編集保存で human 化+履歴タブに updated / 古い version で保存 → OCC トースト / status ボタン: draft→approved 成功・archived→approved は出さない(復帰ボタンのみ = S-10)/ Diff タブ drift 有り: before/after 行・無し: 「差分はありません」 / Gherkin タブに整形テキスト / 履歴タブに actor_display / Identity タブに origin と stale
- [ ] Step 2: 実装 → PASS → S-09〜S-14 の6ドキュメントと突合 → コミット `feat: testcase create/detail/edit ui with tabs`

### Task 21: 管理画面(S-16/S-17 トークン、S-18/S-19 ユーザー、S-20 プロフィール)

**Files:**
- Create: `src/http/ui/tokens-pages.tsx`, `src/http/ui/users-pages.tsx`, `src/http/ui/profile-page.tsx`
- Modify: `src/http/app.ts`
- Test: `tests/integration/ui-admin.test.ts`

**ルート:** `GET /projects/:pid/tokens`(admin)+ `POST .../tokens`(発行 → **S-17: 平文を1回だけ表示する結果ダイアログ**をレスポンスに直接描画。リロードで消える旨の警告文言)+ `POST .../tokens/:id/revoke`(確認付き・冪等)/ `GET /admin/users` + `GET|POST /admin/users/new` + `GET|POST /admin/users/:id/edit` + `POST /admin/users/:id/reset-password`(S-19。自分自身の role 変更 UI は無効化+最後の admin は API 側 422 をトースト表示)/ `GET|POST /profile`(S-20 パスワード変更)

**Docs:** `docs/screens/project-settings/S-16-api-token-list.md` / `S-17-token-issue-result.md`、`docs/screens/admin/S-18-user-list.md` / `S-19-user-create-edit.md` / `S-20-profile-password.md`、スペック D-13-7

- [ ] Step 1: スモークテスト(FAIL): トークン発行 → 応答 HTML に平文1回表示+一覧には平文なし / 失効 → バッジ表示 / editor で /projects/:pid/tokens → 403 ページ / ユーザー作成 → 一覧に last_login_at 列(未ログインは「—」)/ 最後の admin 降格 → エラートースト / プロフィールでパスワード変更 → 再ログインで新 PW
- [ ] Step 2: 実装 → PASS → 5画面ドキュメントと突合 → コミット `feat: admin ui (tokens, users, profile)`

### Task 22: メンテナンス(パージ・sweep)+ Workers エントリ本実装(scheduled)

**Files:**
- Create: `src/maintenance/purge.ts`, `src/maintenance/sweep.ts`
- Modify: `src/storage/interface.ts` / `src/storage/drizzle-storage.ts`(下記メソッド), `src/entry/workers.ts`(仮実装を置換), `tests/contract/storage-contract.ts`
- Test: `tests/unit/maintenance.test.ts`(better-sqlite3 で高速検証), `tests/integration/entry.test.ts`

**Interfaces:**
- Produces(Storage 追加分):
  ```ts
  purgeObservations(p: { now: number; retentionMs: number; batchLimit: number }): Promise<number>; // 削除行数
  sweepExpiredSyncSessions(now: number): Promise<number>;   // active かつ期限切れ → expired(全プロジェクト)
  deleteExpiredUiSessions(now: number, limit: number): Promise<number>;
  purgeSyncWorkdata(): Promise<number>; // committed/expired セッションの sync_staging + sync_seen を DELETE...LIMIT で削除
  countsSnapshot(): Promise<Record<string, number>>; // 主要テーブルの行数(概算容量監視ログ用)
  runMaintenance(deps): Promise<void>;  // src/maintenance: 上記を順に呼び、結果を構造化ログ出力(共通実装。CF scheduled と node CLI の両方から呼ぶ)
  ```
- Workers エントリ:
  ```ts
  export default {
    fetch: (req, env, ctx) => getApp(env).fetch(req, env, ctx),   // getApp = env から AppDeps を組んで createApp(isolate 内キャッシュ)
    scheduled: (event, env, ctx) => ctx.waitUntil(runMaintenance(depsFrom(env))),
  };
  ```

**Docs:** `docs/operations.md` §4(パージの削除述語 SQL・最低1件保持・小バッチ・1,000 クエリ未満・committed フィルタ)、`docs/sync-protocol.md`「失効の執行モデル」(Cron はセカンダリ)、`docs/data-model.md`「パージポリシー」

**パージの不変条件(テストで検証する仕様):**
- committed セッション由来の観測のみ削除対象。retention(90日)より新しいものは残す
- **各 (test_case_id, origin) の直近 committed 観測は期間に関わらず必ず1件残す**(operations.md の ROW_NUMBER 述語をそのまま実装)
- `DELETE ... LIMIT :batchLimit` の反復で、1回の実行あたり総文数を 1,000 未満に抑える(反復回数上限を引数化)
- active セッション由来の観測は絶対に消さない

- [ ] Step 1: テスト(FAIL): 91日前 committed 観測が消える / 直近1件は91日前でも残る / active 由来は残る / batchLimit=1 で複数回反復して全量到達 / sweep が active期限切れ→expired / UI 期限切れセッション削除 / purgeSyncWorkdata が committed の staging/seen を消し active のは残す / countsSnapshot のキーに 11 テーブル
- [ ] Step 2: 実装(Storage → maintenance → workers entry)→ `npm test` 全 PASS
- [ ] Step 3: `tests/integration/entry.test.ts`: workers pool の `SELF`/app 経由で `GET /` 302 と `/api/v1/setup` が動く(エントリ配線の確認)
- [ ] Step 4: operations.md §4 と突合(述語・バッチ上限)→ コミット `feat: maintenance (purge/sweep) + workers entry with scheduled cron`

---

### Task 23: Node エントリ・README・docs 反映・最終検証

**Files:**
- Create: `src/entry/node.ts`(`createNodeApp()` + listen), `src/entry/maintenance-cli.ts`
- Modify: `README.md`(完成), `package.json`(scripts: `start:node`, `maintenance:node`)
- Modify(docs 反映 — スペック「既存ドキュメントへの反映」+ 実装中に確定した差分):
  - `docs/apis/sync.md` を新規作成するか `docs/sync-protocol.md` に追記: `GET /sync/status`(D-01)・工程3/4 の出現台帳(sync_seen)・observation の任意 `category`・mappings に staled を含めない解釈
  - `docs/apis/testcases.md`: DELETE=アーカイブエイリアス(D-02)・一覧 `total`(D-03)・history `actor_display`(D-04)・`updated_at` 意味論(D-05)
  - `docs/apis/projects.md`: `testcase_count` / `docs/apis/users.md`: `last_login_at`・最後の admin 保護
  - `docs/data-model.md`: SyncSession 集計列・User.last_login_at・sync_seen・observations.confidence 列・re-adopt `[※MVP後]`(D-12)
  - `docs/api-reference.md`: Idempotency-Key を「受理のみ・構造的冪等性が正」(D-10)
  - `docs/auth-security.md`: PW ポリシー(D-06)・セッション TTL 7日(D-08)・CSRF 方式(D-09)・レートリミット具体値と「ログインは全環境メモリ実装」(D-14)・認証失敗は構造化ログ(D-11)
  - `docs/screens.md` / `docs/screens/testcase/S-08`: 「前へ」廃止(D-03)、S-02 リンク(D-13-2)、S-09 ボタン統合(D-13-3)、S-12 タブ挙動(D-13-4)
- Test: `tests/unit/node-entry.test.ts`

**Docs:** スペック全体(D-01〜D-14 が docs へ反映されたことを最終確認)、`docs/operations.md` §4.3(オンプレの cron / incremental_vacuum)

- [ ] **Step 1: node エントリ(FAIL→実装)**

```ts
// src/entry/node.ts(骨子)
export function createNodeApp(dataPath = process.env.TMS_DB_PATH ?? './tms.sqlite') {
  const config = loadConfig(process.env);
  const { storage } = createBetterSqlite3Storage(dataPath);
  const deps: AppDeps = { storage, auth: createWebcryptoAuth({ ...config }), config, now: () => Date.now(),
    loginLimiter: createMemoryRateLimiter(config.loginRateLimit), syncLimiter: createMemoryRateLimiter(config.syncRateLimit) };
  const app = createApp(deps);
  app.use('/*', serveStatic({ root: './public' })); // 未マッチのみ静的配信
  return { app, deps };
}
// main(import.meta.main 相当のガード): serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8788) })
```

テスト: `createNodeApp(':memory:')` で `GET /` が 302、`POST /api/v1/setup` が 201(listen せず app.request で検証)

- [ ] **Step 2: maintenance-cli(`node --experimental-strip-types` または tsx で実行し `runMaintenance` + オンプレのみ `PRAGMA incremental_vacuum` を発行)**
- [ ] **Step 3: README 完成** — 必須節: 概要(docs/ への索引)/ 開発(`npm install`, `npm test`, `npm run dev`)/ **CF デプロイ手順**(`wrangler d1 create tms` → database_id 差し替え → `wrangler secret put SESSION_SIGNING_KEYS` → `wrangler d1 migrations apply tms --remote` → `wrangler deploy`)/ **オンプレ起動**(env 一覧・`npm run start:node`・OS cron 例 `0 * * * * node .../maintenance-cli.js`)/ 初期セットアップ(ブラウザで /setup)/ **衛星同期のクイックスタート(curl)**
- [ ] **Step 4: docs 反映**(上記 Modify リストを1ファイルずつ。**変更は実装済みの事実のみ**を書き、未実装の約束を書かない)
- [ ] **Step 5: 最終検証(スペック「成功基準」の実施)**
  1. `npm test` 全グリーン(単体・契約×3・統合)+ `npm run typecheck`
  2. `wrangler dev` を起動し、以下の curl ウォークスルーが通る(UC-02〜UC-16 相当):

```bash
B=http://localhost:8787
curl -s -X POST $B/api/v1/setup -H 'content-type: application/json' \
  -d '{"organization_name":"Org","admin_email":"a@example.com","admin_password":"password1","admin_display_name":"Admin"}'   # 201
curl -s -c /tmp/jar -X POST $B/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"a@example.com","password":"password1"}'                              # 200 + cookies
CSRF=$(awk '$6=="csrf"{print $7}' /tmp/jar)
PID=$(curl -s -b /tmp/jar -H "x-csrf-token: $CSRF" -X POST $B/api/v1/projects \
  -H 'content-type: application/json' -d '{"name":"payment"}' | jq -r .id)           # 201
TOKEN=$(curl -s -b /tmp/jar -H "x-csrf-token: $CSRF" -X POST $B/api/v1/projects/$PID/tokens \
  -H 'content-type: application/json' -d '{"name":"discovery-ci"}' | jq -r .token)   # 201 平文1回
SYN=$(curl -s -H "authorization: Bearer $TOKEN" -X POST $B/api/v1/projects/$PID/sync/start \
  -H 'content-type: application/json' -d '{"origin":"discovery-v1"}' | jq -r .sync_token)
curl -s -H "authorization: Bearer $TOKEN" -X POST $B/api/v1/projects/$PID/sync/$SYN/chunk \
  -H 'content-type: application/json' -d '{"observations":[{"external_ref":"com.example.T#m","fingerprint":"fp1",
  "observed":{"title":"支払いが成功する","given":"残高がある","when":"支払う","then":"成功する","parameters":[],"source_ref":{},"schema_version":"1.0"}}]}'
curl -s -H "authorization: Bearer $TOKEN" -X POST $B/api/v1/projects/$PID/sync/$SYN/commit   # completed, created×1
curl -s -b /tmp/jar "$B/api/v1/projects/$PID/sync/status"                            # created=1, unreviewed=1
TC=$(curl -s -b /tmp/jar "$B/api/v1/projects/$PID/testcases" | jq -r '.items[0].id')
curl -s -b /tmp/jar -H "x-csrf-token: $CSRF" -H 'if-match: "1"' -X PATCH \
  $B/api/v1/projects/$PID/testcases/$TC -H 'content-type: application/json' -d '{"status":"approved"}'  # human化+approved
```

  3. ブラウザで `wrangler dev` の URL を開き、S-01→S-02→S-06→S-08→S-10 の主要フローを目視確認(スクリーンショット不要・チェックリストをタスク報告に)
  4. Node エントリ: `TMS_DB_PATH=/tmp/tms.sqlite npm run start:node` → `/login` が 200(curl)
- [ ] **Step 6: コミット**

```bash
git add -A && git commit -m "feat: node entry + maintenance cli; docs: reconcile design docs with implementation (D-01..D-14)"
```

---

## 完了の定義(プラン全体)

- 全 23 タスクのチェックボックスが埋まり、`npm test` / `npm run typecheck` がグリーン
- スペック「成功基準」1〜4 を Task 23 Step 5 で実証済み
- docs/ が実装と一致(GC-1 の完了条件が全タスクで満たされている)
- MVP 除外項目(スペック「対象外」)がコードに紛れ込んでいない(YAGNI)










