// src/auth/session-sign.ts
// 署名付きセッションID: "<keyId>.<id>.<sigB64url>"。sig = HMAC-SHA256(signingKeys[keyId], id)。
// id 自体は newSessionId() が生成する base64url 文字列で '.' を含まないため、単純な split('.') で
// 3パートに分解できる(auth-security.md「署名鍵」「検証フロー」、
// data-model.md「セッション管理の不変条件」)。比較は定数時間(XOR-accumulate)。
// keyId ローテーション: signingKeys に新旧複数の鍵を残したまま activeKeyId だけ切り替えれば、
// 旧鍵で署名済みの値も(その鍵が signingKeys に残っている限り)検証を通り続ける。

function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 不正な base64url(未知の文字・不正な長さ)は例外を投げず null を返す。 */
function base64UrlToBytes(b64url: string): Uint8Array | null {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(b64);
    return Uint8Array.from(binary.split(''), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 定数時間比較(XOR-accumulate)。長さが異なれば直ちに false。 */
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

/**
 * signingKeys[activeKeyId] で id に署名する。
 * activeKeyId が signingKeys の own property でない場合は例外(createWebcryptoAuth の構築時検証を前提とし、
 * ここでは二重防御)。own property チェックは prototype チェーン経由の値(Object.prototype 等)を
 * secret として使ってしまう脆弱性を防ぐため(verifySignedSessionId 側の脅威と同種。下記コメント参照)。
 */
export async function signSessionId(
  id: string,
  signingKeys: Record<string, string>,
  activeKeyId: string,
): Promise<string> {
  if (!Object.hasOwn(signingKeys, activeKeyId)) {
    throw new Error(`signSessionId: unknown activeKeyId "${activeKeyId}"`);
  }
  const secret = signingKeys[activeKeyId];
  if (typeof secret !== 'string') {
    throw new Error(`signSessionId: unknown activeKeyId "${activeKeyId}"`);
  }
  const sig = await hmacSha256(secret, id);
  return `${activeKeyId}.${id}.${bytesToBase64Url(sig)}`;
}

/**
 * 署名検証のみを担当する(DB存在・失効確認は Storage 層 / ミドルウェアの責務。
 * auth-security.md「検証フロー(三段AND)」の第一段)。
 * 未知の形式・未知 keyId・改竄された署名は例外を投げず null を返す。
 *
 * keyId は攻撃者が Cookie 値として自由に指定できる文字列であるため、単純な `signingKeys[keyId]` は
 * 危険: keyId に "__proto__" 等の Object.prototype own-property 名を渡されると、ブラケットアクセスが
 * prototype チェーンを辿って Object.prototype 自身(または Object コンストラクタ等)という truthy な
 * 非 undefined 値を返してしまい、「未知 keyId → null」のガードを回避できる。その値は
 * TextEncoder.encode() で暗黙に `String(Object.prototype)` = 固定文字列 "[object Object]" へ変換され、
 * 攻撃者が実鍵を知らずとも HMAC 鍵として悪用できてしまう(オフラインで
 * `"__proto__." + id + "." + base64url(HMAC-SHA256("[object Object]", id))` を計算すれば偽造署名が
 * 検証を通る)。Object.hasOwn で own property であることを確認してから読み、さらに型も
 * string であることを確認する(belt-and-suspenders)ことで、prototype チェーン経由の値が
 * secret として使われることを防ぐ。
 */
export async function verifySignedSessionId(
  value: string,
  signingKeys: Record<string, string>,
): Promise<string | null> {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [keyId, id, sig] = parts;
  if (!keyId || !id || !sig) return null;
  if (!Object.hasOwn(signingKeys, keyId)) return null;
  const secret = signingKeys[keyId];
  if (typeof secret !== 'string') return null;
  const receivedSigBytes = base64UrlToBytes(sig);
  if (!receivedSigBytes) return null;
  const expectedSigBytes = await hmacSha256(secret, id);
  if (!constantTimeEqualBytes(expectedSigBytes, receivedSigBytes)) return null;
  return id;
}
