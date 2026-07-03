// src/auth/token.ts
// WebCrypto のみに依存する乱数トークン生成・APIトークンハッシュ(auth-security.md「トークン生成」
// 「トークン保存・照合」、data-model.md「トークン生成仕様」)。Workers / Node 20+ 両対応
// (globalThis.crypto / btoa / atob はどちらの環境でもグローバルに存在する。import 不要)。

const API_TOKEN_PREFIX = 'tms_';
const RANDOM_BYTE_LEN = 32; // newSessionId/newCsrfToken/newApiToken 共通(auth-security.md「32バイト以上」)

function bytesToBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBase64Url(byteLen: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return bytesToBase64Url(bytes);
}

/** 32バイト CSPRNG → base64url(パディングなし)。Session 行の PK として使う。 */
export function newSessionId(): string {
  return randomBase64Url(RANDOM_BYTE_LEN);
}

/** 32バイト CSPRNG → base64url(パディングなし)。CSRF double-submit トークン。 */
export function newCsrfToken(): string {
  return randomBase64Url(RANDOM_BYTE_LEN);
}

/** "tms_" + base64url(32バイト CSPRNG)。衛星サービス向け Bearer トークン(平文はここでのみ生成)。 */
export function newApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBase64Url(RANDOM_BYTE_LEN)}`;
}

/** 決定的 SHA-256(saltなし)→ 64桁小文字hex。token_hash 列に保存する値。 */
export async function hashApiToken(plain: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
  return bytesToHex(new Uint8Array(digest));
}
