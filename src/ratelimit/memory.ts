// src/ratelimit/memory.ts
// RateLimiter のインメモリ実装(固定ウィンドウ)。CF/オンプレ問わず全環境で使う(D-14 の 15 分窓は
// Workers Rate Limiting binding の固定窓(10s/60s)では表現できないため、ログイン用途を含め全環境で
// メモリ実装を採用する。best-effort・eventually consistent の位置づけは auth-security.md と整合)。
import type { RateLimiter } from './interface';

interface Bucket {
  resetAt: number;
  count: number;
}

export function createMemoryRateLimiter(
  cfg: { windowMs: number; max: number },
  clock: () => number = Date.now,
): RateLimiter {
  const buckets = new Map<string, Bucket>();
  return {
    async limit(key, opts = {}) {
      const now = clock();
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        b = { resetAt: now + cfg.windowMs, count: 0 };
        buckets.set(key, b);
      }
      if (b.count >= cfg.max) {
        return { allowed: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
      }
      if (opts.consume !== false) b.count += 1;
      return { allowed: true };
    },
  };
}
