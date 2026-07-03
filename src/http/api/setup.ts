// src/http/api/setup.ts
// 初回セットアップ API(docs/apis/setup.md)。認証不要。Organization が0件のときのみ実行可能で、
// 組織 + 管理者ユーザーを単一操作(Storage.setupOrganization、内部で単一トランザクション)で作成する。
// セットアップ本体のロジックは task-17 で src/domain/services/auth-service.ts の setupOrg() へ抽出済み。
// UI ルート(src/http/ui/auth-pages.tsx の GET|POST /setup)も同じ関数を呼ぶ(承認済みアプローチ A)。
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { zodHook } from '../middleware/error';
import { setupInput } from '../../schemas/api';
import { toOrganizationJson, toUserJson } from './serializers';
import { setupOrg } from '../../domain/services/auth-service';

export const setupRoutes = new Hono<AppEnv>().post('/', zValidator('json', setupInput, zodHook), async (c) => {
  const deps = c.get('deps');
  const input = c.req.valid('json');

  // 競合窓についての既知の許容: countOrganizations() と setupOrganization() の間に別リクエストが
  // 割り込めば理論上は2件の組織が作られうる。apis/setup.md は「初回デプロイ直後に1回だけ叩く」運用を
  // 前提とする単一デプロイ操作であり、通常運用でこの窓を突く同時リクエストは発生しない。MVP では
  // ここに一意制約等の追加の排他機構を設けず、この競合窓を許容する(タスクブリーフに明記の判断)。
  const existing = await deps.storage.countOrganizations();
  if (existing > 0) throw new AppError('SETUP_ALREADY_COMPLETE', 409, 'setup already complete');

  const { organization, user } = await setupOrg(deps, {
    orgName: input.organization_name,
    adminEmail: input.admin_email,
    adminPassword: input.admin_password,
    adminDisplayName: input.admin_display_name,
  });

  // apis/setup.md のレスポンス仕様は user.{id,email,display_name,role,created_at} の5フィールドのみ
  // (updated_at/last_login_at は含まない)。toUserJson は以後のタスク(ユーザー一覧・詳細API)向けの
  // 完全形なので、ここではその中からドキュメントの契約に一致する部分集合だけを選び取る。
  const { updated_at: _updatedAt, last_login_at: _lastLoginAt, ...setupUser } = toUserJson(user);
  return c.json({ organization: toOrganizationJson(organization), user: setupUser }, 201);
});
