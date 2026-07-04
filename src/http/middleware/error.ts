// src/http/middleware/error.ts
// 統一エラースキーマ(GC-4, api-reference.md「統一エラースキーマ」)を app.onError(errorMiddleware)
// として登録する(src/http/app.ts)。実際の例外→スキーマ変換ロジックは src/http/errors.ts の
// toErrorResponsePayload に一本化されている(src/entry/workers.ts の config bootstrap 失敗ガードも
// 同じ関数を再利用する。レビュー finding #1: 変換ロジックの二重実装を避ける)。
import type { Context } from 'hono';
import { AppError, toErrorResponsePayload } from '../errors';

export function errorMiddleware(err: unknown, c: Context) {
  const { status, body } = toErrorResponsePayload(err);
  return c.json(body, status as any);
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
