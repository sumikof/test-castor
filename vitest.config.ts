import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts', 'tests/contract/better-sqlite3.test.ts', 'tests/contract/libsql.test.ts'] },
});
