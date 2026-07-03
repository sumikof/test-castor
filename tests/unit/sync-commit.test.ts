// tests/unit/sync-commit.test.ts
// task-16-brief.md: src/domain/sync-commit.ts(工程の述語の純粋部分)の単体テスト。
// commit 8工程パイプラインは大半が set-based SQL(drizzle-storage.ts)で実行されるが、
// 「観測 category のフォールバック(工程1)」「mappings の3分類(syncMappings)」
// 「rollup の is_stale 集約述語(工程7。TTL 判定含む)」は DB を伴わない純粋なロジックとして
// 切り出せるため、GC-6(domain は D1/workers-types を import しない)に従い純関数化し、
// ここで単体に検証する。工程7の実際の書き込みは drizzle-storage.ts の相関サブクエリ SQL が担うが、
// この純関数は「同じ述語」の実行可能な仕様として、SQL 側の意図を裏付けるために存在する
// (drizzle-storage.ts のコメントから本ファイルの関数名を相互参照する)。
import { describe, it, expect } from 'vitest';
import {
  resolveCanonicalCategory,
  classifySyncMappings,
  isIdentityLive,
  computeCanonicalIsStale,
} from '../../src/domain/sync-commit';

describe('domain/sync-commit: resolveCanonicalCategory(工程1のcategoryフォールバック)', () => {
  it('観測に category があればそれを採用する', () => {
    expect(resolveCanonicalCategory('boundary')).toBe('boundary');
  });
  it('観測に category が無ければ normal にフォールバックする', () => {
    expect(resolveCanonicalCategory(null)).toBe('normal');
  });
});

describe('domain/sync-commit: classifySyncMappings(syncMappings の3分類)', () => {
  it('staging に有る ref は created', () => {
    const result = classifySyncMappings({
      stagingRefs: ['ext-new'],
      observedRefs: [],
      seenRefs: ['ext-new'],
    });
    expect(result).toEqual([{ externalRef: 'ext-new', outcome: 'created' }]);
  });

  it('staging に無く観測(:T)が有る ref は updated', () => {
    const result = classifySyncMappings({
      stagingRefs: [],
      observedRefs: ['ext-changed'],
      seenRefs: ['ext-changed'],
    });
    expect(result).toEqual([{ externalRef: 'ext-changed', outcome: 'updated' }]);
  });

  it('sync_seen のみ(staging にも観測にも無い)の ref は unchanged', () => {
    const result = classifySyncMappings({
      stagingRefs: [],
      observedRefs: [],
      seenRefs: ['ext-unchanged'],
    });
    expect(result).toEqual([{ externalRef: 'ext-unchanged', outcome: 'unchanged' }]);
  });

  it('3種混在・staged が最優先(staging かつ観測に同時に載っていても created)', () => {
    const result = classifySyncMappings({
      stagingRefs: ['ext-a', 'ext-priority'],
      observedRefs: ['ext-b', 'ext-priority'],
      seenRefs: ['ext-a', 'ext-b', 'ext-c', 'ext-priority'],
    });
    const byRef = new Map(result.map((r) => [r.externalRef, r.outcome]));
    expect(byRef.get('ext-a')).toBe('created');
    expect(byRef.get('ext-b')).toBe('updated');
    expect(byRef.get('ext-c')).toBe('unchanged');
    expect(byRef.get('ext-priority')).toBe('created'); // staging が最優先
    expect(result).toHaveLength(4);
  });

  it('seenRefs の重複は1件として畳み込まれる', () => {
    const result = classifySyncMappings({ stagingRefs: [], observedRefs: [], seenRefs: ['ext-x', 'ext-x'] });
    expect(result).toEqual([{ externalRef: 'ext-x', outcome: 'unchanged' }]);
  });
});

describe('domain/sync-commit: isIdentityLive(rollup の TTL 判定)', () => {
  const now = 1_700_000_000_000;
  const ttl = 90 * 24 * 60 * 60 * 1000;

  it('last_seen_at が null なら live ではない', () => {
    expect(isIdentityLive(null, now, ttl)) .toBe(false);
  });
  it('TTL 内なら live', () => {
    expect(isIdentityLive(now - 1000, now, ttl)).toBe(true);
  });
  it('TTL ちょうど(境界)は live ではない(> の厳密比較)', () => {
    expect(isIdentityLive(now - ttl, now, ttl)).toBe(false);
  });
  it('TTL 超過は live ではない(凍結)', () => {
    expect(isIdentityLive(now - ttl - 1, now, ttl)).toBe(false);
  });
});

describe('domain/sync-commit: computeCanonicalIsStale(工程7 rollup の集約述語)', () => {
  const now = 1_700_000_000_000;
  const ttl = 90 * 24 * 60 * 60 * 1000;

  it('identity が1件も無ければ stale ではない(EXISTS(live)が偽)', () => {
    expect(computeCanonicalIsStale([], now, ttl)).toBe(false);
  });

  it('live な identity が全て stale なら canonical も stale', () => {
    const identities = [
      { isStale: true, lastSeenAt: now - 1000 },
      { isStale: true, lastSeenAt: now - 2000 },
    ];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(true);
  });

  it('live な identity が1つでも non-stale なら canonical は stale ではない', () => {
    const identities = [
      { isStale: true, lastSeenAt: now - 1000 },
      { isStale: false, lastSeenAt: now - 2000 },
    ];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(false);
  });

  it('TTL 超過(凍結)の identity のみの場合は集約から除外され stale にならない(引退オリジンの永久ブロッカー防止)', () => {
    const identities = [{ isStale: true, lastSeenAt: now - ttl - 1 }];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(false);
  });

  it('live(非stale)+凍結(stale) の混在は、凍結側を無視して live 側のみで判定する(non-stale なので false)', () => {
    const identities = [
      { isStale: false, lastSeenAt: now - 1000 }, // live, not stale
      { isStale: true, lastSeenAt: now - ttl - 1 }, // frozen, excluded
    ];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(false);
  });

  it('live(stale)+凍結(non-stale) の混在は、凍結側を無視して live 側のみで判定する(全live がstaleなので true)', () => {
    const identities = [
      { isStale: true, lastSeenAt: now - 1000 }, // live, stale
      { isStale: false, lastSeenAt: now - ttl - 1 }, // frozen, excluded
    ];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(true);
  });
});
