// src/http/ui/params.ts
// UI ルート横断の実行時パスパラメータ取得(HANDOVER C1: 3 ファイルに重複していた同一実装の統合先)。
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { AppError } from '../errors';

/**
 * `c.req.param(name)` は Hono のルート単位のパスリテラル型推論があって初めて `string`(param 無しは
 * `string | undefined`)を返す。複数ルートから呼ばれる独立関数はその推論の恩恵を受けられず
 * `Context<AppEnv>`(パス情報無し)としてしか Context を受け取れないため、動的セグメントの存在を
 * 実行時契約として扱う(前提: 呼び出し元のルート登録が必ず該当セグメントを持つこと)。
 */
export function requiredParam(c: Context<AppEnv>, name: string): string {
  const v = c.req.param(name);
  if (v === undefined) throw new AppError('NOT_FOUND', 404, `missing path param: ${name}`);
  return v;
}
