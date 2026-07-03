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
  /**
   * authn ミドルウェア専用・scope なし。APIハンドラでは使用禁止(GC-5 の唯一の例外)。
   * セッション→ユーザー解決の時点では org がまだ判明していない(Session 行は user_id のみ持つ)ため、
   * org スコープを要求できない。ここで得た UserRow から org を確定させた後は、以後の全ハンドラ処理が
   * 通常の scope 付きメソッド(getUser 等)を経由すること。
   */
  getUserById(id: string): Promise<UserRow | null>;
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
