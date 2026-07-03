// tests/contract/occ-concurrency.test.ts
//
// review round 2(discriminating concurrency test)。
//
// なぜこのファイルが必要か: storage-contract.ts の「review round 1」回帰テスト(patchTestCase/
// acceptFingerprint 各1件、現在は「順次(sequential)」に改名済み)は「勝者」の呼び出しを await で
// 完全に完了させてから「敗者」を呼ぶ逐次実行だった。この構成では敗者自身の事前チェック(getTestCase)
// が既に更新後の行(version=2)を読むため、事前チェックの version 不一致ショートカットだけで conflict
// と判定できてしまい、新旧どちらのコードでも同じ結果になる ―― 本物のバグだった「2つのリクエストが
// 両方とも同じ version を読んでから競走する」(=どちらの事前チェックも自分の expectedVersion と
// 一致してしまう)状況を一切再現できていなかった(task-14-report.md「review round 1」参照。皮肉にも
// acceptFingerprint 版は旧コードに対してそのまま流しても偶然パスしてしまい、判別力ゼロだった)。
//
// 本ファイルは Promise.all で2つの patchTestCase/acceptFingerprint(同一 expectedVersion)を実際に
// 同時発火し、JS の await 挟み込みによる本物のインターリーブ(両方の事前チェック SELECT が、どちらの
// UPDATE も着地する前に同じ stale snapshot を読む)を発生させる。better-sqlite3(同期ドライバ)では
// 1回の呼び出しが他の呼び出しの介在なしに完全に完了してしまうため、この interleave は起こり得ない。
// そのため非同期 I/O を行う libsql アダプタ(createLibsqlStorage)を直接使う。
//
// 不変条件(修正済みコードなら、逐次・並行のどちらのスケジューリングで実行されても必ず成立する。
// つまりこの不変条件のチェック自体は flaky にならない):
//   - 2つの結果のうち exactly one が {kind:'ok'}、残り exactly one が {kind:'conflict'}
//     (「two oks」= false success の再発は絶対に起きない)
//   - 実際に永続化された version は expectedVersion+1 ちょうど(1回だけ増分。2回増分も0回増分もしない)
//   - 実際に永続化された行の値は「ok」を返した側が書き込もうとした値と一致する(捏造行と食い違わない)
//   - history 件数は正確に+1(勝者の1件のみ増える。敗者からの phantom entry は無い)
//
// シナリオを12回繰り返す: 単発の成功は「たまたま都合の良いスケジューリングだった」可能性を排除できない
// (Promise.all の実行順は JS のマイクロタスクスケジューリングにより決定的な傾向を持つが、どちらの
// batch が先に DB へ着地するかまでは仕様上の保証ではない)。旧コード(review round 1 以前)に対しては、
// 本タスク実行時に drizzle-storage.ts を一時的に旧実装へ戻して本ファイルを実行し、実際に「two oks」
// 「history+2」という形で落ちることを確認し、その後正しい修正版へ復元した(task-14-report.md
// 「review round 2」に確認ログを記載)。
import { describe, it, expect, beforeEach } from 'vitest';
import { createLibsqlStorage } from '../../src/storage/adapters/libsql';
import type { Storage, PatchResult, AcceptFingerprintResult } from '../../src/storage/interface';

/**
 * 2つの同時書き込み結果に対する共通の不変条件チェック。exactly one が 'ok'、残りが 'conflict' である
 * ことを検証し、'ok' 側の結果を返す(型は呼び出し側の Result union に合わせて narrow する)。
 * 'no_drift'/'not_found' 等の想定外の kind が紛れ込んだ場合も conflict 以外として検出できる。
 */
function assertSingleWinner<R extends { kind: string }>(results: [R, R]): Extract<R, { kind: 'ok' }> {
  const oks = results.filter((r) => r.kind === 'ok');
  const nonOks = results.filter((r) => r.kind !== 'ok');
  expect(oks).toHaveLength(1); // two-oks(false success の再発)が起きていないこと
  expect(nonOks).toHaveLength(1);
  expect(nonOks[0]?.kind).toBe('conflict'); // 残りは必ず conflict(no_drift/not_found 等ではない)
  return oks[0] as Extract<R, { kind: 'ok' }>;
}

const ITERATIONS = 12;

describe('OCC concurrency (review round 2): 同一 version 同時書き込みの不変条件(libsql・真の非同期インターリーブ)', () => {
  let storage: Storage;
  let rawExec: (sqlText: string) => Promise<void>;
  let scope: { organizationId: string };
  let projectId: string;
  const now = 1_700_000_000_000;

  beforeEach(async () => {
    const created = await createLibsqlStorage(':memory:');
    storage = created.storage;
    rawExec = created.rawExec;
    const org = await storage.setupOrganization({
      orgName: 'org', adminEmail: 'admin@example.com',
      adminPasswordHash: '$pbkdf2-sha256$i=1$x$y', adminDisplayName: 'Admin', now,
    });
    scope = { organizationId: org.organization.id };
    const project = await storage.createProject(scope, { name: 'proj-occ-race' }, now);
    projectId = project.id;
  });

  it(
    `concurrent same-version patchTestCase: exactly one winner・+1 version・+1 history(phantom無し)を ${ITERATIONS} 回連続で確認`,
    async () => {
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const created = await storage.createTestCaseManual(
          scope, projectId,
          {
            title: `race-${iter}`, target: null, category: 'normal', given: 'given', when: 'when', then: 'then',
            parameters: null, status: 'draft', confidence: null, sourceRef: null, metadata: null,
          },
          { actor: 'user:00000000-0000-0000-0000-0000000000ff', action: 'created', delta: {} },
          now,
        );
        expect(created.version).toBe(1);

        const h0 = (await storage.listHistory(scope, projectId, created.id, { limit: 50 })).total;

        // 「同じ version=1 を読んだ」2つのリクエストを模す。columnValues に version(=expectedVersion+1)
        // を含めるのは、production route(src/http/api/testcases.ts)が computeHumanPatch 経由で
        // 実変更ありのときに必ずこのキーを含めるため(domain/testcase-rules.ts「columnValues.version =
        // current.version + 1」)であり、実際の呼び出し形と一致させる。これを省くと、旧コードでは
        // version 列自体が一切更新されなくなり(setValues に version が無いため)、「stale
        // expectedVersion での再試行が常に成功してしまう」という別の(無関係な)理由で本テストが落ちて
        // しまい、phantom-history の検証にならない(task-14-report.md がこの種の confound を明示的に
        // 警告している)。修正済みコードは p.columnValues.version を分割代入で除外し SQL 側で導出する
        // ため(drizzle-storage.ts patchTestCase 参照)、この値を含めても修正済みコードの挙動には
        // 一切影響しない。
        const [a, b] = await Promise.all([
          storage.patchTestCase(scope, projectId, created.id, {
            expectedVersion: 1,
            columnValues: { title: 'A', version: 2 },
            ownershipTransition: false,
            historyEntries: [{ actor: 'user:a', action: 'updated', delta: { title: { before: `race-${iter}`, after: 'A' } } }],
            now,
          }),
          storage.patchTestCase(scope, projectId, created.id, {
            expectedVersion: 1,
            columnValues: { title: 'B', version: 2 },
            ownershipTransition: false,
            historyEntries: [{ actor: 'user:b', action: 'updated', delta: { title: { before: `race-${iter}`, after: 'B' } } }],
            now,
          }),
        ]);

        const winner = assertSingleWinner<PatchResult>([a, b]);

        const finalRow = await storage.getTestCase(scope, projectId, created.id);
        expect(finalRow?.version).toBe(2); // ちょうど1回だけ増分(2回・0回のいずれでもない)
        expect(finalRow?.title).toBe(winner.row.title); // 永続化された値は勝者の応答と食い違わない(捏造行なし)

        const h1 = (await storage.listHistory(scope, projectId, created.id, { limit: 50 })).total;
        expect(h1 - h0).toBe(1); // 勝者の1件のみ(敗者からの phantom entry は無い)
      }
    },
  );

  it(
    `concurrent same-version acceptFingerprint: exactly one winner・+1 version・+1 history(phantom無し)を ${ITERATIONS} 回連続で確認`,
    async () => {
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const created = await storage.createTestCaseManual(
          scope, projectId,
          {
            title: `fp-race-${iter}`, target: null, category: 'normal', given: 'given', when: 'when', then: 'then',
            parameters: null, status: 'draft', confidence: null, sourceRef: null, metadata: null,
          },
          { actor: 'user:00000000-0000-0000-0000-0000000000ff', action: 'created', delta: {} },
          now,
        );
        expect(created.version).toBe(1);

        // drift ありの状態 + committed 観測を用意する(acceptFingerprint が採用する新 fingerprint の元)。
        // iteration ごとに一意な token/observation id を使う(uq_obs_idem・token PK の衝突を避けるため)。
        await rawExec(
          `UPDATE test_cases SET drift=1, fingerprint='old-fp', mirror_origin='discovery-v1' WHERE id='${created.id}'`,
        );
        await rawExec(
          `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at, committed_at) ` +
          `VALUES ('sess-occ-${iter}', '${projectId}', 'discovery-v1', 'committed', ${now}, ${now + 1000}, ${now})`,
        );
        await rawExec(
          `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
          `VALUES ('obs-occ-${iter}', '${created.id}', 'ext-1', '${projectId}', 'new-fp-${iter}', '{"given":"g","when":"w","then":"t","parameters":[]}', 'sess-occ-${iter}', 'discovery-v1', ${now + 1})`,
        );

        const h0 = (await storage.listHistory(scope, projectId, created.id, { limit: 50 })).total;

        // acceptFingerprint は columnValues を取らない(version は実装内部で expectedVersion+1 として
        // 導出される)ため patchTestCase のような confound は存在しない。両呼び出しとも同じ
        // expectedVersion=1・同じ drift=true のスナップショットを読んだ状況を模す。
        const [a, b] = await Promise.all([
          storage.acceptFingerprint(scope, projectId, created.id, 1, 'user:a', now),
          storage.acceptFingerprint(scope, projectId, created.id, 1, 'user:b', now),
        ]);

        const winner = assertSingleWinner<AcceptFingerprintResult>([a, b]);

        const finalRow = await storage.getTestCase(scope, projectId, created.id);
        expect(finalRow?.version).toBe(2); // ちょうど1回だけ増分
        expect(finalRow?.drift).toBe(0);
        expect(finalRow?.fingerprint).toBe(winner.row.fingerprint); // 永続化された値は勝者の応答と食い違わない

        const h1 = (await storage.listHistory(scope, projectId, created.id, { limit: 50 })).total;
        expect(h1 - h0).toBe(1); // 勝者の1件のみ(敗者からの phantom entry は無い)
      }
    },
  );
});
