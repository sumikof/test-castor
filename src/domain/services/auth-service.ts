// src/domain/services/auth-service.ts
// task-17-brief.md: ログイン/セットアップの共通ビジネスロジックを抽出し、API ルート(src/http/api/auth.ts,
// setup.ts)と UI ルート(src/http/ui/auth-pages.tsx)が同一関数を呼ぶ(内部 HTTP 往復はしない =
// 承認済みアプローチ A。UI タスク共通事項)。
//
// レイヤリング: 既存の src/domain/*.ts はいずれも ../schemas・../storage/schema のみを import し、
// ../http/* には依存しない(HTTP 層 → domain 層の一方向依存)。本ファイルもこの規約に従い、
// src/http/config.ts の AppConfig 型を import しない — 必要な設定値(sessionTtlMs)だけを
// 最小のローカル型として宣言する。呼び出し側(AppDeps を持つ HTTP ルート)は AppDeps がこの
// ローカル型を構造的に満たす(config.sessionTtlMs を含む superset)ため、そのまま deps を渡せる。
import type { Storage } from '../../storage/interface';
import type { Auth } from '../../auth/interface';
import type { RateLimiter } from '../../ratelimit/interface';
import type { UserRow, OrganizationRow } from '../../storage/schema';

export interface LoginServiceDeps {
  storage: Storage;
  auth: Auth;
  config: { sessionTtlMs: number };
  loginLimiter: RateLimiter;
  now(): number;
}

export interface LoginServiceInput {
  email: string;
  password: string;
  ip: string;
}

export type LoginResult =
  | { ok: true; user: UserRow; sessionId: string }
  | { ok: false; reason: 'rate_limited'; retryAfterSec: number }
  | { ok: false; reason: 'invalid' };

/**
 * apis/auth.md の POST /login 本体(task-8 由来をそのまま抽出)。Cookie 発行・HTTP レスポンスの
 * 組み立ては呼び出し側の責務(API は JSON + Set-Cookie で 200、UI は 303 リダイレクト + Set-Cookie
 * で異なるため、ここでは sessionId のみ返しシリアライズ・Cookie書き込みはしない)。
 */
export async function loginUser(deps: LoginServiceDeps, input: LoginServiceInput): Promise<LoginResult> {
  const key = `login:${input.email}:${input.ip}`;

  // 事前チェック(consume:false): 既にブロック中なら検証すら行わず429(D-14)。
  const gate = await deps.loginLimiter.limit(key, { consume: false });
  if (!gate.allowed) {
    return { ok: false, reason: 'rate_limited', retryAfterSec: gate.retryAfterSec ?? 60 };
  }

  const user = await deps.storage.findUserForLogin(input.email);
  // 未知 email(user=null)・パスワード未設定でも、既知 email+誤りパスワードと同じコストの PBKDF2 を
  // 必ず1回実行させる(タイミングサイドチャネルによるユーザー列挙対策。auth-security.md「タイミング攻撃対策」)。
  const result = await deps.auth.verifyPassword(input.password, user?.passwordHash ?? null);

  if (!user || !result.ok) {
    // 失敗した試行のみ consume する(正しいパスワードの試行はカウントしない非対称レート制限)。
    await deps.loginLimiter.limit(key);
    // D-11: 認証失敗監査は構造化 JSON ログのみ(D1 監査テーブルは持たない)。
    console.warn(JSON.stringify({ event: 'auth_failure', email: input.email, ip: input.ip, at: deps.now() }));
    return { ok: false, reason: 'invalid' };
  }

  const scope = { organizationId: user.organizationId };
  if (result.needsRehash) {
    // 透過再ハッシュ: 旧イテレーション数の PHC を検出したら現行設定で再ハッシュして保存する
    // (auth-security.md「透過再ハッシュ」)。
    await deps.storage.setUserPassword(scope, user.id, await deps.auth.hashPassword(input.password), deps.now());
  }
  await deps.storage.touchLastLogin(scope, user.id, deps.now()); // D-05: last_login_at 更新

  // セッション固定攻撃対策: ログイン成功時は必ず新規セッションIDを発行する(auth-security.md「不変条件」)。
  const sessionId = deps.auth.newSessionId();
  await deps.storage.createSession({
    id: sessionId,
    userId: user.id,
    expiresAt: deps.now() + deps.config.sessionTtlMs,
    createdAt: deps.now(),
  });

  return { ok: true, user, sessionId };
}

export interface SetupServiceDeps {
  storage: Storage;
  auth: Auth;
  now(): number;
}

export interface SetupOrgInput {
  orgName: string;
  adminEmail: string;
  adminPassword: string;
  adminDisplayName: string;
}

export interface SetupOrgResult {
  organization: OrganizationRow;
  user: UserRow;
}

/**
 * apis/setup.md の POST /setup 本体(task-8 由来をそのまま抽出)。呼び出し側が
 * `countOrganizations()` の事前チェック(409 判定 or /login リダイレクト判定)を行ってから呼ぶ。
 */
export async function setupOrg(deps: SetupServiceDeps, input: SetupOrgInput): Promise<SetupOrgResult> {
  const adminPasswordHash = await deps.auth.hashPassword(input.adminPassword);
  return deps.storage.setupOrganization({
    orgName: input.orgName,
    adminEmail: input.adminEmail,
    adminPasswordHash,
    adminDisplayName: input.adminDisplayName,
    now: deps.now(),
  });
}
