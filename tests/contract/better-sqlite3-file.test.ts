import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createBetterSqlite3Storage } from '../../src/storage/adapters/better-sqlite3';

describe('better-sqlite3 adapter (file-backed)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tms-bsqlite3-'));
  const dbPath = path.join(dir, 'tms.sqlite');
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('applies connection-init pragmas and serves basic storage ops (operations.md §4.3/§6.2)', async () => {
    const { storage, rawExec, sqlite } = createBetterSqlite3Storage(dbPath);

    // 独立したプローブ接続で永続 PRAGMA 状態を検証する。auto_vacuum と journal_mode は
    // どちらも DB ファイル自体に保存されるため、新規接続からも createBetterSqlite3Storage が
    // (テーブル作成前に)設定した値が観測できる。
    const probe = new Database(dbPath);
    expect(probe.pragma('auto_vacuum', { simple: true })).toBe(2); // 2 = INCREMENTAL(ファイル作成前に設定された証拠)
    expect(String(probe.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    probe.close();

    // 基本オペレーション往復: setupOrganization, findUserForLogin, and rawExec
    const r = await storage.setupOrganization({ orgName: 'o', adminEmail: 'a@example.com', adminPasswordHash: 'h', adminDisplayName: 'A', now: 1 });
    const user = await storage.findUserForLogin('a@example.com');
    expect(user?.id).toBe(r.user.id);
    await rawExec('DELETE FROM sessions');
    sqlite.close();
  });
});
