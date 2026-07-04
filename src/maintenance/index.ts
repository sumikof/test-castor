// src/maintenance/index.ts
// task-22-brief.md「runMaintenance(deps): Promise<void> — src/maintenance: 上記(Storage 追加分)を
// 順に呼び、結果を構造化ログ出力(共通実装。CF scheduled と node CLI の両方から呼ぶ)」。
//
// 呼び出し順序(ブリーフの列挙順そのまま。operations.md §4「上記を順に呼び」):
//   1. purgeObservations(観測パージ)
//   2. sweepExpiredSyncSessions(sync-protocol.md「失効の執行モデル」セカンダリ)
//   3. deleteExpiredUiSessions
//   4. purgeSyncWorkdata
//   5. countsSnapshot(概算容量監視ログ)
// 2→4 の順序は意味がある: sweep が active だが期限切れの SyncSession を expired に倒して初めて、
// その SyncSession に属する sync_staging/sync_seen が purgeSyncWorkdata の対象になる
// (同一 run 内でより多くの workdata を回収できる。tests/unit/maintenance.test.ts の
// runMaintenance テストが、この順序依存を直接証拠立てて検証している)。
//
// ポータビリティ境界(GC-6・GC-1 の運用ルール4): CF 型は一切 import しない。CF scheduled ハンドラ
// (src/entry/workers.ts)からも node CLI(Task 23 の src/entry/maintenance-cli.ts)からも
// 同じ runMaintenance を呼ぶ共通実装。
import type { Storage } from '../storage/interface';
import { purgeObservationsUntilDone, purgeSyncWorkdataUntilDone } from './purge';
import { sweepExpired } from './sweep';

// 既定のチューニング値。operations.md §4.1「1 Cron 実行あたりクエリ数 1,000 未満」を満たすことを
// 文数の積算で確認する(すべて既定値を使った場合の最悪ケース):
//   purgeObservations: purgeMaxIterations(100) 文
//   sweepExpiredSyncSessions: 1 文(LIMIT無しの単一UPDATE)
//   deleteExpiredUiSessions: uiSessionMaxIterations(50) 文
//   purgeSyncWorkdata: workdataMaxIterations(50) × 2文(sync_staging + sync_seen) = 100 文
//   countsSnapshot: 11 文(11テーブル分の SELECT COUNT)
//   合計 = 100 + 1 + 50 + 100 + 11 = 262 文 < 1,000
const DEFAULT_PURGE_BATCH_LIMIT = 500;
const DEFAULT_PURGE_MAX_ITERATIONS = 100;
const DEFAULT_UI_SESSION_BATCH_LIMIT = 500;
const DEFAULT_UI_SESSION_MAX_ITERATIONS = 50;
const DEFAULT_WORKDATA_MAX_ITERATIONS = 50;

export interface MaintenanceDeps {
  storage: Storage;
  /** GC-3: 実クロックを読むのは呼び出し側(entry層)の責務。ここは注入された now() をそのまま使う。 */
  now(): number;
  /** committed観測の保持期間(既定90日。src/http/config.ts の observationRetentionMs を渡す想定)。 */
  retentionMs: number;
  /** 以下は全て省略可(未指定時は上記既定値)。テストで小さい値に差し替えて反復・打ち切りを検証する。 */
  purgeBatchLimit?: number;
  purgeMaxIterations?: number;
  uiSessionBatchLimit?: number;
  uiSessionMaxIterations?: number;
  workdataMaxIterations?: number;
  /** 構造化ログの出力先(既定 console.log)。テストで差し替え可能。 */
  log?(line: string): void;
}

export async function runMaintenance(deps: MaintenanceDeps): Promise<void> {
  const now = deps.now();
  const log = deps.log ?? ((line: string) => { console.log(line); });
  const purgeBatchLimit = deps.purgeBatchLimit ?? DEFAULT_PURGE_BATCH_LIMIT;
  const purgeMaxIterations = deps.purgeMaxIterations ?? DEFAULT_PURGE_MAX_ITERATIONS;
  const uiSessionBatchLimit = deps.uiSessionBatchLimit ?? DEFAULT_UI_SESSION_BATCH_LIMIT;
  const uiSessionMaxIterations = deps.uiSessionMaxIterations ?? DEFAULT_UI_SESSION_MAX_ITERATIONS;
  const workdataMaxIterations = deps.workdataMaxIterations ?? DEFAULT_WORKDATA_MAX_ITERATIONS;

  const purge = await purgeObservationsUntilDone(deps.storage, {
    now, retentionMs: deps.retentionMs, batchLimit: purgeBatchLimit, maxIterations: purgeMaxIterations,
  });
  const sweep = await sweepExpired(deps.storage, { now, uiSessionBatchLimit, uiSessionMaxIterations });
  const workdata = await purgeSyncWorkdataUntilDone(deps.storage, { maxIterations: workdataMaxIterations });
  const counts = await deps.storage.countsSnapshot();

  log(JSON.stringify({
    event: 'maintenance_run',
    now,
    observations_purged: purge.deleted,
    observations_purge_iterations: purge.iterations,
    sync_sessions_expired: sweep.syncSessionsExpired,
    ui_sessions_deleted: sweep.uiSessionsDeleted,
    ui_session_iterations: sweep.uiSessionIterations,
    sync_workdata_purged: workdata.deleted,
    sync_workdata_iterations: workdata.iterations,
    table_counts: counts,
  }));
}
