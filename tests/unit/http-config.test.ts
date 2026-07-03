// tests/unit/http-config.test.ts
// loadConfig: env(Record<string,string|undefined>) → AppConfig。既定値は D-08(セッション7日)・
// D-14(レートリミット具体値)・observation/identity 90日保持に一致すること、SESSION_SIGNING_KEYS
// 未設定時のdevフォールバック+console.warn、SESSION_ACTIVE_KEY_ID による明示的な activeKeyId 選択
// (単一鍵は省略可・複数鍵は必須・存在しない鍵IDや数字のみの鍵ID・非文字列の秘密鍵は例外)を検証する。
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

  it('SESSION_SIGNING_KEYS: 複数鍵時は SESSION_ACTIVE_KEY_ID で指定した鍵が activeKeyId になる(新鍵発行・旧鍵検証猶予)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({
      SESSION_SIGNING_KEYS: '{"k1":"secret1","k2":"secret2"}',
      SESSION_ACTIVE_KEY_ID: 'k2',
    });
    expect(cfg.signingKeys).toEqual({ k1: 'secret1', k2: 'secret2' });
    expect(cfg.activeKeyId).toBe('k2');
  });

  it('SESSION_ACTIVE_KEY_ID が signingKeys に存在しない鍵IDを指す場合: 例外を投げる', () => {
    expect(() =>
      loadConfig({
        SESSION_SIGNING_KEYS: '{"k1":"secret1","k2":"secret2"}',
        SESSION_ACTIVE_KEY_ID: 'k9',
      }),
    ).toThrow('SESSION_ACTIVE_KEY_ID');
  });

  it('複数鍵 かつ SESSION_ACTIVE_KEY_ID 未設定: 例外を投げる(曖昧な自動選択を拒否する)', () => {
    expect(() => loadConfig({ SESSION_SIGNING_KEYS: '{"k1":"secret1","k2":"secret2"}' })).toThrow(
      'SESSION_ACTIVE_KEY_ID must be set when multiple signing keys are configured',
    );
  });

  it('鍵IDが数字のみ(例 "1")の場合: 例外を投げる(JSのオブジェクトキー数値昇順列挙の罠を回避)', () => {
    expect(() => loadConfig({ SESSION_SIGNING_KEYS: '{"1":"secret1"}' })).toThrow();
  });

  it('複数鍵の一部が数字のみの鍵IDの場合も例外を投げる(SESSION_ACTIVE_KEY_ID指定の有無に関わらず)', () => {
    expect(() =>
      loadConfig({
        SESSION_SIGNING_KEYS: '{"k1":"secret1","2":"secret2"}',
        SESSION_ACTIVE_KEY_ID: 'k1',
      }),
    ).toThrow();
  });

  it('loadConfig の出力を createWebcryptoAuth にそのまま渡せる(dev フォールバック・複数鍵どちらも構築時エラーにならない)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const devCfg = loadConfig({});
    expect(() => createWebcryptoAuth({ ...devCfg })).not.toThrow();

    const multiCfg = loadConfig({
      SESSION_SIGNING_KEYS: '{"k1":"secret1","k2":"secret2"}',
      SESSION_ACTIVE_KEY_ID: 'k2',
    });
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

  it('SESSION_SIGNING_KEYS の値が文字列でない場合(例 {"k1":42})は例外を投げる', () => {
    expect(() => loadConfig({ SESSION_SIGNING_KEYS: '{"k1":42}' })).toThrow();
  });
});
