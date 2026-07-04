// src/maintenance/purge.ts
// task-22-brief.md「メンテナンス(パージ・sweep)」。Storage の purgeObservations/purgeSyncWorkdata は
// いずれも「1回の呼び出し = 1回分の小バッチ DELETE...LIMIT」しか行わない(drizzle-storage.ts 参照)。
// ここではそれを反復して実際に収束させる薄いドライバを提供する(operations.md §4.1
// 「小バッチ反復」「1 Cron 実行あたりクエリ数 1,000 未満」の"反復"を担う層)。
//
// ポータビリティ境界(GC-6): CF 型は一切 import しない。CF scheduled ハンドラ(src/entry/workers.ts)
// からも node CLI(Task 23)からも同じ関数を呼ぶ想定。
import type { Storage } from '../storage/interface';

export interface PurgeLoopResult {
  /** 反復全体で実際に削除できた行数の合計。 */
  deleted: number;
  /** 実際に行った Storage 呼び出し(= 実行した DELETE 文)の回数。 */
  iterations: number;
}

export interface PurgeObservationsLoopParams {
  now: number;
  retentionMs: number;
  /** 1回の DELETE...LIMIT で削除する最大行数(Storage.purgeObservations にそのまま渡す)。 */
  batchLimit: number;
  /** 反復回数の上限(1回の実行あたり総文数を1,000未満に抑えるための安全弁)。 */
  maxIterations: number;
}

/**
 * storage.purgeObservations を、削除件数が batchLimit 未満になるまで(= このタイミングでもう
 * 対象が残っていないと判断できるまで)繰り返し呼ぶ。syncCommitWindow の `more = count >= windowLimit`
 * と同じ考え方(削除件数がbatchLimit未満なら、その時点でこの実行の対象は尽きたとみなせる。
 * insert/updateが実行中に割り込む前提のバッチ処理ではないため取りこぼしは無い)。
 * maxIterations に達したら安全のためそこで打ち切る(続きは次回の Cron 実行に持ち越す。
 * operations.md §4.1「複数実行に分割継続」)。
 */
export async function purgeObservationsUntilDone(
  storage: Storage, p: PurgeObservationsLoopParams,
): Promise<PurgeLoopResult> {
  let deleted = 0;
  let iterations = 0;
  while (iterations < p.maxIterations) {
    const n = await storage.purgeObservations({ now: p.now, retentionMs: p.retentionMs, batchLimit: p.batchLimit });
    deleted += n;
    iterations += 1;
    if (n < p.batchLimit) break;
  }
  return { deleted, iterations };
}

export interface PurgeSyncWorkdataLoopParams {
  /** 反復回数の上限(purgeSyncWorkdata は引数を取らないため batchLimit は内部固定値。
   * drizzle-storage.ts の WORKDATA_PURGE_BATCH 参照)。 */
  maxIterations: number;
}

/**
 * storage.purgeSyncWorkdata を、削除件数が0になるまで繰り返し呼ぶ。purgeObservations と異なり
 * Storage.purgeSyncWorkdata() は内部バッチ幅を露出しない(ブリーフのシグネチャどおり引数を取らない)ため、
 * 呼び出し側は「削除件数 < 内部バッチ幅」判定ができない。安全側に倒して「0件になるまで」を停止条件にする
 * (境界ケースで最後にもう1回 0 件確認の呼び出しが増えるだけで、正しさに影響はない)。
 */
export async function purgeSyncWorkdataUntilDone(
  storage: Storage, p: PurgeSyncWorkdataLoopParams,
): Promise<PurgeLoopResult> {
  let deleted = 0;
  let iterations = 0;
  while (iterations < p.maxIterations) {
    const n = await storage.purgeSyncWorkdata();
    deleted += n;
    iterations += 1;
    if (n === 0) break;
  }
  return { deleted, iterations };
}
