// tests/integration/helpers.ts
// 統合テストハーネス(task-8-brief.md「テストハーネス」)。D1(miniflare binding)+ 固定クロック +
// 低イテレーション Auth + メモリ RateLimiter で実アプリ(createApp)を組み立てる。以後のタスクの
// 統合テストもここを共通基盤として再利用する想定のため、汎用に保つ(auth 固有のロジックは
// setupAndLogin/loginAs のみに閉じる)。
import { env } from 'cloudflare:test';
import type { Hono } from 'hono';
import { createApp, type AppDeps, type AppEnv } from '../../src/http/app';
import type { Storage } from '../../src/storage/interface';
import { createD1Storage } from '../../src/storage/adapters/d1';
import { createWebcryptoAuth } from '../../src/auth/webcrypto-auth';
import { createMemoryRateLimiter } from '../../src/ratelimit/memory';
import { loadConfig, type AppConfig } from '../../src/http/config';
import { CSRF_COOKIE } from '../../src/http/middleware/csrf';

/** 全テストの起点クロック値(既存テスト群と同じ規約に合わせる)。 */
export const FIXED_NOW = 1_700_000_000_000;

export type RawExec = (sqlText: string) => Promise<void>;

/**
 * FK依存の子→親順(tests/contract/storage-contract.ts の WIPE_ORDER と同じ規約)。
 * auth.test.ts が使うのは users/sessions/organizations だけだが、本ハーネスは以後のタスクの
 * 統合テストにも再利用される想定のため全テーブルを対象にする。
 */
const WIPE_ORDER = [
  'test_case_history', 'test_case_observations', 'sync_seen', 'sync_staging', 'sync_sessions',
  'test_case_identities', 'test_cases', 'api_tokens', 'sessions', 'projects', 'users', 'organizations',
];

/** 全テーブルを DELETE して次のテストに備える(D1 はテスト間で状態が残るため beforeEach で呼ぶ)。 */
export async function wipe(rawExec: RawExec): Promise<void> {
  for (const table of WIPE_ORDER) await rawExec(`DELETE FROM ${table}`);
}

export interface TestApp {
  app: Hono<AppEnv>;
  deps: AppDeps;
  storage: Storage;
  rawExec: RawExec;
  /** クロックを指定値に固定する。 */
  setNow(t: number): void;
  /** クロックを ms 進める。 */
  advance(ms: number): void;
}

/**
 * D1 storage(env.DB) + 固定クロック + iter=1000 の WebCrypto Auth + メモリ RateLimiter で
 * createApp を構築する。600,000 回の本番 PBKDF2 反復ではテストが極端に遅くなるため、
 * テスト専用に低イテレーション(1000)の Auth インスタンスを直接構築する(config.pbkdf2Iterations は
 * loadConfig の既定値(600,000)のままで構わない — 実行時に config から Auth を再構築する経路は
 * entry/workers.ts 側の責務であり、本ハーネスは deps.auth を直接注入するためこの値は参照されない)。
 *
 * configOverrides(task-16-brief.md): 既定の loadConfig 出力を部分的に上書きできる(例: commit の
 * mid-commit 再開シナリオで `commitWindowLimit` を小さい値に注入する)。全既存呼び出し元
 * (`makeTestApp()` 引数無し)は本パラメータ追加前と完全に同一の挙動のまま。
 */
export async function makeTestApp(configOverrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const { storage, rawExec } = createD1Storage(env.DB);
  let now = FIXED_NOW;
  const clock = () => now;

  const auth = createWebcryptoAuth({ signingKeys: { k1: 'test' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
  const config = {
    ...loadConfig({ SESSION_SIGNING_KEYS: JSON.stringify({ k1: 'test' }), SESSION_ACTIVE_KEY_ID: 'k1' }),
    ...configOverrides,
  };
  const loginLimiter = createMemoryRateLimiter(config.loginRateLimit, clock);
  const syncLimiter = createMemoryRateLimiter(config.syncRateLimit, clock);

  const deps: AppDeps = { storage, auth, config, loginLimiter, syncLimiter, now: clock };
  const app = createApp(deps);

  return {
    app,
    deps,
    storage,
    rawExec,
    setNow: (t: number) => { now = t; },
    advance: (ms: number) => { now += ms; },
  };
}

/** Set-Cookie ヘッダ(複数本)を { name: value } の jar に変換する(属性は捨てる。属性込みで検証したい場合は res.headers.getSetCookie() を直接使う)。 */
export function cookiesFrom(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const firstSegment = raw.split(';', 1)[0] ?? '';
    const eq = firstSegment.indexOf('=');
    if (eq === -1) continue;
    const name = firstSegment.slice(0, eq).trim();
    const value = firstSegment.slice(eq + 1).trim();
    jar[name] = value;
  }
  return jar;
}

/** jar を `Cookie:` リクエストヘッダ値に組み立てる(cookiesFrom の逆操作)。 */
export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
}

export interface LoginResult {
  res: Response;
  body: any;
  jar: Record<string, string>;
  csrf: string | undefined;
  user: any;
}

/** POST /api/v1/auth/login を実行する。失敗時(401/429)も呼べるよう例外は投げない。 */
export async function loginAs(app: Hono<AppEnv>, email: string, password: string): Promise<LoginResult> {
  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const jar = cookiesFrom(res);
  const body = await res.json<any>();
  return { res, body, jar, csrf: jar[CSRF_COOKIE], user: body?.user };
}

export interface SetupAndLoginResult {
  jar: Record<string, string>;
  csrf: string | undefined;
  user: any;
}

export const DEFAULT_SETUP_BODY = {
  organization_name: 'Acme',
  admin_email: 'admin@example.com',
  admin_password: 'admin-pass-1',
  admin_display_name: 'Admin Taro',
};

/** POST /api/v1/setup → POST /api/v1/auth/login を実行し、ログイン結果を返す。既定の組織/管理者は上書き可能。 */
export async function setupAndLogin(
  app: Hono<AppEnv>,
  overrides: Partial<typeof DEFAULT_SETUP_BODY> = {},
): Promise<SetupAndLoginResult> {
  const setupBody = { ...DEFAULT_SETUP_BODY, ...overrides };
  const setupRes = await app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(setupBody),
  });
  if (setupRes.status !== 201) {
    throw new Error(`setupAndLogin: setup failed with status ${setupRes.status}: ${await setupRes.text()}`);
  }
  const login = await loginAs(app, setupBody.admin_email, setupBody.admin_password);
  if (login.res.status !== 200) {
    throw new Error(`setupAndLogin: login failed with status ${login.res.status}: ${JSON.stringify(login.body)}`);
  }
  return { jar: login.jar, csrf: login.csrf, user: login.user };
}

/**
 * POST /api/v1/projects を実行する(task-10-brief.md「テストヘルパ追記」。以後のタスク(トークン/
 * テストケース API 等)がプロジェクト前提を満たすために共有する)。admin セッションの jar/csrf
 * (setupAndLogin/loginAs の戻り値をそのまま渡せる)が必要。失敗時(403/422等)も呼べるよう例外は投げない。
 */
export async function createProject(
  app: Hono<AppEnv>,
  adminCtx: { jar: Record<string, string>; csrf?: string },
  name: string,
  repoUrl?: string | null,
): Promise<{ res: Response; body: any }> {
  const res = await app.request('/api/v1/projects', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookieHeader(adminCtx.jar),
      'x-csrf-token': adminCtx.csrf ?? '',
    },
    body: JSON.stringify({ name, ...(repoUrl !== undefined ? { repo_url: repoUrl } : {}) }),
  });
  const body = await res.json<any>();
  return { res, body };
}

/**
 * POST /api/v1/projects/:pid/tokens を実行し、発行された平文トークンだけを返す(task-11-brief.md
 * 「テストヘルパ追記」)。平文はこの応答限りでしか取得できない(auth-security.md「平文の隔離」)ため、
 * 以後のタスク(同期プロトコルの統合テスト等)が Bearer 認証を組み立てる際の唯一の入手経路になる。
 * admin セッションの jar/csrf が必要。失敗時(403/422等)は例外を投げる(createProject と異なり
 * Promise<string> しか返せないため、呼び出し側は「発行成功」を前提にできる契約にする)。
 */
export async function issueToken(
  app: Hono<AppEnv>,
  adminCtx: { jar: Record<string, string>; csrf?: string },
  pid: string,
  name: string,
): Promise<string> {
  const res = await app.request(`/api/v1/projects/${pid}/tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookieHeader(adminCtx.jar),
      'x-csrf-token': adminCtx.csrf ?? '',
    },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) {
    throw new Error(`issueToken: issue failed with status ${res.status}: ${await res.text()}`);
  }
  const body = await res.json<any>();
  return body.token;
}
