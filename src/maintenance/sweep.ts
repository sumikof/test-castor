// src/maintenance/sweep.ts
// task-22-brief.md「メンテナンス(パージ・sweep)」。sync-protocol.md「失効の執行モデル」の
// セカンダリ(Cron sweep。正しさは各エンドポイントの遅延評価が担保する — ここは表示整合・掃除のみ)。
// GC-6: CF 型は import しない。
import type { Storage } from '../storage/interface';

export interface SweepParams {
  now: number;
  /** deleteExpiredUiSessions の1回あたり削除上限(Storage.deleteExpiredUiSessions にそのまま渡す)。 */
  uiSessionBatchLimit: number;
  /** UIセッション削除の反復回数上限(1回の実行あたり総文数を1,000未満に抑える安全弁)。 */
  uiSessionMaxIterations: number;
}

export interface SweepResult {
  /** 全プロジェクト横断で active→expired に倒した SyncSession 数。 */
  syncSessionsExpired: number;
  /** 削除した期限切れ UI セッション数の合計。 */
  uiSessionsDeleted: number;
  /** deleteExpiredUiSessions を実際に呼んだ回数。 */
  uiSessionIterations: number;
}

/**
 * SyncSession sweep(全プロジェクト対象。長期蓄積しないため1回のUPDATEで完結する)→
 * UI セッション削除(purgeObservationsと同じ「削除件数 < batchLimit で打ち切り」の反復)の順で行う。
 */
export async function sweepExpired(storage: Storage, p: SweepParams): Promise<SweepResult> {
  const syncSessionsExpired = await storage.sweepExpiredSyncSessions(p.now);

  let uiSessionsDeleted = 0;
  let uiSessionIterations = 0;
  while (uiSessionIterations < p.uiSessionMaxIterations) {
    const n = await storage.deleteExpiredUiSessions(p.now, p.uiSessionBatchLimit);
    uiSessionsDeleted += n;
    uiSessionIterations += 1;
    if (n < p.uiSessionBatchLimit) break;
  }
  return { syncSessionsExpired, uiSessionsDeleted, uiSessionIterations };
}
