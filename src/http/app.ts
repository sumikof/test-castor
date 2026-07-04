// src/http/app.ts
// アプリの土台: deps 注入・Env 型・Actor 型・RBAC ランク表・createApp 組み立て。
// 以後の全タスクが AppEnv/AppDeps/Actor/ROLE_RANK をここから import する(GC-6: D1/workers-types は
// import しない。Storage/Auth インターフェース越しにのみ実装へ依存する)。
import { Hono } from 'hono';
import type { Storage } from '../storage/interface';
import type { Auth } from '../auth/interface';
import type { UserRow, ApiTokenRow, ProjectRow } from '../storage/schema';
import type { Role } from '../schemas/enums';
import type { AppConfig } from './config';
import type { RateLimiter } from '../ratelimit/interface';
import { AppError } from './errors';
import { errorMiddleware } from './middleware/error';
import { setupRoutes } from './api/setup';
import { authRoutes } from './api/auth';
import { usersRoutes } from './api/users';
import { projectsRoutes } from './api/projects';
import { tokensRoutes } from './api/tokens';
import { testCasesRoutes } from './api/testcases';
import { syncRoutes } from './api/sync';
import { authPageRoutes } from './ui/auth-pages';
import { projectPageRoutes } from './ui/projects-pages';
import { testCasePageRoutes } from './ui/testcase-list';
import { testCaseFormRoutes } from './ui/testcase-form';
import { testCaseDetailRoutes } from './ui/testcase-detail';
import { tokenPageRoutes } from './ui/tokens-pages';
import { userPageRoutes } from './ui/users-pages';
import { profilePageRoutes } from './ui/profile-page';

export interface AppDeps {
  storage: Storage;
  auth: Auth;
  config: AppConfig;
  loginLimiter: RateLimiter;
  syncLimiter: RateLimiter;
  now(): number;
}

export type Actor =
  | { kind: 'user'; user: UserRow; sessionId: string }
  | { kind: 'token'; token: ApiTokenRow & { organizationId: string } };

export type AppEnv = { Variables: { deps: AppDeps; actor: Actor; project: ProjectRow } };

/** RBAC の役割順位(auth-security.md「ロールベースアクセス制御(RBAC)」)。数値が大きいほど強い権限。 */
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 } as const;

/**
 * deps 注入ミドルウェア → `/api/v1` ルート群(以後のタスクが `.route(...)` で追記する)→
 * onError/notFound を組み立てる。ここではルートを一切登録しない(Task 8 以降の責務)。
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    try {
      await next();
    } catch (err) {
      // GC-4(エラー応答は統一スキーマ以外を返さない)の保証: Hono の compose() は
      // `err instanceof Error` の場合のみ onError へルーティングし、非 Error 値(誤って
      // `throw "文字列"` された場合等)はそのまま素通りしてしまう。deps 注入ミドルウェアは
      // チェーンの最外周にいるため、ここで一度だけ正規化しておけば以後の全ルート/ミドルウェアの
      // 例外が確実に errorMiddleware(→ 500 INTERNAL の統一スキーマ)に到達する。
      throw err instanceof Error ? err : new Error(String(err));
    }
  });

  // /api/v1 配下のルート登録。以後のタスクがここに追記していく(Task 8: setup/auth、Task 9: users、Task 10: projects、
  // Task 11: tokens、Task 13: testcases、Task 15: sync start/chunk)。tokensRoutes/testCasesRoutes/
  // syncRoutes は projectsRoutes と同じ '/api/v1/projects' 配下に '/:pid/tokens'・'/:pid/testcases'・
  // '/:pid/sync/...' 等のサブパスとしてマウントする(Hono は同一 base path への複数回の .route() 呼び出しを
  // サポートし、パスが重複しない限りルーティングテーブルにマージされる)。
  app.route('/api/v1/setup', setupRoutes);
  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1/users', usersRoutes);
  app.route('/api/v1/projects', projectsRoutes);
  app.route('/api/v1/projects', tokensRoutes);
  app.route('/api/v1/projects', testCasesRoutes);
  app.route('/api/v1/projects', syncRoutes);

  // SSR UI ルート(task-17-brief.md「UI 基盤 + 認証画面」)。GET / の振り分け(D-13-1/8)・S-01 セットアップ・
  // S-02 ログイン・ログアウトを登録する。/api/v1/* とパスが重複しないため登録順は影響しないが、
  // 「API の 404 フォールバックより前」という規約に合わせ、onError/notFound の直前に置く。
  // Task 18 以降がここに projects-pages 等を追記していく。
  app.route('/', authPageRoutes);
  // S-06 プロジェクト一覧 / S-07 プロジェクト作成ダイアログ(task-18-brief.md)。
  app.route('/', projectPageRoutes);
  // S-08 テストケース一覧 / S-15 一括操作確認ダイアログ(task-19-brief.md)。
  app.route('/', testCasePageRoutes);
  // S-09 テストケース作成(task-20-brief.md)。static パス `/testcases/new` を detail の `/testcases/:id`
  // より前に登録する(Hono のルータは静的パスを優先するため実害は無いはずだが、可読性のため明示的に
  // form ルートを detail ルートより先に app.route() する)。
  app.route('/', testCaseFormRoutes);
  // S-10 詳細 + S-11 編集 + S-12 Diff / S-13 Gherkin / S-14 履歴 / Identity タブ(task-20-brief.md)。
  app.route('/', testCaseDetailRoutes);
  // S-16 API トークン一覧 / S-17 トークン発行結果ダイアログ(task-21-brief.md)。
  app.route('/', tokenPageRoutes);
  // S-18 ユーザー一覧 / S-19 ユーザー作成・編集ダイアログ(task-21-brief.md)。
  app.route('/', userPageRoutes);
  // S-20 プロフィール・パスワード変更(task-21-brief.md)。
  app.route('/', profilePageRoutes);

  app.onError(errorMiddleware);
  app.notFound(() => {
    // errorMiddleware に一本化するため throw する(Hono は notFound ハンドラの例外も onError に
    // ルーティングする。統一エラースキーマの組み立てをここで重複させないための意図的な選択)。
    throw new AppError('NOT_FOUND', 404, 'not found');
  });

  return app;
}
