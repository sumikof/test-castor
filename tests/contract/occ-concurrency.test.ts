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

// task-16 review round 1(discriminating concurrency test): sync commit の imported history 重複防止。
//
// なぜこのブロックが必要か: drizzle-storage.ts の syncCommitWindow 工程1b(history INSERT,
// action='imported')は、JS 側の事前チェック(existingHistoryTcIds)で「まだ imported 履歴が無い
// test_case_id」だけに絞ってから INSERT していたが、その INSERT 自体には .onConflictDoNothing() が
// 無く、対応する一意制約も存在しなかった。そのため、同一 token に対する2つの syncCommitWindow 呼び出しが
// 真に並行実行されると、両方が「まだ無い」という同じスナップショットを読んでから競走し、同一
// test_case_id に対して imported 履歴が2重に INSERT されうる(「test_case 1件につき imported は厳密に
// 1行」という不変条件の違反。監査ログの水増し)。修正は schema.ts の部分一意索引
// uq_history_imported_per_tc(test_case_id) WHERE action='imported' + 該当 INSERT への
// .onConflictDoNothing() で、DB 層に真の保証を持たせる。
//
// 上のブロックと同じ理由(non-widePromise.all による真のインターリーブには非同期I/Oが必須)で libsql を
// 直接使う。2つの syncCommitWindow 呼び出しは同一 token・同一 external_ref を対象にするため、工程0
// (同定採番)で同一 newTestCaseId に収束した後、工程1b の事前チェック SELECT が両方とも「まだ無い」を
// 読んでから競走する窓が生まれる。
//
// 不変条件(修正済みコードなら逐次・並行いずれのスケジューリングでも必ず成立):
//   - 新規 canonical 1件につき action='imported' の history は exactly 1 行(重複無し)
//   - canonical(test_cases)・identity(test_case_identities)も exactly 1 件(工程1a/工程2 の既存の
//     onConflictDoNothing により、こちらは修正前から保護されている。ここでも明示的に検証する)
//
// シナリオを12回繰り返す(ITERATIONS。上のブロックと同じ理由で単発の成功は判別力が無いため)。
// 旧コード(このタスクの review round 1 以前。onConflictDoNothing 無し・部分一意索引無し)に対しては、
// 本タスク実行時に schema.ts/drizzle-storage.ts を一時的に旧実装へ戻して本ブロックを実行し、実際に
// 「imported history 2行」という形で落ちることを確認し、その後正しい修正版へ復元した
// (task-16-report.md「Fix report(review round 1)」に確認ログを記載)。
describe(
  'OCC concurrency (task-16 review round 1): 同一 token の並行 syncCommitWindow による imported history ' +
    '重複防止(libsql・真の非同期インターリーブ)',
  () => {
    let storage: Storage;
    let scope: { organizationId: string };
    let projectId: string;
    const now = 1_700_000_000_000;
    const IDENTITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

    beforeEach(async () => {
      const created = await createLibsqlStorage(':memory:');
      storage = created.storage;
      const org = await storage.setupOrganization({
        orgName: 'org', adminEmail: 'admin@example.com',
        adminPasswordHash: '$pbkdf2-sha256$i=1$x$y', adminDisplayName: 'Admin', now,
      });
      scope = { organizationId: org.organization.id };
      const project = await storage.createProject(scope, { name: 'proj-sync-commit-race' }, now);
      projectId = project.id;
    });

    it(
      `concurrent same-token syncCommitWindow: 新規 canonical の imported history は exactly 1 行 ` +
        `(重複無し)を ${ITERATIONS} 回連続で確認`,
      async () => {
        for (let iter = 0; iter < ITERATIONS; iter++) {
          // origin を iteration ごとに変える: uq_active_session(project_id,origin) WHERE status='active'
          // は1 origin につき active セッション1本までのため、前 iteration のセッションを finalize せず
          // 使い回すと2回目以降の syncStart が conflict になってしまう(このテストの関心は finalize では
          // なく工程1bの重複防止のため、finalize は呼ばず origin をずらして回避する)。
          const origin = `discovery-race-${iter}`;
          const token = `tok-race-${iter}`;
          const externalRef = `ext-race-${iter}`;

          const started = await storage.syncStart(scope, projectId, { token, origin, now, slidingMs: 600_000 });
          if (started.kind !== 'created') throw new Error('unreachable');
          await storage.syncAppendObservations(scope, projectId, started.session, [{
            externalRef,
            fingerprint: `fp-race-${iter}`,
            observed: { title: 't', given: 'g', when: 'w', then: 'th', parameters: [], source_ref: {}, schema_version: '1.0' },
            category: null,
            confidence: null,
          }], now + 1);

          const commitParams = { now: now + 2, identityTtlMs: IDENTITY_TTL_MS, windowLimit: 1000, actor: 'token:tok-actor' };
          // 「同じ token に対する2つの syncCommitWindow 呼び出しが同時に走る」状況を実際に再現する
          // (Promise.all。事前に一方を await し切ってから他方を呼ぶ逐次実行では、後着側の事前チェックが
          // 既に着地した履歴を読んでしまい判別力が無くなる。上のOCCブロックと同じ確認済みの落とし穴)。
          await Promise.all([
            storage.syncCommitWindow(scope, projectId, token, commitParams),
            storage.syncCommitWindow(scope, projectId, token, commitParams),
          ]);

          const mappings = await storage.syncMappings(scope, projectId, token);
          const testCaseId = mappings.find((m) => m.externalRef === externalRef)?.testCaseId;
          expect(testCaseId).toBeTruthy();

          const history = await storage.listHistory(scope, projectId, testCaseId!, { limit: 50 });
          const imported = history.items.filter((h) => h.action === 'imported');
          expect(imported).toHaveLength(1); // 重複無し(修正前は稀に2行になっていた)

          // canonical/identity は工程1a/工程2 の既存の onConflictDoNothing で修正前から単一だったが、
          // 「並行実行全体として何も壊れていない」ことをここでも明示的に確認する。
          const tc = await storage.getTestCase(scope, projectId, testCaseId!);
          expect(tc).not.toBeNull();
          const identities = await storage.listIdentities(scope, projectId, testCaseId!);
          expect(identities).toHaveLength(1);
        }
      },
    );
  },
);
