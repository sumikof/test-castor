// src/http/middleware/error.ts
// 統一エラースキーマ(GC-4, api-reference.md「統一エラースキーマ」)を構築する唯一の場所。
// app.onError(errorMiddleware) として登録する(src/http/app.ts)。
import type { Context } from 'hono';
import { AppError } from '../errors';

export function errorMiddleware(err: unknown, c: Context) {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details ?? undefined, retryable: err.retryable } },
      err.status as any,
    );
  }
  // 予期しない例外: レスポンスは固定文言のみ(実メッセージ・スタックは漏らさない)。
  // 詳細はサーバ側ログにのみ構造化 JSON で出す(D-11 の精神。認証失敗監査そのものではないが同じ方針)。
  console.error(JSON.stringify({ level: 'error', msg: String(err), stack: (err as Error)?.stack }));
  return c.json({ error: { code: 'INTERNAL', message: 'internal error', retryable: true } }, 500);
}

/** zValidator(各ルートの入力検証)の失敗を AppError('VALIDATION_FAILED', 422, ...) へ変換する共通 hook。 */
type ZodHookResult =
  | { success: true }
  | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };

export const zodHook = (result: ZodHookResult, _c: Context) => {
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), msg: i.message }));
    throw new AppError('VALIDATION_FAILED', 422, 'validation failed', details);
  }
};
