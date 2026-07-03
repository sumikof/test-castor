// src/http/ui/auth-pages.tsx
// S-01 初期セットアップ(docs/screens/auth/S-01-setup.md)・S-02 ログイン(docs/screens/auth/S-02-login.md)
// + ルートの振り分け(GET /、D-13-1/8)。task-17-brief.md「UI 基盤 + 認証画面」。
//
// ビジネスロジックは src/domain/services/auth-service.ts の loginUser/setupOrg を呼ぶ(API ルートと
// 共有。承認済みアプローチ A = 内部 HTTP 往復はしない)。フォームは通常 PRG(303 + ?flash=)、HTMX は
// 使わない(UI タスク共通事項「除外」: 認証画面は plain PRG で十分)。
//
// 全フォームは <input type="hidden" name="_csrf"> を含む(D-09)。setup/login はどちらも session actor が
// 存在しない(ログイン成立前)ため csrfProtect() は no-op(実質検証されない)。ensureCsrfCookie が
// Cookie 未発行時のみ新規発行するのは、後続タスクの規約(全フォームページ共通)に合わせるため。
import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { SESSION_COOKIE, CSRF_COOKIE, COOKIE_ATTRS, csrfProtect } from '../middleware/csrf';
import { ensureCsrfCookie, requirePageAuth, getPageSession } from '../middleware/page-auth';
import { resolveFlash, type Flash } from './flash';
import { Layout } from './layout';
import { loginUser, setupOrg } from '../../domain/services/auth-service';
import { nameSchema, emailSchema, passwordSchema, LIMITS } from '../../schemas/limits';

// --- 文言(S-01/S-02 の「フィールドバリデーション（クライアント側）」「API エラー」表と一致させる) ---
const MSG = {
  orgNameRequired: '組織名を入力してください',
  // S-01 の「最大長TBD」項目に対する超過フォールバック文言(ドキュメント未記載。D-07 の LIMITS.name=100 を
  // 適用した際の追加メッセージ。タスク報告に明記)。
  orgNameTooLong: '組織名は100文字以内で入力してください',
  emailRequired: 'メールアドレスを入力してください',
  emailInvalid: '有効なメールアドレスを入力してください',
  passwordRequired: 'パスワードを入力してください',
  passwordTooShort: 'パスワードは8文字以上で入力してください',
  // S-01 の「パスワード確認」行は不一致時の文言のみ明記。空文字時の文言はドキュメント未記載のため
  // 本実装で採番(タスク報告に明記)。
  passwordConfirmRequired: '確認用パスワードを入力してください',
  passwordMismatch: 'パスワードが一致しません',
  displayNameRequired: '表示名を入力してください',
  displayNameTooLong: '表示名は100文字以内で入力してください',
  invalidCredentials: 'メールアドレスまたはパスワードが正しくありません',
  rateLimited: 'ログイン試行回数の上限に達しました。しばらくしてから再度お試しください',
} as const;

// --- S-01 セットアップフォーム ---

interface SetupFormInput {
  organization_name: string;
  admin_email: string;
  admin_password: string;
  admin_password_confirm: string;
  admin_display_name: string;
}
type SetupFormErrors = Partial<Record<keyof SetupFormInput, string>>;

/**
 * D-07 の共有 Zod スキーマ(nameSchema/emailSchema/passwordSchema)で実際の可否を判定しつつ、
 * S-01「フィールドバリデーション（クライアント側）」表の文言をそのまま返す(UI・API 同一検証。D-07)。
 * まず空文字判定を行ってから schema.safeParse するのは、「空文字」と「フォーマット不正」で
 * ドキュメントが異なる文言を要求するため(例: メールは空文字と不正形式で文言が異なる)。
 */
function validateSetupForm(input: SetupFormInput): SetupFormErrors {
  const errors: SetupFormErrors = {};

  if (!input.organization_name) errors.organization_name = MSG.orgNameRequired;
  else if (!nameSchema.safeParse(input.organization_name).success) errors.organization_name = MSG.orgNameTooLong;

  if (!input.admin_email) errors.admin_email = MSG.emailRequired;
  else if (!emailSchema.safeParse(input.admin_email).success) errors.admin_email = MSG.emailInvalid;

  if (!input.admin_password) errors.admin_password = MSG.passwordRequired;
  else if (!passwordSchema.safeParse(input.admin_password).success) errors.admin_password = MSG.passwordTooShort;

  if (!input.admin_password_confirm) errors.admin_password_confirm = MSG.passwordConfirmRequired;
  else if (input.admin_password_confirm !== input.admin_password) errors.admin_password_confirm = MSG.passwordMismatch;

  if (!input.admin_display_name) errors.admin_display_name = MSG.displayNameRequired;
  else if (!nameSchema.safeParse(input.admin_display_name).success) errors.admin_display_name = MSG.displayNameTooLong;

  return errors;
}

/** setup/login 共通のテキスト系フィールド1件分(ラベル・input・エラー表示スロットの3点セット)。 */
function TextField(props: {
  testid: string;
  label: string;
  type: 'text' | 'email' | 'password';
  name: string;
  value?: string;
  required?: boolean;
  minlength?: number;
  maxlength?: number;
  autocomplete?: string;
  placeholder?: string;
  error?: string;
  errRequired?: string;
  errType?: string;
  errTooshort?: string;
  matchId?: string;
  errMatch?: string;
}) {
  const errId = `${props.testid}-error`;
  return (
    <div class="field">
      <label for={props.testid}>{props.label}</label>
      <input
        id={props.testid}
        name={props.name}
        type={props.type}
        value={props.value ?? ''}
        required={props.required}
        minlength={props.minlength}
        maxlength={props.maxlength}
        autocomplete={props.autocomplete}
        placeholder={props.placeholder}
        data-testid={props.testid}
        data-err-required={props.errRequired}
        data-err-type={props.errType}
        data-err-tooshort={props.errTooshort}
        data-match={props.matchId}
        data-err-match={props.errMatch}
        aria-describedby={errId}
      />
      <p id={errId} data-testid={errId} class="field-error" aria-live="polite">{props.error ?? ''}</p>
    </div>
  );
}

interface SetupPageProps {
  csrf: string;
  values?: Partial<Pick<SetupFormInput, 'organization_name' | 'admin_email' | 'admin_display_name'>>;
  errors?: SetupFormErrors;
}

function SetupPage(props: SetupPageProps) {
  const v = props.values ?? {};
  const e = props.errors ?? {};
  return (
    <Layout title="セットアップ" user={null} csrf={props.csrf}>
      <div class="auth-card">
        <h1 data-testid="setup-title">TMS セットアップ</h1>
        <form method="post" action="/setup" novalidate data-validate data-testid="setup-form">
          <input type="hidden" name="_csrf" value={props.csrf} />

          <TextField
            testid="setup-org-name" label="組織名" type="text" name="organization_name"
            value={v.organization_name} required maxlength={LIMITS.name} placeholder="例「株式会社Example」"
            error={e.organization_name} errRequired={MSG.orgNameRequired}
          />
          <TextField
            testid="setup-admin-email" label="管理者メール" type="email" name="admin_email"
            value={v.admin_email} required maxlength={LIMITS.email}
            error={e.admin_email} errRequired={MSG.emailRequired} errType={MSG.emailInvalid}
          />
          <TextField
            testid="setup-admin-password" label="パスワード" type="password" name="admin_password"
            required minlength={LIMITS.passwordMin} maxlength={LIMITS.passwordMax} autocomplete="new-password"
            error={e.admin_password} errRequired={MSG.passwordRequired} errTooshort={MSG.passwordTooShort}
          />
          <TextField
            testid="setup-admin-password-confirm" label="パスワード確認" type="password" name="admin_password_confirm"
            required minlength={LIMITS.passwordMin} maxlength={LIMITS.passwordMax} autocomplete="new-password"
            matchId="setup-admin-password" errMatch={MSG.passwordMismatch}
            error={e.admin_password_confirm} errRequired={MSG.passwordConfirmRequired}
          />
          <TextField
            testid="setup-admin-display-name" label="表示名" type="text" name="admin_display_name"
            value={v.admin_display_name} required maxlength={LIMITS.name}
            error={e.admin_display_name} errRequired={MSG.displayNameRequired}
          />

          <button type="submit" class="btn btn-primary" data-testid="setup-submit" disabled>セットアップ開始</button>
        </form>
      </div>
    </Layout>
  );
}

// --- S-02 ログインフォーム ---

interface LoginPageProps {
  csrf: string;
  flash?: Flash | null;
  error?: string;
  email?: string;
}

function LoginPage(props: LoginPageProps) {
  return (
    <Layout title="ログイン" user={null} csrf={props.csrf} flash={props.flash ?? null}>
      <div class="auth-card">
        {/* docs/screens/auth/S-02-login.md「ロゴ image data-testid=login-logo」。実ロゴ画像が無いため
            public/logo.svg の簡易ワードマークを使う。 */}
        <div class="login-logo" data-testid="login-logo">
          <img src="/logo.svg" alt="TMS" width="120" height="32" />
        </div>
        <h1 data-testid="login-title">TMS ログイン</h1>

        {props.error && (
          <div class="alert alert-error" role="alert" data-testid="login-error">{props.error}</div>
        )}

        <form method="post" action="/login" novalidate data-validate data-testid="login-form">
          <input type="hidden" name="_csrf" value={props.csrf} />

          <TextField
            testid="login-email" label="メールアドレス" type="email" name="email"
            value={props.email} required autocomplete="email"
            errRequired={MSG.emailRequired} errType={MSG.emailInvalid}
          />
          <TextField
            testid="login-password" label="パスワード" type="password" name="password"
            required autocomplete="current-password"
            errRequired={MSG.passwordRequired}
          />

          {/* D-13-2: 「パスワードを忘れた場合」リンクは非表示。ヒント文言のみ(未実装の S-03 へのリンクにしない)。 */}
          <p class="hint" data-testid="login-forgot-password">パスワードを忘れた場合は管理者にお問い合わせください</p>

          <button type="submit" class="btn btn-primary" data-testid="login-submit" disabled>ログイン</button>
        </form>
      </div>
    </Layout>
  );
}

// --- ルート ---

export const authPageRoutes = new Hono<AppEnv>()
  // D-13-1/8: org 0件 → /setup、未ログイン → /login、ログイン済み → /projects(S-06。S-05 は MVP後)。
  .get('/', async (c) => {
    const deps = c.get('deps');
    const orgCount = await deps.storage.countOrganizations();
    if (orgCount === 0) return c.redirect('/setup', 302);
    const session = await getPageSession(c);
    if (!session) return c.redirect('/login', 302);
    return c.redirect('/projects', 302);
  })

  // S-01 表示条件: Organization が存在する場合は /login にリダイレクト。
  .get('/setup', async (c) => {
    const deps = c.get('deps');
    const orgCount = await deps.storage.countOrganizations();
    if (orgCount > 0) return c.redirect('/login', 302);
    const csrf = await ensureCsrfCookie(c);
    return c.html(<SetupPage csrf={csrf} />);
  })

  // csrfProtect() は「actor が user のときのみ検証」なので、session actor が絶対に存在しない
  // pre-auth ルート(setup/login)では恒久的に no-op(tests/unit/middleware-csrf.test.ts の
  // 「requireAuth を経由していないルートで csrfProtect を呼んでも例外にならず next() する」で確認済み)。
  // それでも明示的に挟むのは、「このルートは CSRF を検討済み・意図的に対象外」であることをコード上に
  // 残すため(将来の変更でうっかり実挙動が変わっても安全側に倒れる防御的な一貫性)。
  .post('/setup', csrfProtect(), async (c) => {
    const deps = c.get('deps');
    // 競合窓の既知の許容(api/setup.ts と同じ判断。countOrganizations() と setupOrg() の間に別リクエストが
    // 割り込む余地はあるが、初回デプロイ直後の単発操作という運用前提のため追加の排他機構は設けない)。
    const orgCount = await deps.storage.countOrganizations();
    if (orgCount > 0) {
      // S-01「状態バリエーション」エラー(409 SETUP_ALREADY_COMPLETE 相当): エラーメッセージ表示 + /login へ。
      return c.redirect('/login?flash=setup_already_complete', 303);
    }

    const body = await c.req.parseBody();
    const input: SetupFormInput = {
      organization_name: String(body.organization_name ?? '').trim(),
      admin_email: String(body.admin_email ?? '').trim(),
      admin_password: String(body.admin_password ?? ''),
      admin_password_confirm: String(body.admin_password_confirm ?? ''),
      admin_display_name: String(body.admin_display_name ?? '').trim(),
    };

    const errors = validateSetupForm(input);
    if (Object.keys(errors).length > 0) {
      const csrf = await ensureCsrfCookie(c);
      // パスワード系フィールドは再表示しない(セキュリティ上の慣行。値保持はしない)。
      return c.html(
        <SetupPage
          csrf={csrf}
          values={{
            organization_name: input.organization_name,
            admin_email: input.admin_email,
            admin_display_name: input.admin_display_name,
          }}
          errors={errors}
        />,
        200,
      );
    }

    await setupOrg(deps, {
      orgName: input.organization_name,
      adminEmail: input.admin_email,
      adminPassword: input.admin_password,
      adminDisplayName: input.admin_display_name,
    });
    // S-01「トースト / 通知」成功 → S-02 へ引き継ぎ(D-13-5: ?flash= クエリ方式)。
    return c.redirect('/login?flash=setup_complete', 303);
  })

  // S-02 表示条件: org 0件 → /setup、認証済み → /projects。
  .get('/login', async (c) => {
    const deps = c.get('deps');
    const orgCount = await deps.storage.countOrganizations();
    if (orgCount === 0) return c.redirect('/setup', 302);
    const session = await getPageSession(c);
    if (session) return c.redirect('/projects', 302);

    const csrf = await ensureCsrfCookie(c);
    const flash = resolveFlash(c.req.query('flash'));
    return c.html(<LoginPage csrf={csrf} flash={flash} />);
  })

  .post('/login', csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const body = await c.req.parseBody();
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const ip = c.req.header('cf-connecting-ip') ?? 'local';

    const result = await loginUser(deps, { email, password, ip });
    if (!result.ok) {
      // S-02: 未知email/誤パスワードは統一メッセージ(存在有無を漏らさない)。429 もこのタスク指示に
      // 従い 200 で再描画する(S-02 の「状態バリエーション」表はどちらも同じ login-error 表示先)。
      const message = result.reason === 'rate_limited' ? MSG.rateLimited : MSG.invalidCredentials;
      const csrf = await ensureCsrfCookie(c);
      return c.html(<LoginPage csrf={csrf} error={message} email={email} />, 200);
    }

    // セッション固定攻撃対策済みの新規セッション(auth-service.loginUser 内で発行済み)を Cookie 化する。
    setCookie(c, SESSION_COOKIE, await deps.auth.signSessionId(result.sessionId), COOKIE_ATTRS);
    setCookie(c, CSRF_COOKIE, deps.auth.newCsrfToken(), COOKIE_ATTRS);
    // D-13-1: ログイン後の遷移先は S-06 プロジェクト一覧(S-05 ダッシュボードは MVP後)。
    return c.redirect('/projects', 303);
  })

  .post('/logout', requirePageAuth(), csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    await deps.storage.deleteSession(actor.sessionId);
    deleteCookie(c, SESSION_COOKIE, COOKIE_ATTRS);
    deleteCookie(c, CSRF_COOKIE, COOKIE_ATTRS);
    return c.redirect('/login', 303);
  });
