// src/auth/webcrypto-auth.ts
// Auth インターフェースの WebCrypto 実装(architecture.md「ポータビリティ境界」の CF 実装 = WebCrypto PBKDF2)。
// Workers / Node 20+ 共通。依存は WebCrypto のみ(Storage/HTTP を知らない)。
import type { Auth } from './interface';
import { hashPassword, verifyPassword } from './password';
import { signSessionId, verifySignedSessionId } from './session-sign';
import { newApiToken, newCsrfToken, newSessionId, hashApiToken } from './token';

/** OWASP 2023 基準(auth-security.md「パスワード保存」、data-model.md「パスワードハッシュ仕様」)。 */
const DEFAULT_PBKDF2_ITERATIONS = 600_000;

export interface WebcryptoAuthConfig {
  /** keyId -> secret。Task 7 が env `SESSION_SIGNING_KEYS`(JSON)から読み込んで渡す想定。 */
  signingKeys: Record<string, string>;
  /** 新規署名に使う鍵。ローテーション時は新旧の鍵を signingKeys に残したまま切り替える。 */
  activeKeyId: string;
  /** 既定 600,000(OWASP 2023)。テストでは高速化のため小さい値を注入する。 */
  pbkdf2Iterations?: number;
}

/** activeKeyId が signingKeys に存在しない構成は、実行時エラーの温床になる前に構築時点で弾く。 */
export function createWebcryptoAuth(cfg: WebcryptoAuthConfig): Auth {
  const { signingKeys, activeKeyId } = cfg;
  const pbkdf2Iterations = cfg.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (signingKeys[activeKeyId] === undefined) {
    throw new Error(`createWebcryptoAuth: activeKeyId "${activeKeyId}" is not present in signingKeys`);
  }

  return {
    hashPassword: (plain) => hashPassword(plain, pbkdf2Iterations),
    verifyPassword: (plain, phc) => verifyPassword(plain, phc, pbkdf2Iterations),
    newSessionId,
    signSessionId: (id) => signSessionId(id, signingKeys, activeKeyId),
    verifySignedSessionId: (value) => verifySignedSessionId(value, signingKeys),
    newApiToken,
    hashApiToken,
    newCsrfToken,
  };
}
