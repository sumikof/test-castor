// tests/contract/libsql.test.ts
import { runStorageContract } from './storage-contract';
import { createLibsqlStorage } from '../../src/storage/adapters/libsql';
runStorageContract('libsql', async () => createLibsqlStorage(':memory:'));
