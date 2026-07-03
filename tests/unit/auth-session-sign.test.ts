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

describe('auth: 認証バイパス回帰(keyId が Object.prototype own-property 名の場合)', () => {
  // 修正前の脆弱性: `signingKeys[keyId]` は keyId が "__proto__" 等の Object.prototype own-property 名の
  // 場合、bracket アクセスが prototype チェーンを辿って truthy な非 undefined 値(Object.prototype 自身や
  // Object コンストラクタ等)を返してしまい、「未知 keyId → null」のガード(`secret === undefined`)を
  // すり抜けていた。その値は TextEncoder.encode() に渡る際に暗黙の ToString 変換を受け(例えば
  // Object.prototype なら固定文字列 "[object Object]" に)、攻撃者が実鍵を一切知らずとも HMAC 鍵として
  // 悪用し、偽造トークンを検証に通すことができた。
  //
  // ここでは (a) 5つの prototype own-property 名それぞれについて、任意の(実際には無関係な)署名でも
  // 常に null になること、(b) __proto__ については実際に脆弱性が使う鍵 "[object Object]" で正しく
  // HMAC-SHA256 署名した「本物の偽造トークン」でも null になること(＝当該脆弱性の攻撃経路が
  // 塞がれていることの直接証明)を確認する。

  /** ソースの hmacSha256 + bytesToBase64Url と同じ手順で HMAC-SHA256 を計算し base64url 化する。
   *  攻撃者が実secretを知らずとも計算できる "[object Object]" 鍵での偽造署名を作るために使う。 */
  async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    const bytes = new Uint8Array(sigBuf);
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const PROTOTYPE_KEY_IDS = ['__proto__', 'constructor', 'valueOf', 'hasOwnProperty', 'toString'];
  // 43文字ちょうどの妥当な base64url 形式のダミー署名。値そのものが正しい署名かどうかは無関係で、
  // 「keyId が prototype own-property 名なら、どんな sig であろうと絶対に検証を通らない」
  // (Object.hasOwn ガードがシグネチャ検証より先に落とすため)ことを示すのが目的。
  const PLAUSIBLE_DUMMY_SIG = 'A'.repeat(43);

  it.each(PROTOTYPE_KEY_IDS)(
    'keyId="%s"(Object.prototype own-property名)は signingKeys={k1:...} に存在しないため常に null',
    async (protoKeyId) => {
      const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
      const someId = auth.newSessionId();
      const forged = `${protoKeyId}.${someId}.${PLAUSIBLE_DUMMY_SIG}`;
      expect(await auth.verifySignedSessionId(forged)).toBeNull();
    },
  );

  it('実攻撃再現: keyId="__proto__" を "[object Object]" 鍵で正しくHMAC署名した偽造トークンは検証を通らない', async () => {
    // 修正前の脆弱性下では signingKeys['__proto__'] が Object.prototype を返し、
    // TextEncoder.encode() に渡る際に String(Object.prototype) === "[object Object]" に暗黙変換されて
    // HMAC鍵として使われてしまっていた(secret は本来 signingKeys.k1 = 'secret1' であり、攻撃者はこれを
    // 知らない)。ここでは実鍵を一切使わず、公開されている固定文字列 "[object Object]" だけを鍵として
    // 正しい HMAC-SHA256 署名を計算し、実際の攻撃と全く同じ手順で偽造トークンを作って検証にかける。
    const auth = createWebcryptoAuth({ signingKeys: { k1: 'secret1' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
    const someId = auth.newSessionId();
    const forgedSig = await hmacSha256Base64Url('[object Object]', someId);
    const forged = `__proto__.${someId}.${forgedSig}`;
    expect(await auth.verifySignedSessionId(forged)).toBeNull();
  });

  it('signingKeys が空でも activeKeyId="__proto__" は own property ではないため createWebcryptoAuth は構築時に例外', () => {
    // Object.hasOwn 導入前は `{}['__proto__']`(= Object.prototype、truthy)が
    // `!== undefined` を満たしてしまい、この危険な構成(署名に使う実体のない鍵で活性化)が
    // 構築時検証をすり抜けていた。
    expect(() => createWebcryptoAuth({ signingKeys: {}, activeKeyId: '__proto__', pbkdf2Iterations: 1000 }))
      .toThrow();
  });
});
