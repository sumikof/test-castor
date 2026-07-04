// src/http/ui/profile-page.tsx
// S-20 プロフィール・パスワード変更(docs/screens/admin/S-20-profile-password.md)。task-21-brief.md。
// 必要ロールは任意(ログイン済みであれば admin/editor/viewer いずれでもアクセス可)。
//
// ビジネスロジックは src/http/api/auth.ts の PATCH /password と同じ Auth/Storage 呼び出し
// (verifyPassword → setUserPassword → deleteUserSessions(除く自セッション))をそのまま呼ぶ
// (task-18 以降の「承認済みアプローチ A」を踏襲)。
//
// GC-1 突合メモ(タスク報告に転記):
// - password_confirm はクライアント側検証のみで API(ここでは Storage 直呼び出し)には使わない
//   (S-20「PATCH /api/v1/auth/password リクエスト」の注記どおり)。フォームは素の <form> のため
//   ブラウザは password_confirm フィールドも POST するが、サーバー側ハンドラはこの値を一切読まない
//   (「送信しない」という意図を、値を無視することで実質的に満たす)。
// - 既存の flash.ts の `password_changed` キー(Task 17 が S-04/S-20 向けに先取り登録)は
//   「再度ログインしてください」という全ログアウト前提の文言だが、実装済みの副作用(自セッションは
//   維持)と矛盾するため、本タスクは新規キー `profile_password_changed` を追加して使う
//   (flash.ts 側のコメント参照。既存キーは変更しない)。
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { csrfProtect } from '../middleware/csrf';
import { ensureCsrfCookie, requirePageAuth } from '../middleware/page-auth';
import { orgScopeOf } from '../middleware/scope';
import { resolveFlash, type Flash } from './flash';
import { Layout } from './layout';
import { ROLE_LABEL } from './users-pages';
import { passwordSchema, LIMITS } from '../../schemas/limits';
import type { Role } from '../../schemas/enums';
import type { UserRow } from '../../storage/schema';

// --- 文言(S-20 の各表と一致させる。GC-1) ---
const MSG = {
  // S-20「フィールドバリデーション」表に「現在のパスワード: 空文字不可」の具体的な文言は無い。
  // 他画面(login-password 等)と同じ言い回しで本実装が採番する(タスク報告に明記)。
  currentRequired: '現在のパスワードを入力してください',
  currentInvalid: '現在のパスワードが正しくありません',
  newRequired: '新しいパスワードを入力してください',
  newTooShort: 'パスワードは8文字以上で入力してください',
  confirmRequired: '確認用パスワードを入力してください',
  confirmMismatch: 'パスワードが一致しません',
} as const;

/** S-20「パスワードポリシーのフィードバック」: password-new-input の入力中にリアルタイムで
 * policy-length 表示をトグルする(D-06 は長さのみのポリシーのため、追加ポリシー項目は無い。
 * 「追加ポリシーは実装時に確定」の指示どおり、本実装では長さのみを対象とする)。 */
const PASSWORD_POLICY_SCRIPT = `
(function () {
  if (window.__tmsPasswordPolicyBound) return;
  window.__tmsPasswordPolicyBound = true;
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('[data-testid="password-new-input"]')) return;
    var el = document.querySelector('[data-testid="password-policy-length"]');
    if (!el) return;
    var minLength = Number(t.getAttribute('minlength') || '${LIMITS.passwordMin}');
    el.classList.toggle('policy-met', t.value.length >= minLength);
  });
})();
`;

interface ProfilePageProps {
  user: UserRow;
  csrf: string;
  flash?: Flash | null;
  errors?: { current?: string; newPassword?: string };
}

function ProfilePage(props: ProfilePageProps) {
  const e = props.errors ?? {};
  const role = props.user.role as Role;
  return (
    <Layout title="プロフィール" user={props.user} csrf={props.csrf} flash={props.flash ?? null}>
      <h1 data-testid="profile-title">プロフィール</h1>
      <p>表示名: <span data-testid="profile-display-name">{props.user.displayName}</span></p>
      <p>メール: <span data-testid="profile-email">{props.user.email}</span></p>
      <p>ロール: <span class={`badge badge-role-${role}`} data-testid="profile-role">{ROLE_LABEL[role]}</span></p>

      <h2 data-testid="password-change-heading">パスワード変更</h2>
      <form method="post" action="/profile" novalidate data-validate data-testid="password-change-form">
        <input type="hidden" name="_csrf" value={props.csrf} />
        <div class="field">
          <label for="password-current-input">現在のパスワード</label>
          <input
            id="password-current-input" name="current_password" type="password" required autocomplete="current-password"
            data-testid="password-current-input" data-err-required={MSG.currentRequired} aria-describedby="password-current-error"
          />
          <p id="password-current-error" data-testid="password-current-error" class="field-error" aria-live="polite">{e.current ?? ''}</p>
        </div>
        <div class="field">
          <label for="password-new-input">新しいパスワード</label>
          <input
            id="password-new-input" name="new_password" type="password" required
            minlength={LIMITS.passwordMin} maxlength={LIMITS.passwordMax} autocomplete="new-password"
            data-testid="password-new-input" data-err-required={MSG.newRequired} data-err-tooshort={MSG.newTooShort}
            aria-describedby="password-new-error"
          />
          <p id="password-new-error" data-testid="password-new-error" class="field-error" aria-live="polite">{e.newPassword ?? ''}</p>
          <p data-testid="password-policy-length" class="hint">8文字以上</p>
        </div>
        <div class="field">
          <label for="password-confirm-input">パスワード確認</label>
          {/* data-match/data-err-match: layout.tsx の FORM_ENHANCE_SCRIPT が既に持つ汎用の一致検証
              (auth-pages.tsx の admin_password_confirm フィールドと同じ idiom)をそのまま再利用する。
              blur 時に不一致なら password-confirm-error にエラースタイル・文言を表示する
              (S-20「パスワード確認のインラインバリデーション」)。 */}
          <input
            id="password-confirm-input" name="password_confirm" type="password" required
            minlength={LIMITS.passwordMin} maxlength={LIMITS.passwordMax} autocomplete="new-password"
            data-testid="password-confirm-input" data-err-required={MSG.confirmRequired}
            data-match="password-new-input" data-err-match={MSG.confirmMismatch}
            aria-describedby="password-confirm-error"
          />
          <p id="password-confirm-error" data-testid="password-confirm-error" class="field-error" aria-live="polite"></p>
        </div>
        {/* progressive enhancement: 他画面と同じ理由で SSR は disabled をハードコードしない
            (S-20「全3フィールド入力済み+確認一致で enabled」は FORM_ENHANCE_SCRIPT が JS 実行時に適用)。 */}
        <button type="submit" class="btn btn-primary" data-testid="password-change-submit">パスワードを変更</button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: PASSWORD_POLICY_SCRIPT }}></script>
    </Layout>
  );
}

export const profilePageRoutes = new Hono<AppEnv>()
  // S-20: 任意のロール(ログイン済みであればよい)。requirePageAuth の minRole 省略 = ロール制限なし。
  .get('/profile', requirePageAuth(), async (c) => {
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const csrf = await ensureCsrfCookie(c);
    const flash = resolveFlash(c.req.query('flash'));
    return c.html(<ProfilePage user={actor.user} csrf={csrf} flash={flash} />);
  })

  .post('/profile', requirePageAuth(), csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const csrf = await ensureCsrfCookie(c);
    const { user, sessionId } = actor;

    const body = await c.req.parseBody();
    const currentPassword = String(body.current_password ?? '');
    const newPassword = String(body.new_password ?? '');
    // password_confirm はここでは意図的に読まない(ファイル冒頭コメント参照。クライアント側検証のみ)。

    const rerender = (errors: { current?: string; newPassword?: string }) => c.html(<ProfilePage user={user} csrf={csrf} errors={errors} />, 200);

    // 形式チェック(空文字・長さ)を先に行い、コストの高い PBKDF2 検証(verifyPassword)は
    // 形式が妥当な場合のみ実行する。
    if (!currentPassword) return rerender({ current: MSG.currentRequired });
    if (!newPassword) return rerender({ newPassword: MSG.newRequired });
    if (!passwordSchema.safeParse(newPassword).success) return rerender({ newPassword: MSG.newTooShort });

    const verifyResult = user.passwordHash
      ? await deps.auth.verifyPassword(currentPassword, user.passwordHash)
      : { ok: false, needsRehash: false };
    if (!verifyResult.ok) return rerender({ current: MSG.currentInvalid });

    const scope = orgScopeOf(actor);
    await deps.storage.setUserPassword(scope, user.id, await deps.auth.hashPassword(newPassword), deps.now());
    // 自分自身の他の全セッションを無効化する。自セッションは維持する(src/http/api/auth.ts の
    // PATCH /password と同じ副作用。apis/auth.md「副作用・業務ルール」)。
    await deps.storage.deleteUserSessions(user.id, sessionId);

    return c.redirect('/profile?flash=profile_password_changed', 303);
  });
