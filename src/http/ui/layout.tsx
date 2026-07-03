// src/http/ui/layout.tsx
// 共通レイアウト(docs/screens.md「共通レイアウト」): グローバルヘッダー・プロジェクトコンテキスト
// ヘッダー・パンくず・トースト。task-17-brief.md Step 2 の骨子をそのまま実装する。
//
// フォーム強化スクリプト(FORM_ENHANCE_SCRIPT): S-01/S-02 の「状態バリエーション」表(初期状態=
// 送信ボタン disabled・入力中=フォーカスアウトでバリデーションエラー表示・送信中=loading 状態)を
// プログレッシブエンハンスメントとして満たす、依存ライブラリ無しの最小 JS。サーバー側の
// 権威検証(auth-pages.tsx の validateSetupForm 等)と表示文言を一致させるため、メッセージ文字列は
// input 要素の data-err-required/data-err-type/data-err-tooshort/data-err-match 属性として
// サーバーが埋め込み、本スクリプトはそれを読むだけ(文言のハードコードをこちらに二重管理しない)。
//
// レビュー指摘の修正(no-JS 送信不能バグ): SSR HTML の送信ボタンは disabled をハードコードしない
// (auth-pages.tsx 側。JS が無い/失敗した利用者でもサーバー側検証を頼りに送信できる必要がある)。
// 「初期状態=disabled」という UX 自体は JS 利用者向けには維持する必要があるため、その適用は
// このスクリプト(attach 関数)が読み込み時に行う。つまり disabled 状態は完全に JS 側の追加仕様
// (purely additive)になり、JS が無ければ最初からボタンは有効なまま。
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import type { UserRow, ProjectRow } from '../../storage/schema';
import type { Flash } from './flash';

const FORM_ENHANCE_SCRIPT = `
(function () {
  function fieldMessage(input) {
    var v = input.validity;
    if (v.valueMissing) return input.dataset.errRequired || '';
    if (v.typeMismatch) return input.dataset.errType || '';
    if (v.tooShort) return input.dataset.errTooshort || '';
    var matchId = input.dataset.match;
    if (matchId) {
      var other = document.getElementById(matchId);
      if (other && input.value && other.value !== input.value) return input.dataset.errMatch || '';
    }
    return '';
  }
  function errorEl(input) {
    var id = input.getAttribute('aria-describedby');
    return id ? document.getElementById(id) : null;
  }
  function paint(input) {
    var el = errorEl(input);
    if (!el) return true;
    var msg = input.dataset.touched === '1' ? fieldMessage(input) : '';
    el.textContent = msg;
    return !msg;
  }
  function attach(form) {
    // 冪等ガード(T19/T20 申し送り): htmx:afterSwap の再スキャンで同じ form に2度目の attach が
    // 走っても、リスナーを二重登録しない(2重 disabled トグル・2重 submit ハンドラを防ぐ)。
    if (form.dataset.enhanced === '1') return;
    form.dataset.enhanced = '1';
    var submit = form.querySelector('button[type=submit]');
    var inputs = Array.prototype.slice.call(form.querySelectorAll('input'));
    // SSR HTML はこの button に disabled を含めない(no-JS 送信可能にするため)。JS が実行できた
    // クライアントに限り、ここで明示的に初期 disabled を適用する。直後の refresh() が現在値に基づき
    // 即座に再計算するため、実質的な見た目は「initial disabled → toggle on validity」のまま変わらない。
    if (submit) submit.disabled = true;
    function refresh() {
      var ok = form.checkValidity();
      for (var i = 0; i < inputs.length; i++) {
        var matchId = inputs[i].dataset.match;
        if (matchId) {
          var other = document.getElementById(matchId);
          if (other && inputs[i].value && other.value !== inputs[i].value) ok = false;
        }
      }
      if (submit) submit.disabled = !ok;
    }
    inputs.forEach(function (input) {
      input.addEventListener('blur', function () {
        input.dataset.touched = '1';
        paint(input);
      });
      input.addEventListener('input', function () {
        if (input.dataset.touched === '1') paint(input);
        refresh();
      });
    });
    form.addEventListener('submit', function (evt) {
      var ok = true;
      inputs.forEach(function (input) {
        input.dataset.touched = '1';
        if (!paint(input)) ok = false;
      });
      if (!ok) {
        evt.preventDefault();
        refresh();
        return;
      }
      if (submit) {
        submit.disabled = true;
        submit.classList.add('is-loading');
      }
    });
    refresh();
  }
  function enhanceAll(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    Array.prototype.forEach.call(root.querySelectorAll('form[data-validate]'), attach);
    // root 自身が対象になりうるケース(hx-swap="outerHTML" でフォーム自身が置換された場合等)。
    if (root.matches && root.matches('form[data-validate]')) attach(root);
  }
  enhanceAll(document);
  // T19/T20 申し送り(notes.md): FORM_ENHANCE_SCRIPT は読み込み時に一度だけ querySelectorAll するため、
  // HTMX が #dialog-root や #testcase-list-section 等にスワップしたフラグメント内の新規フォームには
  // 再作用しない(no-JS では元々サーバー検証が権威のため機能欠陥ではないが、spinner/disabled UX の
  // 一貫性のため再エンハンスする)。htmx:afterSwap は swap された要素(detail.target 相当)をバブリングで
  // 拾えるので、document に1回だけ委譲リスナーを張り、スワップされた部分木だけを再スキャンする。
  // 既存フォーム(旧 DOM に残るもの)は dataset.enhanced ガードにより再アタッチされない。
  document.body.addEventListener('htmx:afterSwap', function (evt) {
    enhanceAll(evt.target || document);
  });
})();
`;

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface LayoutProps {
  title: string;
  user?: UserRow | null;
  csrf?: string;
  project?: ProjectRow | null;
  breadcrumb?: Array<BreadcrumbItem>;
  flash?: Flash | null;
  children: unknown;
}

function GlobalHeader(props: { user: UserRow; csrf?: string }) {
  const { user } = props;
  const isAdmin = user.role === 'admin';
  return (
    <header class="global-header" data-testid="global-header">
      <div class="global-header-left">
        <a href="/projects" class="global-header-logo" data-testid="global-header-logo">TMS</a>
        {/* MVP除外: ダッシュボード(S-05)は MVP 後のためナビに出さない(D-13-1)。 */}
        <nav class="global-nav" data-testid="global-nav">
          <a href="/projects" data-testid="nav-projects">プロジェクト</a>
          {isAdmin && (
            <a href="/admin/users" data-testid="nav-admin-users">ユーザー管理</a>
          )}
        </nav>
      </div>
      <div class="global-header-right">
        <details class="user-menu" data-testid="user-menu">
          <summary data-testid="user-menu-toggle">{user.displayName}</summary>
          <div class="user-menu-list">
            <a href="/profile" data-testid="user-menu-profile">プロフィール</a>
            <form method="post" action="/logout" data-testid="logout-form">
              <input type="hidden" name="_csrf" value={props.csrf ?? ''} />
              <button type="submit" class="link-button" data-testid="user-menu-logout">ログアウト</button>
            </form>
          </div>
        </details>
      </div>
    </header>
  );
}

function ProjectContextHeader(props: { project: ProjectRow; user: UserRow }) {
  const isAdmin = props.user.role === 'admin';
  const pid = props.project.id;
  return (
    <div class="project-context-header" data-testid="project-context-header">
      <a href="/projects" data-testid="project-context-back">← プロジェクト一覧</a>
      <span class="project-context-name" data-testid="project-context-name">{props.project.name}</span>
      <nav class="project-context-nav" data-testid="project-context-nav">
        <a href={`/projects/${pid}/testcases`} data-testid="nav-testcases">テストケース</a>
        {isAdmin && <a href={`/projects/${pid}/tokens`} data-testid="nav-tokens">API トークン</a>}
        {isAdmin && <a href={`/projects/${pid}/settings`} data-testid="nav-settings">設定</a>}
      </nav>
    </div>
  );
}

function Breadcrumb(props: { items: Array<BreadcrumbItem> }) {
  return (
    <nav class="breadcrumb" data-testid="breadcrumb" aria-label="breadcrumb">
      {props.items.map((item, i) => (
        <span class="breadcrumb-entry">
          {i > 0 && <span class="breadcrumb-sep">{'>'}</span>}
          {item.href ? (
            <a href={item.href} data-testid={`breadcrumb-item-${i}`}>{item.label}</a>
          ) : (
            <span data-testid={`breadcrumb-item-${i}`}>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** docs/screens.md「共通レイアウト」骨子(task-17-brief.md Step 2)。 */
export const Layout = (p: LayoutProps) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{p.title} - TMS</title>
      <link rel="stylesheet" href="/app.css" />
      <script src="/htmx.min.js" defer></script>
    </head>
    <body hx-headers={p.csrf ? JSON.stringify({ 'X-CSRF-Token': p.csrf }) : undefined}>
      {p.user && <GlobalHeader user={p.user} csrf={p.csrf} />}
      {p.project && p.user && <ProjectContextHeader project={p.project} user={p.user} />}
      {p.breadcrumb && <Breadcrumb items={p.breadcrumb} />}
      {p.flash && (
        <div class={`toast toast-${p.flash.kind}`} data-testid="toast" role="status">
          {p.flash.text}
        </div>
      )}
      <main>{p.children}</main>
      <div id="dialog-root"></div>
      <script dangerouslySetInnerHTML={{ __html: FORM_ENHANCE_SCRIPT }}></script>
    </body>
  </html>
);

/**
 * requirePageAuth({minRole}) が権限不足(403)時に描画するページ。docs/screens/ 配下に汎用エラー
 * ページの仕様は無い(各 S-xx は認可済み利用者の遷移のみを記述する)ため、data-testid は本実装で
 * 採番した(page-403-title/page-403-message。GC-8 の趣旨に沿い、内部的な一貫性のために付与)。
 *
 * csrf(レビュー指摘の修正): 呼び出し元(requirePageAuth)が ensureCsrfCookie(c) で取得した実トークンを
 * 渡す。渡さないと Layout → GlobalHeader のログアウトフォームが `_csrf=""` を埋め込み、403 画面から
 * ログアウトしようとすると csrfProtect() に弾かれて再度 403 になる(この画面は必ず認証済み user を
 * 伴うため、GlobalHeader は常に描画され、ログアウトフォームは常に存在する)。
 */
export function renderForbiddenPage(c: Context<AppEnv>, user: UserRow | null, csrf?: string) {
  return c.html(
    <Layout title="アクセス拒否" user={user} csrf={csrf}>
      <div class="auth-card">
        <h1 data-testid="page-403-title">アクセスできません</h1>
        <p data-testid="page-403-message">このページを表示する権限がありません。</p>
      </div>
    </Layout>,
    403,
  );
}
