import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../../src/http/app';
import { AppError } from '../../src/http/errors';
import { requiredParam } from '../../src/http/ui/params';

// requiredParam は c.req.param しか触らないため、最小の fake Context で十分(実 Hono ルータ不要)。
function fakeContext(params: Record<string, string>): Context<AppEnv> {
  return { req: { param: (name: string) => params[name] } } as unknown as Context<AppEnv>;
}

describe('requiredParam(C1 共有ヘルパー)', () => {
  it('存在するパラメータはその値を返す(distinct 値で誤バインドを識別)', () => {
    const c = fakeContext({ pid: 'proj-123', id: 'tc-456' });
    expect(requiredParam(c, 'pid')).toBe('proj-123');
    expect(requiredParam(c, 'id')).toBe('tc-456');
  });

  it('欠落パラメータは AppError(NOT_FOUND, 404) を throw', () => {
    const c = fakeContext({});
    let caught: unknown;
    try {
      requiredParam(c, 'pid');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('NOT_FOUND');
    expect((caught as AppError).status).toBe(404);
    expect((caught as AppError).message).toBe('missing path param: pid');
  });
});
