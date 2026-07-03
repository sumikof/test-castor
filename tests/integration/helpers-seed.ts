// tests/integration/helpers-seed.ts
// task-14-brief.md「tests/integration/helpers-seed.ts」: drift/diff/observations の統合テストを
// Task 15/16 の同期実装(start/chunk/commit)に依存させないための直挿しシードヘルパ。
// committed な sync_sessions 行 + test_case_observations 行 + test_case_identities 行を
// rawExec の INSERT で直接作る(data-model.md「TestCaseObservation」「SyncSession」のテーブル定義どおり)。
import type { RawExec } from './helpers';

/** rawExec は生 SQL 文字列の実行(パラメータバインドなし)のため、シングルクォートのみ最小エスケープする。 */
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export interface SeedCommittedObservationParams {
  pid: string;
  testCaseId: string;
  externalRef: string;
  origin: string;
  fingerprint: string;
  /** 観測スナップショット(data-model.md「observed の固定キーセット」)。呼び出し側が形を決める。 */
  observed: Record<string, unknown>;
  /** この観測・セッションの時刻(epoch ms)。sync_sessions の started_at/committed_at と
   *  test_case_observations.created_at の両方に使う。 */
  at: number;
}

/**
 * committed 済みの sync_sessions 行 + それに紐づく test_case_observations 行 + (冪等な)
 * test_case_identities 行を直接 INSERT する。呼び出しごとに新しい sync_token(uuid)を発行するため、
 * 同一 (pid, testCaseId, origin) に対して複数回呼んでも observations の一意制約
 * (external_ref, origin, sync_token, fingerprint)には抵触しない(時系列で複数観測を積む用途)。
 * identity は (project_id, origin, external_ref) が一意のため INSERT OR IGNORE で冪等に扱う。
 */
export async function seedCommittedObservation(rawExec: RawExec, p: SeedCommittedObservationParams): Promise<void> {
  const token = crypto.randomUUID();
  const obsId = crypto.randomUUID();
  const identityId = crypto.randomUUID();
  const observedJson = JSON.stringify(p.observed);

  await rawExec(
    `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at, committed_at) ` +
      `VALUES (${sqlString(token)}, ${sqlString(p.pid)}, ${sqlString(p.origin)}, 'committed', ${p.at}, ${p.at + 600_000}, ${p.at})`,
  );

  await rawExec(
    `INSERT INTO test_case_observations ` +
      `(id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
      `VALUES (${sqlString(obsId)}, ${sqlString(p.testCaseId)}, ${sqlString(p.externalRef)}, ${sqlString(p.pid)}, ` +
      `${sqlString(p.fingerprint)}, ${sqlString(observedJson)}, ${sqlString(token)}, ${sqlString(p.origin)}, ${p.at})`,
  );

  await rawExec(
    `INSERT OR IGNORE INTO test_case_identities ` +
      `(id, test_case_id, project_id, origin, external_ref, is_stale, last_seen_sync_token, last_seen_at, created_at) ` +
      `VALUES (${sqlString(identityId)}, ${sqlString(p.testCaseId)}, ${sqlString(p.pid)}, ${sqlString(p.origin)}, ` +
      `${sqlString(p.externalRef)}, 0, ${sqlString(token)}, ${p.at}, ${p.at})`,
  );
}
