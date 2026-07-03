// tests/unit/auth-password.test.ts
// パスワードハッシュ(PHC pbkdf2-sha256)の往復・誤りパスワード否認・needsRehash・
// 破損/未知形式の非例外契約を検証する(auth-security.md「パスワード保存」、
// data-model.md「パスワードハッシュ仕様」)。
import { describe, it, expect } from 'vitest';
import { createWebcryptoAuth } from '../../src/auth/webcrypto-auth';

const TEST_ITERATIONS = 1000;

function makeAuth(pbkdf2Iterations = TEST_ITERATIONS) {
  return createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations });
}

describe('auth: password (PHC pbkdf2-sha256)', () => {
  it('hash→verify 往復: 正しいパスワードは ok:true、誤りは ok:false', async () => {
    const auth = makeAuth();
    const phc = await auth.hashPassword('correct horse');
    expect((await auth.verifyPassword('correct horse', phc)).ok).toBe(true);
    expect((await auth.verifyPassword('wrong', phc)).ok).toBe(false);
  });

  it('PHC 文字列の形式: $pbkdf2-sha256$i=<iter>$<salt22文字>$<hash43文字>(16B salt / 32B hash, base64パディングなし)', async () => {
    const auth = makeAuth();
    const phc = await auth.hashPassword('correct horse');
    expect(phc.startsWith(`$pbkdf2-sha256$i=${TEST_ITERATIONS}$`)).toBe(true);
    expect(phc).toMatch(/^\$pbkdf2-sha256\$i=1000\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  it('ソルトは呼び出しごとに新規CSPRNG(同一パスワードでもPHCは毎回異なるが、どちらでも検証は通る)', async () => {
    const auth = makeAuth();
    const a = await auth.hashPassword('same password');
    const b = await auth.hashPassword('same password');
    expect(a).not.toBe(b);
    expect((await auth.verifyPassword('same password', a)).ok).toBe(true);
    expect((await auth.verifyPassword('same password', b)).ok).toBe(true);
  });

  it('needsRehash: phcのiterationsが現行設定未満なら true(iter=500で発行→iter=1000側で検証)', async () => {
    const oldAuth = makeAuth(500);
    const newAuth = makeAuth(1000);
    const phc = await oldAuth.hashPassword('pw');
    const result = await newAuth.verifyPassword('pw', phc);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it('needsRehash: 現行イテレーションと同じなら false', async () => {
    const auth = makeAuth(1000);
    const phc = await auth.hashPassword('pw');
    const result = await auth.verifyPassword('pw', phc);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it('needsRehash: ok=false のときは常に false(誤りパスワードでは旧iterでも立てない)', async () => {
    const oldAuth = makeAuth(500);
    const newAuth = makeAuth(1000);
    const phc = await oldAuth.hashPassword('pw');
    const result = await newAuth.verifyPassword('wrong-password', phc);
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it.each([
    ['空文字列', ''],
    ['プレフィックス無しの平文', 'not-a-phc-string'],
    ['未知アルゴリズム(argon2id)', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'],
    ['パート数不足(hash欠落)', '$pbkdf2-sha256$i=1000$onlysalt'],
    ['iter が数値でない', '$pbkdf2-sha256$i=abc$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
    ['iter が0(非正数)', '$pbkdf2-sha256$i=0$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
    ['salt フィールドが空', '$pbkdf2-sha256$i=1000$$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
    ['salt に不正な文字を含む base64', '$pbkdf2-sha256$i=1000$!!!not-base64!!!$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
    ['hash に不正な文字を含む base64', '$pbkdf2-sha256$i=1000$c2FsdHNhbHRzYWx0$!!!not-base64!!!'],
    ['salt の base64 長が不正(mod4=1でデコード時に例外要因)', '$pbkdf2-sha256$i=1000$AAAAA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
    ['hash のバイト長が32でない(短い)', '$pbkdf2-sha256$i=1000$c2FsdHNhbHRzYWx0$c2hvcnQ'],
  ])('verifyPassword: 破損/未知形式(%s)は例外を投げず { ok:false, needsRehash:false }', async (_label, badPhc) => {
    const auth = makeAuth();
    await expect(auth.verifyPassword('anything', badPhc)).resolves.toEqual({ ok: false, needsRehash: false });
  });
});
