// src/http/api/tokens.ts
// API トークン管理 API(docs/apis/tokens.md)。全エンドポイント admin ロール限定 + session 専用
// (auth-security.md「到達面分離(能力マトリクス)」: token 管理は衛星トークンでは到達不可 → 403。
// requireAuth の modes に 'token' を含めないことで、有効な Bearer でも「認証済みだが禁止」= 403 FORBIDDEN
// になる。失効/未発行の Bearer は認証述語の時点で弾かれ 401 UNAUTHORIZED — 403 と区別される)。
// 状態変更系(POST/DELETE)は CSRF 必須(D-09)。GET は副作用なしのため csrfProtect() を付けない
// (projects.ts/users.ts の GET と同じ規約)。
//
// api_tokens テーブルは organization_id を持たない(Task 4)。テナント境界は resolveProject() が
// :pid → project → organization_id を解決し、UI セッション actor の org と不一致なら 404(存在隠蔽。
// auth-security.md「IDOR の構造防止」)を返すことに全面的に依存する。各ハンドラは resolveProject() が
// 検証済みの c.get('project').id のみを Storage に渡す。Storage 側の scope 引数は GC-5(全メソッド
// orgScope 必須)の型契約を満たすために渡すが、api_tokens 自体の絞り込みは project_id 一致で行われる
// (drizzle-storage.ts の createApiToken/listApiTokens/revokeApiToken)。resolveProject() 通過済みの
// pid である以上、この project_id 一致だけで越境不可能な境界になる。
//
// 平文トークンは POST レスポンスのみに現れる(auth-security.md「平文の隔離」)。GET一覧・DELETE応答・
// エラーボディ・ログのいずれにも平文を含めない。toTokenJson(serializers.ts)は ApiTokenRow を丸ごと
// スプレッドせず許可されたフィールドだけを明示的に選び取ることで token_hash の混入を構造的に防ぐ。
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { zodHook } from '../middleware/error';
import { requireAuth } from '../middleware/authn';
import { csrfProtect } from '../middleware/csrf';
import { resolveProject, orgScopeOf } from '../middleware/scope';
import { createTokenInput } from '../../schemas/api';
import { toTokenJson } from './serializers';

const adminOnly = requireAuth({ modes: ['session'], minRole: 'admin' });

export const tokensRoutes = new Hono<AppEnv>()
  .post('/:pid/tokens', adminOnly, csrfProtect(), resolveProject(), zValidator('json', createTokenInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id; // resolveProject() が既に org 一致を検証済み(他 org は 404 で到達しない)
    const { name } = c.req.valid('json');

    const plaintext = deps.auth.newApiToken();
    const tokenHash = await deps.auth.hashApiToken(plaintext);
    const row = await deps.storage.createApiToken(scope, pid, name, tokenHash, deps.now());

    // 発行応答のみが平文を運ぶ(docs/apis/tokens.md)。row を toTokenJson() には通さず、許可された
    // 4フィールドだけをここで明示的に組み立てる(token_hash を含む row を丸ごと返さない)。
    c.header('Cache-Control', 'no-store');
    return c.json({ id: row.id, name: row.name, token: plaintext, created_at: row.createdAt }, 201);
  })

  .get('/:pid/tokens', adminOnly, resolveProject(), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;

    const items = await deps.storage.listApiTokens(scope, pid);
    return c.json({ items: items.map(toTokenJson) });
  })

  .delete('/:pid/tokens/:id', adminOnly, csrfProtect(), resolveProject(), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const pid = c.get('project').id;
    const tokenId = c.req.param('id');

    // 冪等ソフト失効(apis/tokens.md): revokeApiToken は無条件 UPDATE 後に再SELECTして返す(既に失効済み
    // なら UPDATE は0件ヒットのまま再取得するだけなので、常に「最初の」revoked_at が返る)。id が
    // このプロジェクトに属さない(存在しない/他プロジェクトのもの)場合は null → 404。
    const revoked = await deps.storage.revokeApiToken(scope, pid, tokenId, deps.now());
    if (!revoked) throw new AppError('NOT_FOUND', 404, 'not found');
    return c.json({ id: revoked.id, name: revoked.name, revoked_at: revoked.revokedAt });
  });
