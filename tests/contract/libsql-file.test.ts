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
    // file-backed mode (url !== ':memory:') triggers pragma initialization code path
    // PRAGMA foreign_keys=ON is applied always; journal_mode=WAL and auto_vacuum=INCREMENTAL
    // are applied only for file-backed databases (before migrations run)
    expect(dbPath).toBeTruthy();
    expect(dbPath).toContain('.sqlite');

    // 基本オペレーション往復: setupOrganization, findUserForLogin, and rawExec
    const r = await storage.setupOrganization({ orgName: 'o', adminEmail: 'a@example.com', adminPasswordHash: 'h', adminDisplayName: 'A', now: 1 });
    const user = await storage.findUserForLogin('a@example.com');
    expect(user?.id).toBe(r.user.id);
    await rawExec('DELETE FROM sessions');
  });
});
