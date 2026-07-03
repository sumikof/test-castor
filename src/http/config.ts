// src/http/config.ts
// 実行時設定の正本。env(Workers bindings の `vars`/`secrets` か、Node の `process.env` — どちらも
// Record<string,string|undefined> として渡ってくる)から読み込む(GC-6: ここは D1/workers-types を
// import しない。ポータビリティ境界)。
//
// 環境変数名: SESSION_TTL_MS と SESSION_SIGNING_KEYS はスペック/ブリーフが明示する名前。
// 残り(PBKDF2_ITERATIONS・LOGIN_RATE_LIMIT_WINDOW_MS/MAX・SYNC_RATE_LIMIT_WINDOW_MS/MAX・
// OBSERVATION_RETENTION_MS・IDENTITY_TTL_MS)はブリーフに明記が無いため本実装で採番した名前。
// 未設定時は D-08/D-14 および 90日保持の既定値にフォールバックするため、デプロイ時に必須ではない。
export interface AppConfig {
  sessionTtlMs: number;
  signingKeys: Record<string, string>;
  activeKeyId: string;
  pbkdf2Iterations: number;
  loginRateLimit: { windowMs: number; max: number };
  syncRateLimit: { windowMs: number; max: number };
  observationRetentionMs: number;
  identityTtlMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  sessionTtlMs: 7 * DAY_MS, // D-08: 7日固定(スライディング延長なし)
  pbkdf2Iterations: 600_000, // OWASP 2023 基準(auth-security.md「パスワード保存」)
  loginRateLimitWindowMs: 900_000, // D-14: 15分
  loginRateLimitMax: 5, // D-14: 5失敗
  syncRateLimitWindowMs: 60_000, // D-14: 1分
  syncRateLimitMax: 120, // D-14: 120リクエスト
  observationRetentionMs: 90 * DAY_MS,
  identityTtlMs: 90 * DAY_MS, // rollup TTL
};

/** env 文字列を正の整数として解釈する。未設定・非数値・0以下はすべて fallback を返す(起動を壊さない)。 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * SESSION_SIGNING_KEYS(JSON `{"k1":"secret"}` 形式)を読み込む。未設定時は開発用フォールバック
 * `{"dev":"dev-insecure-key"}` を使い console.warn する(ブリーフ明記の挙動)。
 *
 * activeKeyId の導出規約: signingKeys に列挙された鍵のうち「最後の鍵」を active とする。
 * auth-security.md の鍵ローテーション運用(新鍵発行・旧鍵検証の猶予期間)は、運用者が新鍵を
 * オブジェクトの末尾に追記してデプロイする形を想定している(例: 初期 {"k1":s1} → ローテーション時
 * {"k1":s1,"k2":s2} をデプロイすると k2 が新規署名に使われつつ、k1 で署名済みの既存 Cookie も
 * signingKeys に k1 が残っている限り検証を通り続ける)。この規約はブリーフに明記されていない
 * 実装判断のため、タスク報告で明示する。
 */
function loadSigningKeys(raw: string | undefined): { signingKeys: Record<string, string>; activeKeyId: string } {
  if (raw === undefined) {
    console.warn(
      'loadConfig: SESSION_SIGNING_KEYS is not set; falling back to an insecure development key ' +
        '({"dev":"dev-insecure-key"}). Do not use this fallback in production.',
    );
    return { signingKeys: { dev: 'dev-insecure-key' }, activeKeyId: 'dev' };
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('loadConfig: SESSION_SIGNING_KEYS must be a JSON object of the form {"keyId":"secret"}');
  }
  const signingKeys = parsed as Record<string, string>;
  for (const [keyId, secret] of Object.entries(signingKeys)) {
    if (typeof secret !== 'string') {
      throw new Error(`loadConfig: SESSION_SIGNING_KEYS["${keyId}"] must be a string secret`);
    }
  }
  const keyIds = Object.keys(signingKeys);
  const activeKeyId = keyIds[keyIds.length - 1];
  if (!activeKeyId) {
    throw new Error('loadConfig: SESSION_SIGNING_KEYS must contain at least one key');
  }
  return { signingKeys, activeKeyId };
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const { signingKeys, activeKeyId } = loadSigningKeys(env.SESSION_SIGNING_KEYS);
  return {
    sessionTtlMs: parsePositiveInt(env.SESSION_TTL_MS, DEFAULTS.sessionTtlMs),
    signingKeys,
    activeKeyId,
    pbkdf2Iterations: parsePositiveInt(env.PBKDF2_ITERATIONS, DEFAULTS.pbkdf2Iterations),
    loginRateLimit: {
      windowMs: parsePositiveInt(env.LOGIN_RATE_LIMIT_WINDOW_MS, DEFAULTS.loginRateLimitWindowMs),
      max: parsePositiveInt(env.LOGIN_RATE_LIMIT_MAX, DEFAULTS.loginRateLimitMax),
    },
    syncRateLimit: {
      windowMs: parsePositiveInt(env.SYNC_RATE_LIMIT_WINDOW_MS, DEFAULTS.syncRateLimitWindowMs),
      max: parsePositiveInt(env.SYNC_RATE_LIMIT_MAX, DEFAULTS.syncRateLimitMax),
    },
    observationRetentionMs: parsePositiveInt(env.OBSERVATION_RETENTION_MS, DEFAULTS.observationRetentionMs),
    identityTtlMs: parsePositiveInt(env.IDENTITY_TTL_MS, DEFAULTS.identityTtlMs),
  };
}
