import { runStorageContract } from './storage-contract';
import { createBetterSqlite3Storage } from '../../src/storage/adapters/better-sqlite3';
runStorageContract('better-sqlite3', async () => createBetterSqlite3Storage(':memory:'));
