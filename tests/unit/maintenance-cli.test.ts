// tests/unit/maintenance-cli.test.ts
// HANDOVER B8: runMaintenanceCli / maintenanceCliMain ラッパーの直接テスト。
// 実 better-sqlite3 のファイル DB を使い、Database.prototype への spy で incremental_vacuum
// 呼び出しと close を観測する(CLI に注入シームが無いための正当な観測手段。spyOn は既定で
// 元実装を呼び通すため、アダプタ構築時の PRAGMA 群の挙動は変わらない)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { maintenanceCliMain, runMaintenanceCli } from '../../src/entry/maintenance-cli';

describe('maintenance-cli(B8)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tms-maint-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0; // exitCode=1 を残すと vitest プロセス自体の終了コードを汚すため必ず復元
    rmSync(dir, { recursive: true, force: true });
  });

  it('runMaintenanceCli: maintenance 実行後に incremental_vacuum を発行し、接続を close する', async () => {
    const pragmaSpy = vi.spyOn(Database.prototype, 'pragma');
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMaintenanceCli(join(dir, 'm.sqlite'));

    expect(pragmaSpy.mock.calls.some((args) => args[0] === 'incremental_vacuum')).toBe(true);
    expect(closeSpy).toHaveBeenCalled();
    // runMaintenance の構造化ログ(maintenance_run)が stdout(console.log)へ 1 行出る
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes('"event":"maintenance_run"'))).toBe(true);
  });

  it('maintenanceCliMain: 失敗時に maintenance_cli_failed JSON + exitCode=1(throw しない)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 存在しないサブディレクトリ → better-sqlite3 が SQLITE_CANTOPEN で同期 throw する
    await maintenanceCliMain(join(dir, 'no-such-subdir', 'x.sqlite'));

    expect(process.exitCode).toBe(1);
    const line = errSpy.mock.calls.map((args) => String(args[0])).find((s) => s.includes('maintenance_cli_failed'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string) as { event: string; error: string };
    expect(parsed.event).toBe('maintenance_cli_failed');
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it('maintenanceCliMain: 成功時は exitCode を汚さず、失敗 JSON も出さない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await maintenanceCliMain(join(dir, 'ok.sqlite'));

    expect(process.exitCode).not.toBe(1);
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes('maintenance_cli_failed'))).toBe(false);
  });
});
