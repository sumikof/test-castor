// tests/contract/storage-contract.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { Storage, NewTestCaseColumns, NewHistoryEntry } from '../../src/storage/interface';

export interface ContractCtx {
  storage: Storage;
  rawExec(sqlText: string): Promise<void>;
}
const WIPE_ORDER = [
  'test_case_history', 'test_case_observations', 'sync_staging', 'sync_sessions',
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
  });
}
