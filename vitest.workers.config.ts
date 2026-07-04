import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      include: ['tests/integration/**/*.test.ts', 'tests/contract/d1.test.ts'],
      setupFiles: ['./tests/integration/setup-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          // TEST_MIGRATIONS に加え、SESSION_SIGNING_KEYS/SESSION_ACTIVE_KEY_ID もここで注入する
          // (レビュー finding #2): wrangler.jsonc は本番同様 SESSION_SIGNING_KEYS を secret 運用の
          // ため設定しないので、これが無いと tests/integration/entry.test.ts が実entry経由で
          // buildDeps(env)→loadConfig を叩くたびに毎回 loadConfig の dev フォールバック
          // console.warn を踏む(テスト出力は pristine であるべき)。tests/integration/helpers.ts が
          // makeTestApp() に注入するのと同じ、明示的にテスト専用と分かる鍵値で揃える。
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              SESSION_SIGNING_KEYS: JSON.stringify({ k1: 'test' }),
              SESSION_ACTIVE_KEY_ID: 'k1',
            },
          },
        },
      },
    },
  };
});
