// src/storage/adapters/better-sqlite3.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createDrizzleStorage, type AnyQuery } from '../drizzle-storage';
import { migrationStatements } from '../migrations-loader';

export function createBetterSqlite3Storage(path = ':memory:') {
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  // operations.md §4.3: auto_vacuum はテーブル作成前(空DB時)に設定
  // auto_vacuum は最初のコミット前に設定必須(WAL切替がpage 1をコミットするため先に発行するとno-op化する)
  if ((sqlite.pragma('page_count', { simple: true }) as number) <= 1) {
    sqlite.pragma('auto_vacuum = INCREMENTAL');
  }
  sqlite.pragma('journal_mode = WAL');
  for (const stmt of migrationStatements()) sqlite.exec(stmt);
  const db = drizzle(sqlite);
  const storage = createDrizzleStorage({
    db,
    // review round 1(CRITICAL OCC concurrency): 各文の affected 行数(better-sqlite3 の
    // RunResult.changes)を実行順に集めて返す。呼び出し側(drizzle-storage.ts の patchTestCase 等)は
    // これで OCC 対象 UPDATE が実際に何行へ命中したかを検査する。
    async batch(queries: AnyQuery[]) {
      return sqlite.transaction(() => queries.map((q) => (q.run() as { changes: number }).changes))();
    },
    async rawExec(sqlText: string) { sqlite.exec(sqlText); },
  });
  return { storage, rawExec: async (s: string) => { sqlite.exec(s); }, sqlite };
}
