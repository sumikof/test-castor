// src/http/config.ts
// 実行時設定の正本。env(Workers bindings の `vars`/`secrets` か、Node の `process.env` — どちらも
// Record<string,string|undefined> として渡ってくる)から読み込む(GC-6: ここは D1/workers-types を
// import しない。ポータビリティ境界)。
//
// 環境変数名: SESSION_TTL_MS と SESSION_SIGNING_KEYS はスペック/ブリーフが明示する名前。
// 残り(SESSION_ACTIVE_KEY_ID・PBKDF2_ITERATIONS・LOGIN_RATE_LIMIT_WINDOW_MS/MAX・
// SYNC_RATE_LIMIT_WINDOW_MS/MAX・OBSERVATION_RETENTION_MS・IDENTITY_TTL_MS)はブリーフに明記が無いため
// 本実装で採番した名前。未設定時は D-08/D-14 および 90日保持の既定値にフォールバックするため、
// デプロイ時に必須ではない(ただし SESSION_SIGNING_KEYS に複数鍵を設定する場合に限り
// SESSION_ACTIVE_KEY_ID が必須になる。下記 loadSigningKeys 参照)。
export interface AppConfig {
  sessionTtlMs: number;
  signingKeys: Record<string, string>;
  activeKeyId: string;
  pbkdf2Iterations: number;
  loginRateLimit: { windowMs: number; max: number };
  syncRateLimit: { windowMs: number; max: number };
  observationRetentionMs: number;
  identityTtlMs: number;
  /**
   * task-16-brief.md「syncCommitWindow」の windowLimit 既定値(工程3〜7 の rowid ウィンドウ幅)。
   * ブリーフの Storage インターフェース原文は呼び出し時の引数として windowLimit を渡す形だが、
   * 実際に値を決めて注入する場所(HTTP ルート)が必要なため config に追加した(タスク報告に明記)。
   * MAX_CHUNK_SIZE(sync-protocol.md「1 chunk ≤500 観測」)と同水準にし、典型的な同期が1回の
   * commit 呼び出しで収束するようにする。テストは mid-commit 再開を検証するためこれより小さい値を注入する。
   */
  commitWindowLimit: number;
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
  commitWindowLimit: 500, // MAX_CHUNK_SIZE と同水準(schemas/sync.ts)
};

/** env 文字列を正の整数として解釈する。未設定・非数値・0以下はすべて fallback を返す(起動を壊さない)。 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 純粋な数字列(例 "1","42")かどうか。整数様キーは JS のオブジェクト列挙順の罠があるため鍵IDとして禁止する。 */
const NUMERIC_KEY_ID_RE = /^\d+$/;

/**
 * SESSION_SIGNING_KEYS(JSON `{"k1":"secret"}` 形式)と SESSION_ACTIVE_KEY_ID を読み込む。
 * SESSION_SIGNING_KEYS 未設定時は開発用フォールバック `{"dev":"dev-insecure-key"}` を使い
 * console.warn する(ブリーフ明記の挙動)。この分岐では鍵が1個しかないため SESSION_ACTIVE_KEY_ID は
 * 参照せず 'dev' を無条件に active とする。
 *
 * 鍵IDの制約: 純粋な数字列(/^\d+$/、例 "1","2")は禁止し、ロード時に例外を投げる。JS のオブジェクトは
 * 整数様のキーを「宣言順」ではなく「数値昇順」で列挙する仕様があり、これに暗黙に依存すると鍵ローテー
 * ション時の意図(新しい鍵を追記する)が静かに壊れる(未検知のまま運用ミスにつながる footgun)。この
 * 制約に実装上のメリットはなく、価値のない罠を根元から断つためだけに存在する。
 *
 * activeKeyId の導出規約(明示優先。複数鍵時の曖昧な自動選択はしない):
 *   1. env `SESSION_ACTIVE_KEY_ID` が設定されていれば、それを active とする。ただし signingKeys の
 *      own property でなければ構築時に例外を投げる(タイポ・鍵未登録を早期検知)。
 *   2. `SESSION_ACTIVE_KEY_ID` が未設定で signingKeys が単一鍵なら、その鍵を active とする(選択肢が
 *      1つしかなく曖昧さがない。dev フォールバックもこの分岐を通る)。
 *   3. `SESSION_ACTIVE_KEY_ID` が未設定で signingKeys が複数鍵なら、どれを active にすべきか安全に
 *      決定できないため例外を投げる("SESSION_ACTIVE_KEY_ID must be set when multiple signing keys are
 *      configured")。
 *
 * 旧規約(`Object.keys(signingKeys)` の「最後の要素」を暗黙に active とみなす)はレビューで footgun と
 * 指摘され廃止した: 整数様の鍵ID("1","2",…)は宣言順ではなく数値昇順で列挙されるため、「運用者が最後に
 * 追記した鍵」と「JS が列挙上『最後』に返す鍵」が食い違いうる、かつ未テストだった。既存セッションは
 * Cookie に埋め込まれた keyId で検証するため無影響だが、新規署名にどの鍵を使うかが運用者の意図と
 * 乖離しうる危険な暗黙挙動だったため、明示指定必須の方式に置き換えた。
 *
 * 鍵ローテーション運用(新鍵発行・旧鍵検証の猶予期間)は、SESSION_SIGNING_KEYS に旧鍵を残したまま
 * SESSION_ACTIVE_KEY_ID を新鍵IDへ切り替える形で行う(例: {"k1":s1} 運用中に {"k1":s1,"k2":s2} を
 * デプロイしつつ SESSION_ACTIVE_KEY_ID=k2 を設定すると、新規署名は k2 を使いつつ k1 で署名済みの
 * 既存 Cookie も signingKeys に k1 が残っている限り検証を通り続ける)。
 */
function loadSigningKeys(
  raw: string | undefined,
  explicitActiveKeyId: string | undefined,
): { signingKeys: Record<string, string>; activeKeyId: string } {
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
    if (NUMERIC_KEY_ID_RE.test(keyId)) {
      throw new Error(
        `loadConfig: SESSION_SIGNING_KEYS key id "${keyId}" must not be purely numeric — numeric-like key ids ` +
          'are enumerated by JS in ascending numeric order (not declaration order), which silently breaks ' +
          'key-rotation intent',
      );
    }
  }
  const keyIds = Object.keys(signingKeys);
  if (keyIds.length === 0) {
    throw new Error('loadConfig: SESSION_SIGNING_KEYS must contain at least one key');
  }

  let activeKeyId: string;
  if (explicitActiveKeyId !== undefined) {
    if (!Object.hasOwn(signingKeys, explicitActiveKeyId)) {
      throw new Error(
        `loadConfig: SESSION_ACTIVE_KEY_ID "${explicitActiveKeyId}" is not a key present in SESSION_SIGNING_KEYS`,
      );
    }
    activeKeyId = explicitActiveKeyId;
  } else if (keyIds.length === 1) {
    const onlyKeyId = keyIds[0];
    if (onlyKeyId === undefined) {
      throw new Error('loadConfig: SESSION_SIGNING_KEYS must contain at least one key');
    }
    activeKeyId = onlyKeyId;
  } else {
    throw new Error('loadConfig: SESSION_ACTIVE_KEY_ID must be set when multiple signing keys are configured');
  }

  return { signingKeys, activeKeyId };
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const { signingKeys, activeKeyId } = loadSigningKeys(env.SESSION_SIGNING_KEYS, env.SESSION_ACTIVE_KEY_ID);
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
    commitWindowLimit: parsePositiveInt(env.SYNC_COMMIT_WINDOW_LIMIT, DEFAULTS.commitWindowLimit),
  };
}
