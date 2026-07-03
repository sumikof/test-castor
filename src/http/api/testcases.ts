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
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { zodHook } from '../middleware/error';
import { requireAuth } from '../middleware/authn';
import { csrfProtect } from '../middleware/csrf';
import { resolveProject, orgScopeOf } from '../middleware/scope';
import {
  createTestCaseInput, listTestCasesQuery, pageQuery, patchTestCaseInput, bulkInput, observationsQuery,
} from '../../schemas/api';
import {
  toTestCaseJson, toTestCaseListItemJson, toHistoryJson,
  toIdentityJson, toObservationJson, toDiffJson, toAcceptFingerprintJson,
} from './serializers';
import { renderGherkin } from '../../domain/gherkin';
import { computeHumanPatch, jsonDeepEqual } from '../../domain/testcase-rules';
import { buildHistoryEntries } from '../../domain/history-delta';

const viewerUp = requireAuth({ modes: ['session', 'token'], minRole: 'viewer' });
const editorOnly = requireAuth({ modes: ['session'], minRole: 'editor' });

/**
 * If-Match ヘッダから OCC の version を取り出す(api-reference.md「楽観的排他制御(OCC)」)。
 * `"3"`(strong)・`W/"3"`(weak)のいずれの形式も受理し、整数 3 として比較する。
 * 未指定・不正な形式(整数として解釈できない)はどちらも呼び出し側で 428 PRECONDITION_REQUIRED
 * として扱う(不正な値をどのバージョンとも解釈できないため、未指定と同様に扱う設計判断)。
 */
function parseIfMatch(raw: string): number | null {
  const m = /^(?:W\/)?"(\d+)"$/.exec(raw);
  if (!m?.[1]) return null;
  return Number(m[1]);
}

/** PATCH/accept-fingerprint 共通: If-Match ヘッダを取り出し、未指定・不正形式は自ら 428 を投げる。 */
function requireIfMatchVersion(c: Context<AppEnv>): number {
  const raw = c.req.header('if-match');
  const version = raw ? parseIfMatch(raw) : null;
  if (version === null) throw new AppError('PRECONDITION_REQUIRED', 428, 'If-Match header required');
  return version;
}

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
  })

  // --- 書き込み系(task-14-brief.md)。PATCH/DELETE/bulk/accept-fingerprint は editor 以上・session 専用 + CSRF ---

  .patch('/:pid/testcases/:id', editorOnly, csrfProtect(), resolveProject(), zValidator('json', patchTestCaseInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const id = c.req.param('id');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');

    // OCC(api-reference.md「楽観的排他制御(OCC)」): If-Match 必須。未指定・不正形式は 428。
    const expectedVersion = requireIfMatchVersion(c);

    const current = await deps.storage.getTestCase(scope, pid, id);
    if (!current) throw new AppError('NOT_FOUND', 404, 'not found');

    const input = c.req.valid('json');
    const patchResult = computeHumanPatch(current, {
      title: input.title,
      target: input.target,
      category: input.category,
      given: input.given,
      when: input.when,
      then: input.then,
      parameters: input.parameters,
      status: input.status,
      confidence: input.confidence,
      metadata: input.metadata,
    });
    if (!patchResult.ok) throw new AppError('VALIDATION_FAILED', 422, 'invalid status transition');

    // source_ref は data-model.md「人間所有列」に含まれず computeHumanPatch の対象外
    // (domain/testcase-rules.ts の注記参照)。ここで別途カラム代入する。実際に値が変化した場合のみ
    // SET 対象にする(バージョン bump/ownership 遷移/history の対象にはしない)。
    let sourceRefColumnValue: string | null | undefined;
    if (input.source_ref !== undefined) {
      const currentSourceRef = current.sourceRef === null ? null : JSON.parse(current.sourceRef);
      if (!jsonDeepEqual(currentSourceRef, input.source_ref)) {
        sourceRefColumnValue = input.source_ref === null ? null : JSON.stringify(input.source_ref);
      }
    }

    const noChanges = Object.keys(patchResult.changes).length === 0 && sourceRefColumnValue === undefined;
    if (noChanges) {
      // no-op PATCH(data-model.md「同値PATCH(no-op)では遷移しない」): version を bump せず、
      // 書き込みも行わず現行値を 200 で返す。OCC の版比較はここでは行わない(何も書かないため
      // 競合しようがない、という設計判断。docs はこの組み合わせを明示していないためタスク報告に明記)。
      c.header('ETag', `W/"${current.version}"`);
      return c.json(toTestCaseJson(current));
    }

    const columnValues: Record<string, unknown> = { ...patchResult.columnValues };
    if (sourceRefColumnValue !== undefined) columnValues.sourceRef = sourceRefColumnValue;

    const now = deps.now();
    const historyEntries = buildHistoryEntries({
      changes: patchResult.changes,
      statusChange: patchResult.statusChange,
      actor: `user:${actor.user.id}`,
      now,
    }).map((e) => ({ action: e.action, delta: e.delta, actor: `user:${actor.user.id}` }));

    const result = await deps.storage.patchTestCase(scope, pid, id, {
      expectedVersion,
      columnValues,
      ownershipTransition: patchResult.ownershipTransition,
      historyEntries,
      now,
    });
    if (result.kind === 'not_found') throw new AppError('NOT_FOUND', 404, 'not found');
    if (result.kind === 'conflict') throw new AppError('OCC_CONFLICT', 409, 'version mismatch');

    c.header('ETag', `W/"${result.row.version}"`);
    return c.json(toTestCaseJson(result.row));
  })

  // D-02: DELETE はアーカイブのセマンティックエイリアス。OCC 不要・冪等。
  .delete('/:pid/testcases/:id', editorOnly, csrfProtect(), resolveProject(), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const id = c.req.param('id');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');

    const row = await deps.storage.archiveTestCase(scope, pid, id, `user:${actor.user.id}`, deps.now());
    if (!row) throw new AppError('NOT_FOUND', 404, 'not found');

    c.header('ETag', `W/"${row.version}"`);
    return c.json(toTestCaseJson(row));
  })

  .post('/:pid/testcases/bulk', editorOnly, csrfProtect(), resolveProject(), zValidator('json', bulkInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');

    const input = c.req.valid('json');
    const result = await deps.storage.bulkAction(scope, pid, input.ids, input.action, `user:${actor.user.id}`, deps.now());
    return c.json(result);
  })

  .post('/:pid/testcases/:id/accept-fingerprint', editorOnly, csrfProtect(), resolveProject(), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const id = c.req.param('id');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');

    const expectedVersion = requireIfMatchVersion(c);

    const result = await deps.storage.acceptFingerprint(scope, pid, id, expectedVersion, `user:${actor.user.id}`, deps.now());
    if (result.kind === 'not_found') throw new AppError('NOT_FOUND', 404, 'not found');
    if (result.kind === 'no_drift') throw new AppError('NO_DRIFT', 422, 'test case has no drift to accept');
    if (result.kind === 'conflict') throw new AppError('OCC_CONFLICT', 409, 'version mismatch');

    c.header('ETag', `W/"${result.row.version}"`);
    return c.json(toAcceptFingerprintJson(result.row));
  })

  // --- 読み取り系(viewer 以上・session|token) ---

  .get('/:pid/testcases/:id/identities', viewerUp, resolveProject(), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const id = c.req.param('id');

    const tc = await deps.storage.getTestCase(scope, pid, id);
    if (!tc) throw new AppError('NOT_FOUND', 404, 'not found');

    const rows = await deps.storage.listIdentities(scope, pid, id);
    return c.json({ items: rows.map(toIdentityJson) });
  })

  .get('/:pid/testcases/:id/observations', viewerUp, resolveProject(), zValidator('query', observationsQuery, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const id = c.req.param('id');
    const q = c.req.valid('query');

    const tc = await deps.storage.getTestCase(scope, pid, id);
    if (!tc) throw new AppError('NOT_FOUND', 404, 'not found');

    const result = await deps.storage.listObservations(scope, pid, id, { origin: q.origin, cursor: q.cursor, limit: q.limit });
    return c.json({
      items: result.items.map(toObservationJson),
      total: result.total,
      next_cursor: result.nextCursor,
      has_more: result.hasMore,
    });
  })

  .get('/:pid/testcases/:id/diff', viewerUp, resolveProject(), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const id = c.req.param('id');

    const tc = await deps.storage.getTestCase(scope, pid, id);
    if (!tc) throw new AppError('NOT_FOUND', 404, 'not found');

    const latestObservation = await deps.storage.getLatestCommittedObservation(scope, pid, id);
    return c.json(toDiffJson(tc, latestObservation));
  });
