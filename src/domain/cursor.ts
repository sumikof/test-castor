// src/domain/cursor.ts
// カーソルベースページングの opaque トークン。api-reference.md「カーソルベースページング」
// (タイブレーカー: (created_at, id) の安定ソート)を正本とする。
// Workers / Node 20+ 両対応のため btoa/atob のみに依存する(src/auth/token.ts と同じ方針。import 不要)。

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

export type Cursor = { createdAt: number; id: string };

/**
 * カーソルを opaque な base64url 文字列にエンコードする。
 * ペイロードの JSON キーは API 全体の snake_case 規約に合わせて `created_at` を用いる
 * (api-reference.md のコレクション応答例 `next_cursor: "eyJjcmVhdGVkX2F0IjoxNzE5..."` は
 * `{"created_at":1719...` に base64url decode できることを確認済み)。
 * TS 側の関数シグネチャは camelCase の createdAt のまま(ブリーフの宣言どおり)。
 */
export function encodeCursor(c: Cursor): string {
  const json = JSON.stringify({ created_at: c.createdAt, id: c.id });
  return bytesToBase64Url(new TextEncoder().encode(json));
}

/**
 * カーソルを decode する。以下のいずれかに該当する場合は例外を投げず null を返す
 * (呼び出し側は「先頭から」にフォールバックできる):
 * - base64url として不正(未知の文字・不正な長さ)
 * - decode したバイト列が有効な UTF-8 でない
 * - JSON として parse できない
 * - JSON の形が期待(`{ created_at: number, id: string }`)と異なる
 */
export function decodeCursor(s: string): Cursor | null {
  const bytes = base64UrlToBytes(s);
  if (!bytes) return null;

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const createdAt = obj.created_at;
  const id = obj.id;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (typeof id !== 'string' || id.length === 0) return null;

  return { createdAt, id };
}
