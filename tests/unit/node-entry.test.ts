// tests/unit/node-entry.test.ts
// task-23-brief.md Step 1(GC-2 TDD): createNodeApp(':memory:') で GET / が 302(/setup へ、まだ
// Organization が0件のため)、POST /api/v1/setup が 201(組織+管理者を作成)であることを、
// listen せず app.request() で検証する(src/entry/node.ts の main()/serve() は import.meta.main
// ガードにより、このテストからの import では実行されない)。
//
// SESSION_SIGNING_KEYS を明示的に注入するのは、vitest.workers.config.ts が workers pool 統合テストに
// 対して行っているのと同じ理由: 未設定だと createNodeApp() 内部の loadConfig(process.env) が dev
// フォールバックの console.warn を毎回踏み、テスト出力が pristine でなくなるため。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createNodeApp } from '../../src/entry/node';

const ORIGINAL_ENV = { ...process.env };

describe('entry/node: createNodeApp', () => {
  beforeEach(() => {
    process.env.SESSION_SIGNING_KEYS = JSON.stringify({ k1: 'test-signing-key-node-entry' });
    process.env.SESSION_ACTIVE_KEY_ID = 'k1';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('GET / は組織0件のとき302で/setupへリダイレクトする(Locationヘッダで判別。200/404等ではない)', async () => {
    const { app } = createNodeApp(':memory:');

    const res = await app.request('/', { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/setup');
  });

  it('POST /api/v1/setup は201で組織+管理者を作成する(body shapeを検証。ステータスだけでは作成物の正しさを判別できない)', async () => {
    const { app } = createNodeApp(':memory:');

    const res = await app.request('/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_name: 'NodeOrg',
        admin_email: 'node-admin@example.com',
        admin_password: 'node-pass-1',
        admin_display_name: 'Node Admin',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<any>();
    expect(body.organization.name).toBe('NodeOrg');
    expect(typeof body.organization.id).toBe('string');
    expect(body.user.email).toBe('node-admin@example.com');
    expect(body.user.display_name).toBe('Node Admin');
    expect(body.user.role).toBe('admin');
    // apis/setup.md のレスポンス仕様は5フィールドのみ。パスワード関連の値が漏れていないことも確認する。
    expect(body.user.password_hash).toBeUndefined();

    // 2回目の GET / はこの:memory: DBに対して行われ、既にorgが存在するため /login へ(D-13-1)。
    // createNodeApp が返す app が実際にこのstorageインスタンスに配線されていることの追加証拠。
    const rootRes = await app.request('/', { redirect: 'manual' });
    expect(rootRes.status).toBe(302);
    expect(rootRes.headers.get('location')).toBe('/login');
  });

  it('createNodeApp(":memory:") の各呼び出しは独立したstorageを持つ(状態を共有しない)', async () => {
    const first = createNodeApp(':memory:');
    const setupRes = await first.app.request('/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_name: 'FirstOrg',
        admin_email: 'first@example.com',
        admin_password: 'first-pass-1',
        admin_display_name: 'First',
      }),
    });
    expect(setupRes.status).toBe(201);

    const second = createNodeApp(':memory:');
    const res = await second.app.request('/', { redirect: 'manual' });
    // 2つ目のインスタンスが1つ目とstorageを共有していれば/loginになるはずだが、
    // 独立した:memory: DBであれば0件のまま/setupへ。
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/setup');
  });

  // --- B9(HANDOVER §4.2): serveStatic 経路。root './public' は cwd 相対 = リポジトリルート
  // (vitest 実行時 cwd)。app.css/logo.svg はコミット済み、htmx.min.js は postinstall 生成物
  // (npm install 済みがテスト実行の前提条件なので依存してよい)。 ---

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

  it('未マッチパスは serveStatic を素通りして統一 404 スキーマ(GC-4)で返る(B9)', async () => {
    const { app } = createNodeApp(':memory:');
    const res = await app.request('/no-such-asset-xyz.css');
    expect(res.status).toBe(404);
    const body = await res.json<any>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.retryable).toBe(false);
  });
});
