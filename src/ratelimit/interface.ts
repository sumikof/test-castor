// src/ratelimit/interface.ts
// RateLimiter は Storage/Auth に続く第4のポータビリティ境界(auth-security.md「流量制御」)。
// アプリ本体はこのインターフェースのみ参照する。best-effort・eventually consistent の位置づけ
// (D1にカウンタ行を置く方式は単一ライタ自己圧迫のため不採用)。
export interface RateLimiter {
  /**
   * key の残枠を確認する。既定(opts省略 or consume!==false)では1消費した上で判定する。
   * consume:false は「消費せずに残枠だけ見る」チェック専用モード(例: ログイン成功試行を
   * カウントに含めないための事前チェック。D-14)。
   */
  limit(key: string, opts?: { consume?: boolean }): Promise<{ allowed: boolean; retryAfterSec?: number }>;
}
