// tests/contract/storage-contract.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { Storage, NewTestCaseColumns, NewHistoryEntry, ChunkObservation } from '../../src/storage/interface';
import type { SyncSessionRow } from '../../src/storage/schema';

export interface ContractCtx {
  storage: Storage;
  rawExec(sqlText: string): Promise<void>;
}
const WIPE_ORDER = [
  'test_case_history', 'test_case_observations', 'sync_seen', 'sync_staging', 'sync_sessions',
  'test_case_identities', 'test_cases', 'api_tokens', 'sessions', 'projects', 'users', 'organizations',
];

/** task-13-brief.md「Step 1」向けの NewTestCaseColumns デフォルト値。テストごとに必要な列だけ上書きする。 */
function tcInput(overrides: Partial<NewTestCaseColumns> = {}): NewTestCaseColumns {
  return {
    title: 'サンプルテストケース',
    target: null,
    category: 'normal',
    given: 'given',
    when: 'when',
    then: 'then',
    parameters: null,
    status: 'draft',
    confidence: null,
    sourceRef: null,
    metadata: null,
    ...overrides,
  };
}

function historyEntry(overrides: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
  return { actor: 'user:00000000-0000-0000-0000-0000000000ff', action: 'created', delta: {}, ...overrides };
}

/** task-15-brief.md「Step 2」向けの ChunkObservation デフォルト値。 */
function chunkObs(overrides: Partial<ChunkObservation> = {}): ChunkObservation {
  return {
    externalRef: 'ext-1',
    fingerprint: 'fp-1',
    observed: { title: 't', given: 'g', when: 'w', then: 'th', parameters: [], source_ref: {}, schema_version: '1.0' },
    category: null,
    confidence: null,
    ...overrides,
  };
}

export function runStorageContract(name: string, factory: () => Promise<ContractCtx>) {
  describe(`Storage contract: ${name}`, () => {
    let ctx: ContractCtx;
    let scope: { organizationId: string };
    const now = 1_700_000_000_000;

    beforeEach(async () => {
      ctx = await factory();
      for (const t of WIPE_ORDER) await ctx.rawExec(`DELETE FROM ${t}`);
      const r = await ctx.storage.setupOrganization({
        orgName: 'org', adminEmail: 'admin@example.com',
        adminPasswordHash: '$pbkdf2-sha256$i=1$x$y', adminDisplayName: 'Admin', now,
      });
      scope = { organizationId: r.organization.id };
    });

    it('setup: org と admin を作成し countOrganizations=1', async () => {
      expect(await ctx.storage.countOrganizations()).toBe(1);
      const admin = await ctx.storage.findUserForLogin('admin@example.com');
      expect(admin?.role).toBe('admin');
    });

    it('users: 作成・一覧・email 重複は email_taken・ロール更新', async () => {
      const u = await ctx.storage.createUser(scope, {
        email: 'e@example.com', passwordHash: 'h', displayName: 'E', role: 'editor', now,
      });
      expect(u).not.toBe('email_taken');
      expect(await ctx.storage.createUser(scope, {
        email: 'e@example.com', passwordHash: 'h', displayName: 'E2', role: 'viewer', now,
      })).toBe('email_taken');
      expect((await ctx.storage.listUsers(scope)).length).toBe(2);
      expect(await ctx.storage.countAdmins(scope)).toBe(1);
      const upd = await ctx.storage.updateUser(scope, (u as any).id, { role: 'admin' }, now + 1);
      expect(upd?.role).toBe('admin');
      expect(upd?.updatedAt).toBe(now + 1);
      expect(await ctx.storage.countAdmins(scope)).toBe(2);
    });

    it('users: setUserRoleGuarded は最後の admin への降格のみ atomic に拒否する(D-13-7, TOCTOUレース修正)', async () => {
      const admin = (await ctx.storage.findUserForLogin('admin@example.com'))!;
      const second = await ctx.storage.createUser(scope, {
        email: 'second@example.com', passwordHash: 'h', displayName: 'Second', role: 'editor', now,
      });
      const secondId = (second as any).id as string;

      // 昇格(editor→admin)は admin 人数に関わらず常に許可される
      expect(await ctx.storage.setUserRoleGuarded(scope, secondId, 'admin', now + 1)).toBe('ok');
      expect(await ctx.storage.countAdmins(scope)).toBe(2);

      // admin が2人いる状態での降格は許可される(1人になる)
      expect(await ctx.storage.setUserRoleGuarded(scope, admin.id, 'editor', now + 2)).toBe('ok');
      expect(await ctx.storage.countAdmins(scope)).toBe(1);
      expect((await ctx.storage.getUser(scope, admin.id))?.role).toBe('editor');

      // 残る唯一の admin(secondId)を降格しようとすると拒否され、ロールは変化しない
      expect(await ctx.storage.setUserRoleGuarded(scope, secondId, 'editor', now + 3)).toBe('blocked_last_admin');
      expect((await ctx.storage.getUser(scope, secondId))?.role).toBe('admin'); // 変更されていない
      expect(await ctx.storage.countAdmins(scope)).toBe(1);

      // admin→admin のラテラル(no-op)は「降格」ではないため拒否されない
      expect(await ctx.storage.setUserRoleGuarded(scope, secondId, 'admin', now + 4)).toBe('ok');

      // 存在しない id は not_found
      expect(await ctx.storage.setUserRoleGuarded(
        scope, '00000000-0000-0000-0000-000000000000', 'admin', now + 5,
      )).toBe('not_found');
    });

    it('users: getUserById は org 不問で id のみ一致すれば取得できる(authn 専用)。未知 id は null', async () => {
      const admin = await ctx.storage.findUserForLogin('admin@example.com');
      const got = await ctx.storage.getUserById(admin!.id);
      expect(got?.id).toBe(admin!.id);
      expect(got?.email).toBe('admin@example.com');
      expect(await ctx.storage.getUserById('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('users: 他 org のユーザーは scope 越しに見えない(テナント境界)', async () => {
      const other = await ctx.storage.setupOrganization({
        orgName: 'org2', adminEmail: 'a2@example.com', adminPasswordHash: 'h', adminDisplayName: 'A2', now,
      });
      expect(await ctx.storage.getUser(scope, other.user.id)).toBeNull();
      expect((await ctx.storage.listUsers(scope)).some((u) => u.id === other.user.id)).toBe(false);
    });

    it('sessions: 作成・取得・本人全削除(except 指定)', async () => {
      const admin = (await ctx.storage.findUserForLogin('admin@example.com'))!;
      await ctx.storage.createSession({ id: 's1', userId: admin.id, expiresAt: now + 1000, createdAt: now });
      await ctx.storage.createSession({ id: 's2', userId: admin.id, expiresAt: now + 1000, createdAt: now });
      expect((await ctx.storage.getSession('s1'))?.userId).toBe(admin.id);
      await ctx.storage.deleteUserSessions(admin.id, 's2');
      expect(await ctx.storage.getSession('s1')).toBeNull();
      expect(await ctx.storage.getSession('s2')).not.toBeNull();
    });

    it('projects: 作成・一覧(testcaseCount=0)・更新(repoUrl null クリア)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'payment', repoUrl: 'https://x' }, now);
      const list = await ctx.storage.listProjects(scope);
      expect(list[0]?.testcaseCount).toBe(0);
      const upd = await ctx.storage.updateProject(scope, p.id, { repoUrl: null }, now + 1);
      expect(upd?.repoUrl).toBeNull();
    });

    it('tokens: 発行・hash 照合・失効で照合不可(認証述語)・失効は冪等', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'pr' }, now);
      const t = await ctx.storage.createApiToken(scope, p.id, 'discovery-ci', 'HASH1', now);
      const found = await ctx.storage.findApiTokenByHash('HASH1');
      expect(found?.id).toBe(t.id);
      expect(found?.organizationId).toBe(scope.organizationId);
      await ctx.storage.revokeApiToken(scope, p.id, t.id, now + 5);
      expect(await ctx.storage.findApiTokenByHash('HASH1')).toBeNull();
      const again = await ctx.storage.revokeApiToken(scope, p.id, t.id, now + 9);
      expect(again?.revokedAt).toBe(now + 5); // 冪等: 最初の失効時刻を保持
    });

    it('tokens: last_used_at は閾値内の連続更新を間引く', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'pr' }, now);
      const t = await ctx.storage.createApiToken(scope, p.id, 'n', 'H', now);
      await ctx.storage.touchTokenLastUsed(t.id, now + 1000, 60_000);
      await ctx.storage.touchTokenLastUsed(t.id, now + 2000, 60_000); // 間引かれる
      const [row] = await ctx.storage.listApiTokens(scope, p.id);
      expect(row?.lastUsedAt).toBe(now + 1000);
      await ctx.storage.touchTokenLastUsed(t.id, now + 62_000, 60_000);
      const [row2] = await ctx.storage.listApiTokens(scope, p.id);
      expect(row2?.lastUsedAt).toBe(now + 62_000);
    });

    // 素の UPDATE/DELETE...LIMIT は SQLITE_ENABLE_UPDATE_DELETE_LIMIT 無効ビルド(libSQL等)で動かない。本プロジェクトの標準はこの rowid サブクエリパターン(T16 commit窓 / T22 パージで使用)。
    it('バッチ限定 UPDATE/DELETE(rowidサブクエリ・LIMIT)が全アダプタで動作する(operations.md §1.3 移植互換)', async () => {
      const admin = (await ctx.storage.findUserForLogin('admin@example.com'))!;
      for (let i = 0; i < 3; i++) {
        await ctx.storage.createSession({ id: `L${i}`, userId: admin.id, expiresAt: now, createdAt: now });
      }
      await ctx.rawExec(`UPDATE sessions SET expires_at = 1 WHERE rowid IN (SELECT rowid FROM sessions WHERE user_id = '${admin.id}' LIMIT 2)`);

      // 検証: UPDATE後、3個中2個が expires_at=1、1個が元の now
      const updatedL0 = await ctx.storage.getSession('L0');
      const updatedL1 = await ctx.storage.getSession('L1');
      const updatedL2 = await ctx.storage.getSession('L2');
      const updatedSessions = [updatedL0, updatedL1, updatedL2];
      const updatedCount = updatedSessions.filter((s) => s?.expiresAt === 1).length;
      const untouchedCount = updatedSessions.filter((s) => s?.expiresAt === now).length;
      expect(updatedCount).toBe(2);
      expect(untouchedCount).toBe(1);

      await ctx.rawExec(`DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at = 1 LIMIT 2)`);

      // 検証: DELETE後、3個中1個が残り、それは未更新のセッション(expiresAt===now)
      const remainingL0 = await ctx.storage.getSession('L0');
      const remainingL1 = await ctx.storage.getSession('L1');
      const remainingL2 = await ctx.storage.getSession('L2');
      const remainingSessions = [remainingL0, remainingL1, remainingL2];
      const remaining = remainingSessions.filter((s) => s !== null);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.expiresAt).toBe(now);
    });

    // task-13-brief.md「Step 1: 契約テスト追記」
    it(
      'testcases: createTestCaseManual → getTestCase 往復。手動作成の業務ルール' +
        '(ownership=human/created_origin=manual/version=1/human_updated_at=now/system_updated_at=null/' +
        'fingerprint=null/is_stale=0/drift=0)を満たし、履歴に created(delta={})が記録される',
      async () => {
        const p = await ctx.storage.createProject(scope, { name: 'proj' }, now);
        const input = tcInput({
          title: '正常な支払い処理',
          target: 'com.example.PaymentService#charge',
          category: 'normal',
          given: 'G',
          when: 'W',
          then: 'T',
          parameters: [{ inputs: { a: 1 }, expected: 'ok' }],
          status: 'draft',
          confidence: 0.9,
          sourceRef: { file: 'X.java', line: 1 },
          metadata: { tags: ['x'] },
        });
        const created = await ctx.storage.createTestCaseManual(scope, p.id, input, historyEntry({ actor: 'user:abc' }), now);

        expect(created.title).toBe('正常な支払い処理');
        expect(created.ownership).toBe('human');
        expect(created.createdOrigin).toBe('manual');
        expect(created.version).toBe(1);
        expect(created.humanUpdatedAt).toBe(now);
        expect(created.systemUpdatedAt).toBeNull();
        expect(created.fingerprint).toBeNull();
        expect(created.isStale).toBe(0);
        expect(created.drift).toBe(0);
        expect(created.mirrorOrigin).toBeNull();
        expect(created.createdAt).toBe(now);
        expect(JSON.parse(created.parameters ?? 'null')).toEqual([{ inputs: { a: 1 }, expected: 'ok' }]);
        expect(JSON.parse(created.sourceRef ?? 'null')).toEqual({ file: 'X.java', line: 1 });
        expect(JSON.parse(created.metadata ?? 'null')).toEqual({ tags: ['x'] });

        const got = await ctx.storage.getTestCase(scope, p.id, created.id);
        expect(got).toEqual(created); // 往復で完全一致

        const history = await ctx.storage.listHistory(scope, p.id, created.id, { limit: 10 });
        expect(history.items).toHaveLength(1);
        expect(history.items[0]?.action).toBe('created');
        expect(JSON.parse(history.items[0]?.delta ?? '{}')).toEqual({});
        expect(history.items[0]?.actor).toBe('user:abc');
      },
    );

    it('testcases: listTestCases はフィルタ(status/ownership/target部分一致・LIKEメタ文字エスケープ/drift/isStale)をAND結合で適用する', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-filter' }, now);

      const draftHuman = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'draft-human', status: 'draft' }), historyEntry(), now,
      );
      const approvedHuman = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'approved-human', status: 'approved' }), historyEntry(), now,
      );
      const machineDriftStale = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'machine-drift-stale', status: 'draft' }), historyEntry(), now,
      );
      // createTestCaseManual は常に ownership=human/drift=0/is_stale=0 で作る(業務ルール)ため、
      // machine 所有 + drift + stale の組み合わせは直接 UPDATE で用意する(status は 'draft' のまま
      // 変更しないため ck_tc_status_ownership の複合 CHECK も引き続き満たす)。
      await ctx.rawExec(
        `UPDATE test_cases SET ownership='machine', drift=1, is_stale=1 WHERE id='${machineDriftStale.id}'`,
      );

      const targetPercent = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'percent-target', target: '100%Coverage' }), historyEntry(), now,
      );
      const targetNoPercent = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'no-percent-target', target: '100XCoverage' }), historyEntry(), now,
      );
      const targetUnderscore = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'underscore-target', target: 'A_B_Test' }), historyEntry(), now,
      );
      const targetNoUnderscore = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'no-underscore-target', target: 'AXBXTest' }), historyEntry(), now,
      );

      const draftOnly = await ctx.storage.listTestCases(scope, p.id, { status: 'draft' }, { limit: 50 });
      expect(draftOnly.items.map((i) => i.id).sort()).toEqual(
        [draftHuman.id, machineDriftStale.id, targetPercent.id, targetNoPercent.id, targetUnderscore.id, targetNoUnderscore.id].sort(),
      );
      expect(draftOnly.items.some((i) => i.id === approvedHuman.id)).toBe(false);

      const humanOnly = await ctx.storage.listTestCases(scope, p.id, { ownership: 'human' }, { limit: 50 });
      expect(humanOnly.items.some((i) => i.id === machineDriftStale.id)).toBe(false);
      const machineOnly = await ctx.storage.listTestCases(scope, p.id, { ownership: 'machine' }, { limit: 50 });
      expect(machineOnly.items.map((i) => i.id)).toEqual([machineDriftStale.id]);

      const driftOnly = await ctx.storage.listTestCases(scope, p.id, { drift: true }, { limit: 50 });
      expect(driftOnly.items.map((i) => i.id)).toEqual([machineDriftStale.id]);
      const noDrift = await ctx.storage.listTestCases(scope, p.id, { drift: false }, { limit: 50 });
      expect(noDrift.items.some((i) => i.id === machineDriftStale.id)).toBe(false);

      const staleOnly = await ctx.storage.listTestCases(scope, p.id, { isStale: true }, { limit: 50 });
      expect(staleOnly.items.map((i) => i.id)).toEqual([machineDriftStale.id]);
      const notStale = await ctx.storage.listTestCases(scope, p.id, { isStale: false }, { limit: 50 });
      expect(notStale.items.some((i) => i.id === machineDriftStale.id)).toBe(false);

      // target 部分一致 + LIKE メタ文字(%, _)エスケープ: エスケープが効いていなければ
      // ワイルドカードとして働き、xxxNoPercent/xxxNoUnderscore まで誤って一致してしまう
      const percentMatch = await ctx.storage.listTestCases(scope, p.id, { target: '100%Cov' }, { limit: 50 });
      expect(percentMatch.items.map((i) => i.id)).toEqual([targetPercent.id]);
      const underscoreMatch = await ctx.storage.listTestCases(scope, p.id, { target: 'A_B_Te' }, { limit: 50 });
      expect(underscoreMatch.items.map((i) => i.id)).toEqual([targetUnderscore.id]);

      // AND 結合: status + ownership + target
      const combined = await ctx.storage.listTestCases(
        scope, p.id, { status: 'draft', ownership: 'human', target: '100%Cov' }, { limit: 50 },
      );
      expect(combined.items.map((i) => i.id)).toEqual([targetPercent.id]);
    });

    it(
      'testcases: listTestCases は limit+1件フェッチで has_more を判定し、created_at DESC, id DESC' +
        '(同時刻は id タイブレーク)で安定ページングする。total は全ページで不変。不正なカーソルは先頭からになる',
      async () => {
        const p = await ctx.storage.createProject(scope, { name: 'proj-page' }, now);

        // p1/p2 は created_at が同一(tie-break検証のため)。p3 は1ms後(常に先頭に来る)。
        const p1 = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'p1' }), historyEntry(), now);
        const p2 = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'p2' }), historyEntry(), now);
        const p3 = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'p3' }), historyEntry(), now + 1);

        // 期待順: created_at DESC(p3が先頭)、同時刻の2件は id DESC で決定的に並べる
        const tieBreakOrder = [p1, p2].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const expectedOrder = [p3, ...tieBreakOrder];

        const page1 = await ctx.storage.listTestCases(scope, p.id, {}, { limit: 2 });
        expect(page1.total).toBe(3);
        expect(page1.hasMore).toBe(true);
        expect(page1.items.map((i) => i.id)).toEqual([expectedOrder[0]!.id, expectedOrder[1]!.id]);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await ctx.storage.listTestCases(scope, p.id, {}, { limit: 2, cursor: page1.nextCursor! });
        expect(page2.total).toBe(3); // 同フィルタなら total はページを跨いで不変(D-03)
        expect(page2.hasMore).toBe(false);
        expect(page2.nextCursor).toBeNull();
        expect(page2.items.map((i) => i.id)).toEqual([expectedOrder[2]!.id]);

        // 重複無し: 2ページ分を合算するとちょうど3件が1回ずつ登場する
        const allIds = [...page1.items, ...page2.items].map((i) => i.id);
        expect(new Set(allIds).size).toBe(3);
        expect(allIds.sort()).toEqual([p1.id, p2.id, p3.id].sort());

        // 不正なカーソルは decodeCursor が null を返す契約により「先頭から」にフォールバックする
        const malformed = await ctx.storage.listTestCases(scope, p.id, {}, { limit: 2, cursor: 'not-a-valid-cursor!!' });
        expect(malformed.items.map((i) => i.id)).toEqual([expectedOrder[0]!.id, expectedOrder[1]!.id]);
      },
    );

    it('testcases: getTestCase は他 project の id なら null(project 境界)', async () => {
      const p1 = await ctx.storage.createProject(scope, { name: 'proj-a' }, now);
      const p2 = await ctx.storage.createProject(scope, { name: 'proj-b' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p1.id, tcInput(), historyEntry(), now);

      expect((await ctx.storage.getTestCase(scope, p1.id, created.id))?.id).toBe(created.id);
      expect(await ctx.storage.getTestCase(scope, p2.id, created.id)).toBeNull();
    });

    it('testcases: listHistory の actorDisplay は user.display_name / api_token.name に解決し、存在しない actor は生値のまま返す(D-04)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-hist' }, now);
      const user = await ctx.storage.createUser(scope, {
        email: 'resolver@example.com', passwordHash: 'h', displayName: '田中太郎', role: 'editor', now,
      });
      const userId = (user as any).id as string;
      const token = await ctx.storage.createApiToken(scope, p.id, 'discovery-ci', 'HASHX', now);

      const byUser = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'by-user' }), historyEntry({ actor: `user:${userId}` }), now,
      );
      const byToken = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'by-token' }), historyEntry({ actor: `token:${token.id}` }), now,
      );
      const byUnknown = await ctx.storage.createTestCaseManual(
        scope, p.id, tcInput({ title: 'by-unknown' }),
        historyEntry({ actor: 'user:00000000-0000-0000-0000-000000000000' }), now,
      );

      const h1 = await ctx.storage.listHistory(scope, p.id, byUser.id, { limit: 10 });
      expect(h1.items[0]?.actorDisplay).toBe('田中太郎');

      const h2 = await ctx.storage.listHistory(scope, p.id, byToken.id, { limit: 10 });
      expect(h2.items[0]?.actorDisplay).toBe('discovery-ci');

      const h3 = await ctx.storage.listHistory(scope, p.id, byUnknown.id, { limit: 10 });
      expect(h3.items[0]?.actorDisplay).toBe('user:00000000-0000-0000-0000-000000000000');
      expect(h3.total).toBe(1);
      expect(h3.hasMore).toBe(false);
      expect(h3.nextCursor).toBeNull();
    });

    // task-14-brief.md「Step 1: 契約テスト追記」
    it('testcases: patchTestCase は ok(SET列反映・version bump・history追記)/conflict(存在するが version 不一致・history 追記なし)/not_found(存在しない)を判別する', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-patch' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'old' }), historyEntry(), now);

      const ok = await ctx.storage.patchTestCase(scope, p.id, created.id, {
        expectedVersion: created.version,
        columnValues: { title: 'new', version: created.version + 1 },
        ownershipTransition: false,
        historyEntries: [{ actor: 'user:abc', action: 'updated', delta: { title: { before: 'old', after: 'new' } } }],
        now: now + 1,
      });
      expect(ok.kind).toBe('ok');
      if (ok.kind !== 'ok') throw new Error('unreachable');
      expect(ok.row.title).toBe('new');
      expect(ok.row.version).toBe(created.version + 1);
      expect(ok.row.humanUpdatedAt).toBe(now + 1);

      const historyAfterOk = await ctx.storage.listHistory(scope, p.id, created.id, { limit: 10 });
      expect(historyAfterOk.total).toBe(2); // created + updated
      expect(historyAfterOk.items.some((h) => h.action === 'updated')).toBe(true);

      // conflict: expectedVersion はもう古い(現在は created.version+1)
      const conflict = await ctx.storage.patchTestCase(scope, p.id, created.id, {
        expectedVersion: created.version,
        columnValues: { title: 'conflicted', version: created.version + 2 },
        ownershipTransition: false,
        historyEntries: [{ actor: 'user:abc', action: 'updated', delta: { title: { before: 'new', after: 'conflicted' } } }],
        now: now + 2,
      });
      expect(conflict).toEqual({ kind: 'conflict' });
      const historyAfterConflict = await ctx.storage.listHistory(scope, p.id, created.id, { limit: 10 });
      expect(historyAfterConflict.total).toBe(2); // 競合時は history が増えない(phantom entry 無し)
      const stillNew = await ctx.storage.getTestCase(scope, p.id, created.id);
      expect(stillNew?.title).toBe('new'); // 書き込まれていない

      const notFound = await ctx.storage.patchTestCase(scope, p.id, '00000000-0000-0000-0000-000000000000', {
        expectedVersion: 1,
        columnValues: { title: 'x', version: 2 },
        ownershipTransition: false,
        historyEntries: [{ actor: 'user:abc', action: 'updated', delta: {} }],
        now: now + 3,
      });
      expect(notFound).toEqual({ kind: 'not_found' });
    });

    // review round 1(CRITICAL OCC concurrency)回帰テスト・ただし逐次(sequential)版。「勝者」の
    // patchTestCase を await で完全に完了させてから「敗者」を呼ぶため、敗者自身の事前チェック
    // (getTestCase)は既に更新後の行(version=2)を読む。つまりこのテストが検出できるのは
    // 「消費済み(既に他の書き込みで進んだ)stale expectedVersion を指定した単純な再試行が conflict に
    // なること」のみであり、新旧どちらのコードでも同じ結果になる(事前チェックの version 不一致
    // ショートカットだけで判別できてしまうため)。
    // 「2つのリクエストが両方とも同じ version を読んでから競走する」という本物の並行レース
    // (事前チェック時点ではどちらの expectedVersion も一致してしまう状況)の検出には、真の非同期
    // インターリーブが必要であり、これは occ-concurrency.test.ts の Promise.all ベースの
    // プロパティテスト(libsql アダプタ)が担う。本テストはそれより弱いが無意味ではない
    // 回帰(消費済み stale version の単純な再試行が history を増やさず conflict になること)として残す。
    it('testcases: 順次(sequential)— 既に消費された stale expectedVersion での patchTestCase 再試行は history を増やさず必ず conflict を返す(真の並行レース検出は occ-concurrency.test.ts 参照)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-patch-race' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'race-v1' }), historyEntry(), now);
      expect(created.version).toBe(1);

      // 「勝者」: version=1 を expectedVersion として書き込み、version=2 に進む。
      const winner = await ctx.storage.patchTestCase(scope, p.id, created.id, {
        expectedVersion: 1,
        columnValues: { title: 'winner-title' },
        ownershipTransition: false,
        historyEntries: [{ actor: 'user:winner', action: 'updated', delta: { title: { before: 'race-v1', after: 'winner-title' } } }],
        now: now + 1,
      });
      expect(winner.kind).toBe('ok');
      if (winner.kind !== 'ok') throw new Error('unreachable');
      expect(winner.row.version).toBe(2);

      const historyCountBefore = (await ctx.storage.listHistory(scope, p.id, created.id, { limit: 50 })).total;

      // 「敗者」: 勝者の書き込みを知らないまま、同じ stale expectedVersion=1 で別の変更を試みる。
      const loser = await ctx.storage.patchTestCase(scope, p.id, created.id, {
        expectedVersion: 1,
        columnValues: { title: 'loser-title' },
        ownershipTransition: false,
        historyEntries: [{ actor: 'user:loser', action: 'updated', delta: { title: { before: 'race-v1', after: 'loser-title' } } }],
        now: now + 2,
      });
      expect(loser).toEqual({ kind: 'conflict' }); // ok ではない(偽の成功なし)

      const historyCountAfter = (await ctx.storage.listHistory(scope, p.id, created.id, { limit: 50 })).total;
      expect(historyCountAfter).toBe(historyCountBefore); // phantom entry が増えていない

      const finalRow = await ctx.storage.getTestCase(scope, p.id, created.id);
      expect(finalRow?.title).toBe('winner-title'); // 敗者の変更は適用されない
      expect(finalRow?.version).toBe(2); // 敗者による余計な version bump も無い
    });

    it('testcases: archiveTestCase は冪等(2回目は同一状態を返し history が増えない)。machine 所有 draft の archive は ownership を human に遷移する(複合不変条件)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-archive' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'to-archive' }), historyEntry(), now);
      await ctx.rawExec(`UPDATE test_cases SET ownership='machine' WHERE id='${created.id}'`);

      const archived = await ctx.storage.archiveTestCase(scope, p.id, created.id, 'user:abc', now + 1);
      expect(archived?.status).toBe('archived');
      expect(archived?.ownership).toBe('human');
      expect(archived?.version).toBe(created.version + 1);

      const historyAfterArchive = await ctx.storage.listHistory(scope, p.id, created.id, { limit: 10 });
      expect(historyAfterArchive.items.filter((h) => h.action === 'status_changed')).toHaveLength(1);

      const again = await ctx.storage.archiveTestCase(scope, p.id, created.id, 'user:abc', now + 2);
      expect(again?.version).toBe(archived?.version); // 変化なし(冪等)
      const historyAfterAgain = await ctx.storage.listHistory(scope, p.id, created.id, { limit: 10 });
      expect(historyAfterAgain.total).toBe(historyAfterArchive.total); // history は増えない

      expect(await ctx.storage.archiveTestCase(scope, p.id, '00000000-0000-0000-0000-000000000000', 'user:abc', now)).toBeNull();
    });

    it('testcases: bulkAction(approve) は [draft, approved, archived] の混在に対し updated=1/skipped=1/errors=1(archived, VALIDATION_FAILED)。存在しない id は NOT_FOUND。OCC は使用しない', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-bulk' }, now);
      const draftTc = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'd', status: 'draft' }), historyEntry(), now);
      const approvedTc = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'a', status: 'approved' }), historyEntry(), now);
      const archivedTc = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'x', status: 'draft' }), historyEntry(), now);
      await ctx.rawExec(`UPDATE test_cases SET status='archived' WHERE id='${archivedTc.id}'`);
      const missingId = '00000000-0000-0000-0000-0000000000aa';

      const result = await ctx.storage.bulkAction(
        scope, p.id, [draftTc.id, approvedTc.id, archivedTc.id, missingId], 'approve', 'user:abc', now + 1,
      );
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual(expect.arrayContaining([
        { id: archivedTc.id, code: 'VALIDATION_FAILED', message: expect.any(String) },
        { id: missingId, code: 'NOT_FOUND', message: expect.any(String) },
      ]));
      expect(result.errors).toHaveLength(2);

      const updatedDraft = await ctx.storage.getTestCase(scope, p.id, draftTc.id);
      expect(updatedDraft?.status).toBe('approved');
      expect(updatedDraft?.version).toBe(draftTc.version + 1);

      const untouchedApproved = await ctx.storage.getTestCase(scope, p.id, approvedTc.id);
      expect(untouchedApproved?.version).toBe(approvedTc.version); // skip = 書き込みなし

      const untouchedArchived = await ctx.storage.getTestCase(scope, p.id, archivedTc.id);
      expect(untouchedArchived?.status).toBe('archived'); // error = 書き込みなし
      expect(untouchedArchived?.version).toBe(archivedTc.version);
    });

    it('testcases: bulkAction は machine 所有行を human へ遷移させ、各対象に個別の status_changed 履歴を残す', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-bulk2' }, now);
      const machineTc = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'm', status: 'draft' }), historyEntry(), now);
      await ctx.rawExec(`UPDATE test_cases SET ownership='machine' WHERE id='${machineTc.id}'`);

      const result = await ctx.storage.bulkAction(scope, p.id, [machineTc.id], 'approve', 'user:abc', now + 1);
      expect(result.updated).toBe(1);
      expect(result.errors).toEqual([]);

      const updated = await ctx.storage.getTestCase(scope, p.id, machineTc.id);
      expect(updated?.ownership).toBe('human');
      expect(updated?.status).toBe('approved');

      const history = await ctx.storage.listHistory(scope, p.id, machineTc.id, { limit: 10 });
      expect(history.items.filter((h) => h.action === 'status_changed')).toHaveLength(1);
    });

    it('testcases: bulkAction(restore) は archived→draft のみ updated、非 archived は skip', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-bulk3' }, now);
      const archivedTc = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'ar' }), historyEntry(), now);
      await ctx.rawExec(`UPDATE test_cases SET status='archived' WHERE id='${archivedTc.id}'`);
      const draftTc = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'dr' }), historyEntry(), now);

      const result = await ctx.storage.bulkAction(scope, p.id, [archivedTc.id, draftTc.id], 'restore', 'user:abc', now + 1);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual([]);

      expect((await ctx.storage.getTestCase(scope, p.id, archivedTc.id))?.status).toBe('draft');
      expect((await ctx.storage.getTestCase(scope, p.id, draftTc.id))?.status).toBe('draft'); // skip のまま不変
    });

    it('testcases: bulkAction は ids に同一 id が重複していても1回分としてのみ処理する(二重計上・二重 history 防止)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-bulk4' }, now);
      const draftTc = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'dup' }), historyEntry(), now);

      const result = await ctx.storage.bulkAction(scope, p.id, [draftTc.id, draftTc.id], 'approve', 'user:abc', now + 1);
      expect(result.updated).toBe(1); // 2回ではなく1回
      expect(result.errors).toEqual([]);

      const updated = await ctx.storage.getTestCase(scope, p.id, draftTc.id);
      expect(updated?.status).toBe('approved');
      expect(updated?.version).toBe(draftTc.version + 1); // +2 ではなく+1

      const history = await ctx.storage.listHistory(scope, p.id, draftTc.id, { limit: 10 });
      expect(history.items.filter((h) => h.action === 'status_changed')).toHaveLength(1); // 2件ではなく1件
    });

    it('testcases: acceptFingerprint は ok(最新 committed 観測の fingerprint を採用し drift 解消)/conflict/no_drift/not_found を判別する', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-fp' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'fp' }), historyEntry(), now);
      await ctx.rawExec(`UPDATE test_cases SET drift=1, fingerprint='old-fp', mirror_origin='discovery-v1' WHERE id='${created.id}'`);
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at, committed_at) ` +
        `VALUES ('sess-fp-1', '${p.id}', 'discovery-v1', 'committed', ${now}, ${now + 1000}, ${now})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-fp-1', '${created.id}', 'ext-1', '${p.id}', 'new-fp', '{"given":"g","when":"w","then":"t","parameters":[]}', 'sess-fp-1', 'discovery-v1', ${now + 1})`,
      );

      const current = await ctx.storage.getTestCase(scope, p.id, created.id);
      const ok = await ctx.storage.acceptFingerprint(scope, p.id, created.id, current!.version, 'user:abc', now + 2);
      expect(ok.kind).toBe('ok');
      if (ok.kind !== 'ok') throw new Error('unreachable');
      expect(ok.row.fingerprint).toBe('new-fp');
      expect(ok.row.drift).toBe(0);
      expect(ok.row.version).toBe(current!.version + 1);
      const historyAfterOk = await ctx.storage.listHistory(scope, p.id, created.id, { limit: 10 });
      expect(historyAfterOk.items.filter((h) => h.action === 'status_changed')).toHaveLength(1);

      const noDrift = await ctx.storage.acceptFingerprint(scope, p.id, created.id, ok.row.version, 'user:abc', now + 3);
      expect(noDrift).toEqual({ kind: 'no_drift' });

      await ctx.rawExec(`UPDATE test_cases SET drift=1 WHERE id='${created.id}'`);
      const conflict = await ctx.storage.acceptFingerprint(scope, p.id, created.id, ok.row.version - 1, 'user:abc', now + 4);
      expect(conflict).toEqual({ kind: 'conflict' });

      const notFound = await ctx.storage.acceptFingerprint(scope, p.id, '00000000-0000-0000-0000-000000000000', 1, 'user:abc', now);
      expect(notFound).toEqual({ kind: 'not_found' });
    });

    // review round 1(CRITICAL OCC concurrency)回帰テスト・ただし逐次(sequential)版。patchTestCase の
    // 逐次版回帰テストと同じ形の「敗者」再現であり、同じ限界を持つ(コメント詳細はそちらの逐次版回帰
    // テスト参照): 敗者の事前チェックは既に更新後の行を読むため、事前チェックの version 不一致
    // ショートカットだけで判別でき、新旧どちらのコードでも同じ結果になる。真の並行レース(2つの
    // リクエストが両方とも同じ version・同じ drift=true を読んでから競走する状況)の検出は
    // occ-concurrency.test.ts の Promise.all ベースのプロパティテストが担う。
    // acceptFingerprint は no_drift 判定を OCC より先に行うため、「敗者」の再試行の直前に drift を
    // 再度1へ戻す(no_drift ではなく conflict パスを純粋に検証するため)。
    it('testcases: 順次(sequential)— 既に消費された stale expectedVersion での acceptFingerprint 再試行は history を増やさず必ず conflict を返す(真の並行レース検出は occ-concurrency.test.ts 参照)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-fp-race' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'fp-race' }), historyEntry(), now);
      await ctx.rawExec(`UPDATE test_cases SET drift=1, fingerprint='old-fp', mirror_origin='discovery-v1' WHERE id='${created.id}'`);
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at, committed_at) ` +
        `VALUES ('sess-fp-race', '${p.id}', 'discovery-v1', 'committed', ${now}, ${now + 1000}, ${now})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-fp-race', '${created.id}', 'ext-1', '${p.id}', 'new-fp', '{"given":"g","when":"w","then":"t","parameters":[]}', 'sess-fp-race', 'discovery-v1', ${now + 1})`,
      );

      const current = await ctx.storage.getTestCase(scope, p.id, created.id);
      expect(current!.version).toBe(1);

      // 「勝者」: expectedVersion=1 で drift を解消し version=2 に進む。
      const winner = await ctx.storage.acceptFingerprint(scope, p.id, created.id, 1, 'user:winner', now + 1);
      expect(winner.kind).toBe('ok');
      if (winner.kind !== 'ok') throw new Error('unreachable');
      expect(winner.row.version).toBe(2);

      const historyCountBefore = (await ctx.storage.listHistory(scope, p.id, created.id, { limit: 50 })).total;

      // drift を再度立てる(勝者の成功で drift=0 になっているため。no_drift ではなく OCC の
      // conflict パスを検証したいので、drift の前提条件だけ満たしておく)。
      await ctx.rawExec(`UPDATE test_cases SET drift=1 WHERE id='${created.id}'`);

      // 「敗者」: 勝者の書き込みを知らないまま、同じ stale expectedVersion=1 で再試行する。
      const loser = await ctx.storage.acceptFingerprint(scope, p.id, created.id, 1, 'user:loser', now + 2);
      expect(loser).toEqual({ kind: 'conflict' }); // ok ではない(偽の成功なし)

      const historyCountAfter = (await ctx.storage.listHistory(scope, p.id, created.id, { limit: 50 })).total;
      expect(historyCountAfter).toBe(historyCountBefore); // phantom entry が増えていない

      const finalRow = await ctx.storage.getTestCase(scope, p.id, created.id);
      expect(finalRow?.version).toBe(2); // 敗者による余計な version bump も無い
    });

    it('testcases: listIdentities は test_case_id+project_id スコープの全 identity を返す(ページングなし)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-ident' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'ident' }), historyEntry(), now);
      await ctx.rawExec(
        `INSERT INTO test_case_identities (id, test_case_id, project_id, origin, external_ref, is_stale, last_seen_at, created_at) ` +
        `VALUES ('idn-1', '${created.id}', '${p.id}', 'discovery-v1', 'ext-1', 0, ${now}, ${now})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_identities (id, test_case_id, project_id, origin, external_ref, is_stale, last_seen_at, created_at) ` +
        `VALUES ('idn-2', '${created.id}', '${p.id}', 'discovery-v2', 'ext-1', 1, ${now}, ${now})`,
      );

      const rows = await ctx.storage.listIdentities(scope, p.id, created.id);
      expect(rows.map((r) => r.id).sort()).toEqual(['idn-1', 'idn-2']);
    });

    it('testcases: listObservations は committed セッション由来のみ返す(active セッションは除外)。origin フィルタで絞り込む', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-obs' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'obs' }), historyEntry(), now);

      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at) ` +
        `VALUES ('sess-committed', '${p.id}', 'discovery-v1', 'committed', ${now}, ${now + 1000})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-committed-1', '${created.id}', 'ext-1', '${p.id}', 'fp1', '{}', 'sess-committed', 'discovery-v1', ${now + 1})`,
      );

      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at) ` +
        `VALUES ('sess-active', '${p.id}', 'discovery-v1', 'active', ${now}, ${now + 1000})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-active-1', '${created.id}', 'ext-1', '${p.id}', 'fp2', '{}', 'sess-active', 'discovery-v1', ${now + 2})`,
      );

      const result = await ctx.storage.listObservations(scope, p.id, created.id, { limit: 10 });
      expect(result.items.map((i) => i.id)).toEqual(['obs-committed-1']); // active 由来は除外
      expect(result.total).toBe(1);

      const filtered = await ctx.storage.listObservations(scope, p.id, created.id, { origin: 'other-origin', limit: 10 });
      expect(filtered.items).toHaveLength(0);
      expect(filtered.total).toBe(0);
    });

    it('testcases: getLatestCommittedObservation は mirror_origin 一致・committed 由来の最新1件を返す(mirror_origin=null なら null。他 origin の観測は無視)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-latest' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'latest' }), historyEntry(), now);

      expect(await ctx.storage.getLatestCommittedObservation(scope, p.id, created.id)).toBeNull();

      await ctx.rawExec(`UPDATE test_cases SET mirror_origin='discovery-v1' WHERE id='${created.id}'`);
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at) ` +
        `VALUES ('sess-latest', '${p.id}', 'discovery-v1', 'committed', ${now}, ${now + 1000})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-old', '${created.id}', 'ext-1', '${p.id}', 'fp-old', '{}', 'sess-latest', 'discovery-v1', ${now + 1})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-new', '${created.id}', 'ext-1', '${p.id}', 'fp-new', '{}', 'sess-latest', 'discovery-v1', ${now + 2})`,
      );
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at) ` +
        `VALUES ('sess-other', '${p.id}', 'other-origin', 'committed', ${now}, ${now + 1000})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-other', '${created.id}', 'ext-1', '${p.id}', 'fp-other', '{}', 'sess-other', 'other-origin', ${now + 3})`,
      );

      const latest = await ctx.storage.getLatestCommittedObservation(scope, p.id, created.id);
      expect(latest?.id).toBe('obs-new');
      expect(latest?.fingerprint).toBe('fp-new');
    });

    // review round 1(Important #2)。listObservations の committed-JOIN フェンス検証(上の
    // 「active セッションは除外」テスト)と対になる getLatestCommittedObservation 側のテストが
    // 無かったため追加する。同一テストケースに対して committed セッション由来の観測と active
    // セッション由来の観測を両方仕込み、active 側の created_at をより新しくする(除外が効いていなければ
    // ORDER BY created_at DESC で active 側が誤って「最新」として返ってしまうため、除外の有無を
    // 確実に区別できる)。GET /diff・accept-fingerprint の fingerprint 採用元となる関数のため重要。
    it('testcases: getLatestCommittedObservation は active セッション由来の観測を除外する(同一 origin でより新しくても committed 側を返す)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-latest-active-excl' }, now);
      const created = await ctx.storage.createTestCaseManual(scope, p.id, tcInput({ title: 'latest-active-excl' }), historyEntry(), now);
      await ctx.rawExec(`UPDATE test_cases SET mirror_origin='discovery-v1' WHERE id='${created.id}'`);

      // committed セッション由来の観測(より古い created_at)
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at, committed_at) ` +
        `VALUES ('sess-committed-excl', '${p.id}', 'discovery-v1', 'committed', ${now}, ${now + 1000}, ${now})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-committed-excl', '${created.id}', 'ext-1', '${p.id}', 'fp-committed', '{}', 'sess-committed-excl', 'discovery-v1', ${now + 1})`,
      );

      // active セッション由来の観測(同一 origin・より新しい created_at)
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at) ` +
        `VALUES ('sess-active-excl', '${p.id}', 'discovery-v1', 'active', ${now}, ${now + 1000})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-active-excl', '${created.id}', 'ext-1', '${p.id}', 'fp-active', '{}', 'sess-active-excl', 'discovery-v1', ${now + 2})`,
      );

      const latest = await ctx.storage.getLatestCommittedObservation(scope, p.id, created.id);
      expect(latest?.id).toBe('obs-committed-excl'); // active 由来(より新しい)は除外される
      expect(latest?.fingerprint).toBe('fp-committed');
    });

    // task-15-brief.md「Step 2: 契約テスト追記」(start/chunk・出現台帳)
    it('sync: syncStart は created(session 各列を正しく設定)/conflict(同一 (project,origin) の active 重複)を判別し、別 origin なら並行 created を許す', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-sync-start' }, now);

      const created = await ctx.storage.syncStart(scope, p.id, { token: 'tok-a1', origin: 'discovery-v1', now, slidingMs: 600_000 });
      expect(created.kind).toBe('created');
      if (created.kind !== 'created') throw new Error('unreachable');
      expect(created.session.token).toBe('tok-a1');
      expect(created.session.projectId).toBe(p.id);
      expect(created.session.origin).toBe('discovery-v1');
      expect(created.session.status).toBe('active');
      expect(created.session.startedAt).toBe(now);
      expect(created.session.expiresAt).toBe(now + 600_000);
      expect(created.session.committedAt).toBeNull();

      // 同一 (project,origin) に active が既存 → conflict(部分一意索引違反の捕捉)
      const conflict = await ctx.storage.syncStart(scope, p.id, { token: 'tok-a2', origin: 'discovery-v1', now: now + 1, slidingMs: 600_000 });
      expect(conflict).toEqual({ kind: 'conflict' });
      expect(await ctx.storage.syncGetSession(scope, p.id, 'tok-a2')).toBeNull(); // conflict 側は書き込まれない

      // 別 origin なら並行 created 可
      const otherOrigin = await ctx.storage.syncStart(scope, p.id, { token: 'tok-b1', origin: 'selfheal-v1', now: now + 2, slidingMs: 600_000 });
      expect(otherOrigin.kind).toBe('created');
    });

    it('sync: syncStart は期限切れ active を遅延評価で expired に倒してから created を返す(旧セッションは expired に遷移)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-sync-lazyexpire' }, now);

      const first = await ctx.storage.syncStart(scope, p.id, { token: 'tok-old', origin: 'discovery-v1', now, slidingMs: 1000 });
      expect(first.kind).toBe('created');

      const later = now + 5000; // first の expiresAt(now+1000)を過ぎた時刻
      const second = await ctx.storage.syncStart(scope, p.id, { token: 'tok-new', origin: 'discovery-v1', now: later, slidingMs: 1000 });
      expect(second.kind).toBe('created');

      expect((await ctx.storage.syncGetSession(scope, p.id, 'tok-old'))?.status).toBe('expired');
      expect((await ctx.storage.syncGetSession(scope, p.id, 'tok-new'))?.status).toBe('active');
    });

    it('sync: syncGetSession は project 境界で1件取得し、存在しなければ null', async () => {
      const p1 = await ctx.storage.createProject(scope, { name: 'proj-sync-get1' }, now);
      const p2 = await ctx.storage.createProject(scope, { name: 'proj-sync-get2' }, now);
      await ctx.storage.syncStart(scope, p1.id, { token: 'tok-get', origin: 'discovery-v1', now, slidingMs: 600_000 });

      expect((await ctx.storage.syncGetSession(scope, p1.id, 'tok-get'))?.token).toBe('tok-get');
      expect(await ctx.storage.syncGetSession(scope, p2.id, 'tok-get')).toBeNull(); // 他 project の token は null
      expect(await ctx.storage.syncGetSession(scope, p1.id, 'tok-nonexistent')).toBeNull();
    });

    it('sync: syncTouchExpiry はスライディング失効の延長を反映する', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-sync-touch' }, now);
      await ctx.storage.syncStart(scope, p.id, { token: 'tok-touch', origin: 'discovery-v1', now, slidingMs: 600_000 });

      await ctx.storage.syncTouchExpiry('tok-touch', now + 999_999);
      expect((await ctx.storage.syncGetSession(scope, p.id, 'tok-touch'))?.expiresAt).toBe(now + 999_999);
    });

    it('sync: syncExpireLapsed は対象 (project,origin) の期限切れ active のみを expired に倒す(origin=null はプロジェクト全体)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-sync-expirelapsed' }, now);
      await ctx.storage.syncStart(scope, p.id, { token: 'tok-e1', origin: 'discovery-v1', now, slidingMs: 100 });
      await ctx.storage.syncStart(scope, p.id, { token: 'tok-e2', origin: 'selfheal-v1', now, slidingMs: 100_000 });

      // origin 指定: discovery-v1 のみ期限切れになった時刻でスイープ → discovery-v1 のみ expired
      await ctx.storage.syncExpireLapsed(scope, p.id, 'discovery-v1', now + 1000);
      expect((await ctx.storage.syncGetSession(scope, p.id, 'tok-e1'))?.status).toBe('expired');
      expect((await ctx.storage.syncGetSession(scope, p.id, 'tok-e2'))?.status).toBe('active'); // まだ期限内

      // origin=null: プロジェクト全体を対象に、tok-e2 も期限切れになった時刻でスイープ
      await ctx.storage.syncExpireLapsed(scope, p.id, null, now + 200_000);
      expect((await ctx.storage.syncGetSession(scope, p.id, 'tok-e2'))?.status).toBe('expired');
    });

    it('sync: syncAppendObservations は変化点のみ観測を追記し、同一セッションへの同一 fingerprint 再送は duplicate になる(観測行が増えない証拠として2回目以降も duplicate のまま安定する)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-sync-append' }, now);
      const started = await ctx.storage.syncStart(scope, p.id, { token: 'tok-append', origin: 'discovery-v1', now, slidingMs: 600_000 });
      if (started.kind !== 'created') throw new Error('unreachable');
      const session = started.session;

      const obs1 = chunkObs({ externalRef: 'ext-dup', fingerprint: 'fp-1' });
      const first = await ctx.storage.syncAppendObservations(scope, p.id, session, [obs1], now + 1);
      expect(first).toEqual([{ external_ref: 'ext-dup', outcome: 'inserted' }]);

      // 同一 fingerprint の再送(ネットワーク再送・同一チャンク再送を模す)→ duplicate
      const second = await ctx.storage.syncAppendObservations(scope, p.id, session, [obs1], now + 2);
      expect(second).toEqual([{ external_ref: 'ext-dup', outcome: 'duplicate' }]);
      // 3回目も安定して duplicate(観測行が増え続けていれば fingerprint 比較の前提が壊れて re-inserted になりうる)
      const third = await ctx.storage.syncAppendObservations(scope, p.id, session, [obs1], now + 3);
      expect(third).toEqual([{ external_ref: 'ext-dup', outcome: 'duplicate' }]);

      // fingerprint が変わった場合は新しい変化点として inserted
      const changed = await ctx.storage.syncAppendObservations(
        scope, p.id, session, [chunkObs({ externalRef: 'ext-dup', fingerprint: 'fp-2' })], now + 4,
      );
      expect(changed).toEqual([{ external_ref: 'ext-dup', outcome: 'inserted' }]);
    });

    it('sync: syncAppendObservations は16行/文の分割を跨いでも全件を正しく記録する(40件一括 → 全件 inserted、同一40件を再送 → 全件 duplicate)', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-sync-40' }, now);
      const started = await ctx.storage.syncStart(scope, p.id, { token: 'tok-40', origin: 'discovery-v1', now, slidingMs: 600_000 });
      if (started.kind !== 'created') throw new Error('unreachable');

      const obsList = Array.from({ length: 40 }, (_, i) => chunkObs({ externalRef: `ext-${i}`, fingerprint: `fp-${i}` }));

      const firstRound = await ctx.storage.syncAppendObservations(scope, p.id, started.session, obsList, now + 1);
      expect(firstRound).toHaveLength(40);
      expect(firstRound.every((r) => r.outcome === 'inserted')).toBe(true);

      // 全40件が実際に永続化されていなければ、再送時に一部が誤って 'inserted' に戻ってしまう
      // (16行/文の分割の過程で一部の観測が欠落するバグの検知手段)。
      const secondRound = await ctx.storage.syncAppendObservations(scope, p.id, started.session, obsList, now + 2);
      expect(secondRound).toHaveLength(40);
      expect(secondRound.every((r) => r.outcome === 'duplicate')).toBe(true);
    });

    it('sync: syncAppendObservations の committed-JOIN フェンス: active な他セッションの観測は最新指紋比較の対象にならないが、committed セッションの観測は対象になる', async () => {
      const p = await ctx.storage.createProject(scope, { name: 'proj-sync-fence' }, now);

      // 「他セッション」(active・current でも committed でもない)の観測は最新指紋比較から除外される。
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at) ` +
        `VALUES ('other-active', '${p.id}', 'discovery-v1', 'active', ${now}, ${now + 100000})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-other-active', 'ext-fence-active', '${p.id}', 'fp-other-active', '{}', 'other-active', 'discovery-v1', ${now})`,
      );

      // committed セッションの観測は最新指紋比較の対象になる。
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at, committed_at) ` +
        `VALUES ('other-committed', '${p.id}', 'discovery-v1', 'committed', ${now}, ${now + 100000}, ${now})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-other-committed', 'ext-fence-committed', '${p.id}', 'fp-committed', '{}', 'other-committed', 'discovery-v1', ${now})`,
      );

      // "current" セッション: sync_seen.sync_token は sync_sessions への FK のため行自体は必要だが、
      // 同一 origin に status='active' の行が既に(other-active として)存在し uq_active_session と
      // 衝突するため、DB 上は 'expired' として登録する(syncAppendObservations は渡された session
      // オブジェクトの token/origin の等価比較のみでフェンス判定するため、DB 行の status 値そのものは
      // 判定に使われず、この不一致はテスト目的上無害)。
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at) ` +
        `VALUES ('current-fence', '${p.id}', 'discovery-v1', 'expired', ${now}, ${now + 100000})`,
      );
      const currentSession: SyncSessionRow = {
        token: 'current-fence', projectId: p.id, origin: 'discovery-v1', status: 'active',
        startedAt: now, expiresAt: now + 100000, committedAt: null, createdCount: null, changedCount: null, staledCount: null,
      };

      const result = await ctx.storage.syncAppendObservations(scope, p.id, currentSession, [
        chunkObs({ externalRef: 'ext-fence-active', fingerprint: 'fp-current' }), // 他activeの指紋は無視 → 初出扱いで inserted
        chunkObs({ externalRef: 'ext-fence-committed', fingerprint: 'fp-committed' }), // committedの指紋と一致 → duplicate
      ], now + 1);

      expect(result).toEqual(expect.arrayContaining([
        { external_ref: 'ext-fence-active', outcome: 'inserted' },
        { external_ref: 'ext-fence-committed', outcome: 'duplicate' },
      ]));
      expect(result).toHaveLength(2);
    });
  });
}
