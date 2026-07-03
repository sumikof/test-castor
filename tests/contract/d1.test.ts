// tests/contract/d1.test.ts
import { env } from 'cloudflare:test';
import { runStorageContract } from './storage-contract';
import { createD1Storage } from '../../src/storage/adapters/d1';
runStorageContract('d1', async () => createD1Storage(env.DB)); // マイグレーションは setup-migrations.ts が適用済み
