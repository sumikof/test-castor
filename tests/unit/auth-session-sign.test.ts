// tests/unit/auth-session-sign.test.ts
// 署名付きセッションID("<keyId>.<id>.<sig>")の往復・改竄検知・keyIdローテーションを検証する
// (auth-security.md「署名鍵」「検証フロー」、data-model.md「セッション管理の不変条件」)。
import { describe, it, expect } from 'vitest';
import { createWebcryptoAuth } from '../../src/auth/webcrypto-auth';

/** 署名済み値を3パートに分解する。想定外の形(パート数不足/空パート)ならテスト自体を落とす。 */
function splitSigned(value: string): { keyId: string; id: string; sig: string } {
  const parts = value.split('.');
  const [keyId, id, sig] = parts;
  if (parts.length !== 3 || !keyId || !id || !sig) {
    throw new Error(`test helper splitSigned: expected exactly 3 non-empty dot-separated parts, got: "${value}"`);
  }
  return { keyId, id, sig };
}

describe('auth: signed session id (HMAC-SHA256, keyId ローテーション)', () => {
  it('sign→verify 往復: idがそのまま返る', async () => {
    const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const id = auth.newSessionId();
    const signed = await auth.signSessionId(id);
    expect(await auth.verifySignedSessionId(signed)).toBe(id);
  });

  it('署名値の形式: "<activeKeyId>.<id>.<sig>"(sigは32B HMAC-SHA256のbase64url・パディングなし43文字)', async () => {
    const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const id = auth.newSessionId();
    const signed = await auth.signSessionId(id);
    const parsed = splitSigned(signed);
    expect(parsed.keyId).toBe('k1');
    expect(parsed.id).toBe(id);
    expect(parsed.sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('改竄: 署名部分の1文字を書き換えると null', async () => {
    const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const signed = await auth.signSessionId(auth.newSessionId());
    const { keyId, id, sig } = splitSigned(signed);
    const flippedChar = sig.charAt(0) === 'A' ? 'B' : 'A';
    const tampered = `${keyId}.${id}.${flippedChar}${sig.slice(1)}`;
    expect(tampered).not.toBe(signed);
    expect(await auth.verifySignedSessionId(tampered)).toBeNull();
  });

  it('改竄: keyId を未知の値に書き換えると null', async () => {
    const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const signed = await auth.signSessionId(auth.newSessionId());
    const { id, sig } = splitSigned(signed);
    expect(await auth.verifySignedSessionId(`k9.${id}.${sig}`)).toBeNull();
  });

  it('改竄: id 部分を書き換えると署名不一致で null', async () => {
    const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const signed = await auth.signSessionId(auth.newSessionId());
    const { keyId, id, sig } = splitSigned(signed);
    const otherId = auth.newSessionId();
    expect(otherId).not.toBe(id);
    expect(await auth.verifySignedSessionId(`${keyId}.${otherId}.${sig}`)).toBeNull();
  });

  it.each([
    ['ドットを含まないゴミ文字列', 'not-a-signed-session-id'],
    ['空文字列', ''],
    ['ドットが1個(パート数2)', 'k1.onlyid'],
    ['パート数4', 'k1.id.sig.extra'],
    ['空パートを含む(id欠落)', 'k1..sig'],
  ])('不正形式(%s)は例外を投げず null', async (_label, garbage) => {
    const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    await expect(auth.verifySignedSessionId(garbage)).resolves.toBeNull();
  });

  it('鍵ローテーション: k1で署名した値は {k1,k2}(active:k2)を保持するAuthでも検証できる', async () => {
    const oldAuth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const rotatedAuth = createWebcryptoAuth({
      signingKeys: { k1: 'secret1', k2: 'secret2' },
      activeKeyId: 'k2',
      pbkdf2Iterations: 1000,
    });
    const id = oldAuth.newSessionId();
    const signedByOldKey = await oldAuth.signSessionId(id);
    expect(signedByOldKey.startsWith('k1.')).toBe(true);
    expect(await rotatedAuth.verifySignedSessionId(signedByOldKey)).toBe(id);
  });

  it('鍵ローテーション後の新規署名は activeKeyId(k2) を使う', async () => {
    const rotatedAuth = createWebcryptoAuth({
      signingKeys: { k1: 'secret1', k2: 'secret2' },
      activeKeyId: 'k2',
      pbkdf2Iterations: 1000,
    });
    const id = rotatedAuth.newSessionId();
    const signed = await rotatedAuth.signSessionId(id);
    expect(signed.startsWith('k2.')).toBe(true);
    expect(await rotatedAuth.verifySignedSessionId(signed)).toBe(id);
  });

  it('未知keyId(k9)で署名された値はどのAuth構成でも検証できず null', async () => {
    const auth = createWebcryptoAuth({
      signingKeys: { k1: 'secret1', k2: 'secret2' },
      activeKeyId: 'k1',
      pbkdf2Iterations: 1000,
    });
    const dummySig = 'A'.repeat(43);
    expect(await auth.verifySignedSessionId(`k9.some-id.${dummySig}`)).toBeNull();
  });

  it('同じkeyIdでもsecretが異なれば検証できない(鍵の中身自体が意味を持つ)', async () => {
    const authA = createWebcryptoAuth({ signingKeys: { k1: 'secretA' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const authB = createWebcryptoAuth({ signingKeys: { k1: 'secretB' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const id = authA.newSessionId();
    const signed = await authA.signSessionId(id);
    expect(await authB.verifySignedSessionId(signed)).toBeNull();
  });

  it('createWebcryptoAuth: activeKeyId が signingKeys に無い場合は構築時に例外', () => {
    expect(() => createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k9', pbkdf2Iterations: 1000 }))
      .toThrow();
  });
});
