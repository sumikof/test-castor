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
  // Task 11: tokens、Task 13: testcases)。tokensRoutes/testCasesRoutes は projectsRoutes と同じ
  // '/api/v1/projects' 配下に '/:pid/tokens'・'/:pid/testcases' 等のサブパスとしてマウントする
  // (Hono は同一 base path への複数回の .route() 呼び出しをサポートし、パスが重複しない限り
  // ルーティングテーブルにマージされる)。
  app.route('/api/v1/setup', setupRoutes);
  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1/users', usersRoutes);
  app.route('/api/v1/projects', projectsRoutes);
  app.route('/api/v1/projects', tokensRoutes);
  app.route('/api/v1/projects', testCasesRoutes);

  app.onError(errorMiddleware);
  app.notFound(() => {
    // errorMiddleware に一本化するため throw する(Hono は notFound ハンドラの例外も onError に
    // ルーティングする。統一エラースキーマの組み立てをここで重複させないための意図的な選択)。
    throw new AppError('NOT_FOUND', 404, 'not found');
  });

  return app;
}
