// src/http/api/sync.ts
// 衛星同期プロトコル 前半(task-15-brief.md): POST /sync/start・POST /sync/:token/chunk。
// commit(工程0-8)は Task 16。
//
// ⚠ 設計上の重要ノート(sync_seen 出現台帳): sync-protocol.md は「chunk は変化点のみ観測記録」
// (容量設計の根幹。同一 (external_ref, origin) は直前観測と fingerprint が異なる時だけ新規行を作る)
// と、「commit 工程3/4 は今回セッションで出現した external_ref を last_seen/stale 判定に使う」の
// 両方を求める。だが変化なし ref は観測行が作られないため、工程3/4 が観測を参照するとその ref は
// 「出現しなかった」ことになり毎回 stale に誤判定されてしまう。この緊張を解決するため、
// data-model.md/sync-protocol.md には無い新テーブル sync_seen(sync_token, external_ref の2列・
// 一意)を追加し、chunk は (1) 変化点のみ観測 INSERT、(2) 受信した全 ref を sync_seen へ
// INSERT(ON CONFLICT DO NOTHING)の2系統を書く。Task 16 の commit 工程3/4 は観測ではなく
// sync_seen を参照することで、「chunk 追記専用」「変化点のみ記録」「stale 正確性」の3不変条件を
// 同時に満たす(このテーブルは Task 23 で docs に反映予定。詳細な手順は
// drizzle-storage.ts の syncAppendObservations 実装コメント参照)。
//
// 認証: Bearer トークンのみ(modes:['token'])。UI セッションでは到達不可(衛星専用エンドポイント)。
// レート制限: D-14「token別 120/分」= deps.syncLimiter。キーは token id。
// CSRF: Bearer 認証のみのため対象外(csrf.ts の「Bearer トークン認証は Cookie を使わないため検証対象外」
// と同じ理由。csrfProtect() は付与しない)。
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { zodHook } from '../middleware/error';
import { requireAuth } from '../middleware/authn';
import { resolveProject, orgScopeOf } from '../middleware/scope';
import { syncStartInput, syncChunkInput, MAX_CHUNK_SIZE } from '../../schemas/sync';
import { toSyncMappingJson, toSyncStatusJson } from './serializers';

const tokenOnly = requireAuth({ modes: ['token'] });
// GET /sync/status(スペック D-01): session|token・viewer 以上(apis/testcases.md の GET 系と同じ能力)。
const viewerUp = requireAuth({ modes: ['session', 'token'], minRole: 'viewer' });

/** sync-protocol.md「スライディング失効モデル」: chunk/commit のたびに expires_at を now+10分へ延長。 */
const SLIDING_MS = 10 * 60_000;

/**
 * sync_token 生成。src/auth の Auth インターフェース(newApiToken 等)は "tms_" 固定プレフィックスの
 * API トークン専用のため、sync-protocol.md の例("syn_...")に合わせてここでローカルに生成する
 * (task-15-brief.md の Files 一覧に src/auth は含まれないため、Auth インターフェース自体は変更しない
 * という判断。タスク報告に明記)。newSessionId 等(src/auth/token.ts)と同じ32バイト CSPRNG →
 * base64url(パディングなし)の方式をここで独立に再実装する。
 */
function newSyncToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return `syn_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/**
 * D-14「token別 120/分」(sync-protocol.md エラー表「レートリミット超過」)。sync/* は
 * requireAuth({modes:['token']}) の後段でのみマウントするため、ここに到達する actor は必ず token。
 */
function syncRateLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'token') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const gate = await deps.syncLimiter.limit(`sync:${actor.token.id}`);
    if (!gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSec ?? 60));
      throw new AppError('RATE_LIMITED', 429, 'too many sync requests', undefined, true);
    }
    await next();
  };
}

export const syncRoutes = new Hono<AppEnv>()
  .post(
    '/:pid/sync/start',
    tokenOnly,
    syncRateLimit(),
    resolveProject(),
    zValidator('json', syncStartInput, zodHook),
    async (c) => {
      const deps = c.get('deps');
      const scope = orgScopeOf(c.get('actor'));
      const pid = c.get('project').id;
      const { origin } = c.req.valid('json');
      const now = deps.now();

      // Idempotency-Key: D-10「受理して無視」(api-reference.md「Idempotency-Key ヘッダ」)。構造的
      // 冪等性(uq_active_session 部分一意索引 + conflict 捕捉)への多重防御が本体であり、ヘッダ値自体は
      // 参照・保存しない(意図的に読み捨てる。c.req.header('idempotency-key') を呼ぶ必要すらない)。

      const result = await deps.storage.syncStart(scope, pid, { token: newSyncToken(), origin, now, slidingMs: SLIDING_MS });
      if (result.kind === 'conflict') {
        throw new AppError('DUPLICATE_SYNC_SESSION', 409, 'an active sync session already exists for this (project, origin)');
      }

      return c.json(
        {
          sync_token: result.session.token,
          expires_at: result.session.expiresAt,
          server_time: now,
          max_chunk_size: MAX_CHUNK_SIZE,
        },
        201,
      );
    },
  )

  .post(
    '/:pid/sync/:token/chunk',
    tokenOnly,
    syncRateLimit(),
    resolveProject(),
    zValidator('json', syncChunkInput, zodHook),
    async (c) => {
      const deps = c.get('deps');
      const scope = orgScopeOf(c.get('actor'));
      const pid = c.get('project').id;
      const token = c.req.param('token');
      const { observations } = c.req.valid('json');
      const now = deps.now();

      // Idempotency-Key: D-10「受理して無視」。/start と同じ理由でヘッダ値は読み捨てる。

      const session = await deps.storage.syncGetSession(scope, pid, token);
      if (!session) throw new AppError('SESSION_EXPIRED', 410, 'sync session not found or expired');

      // 遅延評価(sync-protocol.md「失効の執行モデル(プライマリ)」): active だが期限切れのセッションは
      // ここで expired に倒してから 410 を返す。committed・既に expired は追加の書き込みなしで即 410
      // (sync-protocol.md「committed 後は同一トークンでの chunk は受け付けない」)。
      if (session.status === 'active' && session.expiresAt <= now) {
        await deps.storage.syncExpireLapsed(scope, pid, session.origin, now);
        throw new AppError('SESSION_EXPIRED', 410, 'sync session expired');
      }
      if (session.status !== 'active') {
        throw new AppError('SESSION_EXPIRED', 410, 'sync session is not active');
      }

      // スライディング失効: 正常なリクエストのたびに expires_at を now+10分へ延長する。
      await deps.storage.syncTouchExpiry(token, now + SLIDING_MS);

      // observation トップレベルの source_ref は data-model.md の observed 固定キーセット内
      // (observed.source_ref)と重複するため Storage 層へは渡さない(task-15 のスコープ外。
      // タスク報告参照)。category 未指定時のデフォルト('normal')適用は Task 16 の canonical 生成側。
      const chunkObs = observations.map((o) => ({
        externalRef: o.external_ref,
        fingerprint: o.fingerprint,
        observed: o.observed,
        category: o.category ?? null,
        confidence: o.confidence ?? null,
      }));
      const received = await deps.storage.syncAppendObservations(scope, pid, session, chunkObs, now);

      return c.json({ accepted: received.length, received }, 200);
    },
  )

  // task-16-brief.md「commit ルートの流れ」: 遅延評価(期限切れ→expired)→ セッション検証
  // (無し/expired → 410、committed → 保存済みカウント+mappings で200即応)→ スライディング延長 →
  // syncCommitWindow(more:true なら202、more:false なら syncFinalize→syncMappings→200)。
  .post(
    '/:pid/sync/:token/commit',
    tokenOnly,
    syncRateLimit(),
    resolveProject(),
    async (c) => {
      const deps = c.get('deps');
      const actor = c.get('actor');
      // tokenOnly は modes:['token'] のため token actor 以外はここへ到達しない(型上のナローイングのみ。
      // testcases.ts の editorOnly ハンドラと同じ流儀)。
      if (actor.kind !== 'token') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
      const scope = orgScopeOf(actor);
      const pid = c.get('project').id;
      const token = c.req.param('token');
      const now = deps.now();

      const session = await deps.storage.syncGetSession(scope, pid, token);
      if (!session) throw new AppError('SESSION_EXPIRED', 410, 'sync session not found or expired');

      // 遅延評価(sync-protocol.md「失効の執行モデル(プライマリ)」): chunk と同じパターン。
      if (session.status === 'active' && session.expiresAt <= now) {
        await deps.storage.syncExpireLapsed(scope, pid, session.origin, now);
        throw new AppError('SESSION_EXPIRED', 410, 'sync session expired');
      }

      // committed 済みへの再送は冪等な即応(sync-protocol.md「commit は完全に冪等」)。保存済みカウント
      // (syncFinalize の alreadyCommitted 経路)+ mappings を並べて 200 で返す。スライディング延長は
      // 行わない(committed セッションの expires_at は以後意味を持たない)。
      if (session.status === 'committed') {
        const finalized = await deps.storage.syncFinalize(scope, pid, token, now);
        const mappings = await deps.storage.syncMappings(scope, pid, token);
        return c.json({
          status: 'completed',
          staled_count: finalized.staledCount,
          more: false,
          mappings: mappings.map(toSyncMappingJson),
        }, 200);
      }
      if (session.status !== 'active') {
        throw new AppError('SESSION_EXPIRED', 410, 'sync session is not active');
      }

      // スライディング失効: 正常なリクエストのたびに expires_at を now+10分へ延長する。
      await deps.storage.syncTouchExpiry(token, now + SLIDING_MS);

      const windowResult = await deps.storage.syncCommitWindow(scope, pid, token, {
        now,
        identityTtlMs: deps.config.identityTtlMs,
        windowLimit: deps.config.commitWindowLimit,
        actor: `token:${actor.token.id}`,
      });

      if (windowResult.more) {
        // 大規模セットの分割実行(sync-protocol.md「大規模セットの分割実行」): 同一トークンで再送させる。
        return c.json({ status: 'in_progress', more: true }, 202);
      }

      const finalized = await deps.storage.syncFinalize(scope, pid, token, now);
      const mappings = await deps.storage.syncMappings(scope, pid, token);
      return c.json({
        status: 'completed',
        staled_count: finalized.staledCount,
        more: false,
        mappings: mappings.map(toSyncMappingJson),
      }, 200);
    },
  )

  // スペック D-01: GET /sync/status(session|token・viewer 以上)。
  .get(
    '/:pid/sync/status',
    viewerUp,
    resolveProject(),
    async (c) => {
      const deps = c.get('deps');
      const scope = orgScopeOf(c.get('actor'));
      const pid = c.get('project').id;
      const result = await deps.storage.syncStatus(scope, pid);
      return c.json(toSyncStatusJson(result));
    },
  );
