// src/http/ui/users-pages.tsx
// S-18 ユーザー一覧(docs/screens/admin/S-18-user-list.md)+ S-19 ユーザー作成・編集ダイアログ
// (docs/screens/admin/S-19-user-create-edit.md)。task-21-brief.md。スペック D-05(last_login_at)・
// D-13-7(最後の admin 保護)。
//
// ビジネスロジックは src/http/api/users.ts と同じ Storage 呼び出し(createUser/updateUser/
// setUserRoleGuarded/setUserPassword/deleteUserSessions)を直接呼ぶ(task-18 以降の「承認済み
// アプローチ A」を踏襲。UI 専用の service 抽出はしない)。特に PATCH の「role 実変更時のみ全セッション
// 無効化」「setUserRoleGuarded の atomic ガード('blocked_last_admin' は 2ラウンドトリップの
// countAdmins 事前チェックではなく単一 UPDATE で強制)」は src/http/api/users.ts の実装をそのまま
// UI ルートでも再現する(重複だが、task-19/20 の testcase 系 UI ルートも同じ判断をしている)。
//
// GC-1 突合メモ(タスク報告に転記):
// - S-19「ロール | select ... 作成/編集」のワイヤーフレームは `[editor ▼]` のように raw な英語値を
//   表示しており(日本語ラベルではない)、これは既存の status select(testcase-detail.tsx の
//   `<option value={s}>{s}</option>`)と同じ語彙選択。よって <select> の option テキストは
//   raw な role 値(admin/editor/viewer)のまま表示し、日本語ラベル(ROLE_LABEL)は S-18 の
//   バッジ表示・トースト文言など「読み物」の文脈にのみ使う。
// - S-19「ロール変更成功トースト」の `{role}` プレースホルダは raw値/日本語ラベルのどちらとも
//   取れる(ドキュメントに例文が無い)。本実装は他のトースト文言(bulk 系の ACTION_LABEL 使用)との
//   一貫性を優先し、日本語ラベル(ROLE_LABEL)を採用する(タスク報告に解釈上の判断として明記)。
// - S-18/S-19「空状態メッセージ」「表示名のみ変更時のトースト」の具体的な文言はドキュメント未記載。
//   本実装で採番する箇所は各所のコメントに個別に明記する。
// - 「最後の admin 保護の 422 をトースト表示」自体は S-19 の「エラー状態」表に載っていない
//   (D-13-7 はスペックレベルの横断ルールであり画面ドキュメントの対象外)。task-21-brief.md が
//   明示的に「トースト表示」と指示しているため、本実装はブリーフの指示を優先する。
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { csrfProtect } from '../middleware/csrf';
import { ensureCsrfCookie, requirePageAuth } from '../middleware/page-auth';
import { orgScopeOf } from '../middleware/scope';
import { resolveFlash, type Flash } from './flash';
import { requiredParam } from './params';
import { Layout } from './layout';
import { formatDateTime } from './testcase-list';
import { nameSchema, emailSchema, passwordSchema, LIMITS } from '../../schemas/limits';
import { ROLES } from '../../schemas/enums';
import type { Role } from '../../schemas/enums';
import type { UserRow } from '../../storage/schema';

/** S-18 ロールバッジ・トースト文言など「読み物」の文脈で使う日本語ラベル(S-18「ロールバッジの表示」表)。
 * S-20(プロフィール)も同じラベルを再利用する(export。testcase-list.tsx の CATEGORY_LABEL と同じ
 * cross-file 再利用の idiom)。 */
export const ROLE_LABEL: Record<Role, string> = { admin: '管理者', editor: '編集者', viewer: '閲覧者' };

// --- 文言(S-19 の各表と一致させる。GC-1) ---
const MSG = {
  emailRequired: 'メールアドレスを入力してください',
  emailInvalid: '有効なメールアドレスを入力してください',
  emailTaken: 'このメールアドレスは既に使用されています',
  displayNameRequired: '表示名を入力してください',
  // S-19 はドキュメント上「最大100文字」としか書いておらず超過時の具体文言は無い。他画面
  // (project-name 等)と同じ言い回しで本実装が採番する(タスク報告に明記)。
  displayNameTooLong: '表示名は100文字以内で入力してください',
  passwordRequired: 'パスワードを入力してください',
  passwordTooShort: 'パスワードは8文字以上で入力してください',
  roleChangeWarning: 'ロール変更時は対象ユーザーの全セッションが無効化されます。次回ログイン時から新しいロールが適用されます',
  selfRoleTooltip: '自身のロールは変更できません',
} as const;

function validateDisplayName(name: string): string | undefined {
  if (!name) return MSG.displayNameRequired;
  if (!nameSchema.safeParse(name).success) return MSG.displayNameTooLong;
  return undefined;
}
function validatePassword(pw: string): string | undefined {
  if (!pw) return MSG.passwordRequired;
  if (!passwordSchema.safeParse(pw).success) return MSG.passwordTooShort;
  return undefined;
}
type CreateFieldErrors = Partial<Record<'email' | 'displayName' | 'password', string>>;
function validateCreateForm(input: { email: string; displayName: string; password: string }): CreateFieldErrors {
  const errors: CreateFieldErrors = {};
  if (!input.email) errors.email = MSG.emailRequired;
  else if (!emailSchema.safeParse(input.email).success) errors.email = MSG.emailInvalid;
  const displayNameError = validateDisplayName(input.displayName);
  if (displayNameError) errors.displayName = displayNameError;
  const passwordError = validatePassword(input.password);
  if (passwordError) errors.password = passwordError;
  return errors;
}

/** projects-pages.tsx の DIALOG_ESCAPE_SCRIPT / testcase-detail.tsx の DIALOG_CLOSE_SCRIPT と同じ
 * idiom(Escape・オーバーレイクリック・[data-dialog-cancel] クリックで閉じる)。S-19 の「画面遷移」表は
 * どちらも「S-18(ダイアログ閉じる)」を明記しており、S-17 ステップ2のような閉じ防止は無い。 */
const USER_DIALOG_CLOSE_SCRIPT = `
(function () {
  if (window.__tmsUserDialogBound) return;
  window.__tmsUserDialogBound = true;
  function closeBackdrop(backdrop) {
    if (!backdrop) return;
    if (backdrop.parentElement && backdrop.parentElement.id === 'dialog-root') {
      backdrop.parentElement.innerHTML = '';
      return;
    }
    backdrop.remove();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeBackdrop(document.querySelector('.dialog-backdrop'));
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('[data-dialog-cancel]')) { e.preventDefault(); closeBackdrop(t.closest('.dialog-backdrop')); return; }
    if (t.matches('.dialog-backdrop')) closeBackdrop(t);
  });
})();
`;

/** S-19「ロール変更時の警告表示」: ロール select の値がプリフィル時の値(data-original-role)から
 * 変わったら警告を表示する。これは SSR 単体では判定できない(初期値は常に「未変更」)ため JS 側の
 * 補助 UX として実装する(bulk 操作バーと同じ「JS-only の付加的アフォーダンス」判断。警告が出ない
 * だけで送信自体は妨げないため no-JS でも安全)。 */
const USER_ROLE_WARN_SCRIPT = `
(function () {
  if (window.__tmsUserRoleWarnBound) return;
  window.__tmsUserRoleWarnBound = true;
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('[data-testid="user-role-select"]')) return;
    var warn = document.querySelector('[data-testid="user-role-change-warning"]');
    if (!warn) return;
    warn.hidden = t.value === t.dataset.originalRole;
  });
})();
`;

// --- S-19 作成モード ---

function UserCreateDialog(props: { csrf: string; values?: { email?: string; displayName?: string; role?: Role }; errors?: CreateFieldErrors }) {
  const v = props.values ?? {};
  const e = props.errors ?? {};
  const role = v.role ?? 'editor'; // S-19「ロール選択肢のデフォルト」: 作成時は editor
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="user-dialog-title" data-testid="user-create-dialog">
        <div class="dialog-header">
          <h2 id="user-dialog-title" data-testid="user-dialog-title">ユーザー追加</h2>
          <a href="/admin/users" class="dialog-close" data-testid="user-create-dialog-close" aria-label="閉じる" data-dialog-cancel="true">✕</a>
        </div>
        <form method="post" action="/admin/users/new" novalidate data-validate data-testid="user-create-form">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <div class="field">
            <label for="user-email-input">メールアドレス</label>
            <input
              id="user-email-input" name="email" type="email" value={v.email ?? ''} required maxlength={LIMITS.email}
              data-testid="user-email-input" data-err-required={MSG.emailRequired} data-err-type={MSG.emailInvalid}
              aria-describedby="user-email-error"
            />
            <p id="user-email-error" data-testid="user-email-error" class="field-error" aria-live="polite">{e.email ?? ''}</p>
          </div>
          <div class="field">
            <label for="user-display-name-input">表示名</label>
            <input
              id="user-display-name-input" name="display_name" type="text" value={v.displayName ?? ''}
              required maxlength={LIMITS.name} data-testid="user-display-name-input"
              data-err-required={MSG.displayNameRequired} aria-describedby="user-display-name-error"
            />
            <p id="user-display-name-error" data-testid="user-display-name-error" class="field-error" aria-live="polite">{e.displayName ?? ''}</p>
          </div>
          <div class="field">
            <label for="user-role-select">ロール</label>
            <select id="user-role-select" name="role" data-testid="user-role-select">
              {ROLES.map((r) => <option value={r} selected={r === role}>{r}</option>)}
            </select>
          </div>
          <div class="field">
            <label for="user-password-input">初期パスワード</label>
            <input
              id="user-password-input" name="password" type="password" required
              minlength={LIMITS.passwordMin} maxlength={LIMITS.passwordMax} autocomplete="new-password"
              data-testid="user-password-input" data-err-required={MSG.passwordRequired} data-err-tooshort={MSG.passwordTooShort}
              aria-describedby="user-password-error"
            />
            <p id="user-password-error" data-testid="user-password-error" class="field-error" aria-live="polite">{e.password ?? ''}</p>
          </div>
          <div class="dialog-actions">
            <a href="/admin/users" class="btn btn-secondary" data-testid="user-dialog-cancel" data-dialog-cancel="true">キャンセル</a>
            {/* progressive enhancement: 他画面と同じ理由で SSR は disabled をハードコードしない。 */}
            <button type="submit" class="btn btn-primary" data-testid="user-dialog-submit-create">追加</button>
          </div>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: USER_DIALOG_CLOSE_SCRIPT }}></script>
    </div>
  );
}

// --- S-19 編集モード ---

interface UserEditDialogProps {
  csrf: string;
  target: UserRow;
  isSelf: boolean;
  values: { displayName: string; role: string };
  errors?: { displayName?: string };
  resetError?: string;
}

function UserEditDialog(props: UserEditDialogProps) {
  const { target, isSelf, values } = props;
  const e = props.errors ?? {};
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="user-dialog-title" data-testid="user-edit-dialog">
        <div class="dialog-header">
          <h2 id="user-dialog-title" data-testid="user-dialog-title">{`ユーザー編集: ${target.displayName}`}</h2>
          <a href="/admin/users" class="dialog-close" data-testid="user-edit-dialog-close" aria-label="閉じる" data-dialog-cancel="true">✕</a>
        </div>
        <form method="post" action={`/admin/users/${target.id}/edit`} novalidate data-validate data-testid="user-edit-form">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <div class="field">
            <label>メールアドレス</label>
            <p data-testid="user-email-readonly">{target.email}</p>
          </div>
          <div class="field">
            <label for="user-display-name-input">表示名</label>
            <input
              id="user-display-name-input" name="display_name" type="text" value={values.displayName}
              required maxlength={LIMITS.name} data-testid="user-display-name-input"
              data-err-required={MSG.displayNameRequired} aria-describedby="user-display-name-error"
            />
            <p id="user-display-name-error" data-testid="user-display-name-error" class="field-error" aria-live="polite">{e.displayName ?? ''}</p>
          </div>
          <div class="field">
            <label for="user-role-select">ロール</label>
            <select
              id="user-role-select" name="role" data-testid="user-role-select"
              data-original-role={target.role} disabled={isSelf} title={isSelf ? MSG.selfRoleTooltip : undefined}
            >
              {ROLES.map((r) => <option value={r} selected={r === values.role}>{r}</option>)}
            </select>
            {/* S-19「ロール変更時の警告表示」: 初期状態は非表示(hidden)。USER_ROLE_WARN_SCRIPT が
                select の change イベントでプリフィル値との差分に応じてトグルする。 */}
            <p class="alert alert-warn" data-testid="user-role-change-warning" hidden>{MSG.roleChangeWarning}</p>
          </div>
          <div class="dialog-actions">
            <a href="/admin/users" class="btn btn-secondary" data-testid="user-dialog-cancel" data-dialog-cancel="true">キャンセル</a>
            <button type="submit" class="btn btn-primary" data-testid="user-dialog-submit-edit">保存</button>
          </div>
        </form>

        {/* S-19「パスワードリセット確認ダイアログ（インライン）」: <details>/<summary> のネイティブ
            開閉(GlobalHeader の user-menu と同じ idiom)で JS 無しでも機能する。フォームは兄弟要素
            (HTML はフォームの入れ子を許さないため、上の user-edit-form とは独立させる)。 */}
        <details data-testid="user-password-reset-disclosure" open={!!props.resetError}>
          <summary data-testid="user-password-reset-button">パスワードリセット</summary>
          <form method="post" action={`/admin/users/${target.id}/reset-password`} novalidate data-validate data-testid="user-reset-password-form">
            <input type="hidden" name="_csrf" value={props.csrf} />
            <div class="field">
              <label for="user-reset-password-input">新しいパスワード</label>
              <input
                id="user-reset-password-input" name="new_password" type="password" required
                minlength={LIMITS.passwordMin} maxlength={LIMITS.passwordMax} autocomplete="new-password"
                data-testid="user-reset-password-input" data-err-required={MSG.passwordRequired} data-err-tooshort={MSG.passwordTooShort}
                aria-describedby="user-reset-password-error"
              />
              <p id="user-reset-password-error" data-testid="user-reset-password-error" class="field-error" aria-live="polite">
                {props.resetError ?? ''}
              </p>
            </div>
            <div class="dialog-actions">
              <a href={`/admin/users/${target.id}/edit`} class="btn btn-secondary" data-testid="user-reset-password-cancel">キャンセル</a>
              <button type="submit" class="btn btn-primary" data-testid="user-reset-password-submit">実行</button>
            </div>
          </form>
        </details>

        {/* S-19「ユーザー無効化ボタン」[※未実装]: カタログ上の要素として存在させるが、機能は無い
            (disabled のまま。裏付けるルートも無い)。GC-8 の趣旨(testid 付与)を満たしつつ、
            未実装であることを disabled 属性で正直に示す。 */}
        <button type="button" disabled data-testid="user-disable-button" title="未実装">ユーザー無効化</button>
      </div>
      <script dangerouslySetInnerHTML={{ __html: USER_DIALOG_CLOSE_SCRIPT }}></script>
      <script dangerouslySetInnerHTML={{ __html: USER_ROLE_WARN_SCRIPT }}></script>
    </div>
  );
}

// --- S-18 一覧テーブル ---

function UserTable(props: { users: UserRow[]; currentUserId: string }) {
  return (
    <table data-testid="user-table">
      <thead>
        <tr>
          <th>表示名</th>
          <th>メール</th>
          <th>ロール</th>
          <th>最終ログイン</th>
        </tr>
      </thead>
      <tbody>
        {props.users.map((u) => {
          const isCurrent = u.id === props.currentUserId;
          const role = u.role as Role;
          return (
            <tr data-testid={`user-row-${u.id}`} class={isCurrent ? 'user-row-current' : undefined}>
              <td>
                <a
                  href={`/admin/users/${u.id}/edit`} hx-get={`/admin/users/${u.id}/edit`} hx-target="#dialog-root" hx-swap="innerHTML"
                  data-testid={`user-display-name-${u.id}`}
                >
                  {u.displayName}
                </a>
                {/* S-18「自分自身の行」: 現在ログイン中のユーザーの行にのみ出現する単一のインジケータ
                    (行は複数あるが「自分」は常に1件のため testid に {id} サフィックスは付けない)。 */}
                {isCurrent && <span class="user-row-current-label" data-testid="user-row-current">あなた</span>}
              </td>
              <td data-testid={`user-email-${u.id}`}>{u.email}</td>
              <td data-testid={`user-role-${u.id}`}>
                <span class={`badge badge-role-${role}`}>{ROLE_LABEL[role]}</span>
              </td>
              <td data-testid={`user-last-login-${u.id}`}>{u.lastLoginAt !== null ? formatDateTime(u.lastLoginAt) : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- S-18 ページ全体 ---

type UsersDialog =
  | { kind: 'create'; values?: { email?: string; displayName?: string; role?: Role }; errors?: CreateFieldErrors }
  | ({ kind: 'edit' } & UserEditDialogProps);

interface UsersPageProps {
  user: UserRow;
  csrf: string;
  flash?: Flash | null;
  users: UserRow[];
  dialog?: UsersDialog | null;
}

function UsersPage(props: UsersPageProps) {
  const addAttrs = {
    href: '/admin/users/new', 'hx-get': '/admin/users/new', 'hx-target': '#dialog-root', 'hx-swap': 'innerHTML',
  } as const;
  return (
    <Layout title="ユーザー管理" user={props.user} csrf={props.csrf} flash={props.flash ?? null}>
      <div class="page-header">
        <h1 data-testid="user-list-title">ユーザー管理</h1>
        <a {...addAttrs} class="btn btn-primary" data-testid="user-add-button">+ 追加</a>
      </div>

      {props.users.length === 0 ? (
        // S-18「空状態メッセージ」: 通常到達しない(admin が必ず1名以上存在)。文言はドキュメント未記載の
        // ため本実装で採番する(タスク報告に明記)。
        <div class="empty-state" data-testid="user-list-empty"><p>ユーザーがいません</p></div>
      ) : (
        <UserTable users={props.users} currentUserId={props.user.id} />
      )}

      {props.dialog?.kind === 'create' && <UserCreateDialog csrf={props.csrf} values={props.dialog.values} errors={props.dialog.errors} />}
      {props.dialog?.kind === 'edit' && (
        <UserEditDialog
          csrf={props.dialog.csrf} target={props.dialog.target} isSelf={props.dialog.isSelf}
          values={props.dialog.values} errors={props.dialog.errors} resetError={props.dialog.resetError}
        />
      )}
    </Layout>
  );
}

function renderUserNotFound(c: Context<AppEnv>, user: UserRow, csrf: string) {
  return c.html(
    <Layout title="ユーザーが見つかりません" user={user} csrf={csrf}>
      <div class="empty-state"><h1 data-testid="page-404-title">ユーザーが見つかりません</h1></div>
    </Layout>,
    404,
  );
}

/** `?flash=` の動的トースト(display_name/role を埋め込む)。testcase-list.tsx の
 * buildBulkFlashFromQuery と同じ idiom(flash.ts の静的テーブルには乗らない)。 */
function resolveUserFlash(c: Context<AppEnv>): Flash | null {
  const key = c.req.query('flash');
  if (key === 'user_created') {
    return { kind: 'success', text: `ユーザー「${c.req.query('name') ?? ''}」を追加しました` };
  }
  if (key === 'user_role_changed') {
    return { kind: 'success', text: `${c.req.query('name') ?? ''} のロールを ${c.req.query('role') ?? ''} に変更しました` };
  }
  if (key === 'user_password_reset') {
    return { kind: 'success', text: `${c.req.query('name') ?? ''} のパスワードをリセットしました` };
  }
  return resolveFlash(key);
}

// --- 共通コンテキスト解決 ---

function getActorUser(c: Context<AppEnv>): UserRow {
  const actor = c.get('actor');
  // requirePageAuth は必ず {kind:'user'} の actor を set する。型の絞り込みのための防御的分岐
  // (testcase-list.tsx 等の既存 UI ルートと同じ idiom)。
  if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
  return actor.user;
}

const adminOnly = requirePageAuth({ minRole: 'admin' });

export const userPageRoutes = new Hono<AppEnv>()
  // S-18: admin のみ。
  .get('/admin/users', adminOnly, async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    const user = getActorUser(c);
    const csrf = await ensureCsrfCookie(c);

    const users = await deps.storage.listUsers(orgScopeOf(actor));
    const flash = resolveUserFlash(c);
    return c.html(<UsersPage user={user} csrf={csrf} users={users} flash={flash} />);
  })

  // S-19 作成ダイアログを開く: admin のみ。
  .get('/admin/users/new', adminOnly, async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    const user = getActorUser(c);
    const csrf = await ensureCsrfCookie(c);

    if (c.req.header('HX-Request')) return c.html(<UserCreateDialog csrf={csrf} />);
    const users = await deps.storage.listUsers(orgScopeOf(actor));
    return c.html(<UsersPage user={user} csrf={csrf} users={users} dialog={{ kind: 'create' }} />);
  })

  // S-19 作成実行: admin + CSRF。
  .post('/admin/users/new', adminOnly, csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    const user = getActorUser(c);
    const csrf = await ensureCsrfCookie(c);
    const scope = orgScopeOf(actor);

    const body = await c.req.parseBody();
    const email = String(body.email ?? '').trim();
    const displayName = String(body.display_name ?? '').trim();
    const roleRaw = String(body.role ?? '').trim();
    const role: Role = (ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as Role) : 'editor';
    const password = String(body.password ?? '');

    const rerender = async (errors: CreateFieldErrors) => {
      if (c.req.header('HX-Request')) return c.html(<UserCreateDialog csrf={csrf} values={{ email, displayName, role }} errors={errors} />, 200);
      const users = await deps.storage.listUsers(scope);
      return c.html(
        <UsersPage user={user} csrf={csrf} users={users} dialog={{ kind: 'create', values: { email, displayName, role }, errors }} />,
        200,
      );
    };

    const fieldErrors = validateCreateForm({ email, displayName, password });
    if (Object.keys(fieldErrors).length > 0) return rerender(fieldErrors);

    const passwordHash = await deps.auth.hashPassword(password);
    const result = await deps.storage.createUser(scope, { email, passwordHash, displayName, role, now: deps.now() });
    if (result === 'email_taken') return rerender({ email: MSG.emailTaken });

    const qs = new URLSearchParams({ flash: 'user_created', name: result.displayName });
    return c.redirect(`/admin/users?${qs.toString()}`, 303);
  })

  // S-19 編集ダイアログを開く: admin のみ。
  .get('/admin/users/:id/edit', adminOnly, async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    const user = getActorUser(c);
    const csrf = await ensureCsrfCookie(c);
    const id = requiredParam(c, 'id');

    const target = await deps.storage.getUser(orgScopeOf(actor), id);
    if (!target) return renderUserNotFound(c, user, csrf);

    const isSelf = target.id === user.id;
    const values = { displayName: target.displayName, role: target.role };

    if (c.req.header('HX-Request')) return c.html(<UserEditDialog csrf={csrf} target={target} isSelf={isSelf} values={values} />);
    const users = await deps.storage.listUsers(orgScopeOf(actor));
    const flash = resolveUserFlash(c);
    return c.html(
      <UsersPage user={user} csrf={csrf} users={users} flash={flash} dialog={{ kind: 'edit', csrf, target, isSelf, values }} />,
    );
  })

  // S-19 保存: admin + CSRF。role が実変更の場合のみ setUserRoleGuarded(D-13-7 の atomic ガード)を
  // 経由し、対象の全セッションを無効化する(src/http/api/users.ts の PATCH と同じロジック)。
  .post('/admin/users/:id/edit', adminOnly, csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    const user = getActorUser(c);
    const csrf = await ensureCsrfCookie(c);
    const scope = orgScopeOf(actor);
    const id = requiredParam(c, 'id');

    const current = await deps.storage.getUser(scope, id);
    if (!current) return renderUserNotFound(c, user, csrf);

    const body = await c.req.parseBody();
    const displayName = String(body.display_name ?? '').trim();
    // 自分自身の行では role select が disabled のため、通常のブラウザ送信では role フィールドが
    // 存在しない(未知/空の値は「変更なし」として扱うだけで、role change 自体を特別扱いで拒否しては
    // いない。D-13-7 の atomic ガードが最終防御であり、改ざんされた POST(自分自身への役割変更)も
    // 同じガードを通る。task-21-brief.md 「最後の admin は API 側 422 をトースト表示」参照)。
    const roleRaw = String(body.role ?? '').trim();
    const requestedRole: Role = (ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as Role) : (current.role as Role);

    const isSelf = current.id === user.id;
    const rerenderError = async (displayNameError: string) => {
      const values = { displayName, role: requestedRole };
      const errors = { displayName: displayNameError };
      if (c.req.header('HX-Request')) return c.html(<UserEditDialog csrf={csrf} target={current} isSelf={isSelf} values={values} errors={errors} />, 200);
      const users = await deps.storage.listUsers(scope);
      return c.html(
        <UsersPage user={user} csrf={csrf} users={users} dialog={{ kind: 'edit', csrf, target: current, isSelf, values, errors }} />,
        200,
      );
    };

    const displayNameError = validateDisplayName(displayName);
    if (displayNameError) return rerenderError(displayNameError);

    const roleChanging = requestedRole !== current.role;

    if (roleChanging) {
      // D-13-7: 単一の条件付き UPDATE で「最後の admin」降格を atomic に拒否する
      // (countAdmins による事前チェックは TOCTOU レースを生むため使わない。src/http/api/users.ts と同じ)。
      const guardResult = await deps.storage.setUserRoleGuarded(scope, id, requestedRole, deps.now());
      if (guardResult === 'not_found') return renderUserNotFound(c, user, csrf);
      if (guardResult === 'blocked_last_admin') {
        return c.redirect(`/admin/users/${id}/edit?flash=user_last_admin_blocked`, 303);
      }
      const after = displayName !== current.displayName
        ? await deps.storage.updateUser(scope, id, { displayName }, deps.now())
        : await deps.storage.getUser(scope, id);
      if (!after) return renderUserNotFound(c, user, csrf);

      // ロール変更時のみ対象ユーザーの全セッションを無効化する(exceptなし。apis/users.md 副作用)。
      await deps.storage.deleteUserSessions(id);

      const qs = new URLSearchParams({ flash: 'user_role_changed', name: after.displayName, role: ROLE_LABEL[requestedRole] });
      return c.redirect(`/admin/users?${qs.toString()}`, 303);
    }

    if (displayName !== current.displayName) {
      const after = await deps.storage.updateUser(scope, id, { displayName }, deps.now());
      if (!after) return renderUserNotFound(c, user, csrf);
    }
    // 変更が無い場合も含め、S-19「画面遷移」どおり S-18 へ戻る(testcase-detail.tsx の
    // 「変更0件でも成功として扱う」と同じ判断)。
    return c.redirect('/admin/users?flash=user_updated', 303);
  })

  // S-19 パスワードリセット実行: admin + CSRF。対象の全セッションを無効化する(exceptなし。
  // 自セッション除外は PATCH /auth/password = 自分自身のパスワード変更のみの規約であり、
  // reset-password は「管理者が他者に対して行う操作」が前提のため除外しない。src/http/api/users.ts と同じ)。
  .post('/admin/users/:id/reset-password', adminOnly, csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    const user = getActorUser(c);
    const csrf = await ensureCsrfCookie(c);
    const scope = orgScopeOf(actor);
    const id = requiredParam(c, 'id');

    const target = await deps.storage.getUser(scope, id);
    if (!target) return renderUserNotFound(c, user, csrf);

    const body = await c.req.parseBody();
    const newPassword = String(body.new_password ?? '');
    const error = validatePassword(newPassword);
    if (error) {
      const isSelf = target.id === user.id;
      const values = { displayName: target.displayName, role: target.role };
      if (c.req.header('HX-Request')) {
        return c.html(<UserEditDialog csrf={csrf} target={target} isSelf={isSelf} values={values} resetError={error} />, 200);
      }
      const users = await deps.storage.listUsers(scope);
      return c.html(
        <UsersPage user={user} csrf={csrf} users={users} dialog={{ kind: 'edit', csrf, target, isSelf, values, resetError: error }} />,
        200,
      );
    }

    await deps.storage.setUserPassword(scope, id, await deps.auth.hashPassword(newPassword), deps.now());
    await deps.storage.deleteUserSessions(id); // 対象の全セッションを無効化する(exceptなし)

    const qs = new URLSearchParams({ flash: 'user_password_reset', name: target.displayName });
    return c.redirect(`/admin/users/${id}/edit?${qs.toString()}`, 303);
  });
