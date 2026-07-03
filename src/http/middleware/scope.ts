// src/http/middleware/scope.ts
// IDOR 構造防止(auth-security.md「IDOR の構造防止」): `:pid` → project_id → organization_id を
// 1ミドルウェアで解決し、リクエスタのスコープと不一致なら存在隠蔽(404)/テナント境界違反(403)を返す。
// 検証済みの ProjectRow を downstream に注入するため、以後のハンドラは個別に認可判定をしない。
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Actor } from '../app';
import type { OrgScope } from '../../storage/interface';
import { AppError } from '../errors';

/** actor から organizationId を取り出す(全ハンドラが Storage 呼び出し時に使う共通ヘルパ)。 */
export function orgScopeOf(actor: Actor): OrgScope {
  return actor.kind === 'token'
    ? { organizationId: actor.token.organizationId }
    : { organizationId: actor.user.organizationId };
}

export function resolveProject(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    const pid = c.req.param('pid');
    if (!pid) throw new AppError('NOT_FOUND', 404, 'not found');

    if (actor.kind === 'token') {
      // token は project スコープ(auth-security.md「UI セッション認証」表)。org不一致ではなく
      // 「そもそも自分の project ではない」ため 403 CROSS_TENANT(sync-protocol.md エラー表)。
      if (actor.token.projectId !== pid) throw new AppError('CROSS_TENANT', 403, 'project scope mismatch');
      const project = await deps.storage.getProject({ organizationId: actor.token.organizationId }, pid);
      if (!project) throw new AppError('CROSS_TENANT', 403, 'project scope mismatch');
      c.set('project', project);
    } else {
      // UI ユーザーは org スコープ。他 org の :pid は「存在しない」として振る舞う(存在隠蔽 = 404)。
      const project = await deps.storage.getProject({ organizationId: actor.user.organizationId }, pid);
      if (!project) throw new AppError('NOT_FOUND', 404, 'not found');
      c.set('project', project);
    }
    await next();
  };
}
