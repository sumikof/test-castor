// src/storage/adapters/libsql.ts
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { createDrizzleStorage, type AnyQuery } from '../drizzle-storage';
import { migrationStatements } from '../migrations-loader';

export async function createLibsqlStorage(url = ':memory:') {
  const client = createClient({ url: url === ':memory:' ? ':memory:' : `file:${url}` });
  // operations.md §6.2: 環境固有 PRAGMA は共通マイグレーションでなく、各オンプレアダプタの
  // 接続初期化フックで(テーブル作成前に)適用する。foreign_keys は全モードで必須のため
  // 失敗を握りつぶさない。
  await client.execute('PRAGMA foreign_keys = ON');
  if (url !== ':memory:') {
    // operations.md §4.3: auto_vacuum はオンプレ固有の肥大化対策として DB 初期化時
    // (テーブル作成前)に設定。WAL は同時実行性のため。一部の libSQL 実行モードは
    // これらの PRAGMA を拒否することがあるため、その場合は無視する(致命的ではない)。
    try {
      await client.execute('PRAGMA journal_mode = WAL');
      await client.execute('PRAGMA auto_vacuum = INCREMENTAL');
    } catch {
      // 一部の libSQL 実行モード(embedded replica 等)では未対応。無視して続行。
    }
  }
  for (const stmt of migrationStatements()) {
    const trimmed = stmt.trim();
    if (trimmed) await client.executeMultiple(trimmed);
  }
  const db = drizzle(client);
  const storage = createDrizzleStorage({
    db,
    async batch(queries: AnyQuery[]) {
      if (queries.length === 0) return;
      await (db as any).batch(queries);
    },
    async rawExec(sqlText: string) { await client.executeMultiple(sqlText); },
  });
  return { storage, rawExec: (s: string) => client.executeMultiple(s).then(() => undefined) };
}
