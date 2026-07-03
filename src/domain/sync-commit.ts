// src/domain/sync-commit.ts
// Commit 8工程パイプライン(sync-protocol.md「Commit 8工程パイプライン」)のうち、DB を伴わない
// 純粋な述語・分類ロジックを切り出す。パイプライン本体は set-based SQL(drizzle-storage.ts の
// syncCommitWindow/syncFinalize/syncMappings)で実行されるが、以下の3つは「観測データの分類」
// という点で純関数として書き下せる:
//   - resolveCanonicalCategory: 工程1(Canonical 生成)の category フォールバック
//   - classifySyncMappings: syncMappings の3分類(created/updated/unchanged)
//   - isIdentityLive/computeCanonicalIsStale: 工程7(Canonical Rollup)の集約述語(TTL 判定含む)
// Storage/HTTP への依存は一切持たない(GC-6: @cloudflare/workers-types や D1 型は import しない)。
//
// 工程7について: 実際の書き込みは drizzle-storage.ts の相関サブクエリ SQL(NOT EXISTS/EXISTS + TTL)が
// set-based に行うため、この純関数が直接呼び出されるわけではない。だがここに書き下すことで
// 「rollup が何を計算しているか」を DB 無しで単体検証できる実行可能な仕様として機能させ、
// SQL 側の実装がこの述語と一致していることを手動レビューの拠り所にする
// (drizzle-storage.ts の該当コメントから本ファイルの関数名を相互参照する)。
import type { Category } from '../schemas/enums';

/** 工程1: 「category=観測の category ?? 'normal'」(task-16-brief.md 工程実装対応表)。 */
export function resolveCanonicalCategory(observedCategory: Category | null): Category {
  return observedCategory ?? 'normal';
}

export type SyncMappingOutcome = 'created' | 'updated' | 'unchanged';

/**
 * syncMappings の3分類(task-16-brief.md「Produces(Storage 追加分)」):
 * - created: 当該 token の SyncStaging に有る(=今回の commit で新規 canonical を採番した)
 * - updated: SyncStaging には無いが、当該 token の観測(TestCaseObservation)が有る
 *   (=既存 canonical に対する変化点。ミラー昇格または drift 記録の対象)
 * - unchanged: 上記どちらでもなく、sync_seen(出現台帳)にのみ存在する
 *   (=送られてきたが指紋が変わらなかった ref)
 *
 * 優先順位は created > updated > unchanged(スコープ引数の順序どおり)。判定対象(=このセッションで
 * 「送られてきた」ref 全体)は seenRefs を正とする: sync_seen は chunk で受信した全 ref を記録する
 * 出現台帳(Task 15)であり、staging/observed の対象 ref は概念上つねに seenRefs の部分集合になる
 * (syncAppendObservations が観測 INSERT と sync_seen INSERT を同一呼び出しで行うため)。
 *
 * staled(今回セッションで未出現)は本分類に含めない(mappings は「送られてきた ref」のマップのため。
 * task-16-brief.md「工程実装対応表」の注記どおり。staled は syncFinalize の staled_count で報告する)。
 */
export function classifySyncMappings(p: {
  stagingRefs: Iterable<string>;
  observedRefs: Iterable<string>;
  seenRefs: Iterable<string>;
}): Array<{ externalRef: string; outcome: SyncMappingOutcome }> {
  const stagingSet = new Set(p.stagingRefs);
  const observedSet = new Set(p.observedRefs);
  const result: Array<{ externalRef: string; outcome: SyncMappingOutcome }> = [];
  for (const ref of new Set(p.seenRefs)) {
    if (stagingSet.has(ref)) {
      result.push({ externalRef: ref, outcome: 'created' });
    } else if (observedSet.has(ref)) {
      result.push({ externalRef: ref, outcome: 'updated' });
    } else {
      result.push({ externalRef: ref, outcome: 'unchanged' });
    }
  }
  return result;
}

/**
 * data-model.md「staleness集約ルール」: `last_seen_at > now - TTL` の identity のみを live とする。
 * last_seen_at が null(まだ工程3で確定していない・またはそもそも一度も確認されていない)identity は
 * live ではない(境界の `>` は厳密比較。ちょうど TTL 分過去の identity は凍結扱い)。
 */
export function isIdentityLive(lastSeenAt: number | null, now: number, ttlMs: number): boolean {
  return lastSeenAt !== null && lastSeenAt > now - ttlMs;
}

/**
 * 工程7(Canonical Rollup)の集約述語(sync-protocol.md「工程7: Canonical Rollup」をそのまま純関数化):
 *
 *   is_stale = NOT EXISTS(live かつ is_stale=0 の identity) AND EXISTS(live な identity)
 *
 * - TTL 超過(凍結)の identity は生死判定(isIdentityLive)から除外される
 *   (「引退したオリジンが永久ブロッカーになることを防ぐ」)。
 * - live な identity が1件も無ければ(凍結のみ、または identity が無い)は EXISTS(live) が偽となり、
 *   常に is_stale=false(判定材料が無いので stale と断定しない)。
 * - 実際の書き込みは drizzle-storage.ts の相関サブクエリ SQL(NOT EXISTS/EXISTS + rowid ウィンドウ)が
 *   set-based に行う。この関数は同じ述語を DB 無しで検証するための対応物。
 */
export function computeCanonicalIsStale(
  identities: Array<{ isStale: boolean; lastSeenAt: number | null }>,
  now: number,
  ttlMs: number,
): boolean {
  const live = identities.filter((i) => isIdentityLive(i.lastSeenAt, now, ttlMs));
  if (live.length === 0) return false;
  return live.every((i) => i.isStale);
}
