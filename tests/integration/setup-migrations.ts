import { applyD1Migrations, env } from 'cloudflare:test';
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    ASSETS: Fetcher;
    SESSION_TTL_MS: string;
    SESSION_SIGNING_KEYS?: string;
  }
}
