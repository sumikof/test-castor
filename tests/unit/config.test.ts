import { describe, expect, it } from 'vitest';
import { loadMaintenanceRetentionMs } from '../../src/http/config';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('loadMaintenanceRetentionMs(C10/C11 最小リーダー)', () => {
  it('未設定 → 既定 90 日', () => {
    expect(loadMaintenanceRetentionMs({})).toBe(90 * DAY_MS);
  });

  it('正整数文字列 → その値(distinct 値で識別)', () => {
    expect(loadMaintenanceRetentionMs({ OBSERVATION_RETENTION_MS: '12345' })).toBe(12345);
  });

  it('非数値・0 以下 → 既定へフォールバック(起動を壊さない)', () => {
    expect(loadMaintenanceRetentionMs({ OBSERVATION_RETENTION_MS: 'abc' })).toBe(90 * DAY_MS);
    expect(loadMaintenanceRetentionMs({ OBSERVATION_RETENTION_MS: '-5' })).toBe(90 * DAY_MS);
    expect(loadMaintenanceRetentionMs({ OBSERVATION_RETENTION_MS: '0' })).toBe(90 * DAY_MS);
  });

  it('SESSION_SIGNING_KEYS が不正でも throw しない(署名鍵設定を読まないことの識別)', () => {
    expect(loadMaintenanceRetentionMs({ SESSION_SIGNING_KEYS: '{not json', OBSERVATION_RETENTION_MS: '777' })).toBe(777);
  });
});
