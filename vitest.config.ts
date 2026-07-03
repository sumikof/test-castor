import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts', 'tests/contract/better-sqlite3.test.ts', 'tests/contract/better-sqlite3-file.test.ts', 'tests/contract/libsql.test.ts', 'tests/contract/libsql-file.test.ts', 'tests/contract/occ-concurrency.test.ts'] },
});
