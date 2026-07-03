// tests/unit/ratelimit.test.ts
// RateLimiter は Storage/Auth に続く第4のポータビリティ境界(auth-security.md「流量制御」)。
// メモリ実装(固定ウィンドウ)を fake clock で検証する: window/max/retryAfterSec/consume:false。
import { describe, it, expect } from 'vitest';
import { createMemoryRateLimiter } from '../../src/ratelimit/memory';

function fakeClock(startAt: number) {
  let now = startAt;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    set: (t: number) => { now = t; },
  };
}

describe('ratelimit: createMemoryRateLimiter (固定ウィンドウ)', () => {
  it('max 回までは allowed:true、max+1 回目は allowed:false', async () => {
    const clock = fakeClock(1_000_000);
    const limiter = createMemoryRateLimiter({ windowMs: 1000, max: 3 }, clock.now);
    expect((await limiter.limit('k')).allowed).toBe(true);
    expect((await limiter.limit('k')).allowed).toBe(true);
    expect((await limiter.limit('k')).allowed).toBe(true);
    const blocked = await limiter.limit('k');
    expect(blocked.allowed).toBe(false);
  });

  it('block 時に retryAfterSec = ceil((resetAt-now)/1000) を返す', async () => {
    const clock = fakeClock(1_000_000);
    const limiter = createMemoryRateLimiter({ windowMs: 10_000, max: 1 }, clock.now);
    await limiter.limit('k'); // 1回目で消費しきる(max=1)
    clock.advance(3_500); // ウィンドウ内(resetAt = 1_010_000, now = 1_003_500 → 残り6500ms)
    const blocked = await limiter.limit('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(7); // ceil(6500/1000) = 7
  });

  it('allowed:true のとき retryAfterSec は付与しない(undefined)', async () => {
    const clock = fakeClock(1_000_000);
    const limiter = createMemoryRateLimiter({ windowMs: 1000, max: 5 }, clock.now);
    const res = await limiter.limit('k');
    expect(res.allowed).toBe(true);
    expect(res.retryAfterSec).toBeUndefined();
  });

  it('consume:false はカウントを消費しない(残枠チェックのみ)', async () => {
    const clock = fakeClock(1_000_000);
    const limiter = createMemoryRateLimiter({ windowMs: 1000, max: 2 }, clock.now);
    // consume:false を5回呼んでも枠は減らない
    for (let i = 0; i < 5; i++) {
      const res = await limiter.limit('k', { consume: false });
      expect(res.allowed).toBe(true);
    }
    // 実消費は max=2 回まで許可される(consume:false の呼び出しが枠を圧迫していない証拠)
    expect((await limiter.limit('k')).allowed).toBe(true);
    expect((await limiter.limit('k')).allowed).toBe(true);
    expect((await limiter.limit('k')).allowed).toBe(false);
  });

  it('consume 省略時は既定で消費する(consume:true 相当)', async () => {
    const clock = fakeClock(1_000_000);
    const limiter = createMemoryRateLimiter({ windowMs: 1000, max: 1 }, clock.now);
    expect((await limiter.limit('k')).allowed).toBe(true); // opts省略 → 消費
    expect((await limiter.limit('k')).allowed).toBe(false); // 枠を使い切っている
  });

  it('ログインのブルートフォース防御の実運用パターン: 失敗のみ consume、正しいパスワードの試行は consume しない(D-14)', async () => {
    const clock = fakeClock(1_000_000);
    const limiter = createMemoryRateLimiter({ windowMs: 900_000, max: 5 }, clock.now);
    // 4回失敗(consume) → まだ許可
    for (let i = 0; i < 4; i++) {
      const gate = await limiter.limit('login:e@example.com:1.2.3.4', { consume: false });
      expect(gate.allowed).toBe(true);
      await limiter.limit('login:e@example.com:1.2.3.4'); // 失敗を consume
    }
    // 5回目の試行前チェック(まだ許可: 4回消費済みなのでmax=5未満)
    const gateBeforeSuccess = await limiter.limit('login:e@example.com:1.2.3.4', { consume: false });
    expect(gateBeforeSuccess.allowed).toBe(true);
    // 成功 → consume しない(ここでは limit() を呼ばない、が実装的には「呼ばない」がconsumeしない、と同義)
    // 直後にもう1回失敗を試みても、まだ5回目の消費前なのでブロックされない
    const gateAfterSuccess = await limiter.limit('login:e@example.com:1.2.3.4', { consume: false });
    expect(gateAfterSuccess.allowed).toBe(true);
  });

  it('ウィンドウ経過後はカウントがリセットされる', async () => {
    const clock = fakeClock(1_000_000);
    const limiter = createMemoryRateLimiter({ windowMs: 1000, max: 1 }, clock.now);
    expect((await limiter.limit('k')).allowed).toBe(true);
    expect((await limiter.limit('k')).allowed).toBe(false);
    clock.advance(1000); // resetAt(=1_001_000) <= now(=1_001_000) → リセット
    expect((await limiter.limit('k')).allowed).toBe(true);
  });

  it('キーごとに独立したカウンタを持つ', async () => {
    const clock = fakeClock(1_000_000);
    const limiter = createMemoryRateLimiter({ windowMs: 1000, max: 1 }, clock.now);
    expect((await limiter.limit('a')).allowed).toBe(true);
    expect((await limiter.limit('a')).allowed).toBe(false); // a は枠を使い切った
    expect((await limiter.limit('b')).allowed).toBe(true); // b は無関係
  });

  it('clock 省略時は既定で Date.now を使う(例外なく動作する)', async () => {
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, max: 1 });
    expect((await limiter.limit('k')).allowed).toBe(true);
    expect((await limiter.limit('k')).allowed).toBe(false);
  });

  it('D-14 既定値相当(sync: 120req/分)でも同じ挙動をする(スケール確認)', async () => {
    const clock = fakeClock(0);
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, max: 120 }, clock.now);
    for (let i = 0; i < 120; i++) {
      expect((await limiter.limit('token:abc')).allowed).toBe(true);
    }
    expect((await limiter.limit('token:abc')).allowed).toBe(false);
  });
});
