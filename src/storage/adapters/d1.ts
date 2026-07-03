// src/storage/adapters/d1.ts
import { drizzle } from 'drizzle-orm/d1';
import { createDrizzleStorage, type AnyQuery } from '../drizzle-storage';

export function createD1Storage(d1: D1Database) {
  const db = drizzle(d1);
  const storage = createDrizzleStorage({
    db,
    async batch(queries: AnyQuery[]) {
      if (queries.length === 0) return;
      await (db as any).batch(queries); // D1: batch = 単一トランザクション(sync-protocol.md「原子性の保証」)
    },
    async rawExec(sqlText: string) { await d1.exec(sqlText); },
  });
  return { storage, rawExec: (s: string) => d1.exec(s).then(() => undefined) };
}
