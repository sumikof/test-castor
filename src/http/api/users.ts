// src/http/api/users.ts
// ユーザー管理 API(docs/apis/users.md)。全エンドポイント admin ロール必須
// (requireAuth({modes:['session'], minRole:'admin'})。衛星トークンはそもそも 'session' 以外を
// 許可しないため到達しない)。状態変更系(POST/PATCH)は CSRF 必須(D-09)。
//
// - PATCH: role が実際に変化した場合のみ、対象ユーザーの全セッションを無効化する(exceptなし。
//   apis/users.md「副作用・業務ルール」)。display_name のみの変更では無効化しない。
//   「最後の admin」保護(D-13-7, スペック D-13-7): 対象が現在 admin かつ新ロールが admin 以外かつ
//   組織の admin 総数が1以下なら、更新前に 422 VALIDATION_FAILED で拒否する(自己降格・他者降格を
//   区別しない。「admin が1人しかいない状態でその1人を降格しようとしている」という条件のみで判定できる)。
// - reset-password: 対象ユーザーの全セッションを無効化する(exceptなし。PATCH /auth/password と異なり
//   自セッションの例外はない — reset-password は「管理者が他者に対して行う操作」が前提のため)。
//   パスワードポリシー(D-06)は resetPasswordInput(共有 Zod スキーマ)が担保する。
// - :id が他 org のものであれば getUser が null を返す → 404(存在隠蔽。GET/PATCH/reset-password 共通)。
//
// GC-1 メモ: docs/apis/users.md の POST/GET単体/PATCH レスポンスのフィールド表には last_login_at が
// 載っていない(GET一覧の表にも同様に無い)。だがスペック D-05 は「GET /api/v1/users の各アイテムに
// last_login_at(null可)を追加」を明記しており、S-18 画面仕様も同フィールドを要求している
// (「API ギャップ」として明示済み)。ここでは serializers.toUserJson(全フィールド形)を全エンドポイントで
// 一貫して返す — 未文書化フィールドの追加は api-reference.md のバージョニング規約上も非破壊。
// タスク報告にこの docs 記載漏れを明示する(GC-1)。
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { zodHook } from '../middleware/error';
import { requireAuth } from '../middleware/authn';
import { csrfProtect } from '../middleware/csrf';
import { orgScopeOf } from '../middleware/scope';
import { createUserInput, patchUserInput, resetPasswordInput } from '../../schemas/api';
import { toUserJson } from './serializers';

const adminOnly = requireAuth({ modes: ['session'], minRole: 'admin' });

export const usersRoutes = new Hono<AppEnv>()
  .get('/', adminOnly, async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const items = await deps.storage.listUsers(scope);
    return c.json({ items: items.map(toUserJson) });
  })

  .post('/', adminOnly, csrfProtect(), zValidator('json', createUserInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const input = c.req.valid('json');

    const passwordHash = await deps.auth.hashPassword(input.password);
    const result = await deps.storage.createUser(scope, {
      email: input.email,
      passwordHash,
      displayName: input.display_name,
      role: input.role,
      now: deps.now(),
    });
    if (result === 'email_taken') {
      throw new AppError('VALIDATION_FAILED', 422, 'email already exists', [{ path: 'email', msg: 'already exists' }]);
    }
    return c.json(toUserJson(result), 201);
  })

  .get('/:id', adminOnly, async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const user = await deps.storage.getUser(scope, c.req.param('id'));
    if (!user) throw new AppError('NOT_FOUND', 404, 'not found');
    return c.json(toUserJson(user));
  })

  .patch('/:id', adminOnly, csrfProtect(), zValidator('json', patchUserInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const id = c.req.param('id');
    const patch = c.req.valid('json');

    const current = await deps.storage.getUser(scope, id);
    if (!current) throw new AppError('NOT_FOUND', 404, 'not found');

    const roleChanging = patch.role !== undefined && patch.role !== current.role;
    if (
      roleChanging
      && current.role === 'admin'
      && patch.role !== 'admin'
      && (await deps.storage.countAdmins(scope)) <= 1
    ) {
      // D-13-7: 組織の admin が0人になる role 変更は拒否する(自己降格・他者降格を区別しない)。
      throw new AppError('VALIDATION_FAILED', 422, 'cannot demote the last admin');
    }

    const updated = await deps.storage.updateUser(scope, id, { role: patch.role, displayName: patch.display_name }, deps.now());
    if (!updated) throw new AppError('NOT_FOUND', 404, 'not found');

    if (roleChanging) {
      // ロール変更時のみ対象ユーザーの全セッションを無効化する(exceptなし。apis/users.md 副作用)。
      await deps.storage.deleteUserSessions(id);
    }

    return c.json(toUserJson(updated));
  })

  .post('/:id/reset-password', adminOnly, csrfProtect(), zValidator('json', resetPasswordInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const scope = orgScopeOf(c.get('actor'));
    const id = c.req.param('id');
    const { new_password: newPassword } = c.req.valid('json');

    const current = await deps.storage.getUser(scope, id);
    if (!current) throw new AppError('NOT_FOUND', 404, 'not found');

    await deps.storage.setUserPassword(scope, id, await deps.auth.hashPassword(newPassword), deps.now());
    await deps.storage.deleteUserSessions(id); // 対象の全セッションを無効化する(exceptなし)

    return c.json({ message: 'password_reset' });
  });
