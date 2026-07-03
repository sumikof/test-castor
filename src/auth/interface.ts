// src/auth/interface.ts
// 認証プリミティブの抽象(auth-security.md「Auth インターフェース抽象化」)。
// 実装は WebCrypto のみに依存し、Storage/HTTP を一切知らない(ポータビリティ境界)。
export interface Auth {
  /** PBKDF2-SHA256 で新規ハッシュを生成する。戻り値は PHC 文字列。 */
  hashPassword(plain: string): Promise<string>;

  /**
   * plain と phc を照合する。未知フォーマット・破損データでも例外を投げない。
   * needsRehash は ok=true のときのみ意味を持ち、phc の iterations が現行設定未満なら true
   * (透過再ハッシュの実行そのものは呼び出し側 = ログイン処理の責務)。
   *
   * phc は null を受け付ける(該当ユーザーが存在しない/パスワード未設定のケースを呼び出し側が
   * そのまま渡せるようにするため)。null・未知フォーマット・破損データのいずれでも必ず現行イテレーション数で
   * 1回分の PBKDF2 導出を行ってから { ok: false, needsRehash: false } を返す実装であること
   * (タイミングサイドチャネルによるユーザー列挙対策。auth-security.md「タイミング攻撃対策」)。
   */
  verifyPassword(plain: string, phc: string | null): Promise<{ ok: boolean; needsRehash: boolean }>;

  /** 32バイト CSPRNG(base64url・パディングなし)。Session 行の PK として使う。 */
  newSessionId(): string;

  /** "<keyId>.<id>.<sig>" 形式で id に署名する(sig = HMAC-SHA256(signingKeys[activeKeyId], id))。 */
  signSessionId(id: string): Promise<string>;

  /**
   * 署名検証のみを行う(DB存在・失効確認は Storage 層 / ミドルウェアの責務、
   * auth-security.md「検証フロー(三段AND)」の第一段)。
   * 未知形式・未知 keyId・改竄された署名は例外を投げず null を返す。
   */
  verifySignedSessionId(value: string): Promise<string | null>;

  /** "tms_" + base64url(32バイト CSPRNG)。衛星サービス向け Bearer トークン。 */
  newApiToken(): string;

  /** 決定的 SHA-256(hex64桁、saltなし)。token_hash 列に保存する値(auth-security.md「トークン保存・照合」)。 */
  hashApiToken(plain: string): Promise<string>;

  /** 32バイト CSPRNG(base64url・パディングなし)。CSRF double-submit トークン。 */
  newCsrfToken(): string;
}
