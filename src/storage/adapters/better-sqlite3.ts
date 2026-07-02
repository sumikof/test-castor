// src/storage/adapters/better-sqlite3.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createDrizzleStorage, type AnyQuery } from '../drizzle-storage';
import { migrationStatements } from '../migrations-loader';

export function createBetterSqlite3Storage(path = ':memory:') {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // operations.md §4.3: auto_vacuum はテーブル作成前(空DB時)に設定
  if ((sqlite.pragma('page_count', { simple: true }) as number) <= 1) {
    sqlite.pragma('auto_vacuum = INCREMENTAL');
  }
  for (const stmt of migrationStatements()) sqlite.exec(stmt);
  const db = drizzle(sqlite);
  const storage = createDrizzleStorage({
    db,
    async batch(queries: AnyQuery[]) {
      sqlite.transaction(() => { for (const q of queries) q.run(); })();
    },
    async rawExec(sqlText: string) { sqlite.exec(sqlText); },
  });
  return { storage, rawExec: async (s: string) => { sqlite.exec(s); }, sqlite };
}
