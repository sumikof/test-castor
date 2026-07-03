// tests/unit/http-config.test.ts
// loadConfig: env(Record<string,string|undefined>) → AppConfig。既定値は D-08(セッション7日)・
// D-14(レートリミット具体値)・observation/identity 90日保持に一致すること、SESSION_SIGNING_KEYS
// 未設定時のdevフォールバック+console.warn、JSON パース結果からの activeKeyId 導出を検証する。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig } from '../../src/http/config';
import { createWebcryptoAuth } from '../../src/auth/webcrypto-auth';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('http/config: loadConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('空env: 全項目が仕様どおりの既定値になる(D-08/D-14/90日保持)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({});
    expect(cfg.sessionTtlMs).toBe(604_800_000); // D-08: 7日
    expect(cfg.pbkdf2Iterations).toBe(600_000);
    expect(cfg.loginRateLimit).toEqual({ windowMs: 900_000, max: 5 }); // D-14
    expect(cfg.syncRateLimit).toEqual({ windowMs: 60_000, max: 120 }); // D-14
    expect(cfg.observationRetentionMs).toBe(90 * DAY_MS);
    expect(cfg.identityTtlMs).toBe(90 * DAY_MS);
  });

  it('SESSION_SIGNING_KEYS 未設定: devフォールバック{"dev":"dev-insecure-key"}を使い console.warn する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({});
    expect(cfg.signingKeys).toEqual({ dev: 'dev-insecure-key' });
    expect(cfg.activeKeyId).toBe('dev');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('SESSION_SIGNING_KEYS 設定時: console.warn しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({ SESSION_SIGNING_KEYS: '{"k1":"secret1"}' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('SESSION_SIGNING_KEYS: JSON {"k1":"secret"} をそのまま signingKeys にパースし、単一鍵なら activeKeyId=k1', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ SESSION_SIGNING_KEYS: '{"k1":"secret1"}' });
    expect(cfg.signingKeys).toEqual({ k1: 'secret1' });
    expect(cfg.activeKeyId).toBe('k1');
  });

  it('SESSION_SIGNING_KEYS: 複数鍵ローテーション時は最後に列挙された鍵が activeKeyId になる(新鍵発行・旧鍵検証猶予)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ SESSION_SIGNING_KEYS: '{"k1":"secret1","k2":"secret2"}' });
    expect(cfg.signingKeys).toEqual({ k1: 'secret1', k2: 'secret2' });
    expect(cfg.activeKeyId).toBe('k2');
  });

  it('loadConfig の出力を createWebcryptoAuth にそのまま渡せる(dev フォールバック・複数鍵どちらも構築時エラーにならない)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const devCfg = loadConfig({});
    expect(() => createWebcryptoAuth({ ...devCfg })).not.toThrow();

    const multiCfg = loadConfig({ SESSION_SIGNING_KEYS: '{"k1":"secret1","k2":"secret2"}' });
    const auth = createWebcryptoAuth({ ...multiCfg, pbkdf2Iterations: 1000 });
    expect(auth).toBeTruthy();
  });

  it('SESSION_TTL_MS env override', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ SESSION_TTL_MS: '12345' });
    expect(cfg.sessionTtlMs).toBe(12345);
  });

  it('PBKDF2_ITERATIONS env override', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ PBKDF2_ITERATIONS: '1000' });
    expect(cfg.pbkdf2Iterations).toBe(1000);
  });

  it('LOGIN_RATE_LIMIT_WINDOW_MS / LOGIN_RATE_LIMIT_MAX env override', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ LOGIN_RATE_LIMIT_WINDOW_MS: '1000', LOGIN_RATE_LIMIT_MAX: '2' });
    expect(cfg.loginRateLimit).toEqual({ windowMs: 1000, max: 2 });
  });

  it('SYNC_RATE_LIMIT_WINDOW_MS / SYNC_RATE_LIMIT_MAX env override', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ SYNC_RATE_LIMIT_WINDOW_MS: '5000', SYNC_RATE_LIMIT_MAX: '9' });
    expect(cfg.syncRateLimit).toEqual({ windowMs: 5000, max: 9 });
  });

  it('OBSERVATION_RETENTION_MS / IDENTITY_TTL_MS env override', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ OBSERVATION_RETENTION_MS: '111', IDENTITY_TTL_MS: '222' });
    expect(cfg.observationRetentionMs).toBe(111);
    expect(cfg.identityTtlMs).toBe(222);
  });

  it('不正な数値文字列(NaNになる)は既定値にフォールバックする', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ SESSION_TTL_MS: 'not-a-number' });
    expect(cfg.sessionTtlMs).toBe(604_800_000);
  });

  it('0 以下の数値文字列は既定値にフォールバックする(TTL/ウィンドウ/maxが0は無意味)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ SESSION_TTL_MS: '0', PBKDF2_ITERATIONS: '-5' });
    expect(cfg.sessionTtlMs).toBe(604_800_000);
    expect(cfg.pbkdf2Iterations).toBe(600_000);
  });

  it('SESSION_SIGNING_KEYS が不正なJSONなら例外を投げる(起動時失敗を優先)', () => {
    expect(() => loadConfig({ SESSION_SIGNING_KEYS: 'not-json' })).toThrow();
  });

  it('SESSION_SIGNING_KEYS が空オブジェクトなら例外を投げる(activeKeyIdが導出不能)', () => {
    expect(() => loadConfig({ SESSION_SIGNING_KEYS: '{}' })).toThrow();
  });

  it('SESSION_SIGNING_KEYS が配列/非オブジェクトなら例外を投げる', () => {
    expect(() => loadConfig({ SESSION_SIGNING_KEYS: '["k1"]' })).toThrow();
    expect(() => loadConfig({ SESSION_SIGNING_KEYS: '42' })).toThrow();
    expect(() => loadConfig({ SESSION_SIGNING_KEYS: 'null' })).toThrow();
  });
});
