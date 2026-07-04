// tests/unit/node-ts-loader.test.ts
// HANDOVER D1: node-ts-loader が transpile 診断を明確に報告することの spawn スモークテスト。
// ローダーは node:module の registerHooks に依存するため、実 node プロセスを spawn して検証する
// (vitest プロセス内では再現できない)。spawn 2〜3 回で数秒かかるが unit スイート全体では許容範囲。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOADER = fileURLToPath(new URL('../../src/entry/node-ts-loader.mjs', import.meta.url));

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });
}

describe('node-ts-loader(D1)', () => {
  it('正当な TS はロードでき、実行結果が出る(対照)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-loader-'));
    try {
      const f = join(dir, 'ok.ts');
      writeFileSync(f, 'const n: number = 42;\nconsole.log(`ok:${n}`);\n');
      const r = runNode(['--import', LOADER, f]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ok:42');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('構文エラー TS は node-ts-loader の診断メッセージ付きで fail する(不明瞭な SyntaxError にしない)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-loader-'));
    try {
      const f = join(dir, 'broken.ts');
      writeFileSync(f, 'const x: = 1;\n');
      const r = runNode(['--import', LOADER, f]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('node-ts-loader: TypeScript transpile diagnostics');
      expect(r.stderr).toContain('broken.ts'); // どのファイルかが分かる
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throw の stack が .ts の元行番号で出る(D2: inline sourcemap + --enable-source-maps)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tms-loader-'));
    try {
      const f = join(dir, 'boom.ts');
      // 型注釈を transpile で除去させ、行番号がズレうる状況を作った上で 4 行目の throw を検証する
      writeFileSync(f, "const pad: number = 1;\nvoid pad;\n\nthrow new Error('boom-at-line-4');\n");
      const r = runNode(['--enable-source-maps', '--import', LOADER, f]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('boom-at-line-4');
      expect(r.stderr).toMatch(/boom\.ts:4/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
