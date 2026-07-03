import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLibsqlStorage } from '../../src/storage/adapters/libsql';

describe('libsql adapter (file-backed)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tms-libsql-'));
  const dbPath = path.join(dir, 'tms.sqlite');
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('applies connection-init pragmas and serves basic storage ops (operations.md §4.3/§6.2)', async () => {
    const { storage, rawExec } = await createLibsqlStorage(dbPath);

    // file-backed mode (url !== ':memory:') triggers pragma initialization code path:
    // PRAGMA foreign_keys=ON is applied always; journal_mode=WAL and auto_vacuum=INCREMENTAL
    // are applied only for file-backed databases (before migrations run). Verify this by
    // opening an independent probe connection to the same file and reading back the
    // persisted pragma state (auto_vacuum and journal_mode are both stored in the DB file
    // itself, so a fresh connection observes what createLibsqlStorage set).
    const { createClient } = await import('@libsql/client');
    const probe = createClient({ url: `file:${dbPath}` });
    const av = await probe.execute('PRAGMA auto_vacuum');
    expect(Number(Object.values(av.rows[0] as Record<string, unknown>)[0])).toBe(2); // 2 = INCREMENTAL(ファイル作成前に設定された証拠)
    const jm = await probe.execute('PRAGMA journal_mode');
    expect(String(Object.values(jm.rows[0] as Record<string, unknown>)[0]).toLowerCase()).toBe('wal');
    probe.close();

    // 基本オペレーション往復: setupOrganization, findUserForLogin, and rawExec
    const r = await storage.setupOrganization({ orgName: 'o', adminEmail: 'a@example.com', adminPasswordHash: 'h', adminDisplayName: 'A', now: 1 });
    const user = await storage.findUserForLogin('a@example.com');
    expect(user?.id).toBe(r.user.id);
    await rawExec('DELETE FROM sessions');
  });
});
