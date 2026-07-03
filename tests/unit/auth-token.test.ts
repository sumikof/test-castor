// tests/unit/auth-token.test.ts
// APIトークン生成("tms_"+base64url(32B))・決定的SHA-256ハッシュ(hex64桁)・
// セッションID/CSRFトークン生成(32B base64url)を検証する
// (auth-security.md「トークン生成」「トークン保存・照合」「CSRF防御」、
// data-model.md「トークン生成仕様」)。
import { describe, it, expect } from 'vitest';
import { createWebcryptoAuth } from '../../src/auth/webcrypto-auth';

function makeAuth() {
  return createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
}

describe('auth: api token (tms_ prefix, sha-256 hash)', () => {
  it('newApiToken: "tms_" + base64url(32バイト) = /^tms_[A-Za-z0-9_-]{43}$/', () => {
    const auth = makeAuth();
    const token = auth.newApiToken();
    expect(token).toMatch(/^tms_[A-Za-z0-9_-]{43}$/);
  });

  it('newApiToken: 呼び出しごとに異なる値(CSPRNG)', () => {
    const auth = makeAuth();
    const tokens = new Set(Array.from({ length: 20 }, () => auth.newApiToken()));
    expect(tokens.size).toBe(20);
  });

  it('hashApiToken: 同一入力に対して同一の hex64 桁を返す(決定的)', async () => {
    const auth = makeAuth();
    const a = await auth.hashApiToken('tms_sometoken');
    const b = await auth.hashApiToken('tms_sometoken');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashApiToken: 既知のSHA-256テストベクタと一致する("abc")', async () => {
    const auth = makeAuth();
    const hash = await auth.hashApiToken('abc');
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashApiToken: 入力が異なれば出力も異なる', async () => {
    const auth = makeAuth();
    const a = await auth.hashApiToken('token-a');
    const b = await auth.hashApiToken('token-b');
    expect(a).not.toBe(b);
  });

  it('hashApiToken: newApiToken() が生成した実トークンをハッシュ化しても形式を満たす', async () => {
    const auth = makeAuth();
    const token = auth.newApiToken();
    const hash = await auth.hashApiToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('auth: session id / csrf token (32B CSPRNG base64url)', () => {
  it('newSessionId: base64url 43文字(パディングなし)', () => {
    const auth = makeAuth();
    expect(auth.newSessionId()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('newSessionId: 呼び出しごとに異なる値', () => {
    const auth = makeAuth();
    const ids = new Set(Array.from({ length: 20 }, () => auth.newSessionId()));
    expect(ids.size).toBe(20);
  });

  it('newCsrfToken: base64url 43文字(パディングなし)', () => {
    const auth = makeAuth();
    expect(auth.newCsrfToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('newCsrfToken: 呼び出しごとに異なる値', () => {
    const auth = makeAuth();
    const tokens = new Set(Array.from({ length: 20 }, () => auth.newCsrfToken()));
    expect(tokens.size).toBe(20);
  });
});
