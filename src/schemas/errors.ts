export const ERROR_CODES = [
  'VALIDATION_FAILED', 'OCC_CONFLICT', 'DUPLICATE_SYNC_SESSION', 'CROSS_TENANT',
  'NOT_FOUND', 'SESSION_EXPIRED', 'RATE_LIMITED', 'UNAUTHORIZED',
  'SETUP_ALREADY_COMPLETE', 'PRECONDITION_REQUIRED', 'NO_DRIFT', 'FORBIDDEN',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
// FORBIDDEN は role 超過(auth-security.md 能力マトリクスの 403)用。
// HTTP ステータス対応は http/middleware/error.ts が持つ。
