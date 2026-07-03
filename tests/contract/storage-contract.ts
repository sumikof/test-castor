// tests/contract/storage-contract.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { Storage } from '../../src/storage/interface';

export interface ContractCtx {
  storage: Storage;
  rawExec(sqlText: string): Promise<void>;
}
const WIPE_ORDER = [
  'test_case_history', 'test_case_observations', 'sync_staging', 'sync_sessions',
  'test_case_identities', 'test_cases', 'api_tokens', 'sessions', 'projects', 'users', 'organizations',
];

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
  });
}
