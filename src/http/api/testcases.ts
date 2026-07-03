// src/http/api/testcases.ts
// テストケース Storage 拡張 + 読み取り系 API(作成含む)(docs/apis/testcases.md)。
// GET(一覧・単体・履歴・gherkin)は viewer 以上、session Cookie または API トークン両対応
// (auth-security.md「到達面分離(能力マトリクス)」: 衛星トークンは自 project の参照系 GET のみ到達可能)。
// POST(手動作成)は editor 以上・session 専用ルート宣言 + CSRF(D-09)。衛星トークンは modes に
// 'token' を含めないため、有効な Bearer でも「認証済みだが禁止」= 403(tokens.ts と同じパターン)。
//
// GC-1 メモ(乖離の明示): docs/apis/testcases.md の一覧レスポンス例・フィールド表には `total` が無く、
// 履歴のフィールド表にも `actor_display` が無い。だがスペック D-03(正確な total)・D-04(actor_display)
// はこれらを明記しており、global-constraints.md「スペックと docs/ の記述が異なる箇所はスペックが優先」に
// 従いスペックどおり実装する(いずれも非破壊な追加フィールドのため api-reference.md のバージョニング
// 規約上も問題ない)。詳細は serializers.ts のコメント、タスク報告を参照。
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { zodHook } from '../middleware/error';
import { requireAuth } from '../middleware/authn';
import { csrfProtect } from '../middleware/csrf';
import { resolveProject, orgScopeOf } from '../middleware/scope';
import { createTestCaseInput, listTestCasesQuery, pageQuery } from '../../schemas/api';
import { toTestCaseJson, toTestCaseListItemJson, toHistoryJson } from './serializers';
import { renderGherkin } from '../../domain/gherkin';

const viewerUp = requireAuth({ modes: ['session', 'token'], minRole: 'viewer' });
const editorOnly = requireAuth({ modes: ['session'], minRole: 'editor' });

export const testCasesRoutes = new Hono<AppEnv>()
  .get('/:pid/testcases', viewerUp, resolveProject(), zValidator('query', listTestCasesQuery, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const q = c.req.valid('query');

    const result = await deps.storage.listTestCases(
      scope,
      pid,
      { status: q.status, category: q.category, ownership: q.ownership, drift: q.drift, isStale: q.is_stale, target: q.target },
      { cursor: q.cursor, limit: q.limit },
    );
    return c.json({
      items: result.items.map(toTestCaseListItemJson),
      total: result.total,
      next_cursor: result.nextCursor,
      has_more: result.hasMore,
    });
  })

  .post('/:pid/testcases', editorOnly, csrfProtect(), resolveProject(), zValidator('json', createTestCaseInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const input = c.req.valid('json');
    const actor = c.get('actor');
    // editorOnly は modes:['session'] のため token actor はここへ到達しない(型上のナローイングのみ)。
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');

    const row = await deps.storage.createTestCaseManual(
      scope,
      pid,
      {
        title: input.title,
        target: input.target ?? null,
        category: input.category,
        given: input.given,
        when: input.when,
        then: input.then,
        parameters: input.parameters ?? null,
        status: input.status,
        confidence: input.confidence ?? null,
        sourceRef: input.source_ref ?? null,
        metadata: input.metadata ?? null,
      },
      { actor: `user:${actor.user.id}`, action: 'created', delta: {} },
      deps.now(),
    );
    c.header('ETag', `W/"${row.version}"`);
    return c.json(toTestCaseJson(row), 201);
  })

  .get('/:pid/testcases/:id', viewerUp, resolveProject(), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const id = c.req.param('id');

    const row = await deps.storage.getTestCase(scope, pid, id);
    if (!row) throw new AppError('NOT_FOUND', 404, 'not found');

    // apis/testcases.md「GET /testcases/:id?format=gherkin」: Gherkin/自然言語ビューの派生表現。
    if (c.req.query('format') === 'gherkin') {
      const text = renderGherkin({
        title: row.title,
        target: row.target,
        given: row.given,
        when: row.when,
        then: row.then,
        parameters: row.parameters === null ? null : JSON.parse(row.parameters),
      });
      return c.text(text, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    c.header('ETag', `W/"${row.version}"`);
    return c.json(toTestCaseJson(row));
  })

  .get('/:pid/testcases/:id/history', viewerUp, resolveProject(), zValidator('query', pageQuery, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const id = c.req.param('id');
    const q = c.req.valid('query');

    // :id が存在しない/この project のものでなければ 404(存在隠蔽。history だけを先に返さない)。
    const tc = await deps.storage.getTestCase(scope, pid, id);
    if (!tc) throw new AppError('NOT_FOUND', 404, 'not found');

    const result = await deps.storage.listHistory(scope, pid, id, { cursor: q.cursor, limit: q.limit });
    return c.json({
      items: result.items.map(toHistoryJson),
      total: result.total,
      next_cursor: result.nextCursor,
      has_more: result.hasMore,
    });
  });
