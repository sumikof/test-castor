// src/http/errors.ts
// アプリ全体の例外型。http/middleware/error.ts の onError がここから統一エラースキーマ
// (GC-4, api-reference.md「統一エラースキーマ」)へ変換する。ハンドラ/ミドルウェアは
// このクラスを throw するだけでよく、Response 組み立てには関与しない。
import type { ErrorCode } from '../schemas/errors';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, status: number, message: string, details?: unknown, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

/** GC-4 統一エラースキーマの応答本体。 */
export interface ErrorResponseBody {
  error: { code: ErrorCode; message: string; details?: unknown; retryable: boolean };
}

/**
 * 任意の例外を GC-4 統一エラースキーマの `{ status, body }` へ変換する、フレームワーク非依存の
 * 唯一の変換ロジック。http/middleware/error.ts の errorMiddleware(Hono onError)と
 * src/entry/workers.ts(Hono の app.fetch() より前 — config bootstrap 失敗時)の両方がここを呼ぶ
 * (レビュー finding #1: 変換ロジックを2箇所で手書きして食い違わせない。手書きし直すと片方だけ
 * スキーマがずれる/鍵材料等の詳細を漏らす、といった不整合の温床になるため一本化する)。
 * AppError 以外は固定文言のみ返す(実メッセージ・スタックはレスポンスに含めず、サーバ側ログにのみ
 * 構造化 JSON で出す — D-11 の精神)。
 */
export function toErrorResponsePayload(err: unknown): { status: number; body: ErrorResponseBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, details: err.details ?? undefined, retryable: err.retryable } },
    };
  }
  console.error(JSON.stringify({ level: 'error', msg: String(err), stack: (err as Error)?.stack }));
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'internal error', retryable: true } } };
}
