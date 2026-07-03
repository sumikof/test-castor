// src/http/api/projects.ts
// プロジェクト管理 API(docs/apis/projects.md)。GET は viewer 以上のセッションで閲覧可、POST/PATCH は
// admin ロール限定 + CSRF(D-09)。PATCH は resolveProject() で :pid → organization_id の一致を検証し、
// 他 org の :pid は存在隠蔽のため 404 NOT_FOUND を返す(auth-security.md「IDOR の構造防止」)。
//
// D-05: GET 一覧の各アイテムは非archivedテストケース件数 testcase_count を含む(storage.listProjects が
// JOIN 集計込みで返す。Task 4 で契約テスト済み)。一方 POST/PATCH のレスポンスは docs/apis/projects.md の
// フィールド表に testcase_count が無いため含めない(toProjectJson(row) を count 無しで呼ぶ)。
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { zodHook } from '../middleware/error';
import { requireAuth } from '../middleware/authn';
import { csrfProtect } from '../middleware/csrf';
import { resolveProject, orgScopeOf } from '../middleware/scope';
import { createProjectInput, patchProjectInput } from '../../schemas/api';
import { toProjectJson } from './serializers';

const viewerUp = requireAuth({ modes: ['session'], minRole: 'viewer' });
const adminOnly = requireAuth({ modes: ['session'], minRole: 'admin' });

export const projectsRoutes = new Hono<AppEnv>()
  .get('/', viewerUp, async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const items = await deps.storage.listProjects(scope);
    return c.json({ items: items.map((p) => toProjectJson(p, p.testcaseCount)) });
  })

  .post('/', adminOnly, csrfProtect(), zValidator('json', createProjectInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const input = c.req.valid('json');

    const project = await deps.storage.createProject(
      scope,
      { name: input.name, repoUrl: input.repo_url ?? null },
      deps.now(),
    );
    return c.json(toProjectJson(project), 201);
  })

  .patch('/:pid', adminOnly, csrfProtect(), resolveProject(), zValidator('json', patchProjectInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id; // resolveProject() が既に org 一致を検証済み(他 org は 404 で到達しない)
    const patch = c.req.valid('json');

    const updated = await deps.storage.updateProject(
      scope,
      pid,
      { name: patch.name, repoUrl: patch.repo_url },
      deps.now(),
    );
    // resolveProject() 通過直後のため通常 null にはならないが、users.ts の PATCH と同じ防御的パターンで扱う。
    if (!updated) throw new AppError('NOT_FOUND', 404, 'not found');
    return c.json(toProjectJson(updated));
  });
