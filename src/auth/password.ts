// src/auth/password.ts
// PHC 文字列形式(auth-security.md「パスワード保存」、data-model.md「パスワードハッシュ仕様」):
//   $pbkdf2-sha256$i=<iterations>$<salt-b64>$<hash-b64>
// salt: 16バイト CSPRNG(per-user)。hash: PBKDF2-SHA256 導出鍵32バイト(SHA-256出力長)。
// salt/hash は標準base64アルファベット(+/)・パディングなし(PHC仕様の慣習)。base64url ではない。
// 比較は定数時間(XOR-accumulate)。verifyPassword は未知形式・破損データで例外を投げない。

const ALGORITHM_ID = 'pbkdf2-sha256';
const PHC_PREFIX = `$${ALGORITHM_ID}$`;
const SALT_BYTE_LEN = 16;
const HASH_BYTE_LEN = 32; // SHA-256 出力長

function bytesToBase64(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary);
}

function bytesToBase64NoPad(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=+$/, '');
}

/** atob は forgiving-base64 decode によりパディング無しでも解釈できる。不正な文字列は例外を投げる。 */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  return Uint8Array.from(binary.split(''), (ch) => ch.charCodeAt(0));
}

/** 定数時間比較(XOR-accumulate)。長さが異なれば直ちに false(長さ自体は秘密情報ではない)。 */
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function pbkdf2Derive(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    // TS 5.7+ の Uint8Array<TArrayBuffer> ジェネリック化と dom lib の BufferSource(ArrayBufferView<ArrayBuffer>)
    // 定義の食い違いによる型エラーを回避するキャスト(実行時は常に通常の ArrayBuffer 由来で無害)。
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    HASH_BYTE_LEN * 8,
  );
  return new Uint8Array(bits);
}

interface ParsedPhc {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

/** 未知形式・破損した PHC 文字列は例外を投げず null を返す(verifyPassword の「never throw」契約を支える)。 */
function parsePhc(phc: string): ParsedPhc | null {
  if (!phc.startsWith(PHC_PREFIX)) return null;
  const parts = phc.split('$');
  // "$pbkdf2-sha256$i=<iter>$<salt>$<hash>".split('$') === ['', 'pbkdf2-sha256', 'i=<iter>', '<salt>', '<hash>']
  if (parts.length !== 5) return null;
  const [, algorithm, iterField, saltB64, hashB64] = parts;
  if (algorithm !== ALGORITHM_ID) return null;
  if (!iterField || !saltB64 || !hashB64) return null;
  const iterMatch = /^i=([0-9]+)$/.exec(iterField);
  if (!iterMatch) return null;
  const iterations = Number(iterMatch[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return null;
  try {
    const salt = base64ToBytes(saltB64);
    const hash = base64ToBytes(hashB64);
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

/** PBKDF2-SHA256 で新規ハッシュを生成し PHC 文字列を返す。ソルトは呼び出しごとに新規 CSPRNG。 */
export async function hashPassword(plain: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTE_LEN));
  const hash = await pbkdf2Derive(plain, salt, iterations);
  return `${PHC_PREFIX}i=${iterations}$${bytesToBase64NoPad(salt)}$${bytesToBase64NoPad(hash)}`;
}

/**
 * plain と phc を照合する。未知フォーマット・破損データは例外を投げず { ok: false, needsRehash: false }。
 * needsRehash は ok=true の場合のみ意味を持ち、phc の iterations が現行設定(configuredIterations)未満なら true
 * (透過再ハッシュの実行そのものは呼び出し側 = Task 8 のログイン処理が行う)。
 */
export async function verifyPassword(
  plain: string,
  phc: string,
  configuredIterations: number,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = parsePhc(phc);
  if (!parsed) return { ok: false, needsRehash: false };
  const computed = await pbkdf2Derive(plain, parsed.salt, parsed.iterations);
  const ok = constantTimeEqualBytes(computed, parsed.hash);
  return { ok, needsRehash: ok && parsed.iterations < configuredIterations };
}
