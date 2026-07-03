// src/storage/adapters/d1.ts
import { drizzle } from 'drizzle-orm/d1';
import { createDrizzleStorage, type AnyQuery } from '../drizzle-storage';

export function createD1Storage(d1: D1Database) {
  const db = drizzle(d1);
  const storage = createDrizzleStorage({
    db,
    // review round 1(CRITICAL OCC concurrency): D1Result.meta.changes(D1 が SQLite の changes() を
    // そのまま転記する affected 行数)を実行順に返す。呼び出し側はこれで OCC 対象 UPDATE の命中行数を検査する
    // (rows_written ではなく changes を使う: rows_written は D1 内部のストレージ書き込み量の指標で
    // WHERE 未命中時の意味論が本用途に適さない懸念があるため、changes()相当が明確な方を採用し、
    // 契約テスト(tests/contract/d1.test.ts 経由)で実際に conflict/ok が正しく分岐することを検証する)。
    async batch(queries: AnyQuery[]) {
      if (queries.length === 0) return [];
      const results = await (db as any).batch(queries); // D1: batch = 単一トランザクション(sync-protocol.md「原子性の保証」)
      return results.map((r: any) => r.meta.changes as number);
    },
    async rawExec(sqlText: string) { await d1.exec(sqlText); },
  });
  return { storage, rawExec: (s: string) => d1.exec(s).then(() => undefined) };
}
