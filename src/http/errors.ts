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
