# Post-MVP Quality Sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** docs/HANDOVER.md §4.2 の繰延 22 項目を消化する(実装 18 / 検証済み注記 1 = C8 / 据え置き 3 = C5・C6・C9 は既録の判断維持で変更なし。実装は 17 タスクに束ねる — Task 7 が B8 と別コミットで B9 も内包)。

**Architecture:** 挙動追加なしの品質スプリント。(1) docs の stale 記述修正、(2) 挙動保存リファクタ(C1/C2/C3)、(3) maintenance エントリの設定結合分離(C10/C11 — 意図的なセマンティクス変更: cron/CLI は署名鍵を読まなくなる)、(4) テスト穴埋め(B 系)、(5) node ローダー改善(D 系)。

**Tech Stack:** TypeScript strict/ESM、Hono ^4、Zod ^4、Vitest ~3.2(unit: `vitest.config.ts` node pool / workers: `vitest.workers.config.ts` CF pool)、better-sqlite3 ^12。

## Global Constraints

- **全コマンドに node22 前置:** `export PATH="$HOME/node22/bin:$PATH" && ` を必ず付ける(既定 node は v18)。
- **検証ゲート(GC-10):** `npm run typecheck` / `npm run test:unit` / `npm run test:workers`。タスク完了時は関係スイート、スプリント完了時は全部。
- **回帰基準:** 開始時点 760 green(unit 376 / workers 384)。テスト追加タスク後は green 数が増えること。
- **GC-6 ポータビリティ:** `src/schemas`・`src/domain`・`src/http`・`src/maintenance` に CF 型を import しない。
- **GC-3 クロック:** 実クロックはエントリ層のみ。テストは固定値。
- **識別テスト必須(HANDOVER §3.1):** 非ゼロ・distinct 値 fixture で検証。空/ゼロ状態だけの assert は不可。
- **コミット:** Conventional Commits(feat:/fix:/test:/refactor:/docs:/build:)。1 タスク 1 コミット目安。
- **docs 原則:** 「実装済みの事実のみ」書く。未実装の約束を書かない。
- **catch 最小スコープ(教訓 §5-10):** エラーハンドリング変更時は catch が要求より広くないか確認。

**据え置き(コード変更禁止):** C5(UNIQUE 検出の文字列一致 — 契約テスト済みの意図的シーム)/ C6(`findUserForLogin` グローバル検索 — マルチ org 化時に修正、auth-security.md に既録)/ C9(`applyBulkAction` の狭いマトリクス — 共有すると過結合という判断が既録)。

---

### Task 1: docs 修正(A2 + A3)+ C8 検証済み注記

**Files:**
- Modify: `docs/screens.md:306`
- Modify: `docs/screens/admin/S-18-user-list.md:49,105`
- Modify: `docs/HANDOVER.md`(C8 行)

**Interfaces:** なし(docs のみ)。

- [ ] **Step 1: screens.md:306 の S-08 行の API 対応セルを修正(A2)**

現状(306 行目):
```
| S-08 テストケース一覧 | 同期結果サマリー | 再同期後に何が変わったかの把握手段 | sync commit レスポンスの `summary` |
```
変更後:
```
| S-08 テストケース一覧 | 同期結果サマリー | 再同期後に何が変わったかの把握手段 | `GET .../sync/status` の `last_summary` |
```
根拠: 実装は S-08 のサマリー表示を `GET /api/v1/projects/:pid/sync/status` から取得(HANDOVER A2)。

- [ ] **Step 2: S-18-user-list.md の stale 注記 2 箇所を実装事実へ更新(A3)**

49 行目の表セル `**※ API 未定義** — ...` を以下へ:
```
| 最終ログイン | `user-last-login` | 最終ログイン日時 | `GET /api/v1/users` レスポンスの `last_login_at`(D-05。未ログインは null) |
```
105 行目の blockquote(`> **API ギャップ:** ...`)を以下へ:
```
> **実装メモ:** 「最終ログイン」列は `GET /api/v1/users` レスポンスの `last_login_at`(D-05、`src/http/api/serializers.ts`)を表示する。未ログインユーザーは null。
```
(表の他セルは現状のまま。周辺行の体裁に合わせること。)

- [ ] **Step 3: HANDOVER §4.2 の C8 行末尾に検証結果を追記**

C8 行の`(機能は全箇所正しい)`の後に追記:
```
(2026-07-04 検証: API 全 32 ルート中 resolveProject+zValidator 併用の 10 箇所すべてが resolveProject→zValidator 順で統一済み・逸脱ゼロ。コード変更不要と確定)
```

- [ ] **Step 4: Commit**
```bash
git add docs/screens.md docs/screens/admin/S-18-user-list.md docs/HANDOVER.md
git commit -m "docs: fix stale S-08 sync-summary ref and S-18 last_login notes (A2/A3); record C8 verified-uniform"
```

---

### Task 2: tsconfig `isolatedModules: true`(D3)

**Files:**
- Modify: `tsconfig.json:7`

**Interfaces:** なし(コンパイラ設定のみ。loader は tsconfig を single source として読むため自動追随)。

- [ ] **Step 1: tsconfig.json に追記**

`"noEmit": true` の行を `"noEmit": true, "isolatedModules": true` に変更。

- [ ] **Step 2: 検証**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npm run test:unit
```
Expected: typecheck 0 エラー(HANDOVER D3 は「現状違反ゼロ確認済み」)、unit 376 passed。

- [ ] **Step 3: Commit**
```bash
git add tsconfig.json
git commit -m "build: enable isolatedModules as per-file transpile guard (D3)"
```

---

### Task 3: `requiredParam` 共有化(C1)+ 直接単体テスト

**Files:**
- Create: `src/http/ui/params.ts`
- Modify: `src/http/ui/testcase-detail.tsx:701-711`(定義削除+import)
- Modify: `src/http/ui/tokens-pages.tsx:309-315`(同上)
- Modify: `src/http/ui/users-pages.tsx:394-400`(同上)
- Test: `tests/unit/ui-params.test.ts`(新規)

**Interfaces:**
- Produces: `export function requiredParam(c: Context<AppEnv>, name: string): string` — 3 ファイルの既存 8 呼び出し(シグネチャ不変)が使う。

- [ ] **Step 1: 共有モジュール作成**

`src/http/ui/params.ts`(新規、全文):
```ts
// src/http/ui/params.ts
// UI ルート横断の実行時パスパラメータ取得(HANDOVER C1: 3 ファイルに重複していた同一実装の統合先)。
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { AppError } from '../errors';

/**
 * `c.req.param(name)` は Hono のルート単位のパスリテラル型推論があって初めて `string`(param 無しは
 * `string | undefined`)を返す。複数ルートから呼ばれる独立関数はその推論の恩恵を受けられず
 * `Context<AppEnv>`(パス情報無し)としてしか Context を受け取れないため、動的セグメントの存在を
 * 実行時契約として扱う(前提: 呼び出し元のルート登録が必ず該当セグメントを持つこと)。
 */
export function requiredParam(c: Context<AppEnv>, name: string): string {
  const v = c.req.param(name);
  if (v === undefined) throw new AppError('NOT_FOUND', 404, `missing path param: ${name}`);
  return v;
}
```

- [ ] **Step 2: 3 ファイルからローカル定義を削除し import へ置換**

各ファイルで `function requiredParam(...)` とその直前の JSDoc コメントを削除し、既存 import 群に `import { requiredParam } from './params';` を追加。呼び出し 8 箇所は無変更。削除後に `Context` / `AppError` の import が未使用になったファイルがあれば import からも除去(typecheck で確認)。

- [ ] **Step 3: 直接単体テストを書く**

`tests/unit/ui-params.test.ts`(新規、全文):
```ts
import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../../src/http/app';
import { AppError } from '../../src/http/errors';
import { requiredParam } from '../../src/http/ui/params';

// requiredParam は c.req.param しか触らないため、最小の fake Context で十分(実 Hono ルータ不要)。
function fakeContext(params: Record<string, string>): Context<AppEnv> {
  return { req: { param: (name: string) => params[name] } } as unknown as Context<AppEnv>;
}

describe('requiredParam(C1 共有ヘルパー)', () => {
  it('存在するパラメータはその値を返す(distinct 値で誤バインドを識別)', () => {
    const c = fakeContext({ pid: 'proj-123', id: 'tc-456' });
    expect(requiredParam(c, 'pid')).toBe('proj-123');
    expect(requiredParam(c, 'id')).toBe('tc-456');
  });

  it('欠落パラメータは AppError(NOT_FOUND, 404) を throw', () => {
    const c = fakeContext({});
    let caught: unknown;
    try {
      requiredParam(c, 'pid');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('NOT_FOUND');
    expect((caught as AppError).status).toBe(404);
    expect((caught as AppError).message).toBe('missing path param: pid');
  });
});
```

- [ ] **Step 4: 検証**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npm run test:unit && npm run test:workers
```
Expected: unit 378(+2)、workers 384、typecheck 0。

- [ ] **Step 5: Commit**
```bash
git add src/http/ui/params.ts src/http/ui/testcase-detail.tsx src/http/ui/tokens-pages.tsx src/http/ui/users-pages.tsx tests/unit/ui-params.test.ts
git commit -m "refactor: share requiredParam across UI route files (C1) with direct unit test"
```

---

### Task 4: create/edit ペイロード写像の単一化(C2)

**Files:**
- Modify: `src/http/ui/testcase-form.tsx:173-193`
- Modify: `src/http/ui/testcase-detail.tsx:314-332`(+import 追加)

**Interfaces:**
- Produces: `export function buildTestCaseFields<A extends null | undefined>(v: TestCaseFormValues, absent: A)`(testcase-form.tsx)
- 既存 `buildTestCasePayload(v)`(export、シグネチャ不変)と detail 内 `buildEditPatchInput(v)`(private、シグネチャ不変)は薄いラッパー化。

- [ ] **Step 1: testcase-form.tsx の `buildTestCasePayload` を共通実装+ラッパーに置換**

173-193 行を以下へ(全文):
```tsx
/**
 * create(省略=未指定)と PATCH(null=クリア)で「空」の表現だけが異なる(HANDOVER C2)。
 * absent 哨兵をパラメータ化して行マッピングを単一実装に保つ。差異を将来ここ以外に足さないこと。
 */
export function buildTestCaseFields<A extends null | undefined>(v: TestCaseFormValues, absent: A) {
  const parameters = v.parameters.length > 0
    ? v.parameters.map((row) => ({
      ...(row.name.trim() ? { name: row.name.trim() } : {}),
      inputs: JSON.parse(row.inputs) as unknown,
      expected: row.expected as unknown,
    }))
    : absent;
  return {
    title: v.title.trim(),
    target: v.target.trim() ? v.target.trim() : absent,
    category: v.category,
    given: v.given,
    when: v.when,
    then: v.then,
    parameters,
    metadata: v.tags.length > 0 ? { tags: v.tags } : absent,
  };
}

/** 検証済みフォーム値 → createTestCaseInput の入力形へ(parameters/metadata は空なら未指定=省略)。 */
export function buildTestCasePayload(v: TestCaseFormValues) {
  return buildTestCaseFields(v, undefined);
}
```

- [ ] **Step 2: testcase-detail.tsx の `buildEditPatchInput`(314-332 行)を置換**

```tsx
/** 検証済みフォーム値 → patchTestCaseInput の入力形へ(空は null = クリア指示。create との差は absent 哨兵のみ)。 */
function buildEditPatchInput(v: TestCaseFormValues) {
  return buildTestCaseFields(v, null);
}
```
既存の testcase-form.tsx からの import 行に `buildTestCaseFields` を追加。

- [ ] **Step 3: 検証(既存統合テストが挙動保存のゲート)**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npm run test:workers
```
Expected: workers 384 passed(特に ui-testcase-detail 32 / testcases-write 41)。

- [ ] **Step 4: Commit**
```bash
git add src/http/ui/testcase-form.tsx src/http/ui/testcase-detail.tsx
git commit -m "refactor: unify create/edit payload mapping via absent-sentinel helper (C2)"
```

---

### Task 5: Gherkin 行導出の単一化(C3)+ data-raw ガードテスト

**Files:**
- Modify: `src/domain/gherkin.ts:102-121`(buildGherkinLines 追加、renderGherkin を委譲化)
- Modify: `src/http/ui/testcase-detail.tsx:495-528`(GherkinTabContent の再導出排除)
- Test: `tests/integration/ui-testcase-detail.test.ts`(S-13 describe に 1 追加)

**Interfaces:**
- Produces: `export interface GherkinLines { feature: string; scenario: string; isOutline: boolean; given: string; when: string; then: string }` と `export function buildGherkinLines(tc: GherkinInput): GherkinLines`(gherkin.ts)。

- [ ] **Step 1: gherkin.ts に buildGherkinLines を追加し renderGherkin を委譲化**

102-121 行(renderGherkin)を以下へ:
```ts
/** S-13 の行データ。コピー文(renderGherkin)と DOM 表示(GherkinTabContent)の両方をここから導出し、
 * feature/Scenario 判定の二重実装(HANDOVER C3 の drift 危険)を根絶する。 */
export interface GherkinLines {
  feature: string;
  scenario: string;
  isOutline: boolean;
  given: string;
  when: string;
  then: string;
}

export function buildGherkinLines(tc: GherkinInput): GherkinLines {
  const feature = tc.target && tc.target.trim().length > 0 ? tc.target : tc.title;
  const hasParams = Array.isArray(tc.parameters) && tc.parameters.length > 0;
  return {
    feature: `Feature: ${feature}`,
    scenario: hasParams ? `  Scenario Outline: ${tc.title}` : `  Scenario: ${tc.title}`,
    isOutline: hasParams,
    given: `    Given ${tc.given}`,
    when: `    When ${tc.when}`,
    then: `    Then ${tc.then}`,
  };
}

/** S-13 のレンダリング仕様に一致させる(Feature: target-or-title、Examples 表は parameters ありの時のみ)。 */
export function renderGherkin(tc: GherkinInput): string {
  const l = buildGherkinLines(tc);
  const lines: string[] = [l.feature, '', l.scenario, l.given, l.when, l.then];
  if (l.isOutline && tc.parameters) {
    lines.push('');
    lines.push('    Examples:');
    lines.push(...renderExamplesTable(tc.parameters));
  }
  return lines.join('\n');
}
```

- [ ] **Step 2: GherkinTabContent(testcase-detail.tsx:495-528)の再導出を排除**

`feature`/`hasParams` のローカル導出と各行のテンプレート再構築を削除し、`buildGherkinLines` の値を使う:
```tsx
function GherkinTabContent(props: { tc: TestCaseRow }) {
  const { tc } = props;
  const parameters: ParamRow[] | null = tc.parameters === null ? null : (JSON.parse(tc.parameters) as ParamRow[]);
  const input = { title: tc.title, target: tc.target, given: tc.given, when: tc.when, then: tc.then, parameters };
  const lines = buildGherkinLines(input);
  const raw = renderGherkin(input);

  return (
    <div data-testid="gherkin-tab-content">
      <pre data-testid="gherkin-content" data-raw={JSON.stringify(raw)}>
        <div data-testid="gherkin-feature">{lines.feature}</div>
        {'\n'}
        <div data-testid={lines.isOutline ? 'gherkin-scenario-outline' : 'gherkin-scenario'}>{lines.scenario}</div>
        <div data-testid="gherkin-given">{lines.given}</div>
        <div data-testid="gherkin-when">{lines.when}</div>
        <div data-testid="gherkin-then">{lines.then}</div>
        {lines.isOutline && parameters && (
          <>
            {'\n'}
            <div>    Examples:</div>
            <GherkinExamplesTable parameters={parameters} />
          </>
        )}
      </pre>
      {/* 以下 gherkin-actions / GHERKIN_COPY_SCRIPT は現状のまま変更しない */}
```
import 行を `import { buildGherkinLines, renderGherkin } from '../../domain/gherkin';` に更新。
**注意:** DOM の文字列は従来とバイト同一になること(既存テストの text 断定を壊さない)。Examples の視覚テーブル(`GherkinExamplesTable`)はコピー文(パイプ整形)と役割が違うため現状維持。

- [ ] **Step 3: data-raw ガードテストを S-13 describe(ui-testcase-detail.test.ts:693〜)に追加**

```ts
    it('data-raw のコピー文は domain/renderGherkin の出力と完全一致する(C3 の乖離ガード)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'gherkin-raw-svc');
      const { id } = await createViaForm(ctx, admin, project.id, [
        ['param_name[]', 'case-a'], ['param_inputs[]', '{"x":1}'], ['param_expected[]', 'ok'],
      ]);
      const html = await getTab(ctx, admin.jar, project.id, id, 'gherkin');

      const expectedRaw = JSON.stringify(renderGherkin({
        title: BASE_FIELDS.title, target: BASE_FIELDS.target || null,
        given: BASE_FIELDS.given, when: BASE_FIELDS.when, then: BASE_FIELDS.then,
        parameters: [{ name: 'case-a', inputs: { x: 1 }, expected: 'ok' }],
      }));
      const escapeAttr = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      expect(html).toContain(`data-raw="${escapeAttr(expectedRaw)}"`);
    });
```
**実装時の適合:** `createViaForm` の追加ペア引数の実シグネチャ(ui-testcase-detail.test.ts:107)と param フィールド名(:721 のテスト参照)、`BASE_FIELDS` の実値、hono/jsx の属性エスケープ実装(`&quot;` 等)に合わせて調整する。renderGherkin の import を当該テストファイルに追加(`import { renderGherkin } from '../../src/domain/gherkin';`)。

- [ ] **Step 4: 検証**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npm run test:unit && npm run test:workers
```
Expected: unit(gherkin.test.ts 含む)green、workers 385(+1)。ui-testcase-detail の S-13 既存 2 テストと testcases-read の「本文は renderGherkin 出力と完全一致」テストが green のままであること。

- [ ] **Step 5: Commit**
```bash
git add src/domain/gherkin.ts src/http/ui/testcase-detail.tsx tests/integration/ui-testcase-detail.test.ts
git commit -m "refactor: derive S-13 DOM and copy text from single buildGherkinLines (C3) + data-raw guard test"
```

---

### Task 6: maintenance エントリの設定結合分離(C10 + C11)

**意図的なセマンティクス変更**: cron(workers scheduled)と maintenance-cli は SESSION_SIGNING_KEYS を読まなくなる(不正な鍵でも maintenance は走る。鍵未設定の警告も出ない)。retention は専用最小リーダーで読む。

**Files:**
- Modify: `src/http/config.ts`(loadMaintenanceRetentionMs を export 追加)
- Modify: `src/entry/workers.ts:75-79`(depsFrom を最小化)
- Modify: `src/entry/maintenance-cli.ts:16,27,33`(loadConfig 依存排除)
- Modify: `tests/integration/entry.test.ts:99-…`(bootstrap 失敗テストを鍵非依存テストへ書き換え)
- Test: `tests/unit/config.test.ts`(新規)
- Modify: `README.md:109`(cron 例から SESSION_SIGNING_KEYS を除去)

**Interfaces:**
- Produces: `export function loadMaintenanceRetentionMs(env: Record<string, string | undefined>): number`(config.ts。既存 private `parsePositiveInt`+`DEFAULTS.observationRetentionMs` を再利用)

- [ ] **Step 1: config.ts に最小リーダーを追加(loadConfig の直後)**
```ts
/**
 * maintenance 系エントリ(workers scheduled / maintenance-cli)専用の最小リーダー(HANDOVER C10/C11)。
 * cron 実行は署名鍵・レートリミッタと無関係のため、loadConfig(= loadSigningKeys の警告/throw)を
 * 経由せず observation retention のみを読む。不正値は既定 90 日へフォールバック(起動を壊さない)。
 */
export function loadMaintenanceRetentionMs(env: Record<string, string | undefined>): number {
  return parsePositiveInt(env.OBSERVATION_RETENTION_MS, DEFAULTS.observationRetentionMs);
}
```

- [ ] **Step 2: 単体テスト(新規 `tests/unit/config.test.ts`)**
```ts
import { describe, expect, it } from 'vitest';
import { loadMaintenanceRetentionMs } from '../../src/http/config';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('loadMaintenanceRetentionMs(C10/C11 最小リーダー)', () => {
  it('未設定 → 既定 90 日', () => {
    expect(loadMaintenanceRetentionMs({})).toBe(90 * DAY_MS);
  });
  it('正整数文字列 → その値(distinct 値で識別)', () => {
    expect(loadMaintenanceRetentionMs({ OBSERVATION_RETENTION_MS: '12345' })).toBe(12345);
  });
  it('非数値・0 以下 → 既定へフォールバック', () => {
    expect(loadMaintenanceRetentionMs({ OBSERVATION_RETENTION_MS: 'abc' })).toBe(90 * DAY_MS);
    expect(loadMaintenanceRetentionMs({ OBSERVATION_RETENTION_MS: '-5' })).toBe(90 * DAY_MS);
    expect(loadMaintenanceRetentionMs({ OBSERVATION_RETENTION_MS: '0' })).toBe(90 * DAY_MS);
  });
});
```
実行(この時点で pass するのが正 — 既存 private 実装の薄い公開なので red フェーズは無い):
```bash
export PATH="$HOME/node22/bin:$PATH" && npx vitest run --config vitest.config.ts tests/unit/config.test.ts
```

- [ ] **Step 3: workers.ts の depsFrom(75-79 行)を最小化**
```ts
/** scheduled ハンドラ用の MaintenanceDeps。cron tick は storage+clock+retention だけでよく、
 * Auth/RateLimiter/署名鍵設定は組み立てない(C10。鍵設定の不備が cron maintenance を止めない)。 */
function depsFrom(env: Env): MaintenanceDeps {
  return {
    storage: createD1Storage(env.DB).storage,
    now: () => Date.now(), // GC-3: 実クロックを読むのは entry 層のみ
    retentionMs: loadMaintenanceRetentionMs(env as unknown as Record<string, string | undefined>),
  };
}
```
import へ `loadMaintenanceRetentionMs` を追加(`loadConfig` は fetch 側 buildDeps が使い続けるので残す)。`runScheduledMaintenance` の try/catch(97-109 行)は**そのまま維持**(catch スコープを広げない・狭めない。D1 バインディング異常などの防御)。

- [ ] **Step 4: maintenance-cli.ts の loadConfig 依存を排除**

16 行 `import { loadConfig } from '../http/config';` → `import { loadMaintenanceRetentionMs } from '../http/config';`
27 行 `const config = loadConfig(process.env);` → `const retentionMs = loadMaintenanceRetentionMs(process.env);`
33 行 `retentionMs: config.observationRetentionMs,` → `retentionMs,`
ファイル冒頭コメントに「署名鍵設定は読まない(C11)」の一文を追加。

- [ ] **Step 5: entry.test.ts の scheduled bootstrap 失敗テスト(99 行〜)を書き換え**

旧テスト(不正 SESSION_SIGNING_KEYS → `scheduled_maintenance_bootstrap_failed` ログ + スキップ)は前提が消える。同じ位置に新テスト:
```ts
  it('scheduled: SESSION_SIGNING_KEYS が不正でも maintenance は実行される(C10: cron は署名鍵を読まない)', async () => {
    // 期限切れ UI セッションを seed(:52 の既存テストと同じ fixture 構築を踏襲)
    // env だけ不正な署名鍵で上書きし、scheduled を実行 → セッションが削除されていること
    const badEnv = { ...env, SESSION_SIGNING_KEYS: '{not json' } as typeof env;
    /* :52 のテスト本文を badEnv で再現し、期限切れセッション削除を assert */
  });
```
**実装時の適合:** :52 の既存テスト本文(seed 方法・createScheduledController/createExecutionContext/waitOnExecutionContext の使い方)をそのまま流用し、env だけ差し替える。旧テストの「bootstrap 失敗ログ」assert は削除。:149 の実行時エラー伝播テストは無変更で green のはず。

- [ ] **Step 6: README の cron 例(109 行)から SESSION_SIGNING_KEYS を除去**

```
0 * * * * cd /path/to/tms-web-service && TMS_DB_PATH=/var/lib/tms/tms.sqlite node --import ./src/entry/node-ts-loader.mjs src/entry/maintenance-cli.ts >> /var/log/tms-maintenance.log 2>&1
```
近傍に一文追加: 「maintenance-cli は署名鍵設定(SESSION_SIGNING_KEYS)を読まない(必要なのは TMS_DB_PATH と OBSERVATION_RETENTION_MS のみ)。」

- [ ] **Step 7: 検証**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npm run test:unit && npm run test:workers
```
Expected: 全 green(entry.test.ts の書き換え分含む)。

- [ ] **Step 8: Commit**
```bash
git add src/http/config.ts src/entry/workers.ts src/entry/maintenance-cli.ts tests/integration/entry.test.ts tests/unit/config.test.ts README.md
git commit -m "refactor: decouple maintenance entries from session-key config (C10/C11)"
```

---

### Task 7: maintenance-cli ラッパーのテスト可能化+テスト(B8)

**Files:**
- Modify: `src/entry/maintenance-cli.ts:43-51`(failure ラッパーを export 関数へ抽出)
- Test: `tests/unit/maintenance-cli.test.ts`(新規)

**Interfaces:**
- Produces: `export async function maintenanceCliMain(dataPath?: string): Promise<void>`(失敗時: `maintenance_cli_failed` JSON を console.error + `process.exitCode = 1`。throw しない)

- [ ] **Step 1: ラッパー抽出**

`if (import.meta.main) { ... }` ブロック(43-51 行)を以下へ:
```ts
/** CLI 失敗ラッパー(B8: テスト可能にするため export。import.meta.main はこれを呼ぶだけ)。 */
export async function maintenanceCliMain(dataPath?: string): Promise<void> {
  try {
    await runMaintenanceCli(dataPath);
  } catch (err) {
    console.error(JSON.stringify({
      event: 'maintenance_cli_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void maintenanceCliMain();
}
```
(`runMaintenanceCli(dataPath)` は `dataPath === undefined` なら既存のデフォルト引数が効く。)

- [ ] **Step 2: テスト(新規 `tests/unit/maintenance-cli.test.ts`)**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { maintenanceCliMain, runMaintenanceCli } from '../../src/entry/maintenance-cli';

// 実 better-sqlite3 のファイル DB を使い、Database.prototype への spy で
// incremental_vacuum 呼び出しと close を観測する(注入シームが無いための正当な手段)。
describe('maintenance-cli(B8)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tms-maint-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0; // exitCode=1 を残すと vitest プロセス自体が失敗するため必ず復元
    rmSync(dir, { recursive: true, force: true });
  });

  it('runMaintenanceCli: maintenance 実行後に incremental_vacuum を発行し、close する', async () => {
    const pragmaSpy = vi.spyOn(Database.prototype, 'pragma');
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMaintenanceCli(join(dir, 'm.sqlite'));
    expect(pragmaSpy.mock.calls.some((args) => args[0] === 'incremental_vacuum')).toBe(true);
    expect(closeSpy).toHaveBeenCalled();
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('"event":"maintenance_run"'))).toBe(true);
  });

  it('maintenanceCliMain: 失敗時に maintenance_cli_failed JSON + exitCode=1(throw しない)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await maintenanceCliMain(join(dir, 'no-such-subdir', 'x.sqlite')); // SQLITE_CANTOPEN
    expect(process.exitCode).toBe(1);
    const line = errSpy.mock.calls.map((args) => String(args[0])).find((s) => s.includes('maintenance_cli_failed'));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string).event).toBe('maintenance_cli_failed');
  });

  it('maintenanceCliMain: 成功時は exitCode を汚さない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await maintenanceCliMain(join(dir, 'ok.sqlite'));
    expect(process.exitCode).not.toBe(1);
  });
});
```
**実装時の適合:** better-sqlite3 アダプタが構築時にマイグレーションを自走するか確認(`src/storage/adapters/better-sqlite3.ts`。node-entry テストが `:memory:` で setup を通せている事実から自走のはず)。しないなら成功系テストの前に必要スキーマ適用の既存手段を使う。

- [ ] **Step 3: 検証**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npm run test:unit
```
Expected: unit +3。

- [ ] **Step 4: Commit**
```bash
git add src/entry/maintenance-cli.ts tests/unit/maintenance-cli.test.ts
git commit -m "test: cover maintenance-cli wrapper via extracted maintenanceCliMain (B8)"
```

---

### Task 8: node エントリ serveStatic 経路のテスト(B9)

**Files:**
- Test: `tests/unit/node-entry.test.ts`(3 テスト追加)

**Interfaces:** Consumes: `createNodeApp(':memory:')` → `{ app }`(既存)。

- [ ] **Step 1: テスト追加(既存 describe 内、既存 beforeEach の env 設定をそのまま利用)**

```ts
  it('GET /app.css は serveStatic 経由で 200 + text/css を返す(B9)', async () => {
    const { app } = createNodeApp(':memory:');
    const res = await app.request('/app.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/css');
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it('GET /htmx.min.js は serveStatic 経由で 200 + javascript を返す(B9。postinstall 生成物)', async () => {
    const { app } = createNodeApp(':memory:');
    const res = await app.request('/htmx.min.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('javascript');
  });

  it('未マッチパスは serveStatic を素通りして統一 404 スキーマで返る(B9/GC-4)', async () => {
    const { app } = createNodeApp(':memory:');
    const res = await app.request('/no-such-asset-xyz.css');
    expect(res.status).toBe(404);
    /* 実装時の適合: createApp の notFound 応答(JSON error schema か)を確認して assert を確定。
       JSON なら: expect((await res.json() as any).error.code).toBe('NOT_FOUND') */
  });
```
serveStatic の root './public' は cwd 相対 = リポジトリルート(vitest 実行時 cwd)。`public/app.css` はコミット済み、`public/htmx.min.js` は postinstall 生成(npm install 済み前提 — テスト実行の前提条件と同一)。

- [ ] **Step 2: 検証 + Commit**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:unit
git add tests/unit/node-entry.test.ts
git commit -m "test: cover node entry serveStatic paths (B9)"
```

---

### Task 9: viewer 403 の明示テスト(B2)

**Files:**
- Test: `tests/integration/projects.test.ts`(PATCH describe に 1 追加)
- Test: `tests/integration/tokens.test.ts`(GET/DELETE describe に各 1 追加)

**Interfaces:** Consumes: `setupAndLogin` / `createProject` / `loginAs` / `cookieHeader` / `jsonReq`(helpers.ts)、tokens.test.ts のファイルローカル `loginAsRole(ctx, admin, role, email)`。

- [ ] **Step 1: projects.test.ts の PATCH describe に viewer 403 を追加(:115-130 の viewer 作成インラインスタイルを踏襲)**

```ts
    it('viewer: 403 FORBIDDEN(admin 限定)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'patch-viewer-svc');
      await ctx.app.request('/api/v1/users', jsonReq('POST', {
        email: 'viewer-patch@example.com', password: 'viewer-pass-1', display_name: 'Viewer', role: 'viewer',
      }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }));
      const viewer = await loginAs(ctx.app, 'viewer-patch@example.com', 'viewer-pass-1');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}`,
        jsonReq('PATCH', { name: 'should-not-apply' }, { Cookie: cookieHeader(viewer.jar), 'x-csrf-token': viewer.csrf ?? '' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
      // 識別: 名前が変わっていないこと
      const list = await ctx.app.request('/api/v1/projects', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(JSON.stringify(await list.json())).toContain('patch-viewer-svc');
    });
```

- [ ] **Step 2: tokens.test.ts の GET describe に viewer 403 を追加(:78-89 の viewer POST テストをミラー)**

```ts
    it('viewer: 403 FORBIDDEN(GET も admin 限定)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'tokens-get-viewer-svc');
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-tokens-get@example.com');
      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, {
        headers: { Cookie: cookieHeader(viewer.jar) },
      });
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });
```

- [ ] **Step 3: tokens.test.ts の DELETE describe に viewer 403 を追加(:282-298 の editor DELETE テストをミラー。トークン発行 → viewer で DELETE → 403 → トークンがまだ使える(または一覧に残る)ことまで assert)**

```ts
    it('viewer: 403 FORBIDDEN(DELETE も admin 限定)、トークンは失効しない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'tokens-del-viewer-svc');
      const token = await issueToken(ctx.app, admin, project.body.id, 'keep-alive');
      const listBefore = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      const idOf = (body: any) => body.items?.[0]?.id ?? body[0]?.id; // 実装時の適合: 既存 editor DELETE テストの ID 取得方法をそのまま使う
      const tokenId = idOf(await listBefore.json<any>());

      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-tokens-del@example.com');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens/${tokenId}`,
        { method: 'DELETE', headers: { Cookie: cookieHeader(viewer.jar), 'x-csrf-token': viewer.csrf ?? '' } },
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
      // 識別: 削除されていない(sync start がまだ通る or 一覧に残存 — editor 版テストと同じ検証手段を使う)
      void token;
    });
```
**実装時の適合:** editor 403 DELETE テスト(:282-298)の「削除されていないことの検証手段」と ID 取得をそのまま踏襲する(推測で書かない)。

- [ ] **Step 4: 検証 + Commit**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:workers
git add tests/integration/projects.test.ts tests/integration/tokens.test.ts
git commit -m "test: add viewer 403 coverage for projects PATCH and tokens GET/DELETE (B2)"
```

---

### Task 10: history の cross-org 404 + 不正カーソル(B3)

**Files:**
- Test: `tests/integration/testcases-read.test.ts`(history describe :414-480 に 2 追加)

**Interfaces:** Consumes: 既存 cross-org パターン(:339-357 の `ctx.storage.setupOrganization` + `createProject(orgScope)`)、`postTestCase` ローカルヘルパー、`FIXED_NOW`。

- [ ] **Step 1: cross-org 404 テスト(:339-357 を history URL でミラー)**

```ts
    it('他 org の :pid → 404(存在隠蔽)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();

      const otherOrg = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin-history@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });
      const otherProject = await ctx.storage.createProject(
        { organizationId: otherOrg.organization.id }, { name: 'other-org-project' }, FIXED_NOW,
      );
      const res = await ctx.app.request(
        `/api/v1/projects/${otherProject.id}/testcases/${createdBody.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });
```

- [ ] **Step 2: 不正カーソルは先頭ページへフォールバック(200)テスト**

```ts
    it('不正な cursor は 422 にせず先頭ページへフォールバックする(200。domain/cursor の decode null 仕様)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();

      const baseline = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${createdBody.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const baselineBody = await baseline.json<any>();
      expect(baseline.status).toBe(200);
      expect(baselineBody.items.length).toBeGreaterThan(0); // created 履歴が最低 1 件(非ゼロ識別)

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${createdBody.id}/history?cursor=not%40%40valid%24%24base64`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.items).toEqual(baselineBody.items); // 先頭ページと同一(フォールバックの識別)
    });
```
**実装時の適合:** レスポンス形(items/next_cursor 等)は既存 happy-path テスト(:415)の assert に合わせる。

- [ ] **Step 3: 検証 + Commit**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:workers
git add tests/integration/testcases-read.test.ts
git commit -m "test: history cross-org 404 and malformed-cursor fallback (B3)"
```

---

### Task 11: detail POST の occ_conflict 分岐テスト(B4)

**Files:**
- Test: `tests/integration/ui-testcase-detail.test.ts`(status / accept-fingerprint describe に各 1 追加)

**Interfaces:** Consumes: ファイルローカル `createViaForm`・`formReq`・`sqlStr`・`getDetail`、既存 happy-path(:431-459 status approve、:638-675 accept-fp)の fixture 手順。

- [ ] **Step 1: status POST の conflict テスト**

```ts
    it('古い version で status POST → 303 + flash=occ_conflict、状態は変わらない(B4)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'status-occ-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      // 並行更新をシミュレート(version=2 へ)
      await ctx.rawExec(`UPDATE test_cases SET version = 2 WHERE id = ${sqlStr(id)}`);

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/status`,
        formReq({ status: 'approved', version: '1', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location') ?? '').toContain('flash=occ_conflict');

      const { html } = await getDetail(ctx, admin.jar, project.id, id);
      expect(tagText(html, 'display-status')).toContain('draft'); // 変化していない(識別)
    });
```
**実装時の適合:** status フォームのフィールド名(status/version/_csrf)と display-status の表示文字列は既存 happy-path(:431-459)から正確に写す。

- [ ] **Step 2: accept-fingerprint POST の conflict テスト(:638-675 の drift fixture + version ずらし)**

```ts
    it('古い version で accept-fingerprint POST → 303 + tab=diff&flash=occ_conflict、drift は残る(B4)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'acceptfp-occ-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      /* :638-675 と同じ drift セットアップ(seedCommittedObservation 等)を行った上で version も 2 に:
         UPDATE test_cases SET drift = 1, fingerprint = 'old-fp', version = 2 WHERE id = ... */

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/accept-fingerprint`,
        formReq({ version: '1', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(303);
      const loc = res.headers.get('location') ?? '';
      expect(loc).toContain('tab=diff');
      expect(loc).toContain('flash=occ_conflict');
      /* 識別: drift が 1 のまま(diff タブ or DB を既存テストと同じ手段で確認) */
    });
```
**実装時の適合:** drift fixture は既存 accept-fp happy-path テストの手順を丸ごと踏襲し、version だけ 2 に上げて POST は version:'1' を送る。

- [ ] **Step 3: サボタージュ検証(識別性の証明、コミットしない)**

`testcase-detail.tsx` の status conflict 分岐の `occ_conflict` を一時的に `testcase_updated` へ変え、Step 1 のテストが FAIL することを確認 → 直ちに revert。
```bash
export PATH="$HOME/node22/bin:$PATH" && npx vitest run --config vitest.workers.config.ts tests/integration/ui-testcase-detail.test.ts -t 'occ_conflict'
git checkout -- src/http/ui/testcase-detail.tsx
```

- [ ] **Step 4: 検証 + Commit**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:workers
git add tests/integration/ui-testcase-detail.test.ts
git commit -m "test: cover occ_conflict redirects for status/accept-fingerprint POST (B4)"
```

---

### Task 12: parameters 100KB 上限の回帰テスト(B5)

**Files:**
- Test: `tests/integration/ui-testcase-detail.test.ts`(edit describe、metadata 10KB テスト :336-362 の隣に 2 追加)

- [ ] **Step 1: 超過(>100KB)→ 拒否テスト(:336-362 をミラー、param 行で超過させる)**

```ts
    it('編集保存: parameters が byte 上限(100KB)を超える → 保存されず 200 で再描画(B5)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'edit-param-cap-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const version = await getEditVersion(ctx, admin.jar, project.id, id);

      // JSON.stringify(parameters) が 100*1024 bytes を超える巨大 inputs(JSON テキストとして正当)
      const hugeInputs = JSON.stringify({ big: 'x'.repeat(105 * 1024) });
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        multiFormReq(
          [
            ...Object.entries({ ...BASE_FIELDS, version: String(version), _csrf: admin.csrf ?? '' }),
            ['param_name[]', 'huge'], ['param_inputs[]', hugeInputs], ['param_expected[]', 'ok'],
          ],
          { Cookie: cookieHeader(admin.jar) },
        ),
      );
      expect(res.status).toBe(200);
      expect(hasTag(await res.text(), 'edit-form-error')).toBe(true);
      const { html: detailHtml } = await getDetail(ctx, admin.jar, project.id, id);
      expect(tagText(detailHtml, 'display-version')).toBe('バージョン: 1'); // 保存されていない(識別)
    });
```

- [ ] **Step 2: 上限内(~90KB)→ 保存成功テスト(境界の識別: 上限値が判定要因であることの証明)**

```ts
    it('編集保存: parameters が上限内(~90KB)なら保存される(B5 境界の対照)', async () => {
      /* 同じ手順で 90*1024 bytes 程度の inputs → res.status 303、display-version が 2 になる */
    });
```

- [ ] **Step 3: 検証 + Commit**

param フィールド名(`param_name[]` 等)は既存テスト(:721 周辺)から正確に写す。
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:workers
git add tests/integration/ui-testcase-detail.test.ts
git commit -m "test: parameters 100KB byte-cap rejection and under-limit save (B5)"
```

---

### Task 13: パスワード上限 128 字の拒否テスト(B6 / D-06)

**Files:**
- Test: `tests/integration/users.test.ts`(reset-password API に 1)
- Test: `tests/integration/auth.test.ts`(PATCH /auth/password に 1)
- Test: `tests/integration/ui-admin.test.ts`(S-19 reset UI・S-19 user-create UI・S-20 profile UI に各 1)

すべて `'a'.repeat(129)` を使用。**注意(探索で確認済みの現行仕様):** SSR 側は max 超過も min 文言(「8文字以上」)で拒否するため、SSR テストは**文言でなく拒否の事実**(200 + エラー tag + パスワード不変)を assert する。

- [ ] **Step 1: API — reset-password 422(users.test.ts の既存 min テスト :154-167 スタイル)**

```ts
    it('new_password が 129 文字(上限 128 超) → 422 VALIDATION_FAILED(D-06)', async () => {
      /* setupAndLogin → 対象ユーザー作成 → POST /api/v1/users/:id/reset-password
         { new_password: 'a'.repeat(129) } → 422、details path 'new_password' */
    });
```

- [ ] **Step 2: API — PATCH /auth/password 422(auth.test.ts)**

```ts
    it('new_password が 129 文字 → 422 VALIDATION_FAILED(D-06 上限)', async () => {
      /* setupAndLogin → PATCH /api/v1/auth/password
         { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: 'a'.repeat(129) }
         (csrf ヘッダ付き)→ 422、details path 'new_password' */
    });
```

- [ ] **Step 3: UI — S-19 reset(ui-admin.test.ts :744-757 ミラー)**

129 字を POST → 200 + `user-reset-password-input` 再表示系 assert + **旧パスワードで引き続きログインできる**(リセットされていない識別)。

- [ ] **Step 4: UI — S-19 user-create(:570-578 ミラー)**

129 字 → 200 + `user-password-error` tag 表示 + 当該 email でログイン不能(作成されていない)。

- [ ] **Step 5: UI — S-20 profile(:844-852 ミラー)**

129 字 → 200 + `password-new-error` tag 表示 + 旧パスワードが引き続き有効。

- [ ] **Step 6: 検証 + Commit**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:workers
git add tests/integration/users.test.ts tests/integration/auth.test.ts tests/integration/ui-admin.test.ts
git commit -m "test: reject >128-char passwords across S-19/S-20 flows (B6, D-06)"
```

---

### Task 14: 入力スキーマの直接単体テスト(B1)

**Files:**
- Test: `tests/unit/schemas.test.ts`(拡張。既存スタイル: `safeParse(...).success` boolean)

対象(探索で「直接テスト無し」と確定した全量): `setupInput` `loginInput` `changePasswordInput` `createUserInput` `patchUserInput` `resetPasswordInput` `createProjectInput` `patchProjectInput` `createTokenInput` `patchTestCaseInput` `listTestCasesQuery` `pageQuery` `observationsQuery`(api.ts)、`nameSchema` `emailSchema` `repoUrlSchema`(limits.ts)、`parametersSchema` `metadataSchema` `sourceRefSchema` `confidenceSchema`(entities.ts)、`syncStartInput` `syncChunkInput`(sync.ts)。

- [ ] **Step 1: describe を追加(スキーマごとに境界+型+識別)**

方針(全 describe 共通):
- 文字数境界は min-1 / min / max / max+1 の 4 点(例: nameSchema 0/1/100/101)。
- enum は正値 1 つ+不正値 1 つ。
- optional/nullable の別を明示(patch 系: `{}` は success、`{ target: null }` は success、`{ title: '' }` は fail 等)。
- coerce 系 query は文字列入力(`'50'` → 50、`'0'`/`'101'` fail、未指定 → default 50)を parsed.data の実値で assert(識別)。
- boolParam(`listTestCasesQuery.drift`)は `'true'`→true / `'false'`→false / `'1'` fail を parsed.data で assert。
- byte 上限(parametersSchema 100KB / metadataSchema 10KB)は境界直下 pass / 直上 fail(`'x'.repeat` で JSON バイト数を制御)。
- `syncChunkInput` は 0 件 fail / 1 件 pass / 501 件 fail(500 は MAX_CHUNK_SIZE)。
- 識別テスト原則: 少なくとも各オブジェクトスキーマ 1 箇所で `parsed.data.<field>` が入力の distinct 値と一致することを assert(型が通るだけの偽 green を防ぐ)。

コード例(スタイル見本 — 全スキーマ分をこの形で書く):
```ts
describe('createProjectInput(B1)', () => {
  it('name 1..100 + repo_url は http/https のみ・省略可', () => {
    expect(createProjectInput.safeParse({ name: 'p1' }).success).toBe(true);
    expect(createProjectInput.safeParse({ name: '' }).success).toBe(false);
    expect(createProjectInput.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(createProjectInput.safeParse({ name: 'p1', repo_url: 'https://example.com/r.git' }).success).toBe(true);
    expect(createProjectInput.safeParse({ name: 'p1', repo_url: 'ftp://example.com/r' }).success).toBe(false);
    const parsed = createProjectInput.safeParse({ name: 'distinct-name-42' });
    expect(parsed.success && parsed.data.name).toBe('distinct-name-42');
  });
});
```

- [ ] **Step 2: 検証 + Commit**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:unit
git add tests/unit/schemas.test.ts
git commit -m "test: direct unit coverage for all input schemas (B1)"
```

---

### Task 15: node-ts-loader の diagnostics 報告(D1)

**Files:**
- Modify: `src/entry/node-ts-loader.mjs:60-68`(load フック)
- Test: `tests/unit/node-ts-loader.test.ts`(新規、spawnSync スモーク)

- [ ] **Step 1: load フックに reportDiagnostics を追加**

64-65 行を以下へ:
```js
      const { outputText, diagnostics } = ts.transpileModule(source, {
        compilerOptions, fileName: path, reportDiagnostics: true,
      });
      if (diagnostics && diagnostics.length > 0) {
        // transpile 段階の構文エラーを不明瞭なランタイム SyntaxError にしない(HANDOVER D1)。
        const message = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCurrentDirectory: () => projectRoot,
          getCanonicalFileName: (f) => f,
          getNewLine: () => '\n',
        });
        throw new Error(`node-ts-loader: TypeScript transpile diagnostics for ${path}\n${message}`);
      }
      return { format: 'module', shortCircuit: true, source: outputText };
```

- [ ] **Step 2: spawnSync スモークテスト(新規 `tests/unit/node-ts-loader.test.ts`)**

```ts
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LOADER = resolve(__dirname, '../../src/entry/node-ts-loader.mjs');

function runNode(entry: string) {
  return spawnSync(process.execPath, ['--import', LOADER, entry], { encoding: 'utf8', timeout: 30_000 });
}

describe('node-ts-loader(D1)', () => {
  it('正当な TS はロードできる(対照)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-loader-'));
    try {
      const f = join(dir, 'ok.ts');
      writeFileSync(f, "const n: number = 42;\nconsole.log(`ok:${n}`);\n");
      const r = runNode(f);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ok:42');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('構文エラー TS は明確な diagnostics 付きで fail する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-loader-'));
    try {
      const f = join(dir, 'broken.ts');
      writeFileSync(f, 'const x: = 1;\n');
      const r = runNode(f);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('node-ts-loader: TypeScript transpile diagnostics');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```
**実装時の適合:** `__dirname` は ESM テストで使えない場合 `new URL('../../src/entry/node-ts-loader.mjs', import.meta.url)` 経由に(vitest は既定 CJS 変換だが、リポジトリのテスト実態に合わせる)。spawn 2 回で +2〜3 秒程度は許容。

- [ ] **Step 3: 手動スモーク(既存エントリが壊れていないこと)**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:unit && node --import ./src/entry/node-ts-loader.mjs -e "console.log('loader ok')"
```

- [ ] **Step 4: Commit**
```bash
git add src/entry/node-ts-loader.mjs tests/unit/node-ts-loader.test.ts
git commit -m "feat: surface TypeScript transpile diagnostics in node-ts-loader (D1)"
```

---

### Task 16: node-ts-loader の sourcemap 対応(D2)

**Files:**
- Modify: `src/entry/node-ts-loader.mjs`(inlineSourceMap)
- Modify: `package.json:11-12`(start:node / maintenance:node に `--enable-source-maps`)
- Test: `tests/unit/node-ts-loader.test.ts`(1 追加)

- [ ] **Step 1: transpile オプションに inline sourcemap を追加**

Task 15 で変えた transpileModule 呼び出しの compilerOptions を:
```js
      const { outputText, diagnostics } = ts.transpileModule(source, {
        // tsconfig は noEmit:true のため sourceMap 系はここでだけ上書きする(tsc --noEmit は sourceMap と併用不可)。
        compilerOptions: { ...compilerOptions, sourceMap: false, inlineSourceMap: true, inlineSources: true },
        fileName: path, reportDiagnostics: true,
      });
```

- [ ] **Step 2: package.json の 2 スクリプトへ `--enable-source-maps` を追加**

```json
    "start:node": "node --enable-source-maps --import ./src/entry/node-ts-loader.mjs src/entry/node.ts",
    "maintenance:node": "node --enable-source-maps --import ./src/entry/node-ts-loader.mjs src/entry/maintenance-cli.ts",
```

- [ ] **Step 3: スタックトレース検証テスト(loader テストに追加)**

```ts
  it('throw の stack が .ts の元行番号で出る(D2: inline sourcemap + --enable-source-maps)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-loader-'));
    try {
      const f = join(dir, 'boom.ts');
      writeFileSync(f, "const pad: number = 1;\nvoid pad;\n\nthrow new Error('boom-at-line-4');\n");
      const r = spawnSync(process.execPath, ['--enable-source-maps', '--import', LOADER, f], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('boom-at-line-4');
      expect(r.stderr).toMatch(/boom\.ts:4/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
```

- [ ] **Step 4: 検証 + Commit**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run test:unit && npm run typecheck
git add src/entry/node-ts-loader.mjs package.json tests/unit/node-ts-loader.test.ts
git commit -m "feat: inline sourcemaps in node-ts-loader + --enable-source-maps for node scripts (D2)"
```

---

### Task 17: 総仕上げ(全スイート・HANDOVER 追随・レビュー・統合)

- [ ] **Step 1: 全スイート + typecheck**
```bash
export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npm test
```
Expected: 全 green(開始時 760 から増加)。

- [ ] **Step 2: HANDOVER §4.2 冒頭に状況更新を 1 行追記(実装済みの事実のみ)**

```
> **2026-07-04 更新:** 本節の B1-B9・C1-C3・C10-C11・A2-A3・D1-D3 は品質スプリント(plans/2026-07-04-post-mvp-quality-sprint.md)で消化済み。C8 は検証の結果「既に統一済み・変更不要」。C5/C6/C9 は既録の判断のまま据え置き。
```

- [ ] **Step 3: コミット後、superpowers:requesting-code-review でスプリント全 diff をレビュー(観点: §3.2 実装標準 + §5 教訓、特に catch スコープ・識別テスト・挙動保存)。指摘は修正して再検証。**

- [ ] **Step 4: superpowers:finishing-a-development-branch に従い main へ ff-merge(確立済みパターン)。push はユーザー依頼事項(権限分類器により本セッションから不可)。**
