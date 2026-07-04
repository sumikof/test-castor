// src/http/ui/tokens-pages.tsx
// S-16 API トークン一覧(docs/screens/project-settings/S-16-api-token-list.md)+
// S-17 トークン発行結果ダイアログ(docs/screens/project-settings/S-17-token-issue-result.md)。
// task-21-brief.md。スペック D-13-7 は本ファイルでは直接関係しない(ユーザー管理側の最後の admin 保護)。
//
// ビジネスロジックは既存の Storage/Auth 直呼び出し(task-18 以降の「承認済みアプローチ A」を踏襲。
// src/http/api/tokens.ts の POST/DELETE と同じ deps.auth.newApiToken/hashApiToken・
// storage.createApiToken/listApiTokens/revokeApiToken をそのまま呼ぶ。UI 専用の service 抽出はしない
// — トークン管理には API ルート超えるドメインルールが無いため)。
//
// S-17 の設計上の要点(通常の PRG と異なる): 平文トークンは発行レスポンスでしか手に入らない
// (auth-security.md「平文の隔離」)。他の全フォーム(project-create/bulk/status 等)は 303 リダイレクトで
// 完了する PRG パターンだが、それだと平文を表示する GET が別途必要になり「平文は発行時に1回だけ」という
// 要件と矛盾する。そのため POST /projects/:pid/tokens は成功時も 303 を返さず、そのレスポンスへ直接
// ステップ2(結果ダイアログ)を描画する(ブリーフ「レスポンスに直接描画」)。この設計により、この POST に
// 限っては hx-post で #dialog-root を差し替えても安全(project-create 等が hx-post を避けている理由
// ＝ 303 リダイレクト本文がそのままフラグメントに swap される事故は、本ルートには redirect が無いため
// 発生しない)。無 JS/HTMX 環境ではブラウザの通常ナビゲーションとしてこの POST 結果ページがそのまま
// 表示される(リロードすると同じ URL への再送信確認が出うるが、これは「リロードで平文が消える」という
// ドキュメント上の意図された挙動そのものであり、欠陥ではない)。
//
// GC-1 突合メモ(タスクブリーフの事前指示どおり。詳細はタスク報告に転記):
// - S-17「トークン名 ... 最大128文字」は誤り。LIMITS.name=100(src/schemas/limits.ts)が正。
// - S-17「トークン名重複 → 422」は誤り。api_tokens テーブルに name の一意制約は無く(src/storage/schema.ts)、
//   Task 11 の POST /api/v1/projects/:pid/tokens も重複チェックを行わない。本実装も重複検出はしない。
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { csrfProtect } from '../middleware/csrf';
import { ensureCsrfCookie, requirePageAuth } from '../middleware/page-auth';
import { orgScopeOf } from '../middleware/scope';
import { resolveFlash, type Flash } from './flash';
import { Layout } from './layout';
import { renderProjectNotFound, formatDateTime } from './testcase-list';
import { nameSchema, LIMITS } from '../../schemas/limits';
import type { ProjectRow, UserRow, ApiTokenRow } from '../../storage/schema';

// --- 文言(S-16/S-17 の各表と一致させる。GC-1) ---
const MSG = {
  // S-17「エラー状態」はトークン名が空の場合を「フォームバリデーション。発行ボタン disabled」としか
  // 書いておらず、具体的な文言は無い。既存の name 系フィールド(project-name 等)と同じ言い回しで
  // 本実装が採番する(タスク報告に明記)。
  nameRequired: 'トークン名を入力してください',
  nameTooLong: 'トークン名が長すぎます',
} as const;

function validateTokenName(name: string): string | undefined {
  if (!name) return MSG.nameRequired;
  if (!nameSchema.safeParse(name).success) return MSG.nameTooLong;
  return undefined;
}

/** S-17 ステップ1(名前入力)ダイアログ、および S-16 の失効確認ダイアログが共有する
 * Escape/オーバーレイクリックでの閉じる挙動(testcase-list.tsx の BULK_DIALOG_CLOSE_SCRIPT・
 * testcase-detail.tsx の DIALOG_CLOSE_SCRIPT と同じ idiom)。
 * S-17 ステップ2(結果ダイアログ)には意図的に同梱しない(「ダイアログ閉じ防止」要件。閉じるボタンの
 * クリックのみで閉じる = このスクリプトを描画しなければ Escape/オーバーレイクリックは何もしない)。 */
const TOKEN_DIALOG_CLOSE_SCRIPT = `
(function () {
  if (window.__tmsTokenDialogBound) return;
  window.__tmsTokenDialogBound = true;
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

/** S-17 ステップ2「コピー」ボタン(testcase-detail.tsx の GHERKIN_COPY_SCRIPT と同じ idiom。
 * 2秒後に元のラベルへ戻す = S-17「コピーボタンの状態」表のとおり)。 */
const TOKEN_COPY_SCRIPT = `
(function () {
  if (window.__tmsTokenCopyBound) return;
  window.__tmsTokenCopyBound = true;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('[data-testid="token-result-copy"]')) return;
    var code = document.querySelector('[data-testid="token-result-plaintext"]');
    if (!code) return;
    var raw = code.textContent || '';
    var restoreText = t.textContent;
    function done(ok) {
      t.textContent = ok ? 'コピーしました \\u2713' : 'コピーに失敗しました';
      setTimeout(function () { t.textContent = restoreText; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(raw).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  });
})();
`;

// --- S-17 ステップ1: トークン発行フォーム ---

function TokenIssueDialog(props: { pid: string; csrf: string; name?: string; error?: string }) {
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="token-issue-title" data-testid="token-issue-dialog">
        <div class="dialog-header">
          <h2 id="token-issue-title" data-testid="token-issue-title">トークン発行</h2>
          <a href={`/projects/${props.pid}/tokens`} class="dialog-close" data-testid="token-issue-dialog-close" aria-label="閉じる" data-dialog-cancel="true">✕</a>
        </div>
        <form method="post" action={`/projects/${props.pid}/tokens`} novalidate data-validate data-testid="token-issue-form">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <div class="field">
            <label for="token-issue-name-input">トークン名</label>
            <input
              id="token-issue-name-input" name="name" type="text" value={props.name ?? ''}
              required maxlength={LIMITS.name} data-testid="token-issue-name-input"
              data-err-required={MSG.nameRequired} aria-describedby="token-issue-name-error"
            />
            <p id="token-issue-name-error" data-testid="token-issue-name-error" class="field-error" aria-live="polite">
              {props.error ?? ''}
            </p>
          </div>
          <div class="dialog-actions">
            <a href={`/projects/${props.pid}/tokens`} class="btn btn-secondary" data-testid="token-issue-cancel" data-dialog-cancel="true">
              キャンセル
            </a>
            {/* progressive enhancement: 他画面と同じ理由で SSR は disabled をハードコードしない
                (S-17「発行ボタン: トークン名が空なら disabled」は layout.tsx の FORM_ENHANCE_SCRIPT が
                JS 実行時にのみ適用する)。 */}
            <button type="submit" class="btn btn-primary" data-testid="token-issue-submit">発行</button>
          </div>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: TOKEN_DIALOG_CLOSE_SCRIPT }}></script>
    </div>
  );
}

// --- S-17 ステップ2: 発行結果ダイアログ(平文を1回だけ表示) ---

function TokenResultDialog(props: { pid: string; name: string; token: string; projectName: string }) {
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      {/* S-17「ダイアログ閉じ防止」: このダイアログには TOKEN_DIALOG_CLOSE_SCRIPT を同梱しない
          (Escape/オーバーレイクリックでは閉じない。閉じるボタンのみが有効な唯一の閉じる手段)。 */}
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="token-result-title" data-testid="token-result-dialog">
        <h2 id="token-result-title" data-testid="token-result-title">トークンが発行されました</h2>
        <div class="alert alert-warn" role="alert" data-testid="token-result-warning">
          この画面を閉じると平文は二度と表示できません
        </div>
        <div class="token-plaintext-row">
          <code data-testid="token-result-plaintext">{props.token}</code>
          <button type="button" class="btn btn-secondary" data-testid="token-result-copy">コピー</button>
        </div>
        <p>名前: <span data-testid="token-result-name">{props.name}</span></p>
        <p>プロジェクト: <span data-testid="token-result-project">{props.projectName}</span></p>
        <div class="dialog-actions">
          {/* リロードで平文が消える設計(コメント冒頭参照): 「閉じる」は一覧への通常ナビゲーションリンク。
              一覧再取得 + トースト(S-16「画面遷移」)を兼ねる。 */}
          <a href={`/projects/${props.pid}/tokens?flash=token_issued`} class="btn btn-primary" data-testid="token-result-close">
            閉じる
          </a>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: TOKEN_COPY_SCRIPT }}></script>
    </div>
  );
}

// --- S-16 失効確認ダイアログ ---

function TokenRevokeConfirmDialog(props: { pid: string; token: ApiTokenRow; csrf: string }) {
  const { pid, token, csrf } = props;
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true" data-testid="token-revoke-confirm-dialog">
        <h2>トークンの失効</h2>
        <p data-testid="token-revoke-confirm-message">
          トークン「{token.name}」を失効させますか？失効後は即座に認証が拒否されます
        </p>
        <form method="post" action={`/projects/${pid}/tokens/${token.id}/revoke`} data-validate data-testid="token-revoke-confirm-form">
          <input type="hidden" name="_csrf" value={csrf} />
          <div class="dialog-actions">
            <a
              href={`/projects/${pid}/tokens`} class="btn btn-secondary"
              data-testid="token-revoke-confirm-cancel" data-dialog-cancel="true"
            >
              キャンセル
            </a>
            <button type="submit" class="btn btn-primary" data-testid="token-revoke-confirm-execute">失効</button>
          </div>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: TOKEN_DIALOG_CLOSE_SCRIPT }}></script>
    </div>
  );
}

// --- S-16 一覧テーブル ---

function TokenTable(props: { pid: string; tokens: ApiTokenRow[] }) {
  return (
    <table data-testid="token-table">
      <thead>
        <tr>
          <th>名前</th>
          <th>作成日</th>
          <th>最終使用</th>
          <th>状態</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {props.tokens.map((t) => {
          const revoked = t.revokedAt !== null;
          return (
            <tr data-testid={`token-row-${t.id}`}>
              <td data-testid={`token-name-${t.id}`}>{t.name}</td>
              <td data-testid={`token-created-at-${t.id}`}>{formatDateTime(t.createdAt)}</td>
              <td data-testid={`token-last-used-${t.id}`}>{t.lastUsedAt !== null ? formatDateTime(t.lastUsedAt) : '未使用'}</td>
              <td data-testid={`token-status-${t.id}`}>
                <span class={`badge ${revoked ? 'badge-token-revoked' : 'badge-token-active'}`}>
                  {revoked ? '失効済み' : '有効'}
                </span>
              </td>
              <td data-testid={`token-actions-${t.id}`}>
                {!revoked && (
                  <a
                    href={`/projects/${props.pid}/tokens/${t.id}/revoke-confirm`}
                    hx-get={`/projects/${props.pid}/tokens/${t.id}/revoke-confirm`}
                    hx-target="#dialog-root" hx-swap="innerHTML"
                    class="btn btn-secondary" data-testid={`token-revoke-button-${t.id}`}
                  >
                    失効
                  </a>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- S-16 ページ全体 ---

type TokenDialog =
  | { kind: 'issue'; name?: string; error?: string }
  | { kind: 'result'; name: string; token: string; projectName: string }
  | { kind: 'revoke-confirm'; token: ApiTokenRow };

interface TokensPageProps {
  user: UserRow;
  csrf: string;
  flash?: Flash | null;
  project: ProjectRow;
  tokens: ApiTokenRow[];
  dialog?: TokenDialog | null;
}

function renderDialog(pid: string, csrf: string, dialog: TokenDialog) {
  if (dialog.kind === 'issue') return <TokenIssueDialog pid={pid} csrf={csrf} name={dialog.name} error={dialog.error} />;
  if (dialog.kind === 'result') return <TokenResultDialog pid={pid} name={dialog.name} token={dialog.token} projectName={dialog.projectName} />;
  return <TokenRevokeConfirmDialog pid={pid} token={dialog.token} csrf={csrf} />;
}

function TokensPage(props: TokensPageProps) {
  const { project, tokens } = props;
  const issueAttrs = {
    href: `/projects/${project.id}/tokens/new`,
    'hx-get': `/projects/${project.id}/tokens/new`,
    'hx-target': '#dialog-root',
    'hx-swap': 'innerHTML',
  } as const;

  return (
    <Layout title="API トークン" user={props.user} project={project} csrf={props.csrf} flash={props.flash ?? null}>
      <div class="page-header">
        <h1 data-testid="token-list-title">API トークン</h1>
        <a {...issueAttrs} class="btn btn-primary" data-testid="token-issue-button">+ 発行</a>
      </div>

      {tokens.length === 0 ? (
        <div class="empty-state" data-testid="token-list-empty">
          <p>APIトークンがありません。「発行」ボタンからトークンを作成してください</p>
        </div>
      ) : (
        <TokenTable pid={project.id} tokens={tokens} />
      )}

      <p class="hint" data-testid="token-list-note">※ トークンの平文は発行時に1回だけ表示されます</p>

      {props.dialog && renderDialog(project.id, props.csrf, props.dialog)}
    </Layout>
  );
}

// --- 共通コンテキスト解決 ---

/** testcase-detail.tsx の requiredParam と同じ理由(この関数は個別ルートのパスリテラル型推論の
 * 恩恵を受けられない独立関数のため、動的セグメントの有無を実行時契約として扱う)。 */
function requiredParam(c: Context<AppEnv>, name: string): string {
  const v = c.req.param(name);
  if (v === undefined) throw new AppError('NOT_FOUND', 404, `missing path param: ${name}`);
  return v;
}

interface LoadedTokensContext {
  kind: 'ok';
  project: ProjectRow;
  csrf: string;
  user: UserRow;
}
type TokensContextResult = LoadedTokensContext | { kind: 'response'; response: Response | Promise<Response> };

async function loadProjectContext(c: Context<AppEnv>): Promise<TokensContextResult> {
  const deps = c.get('deps');
  const actor = c.get('actor');
  // requirePageAuth は必ず {kind:'user'} の actor を set する(UI ページはセッション認証のみを扱う)。
  // 型の絞り込みのための防御的分岐(testcase-list.tsx 等の既存 UI ルートと同じ idiom)。
  if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
  const csrf = await ensureCsrfCookie(c);
  const pid = requiredParam(c, 'pid');

  const project = await deps.storage.getProject(orgScopeOf(actor), pid);
  if (!project) return { kind: 'response', response: renderProjectNotFound(c, actor.user, csrf) };

  return { kind: 'ok', project, csrf, user: actor.user };
}

const adminOnly = requirePageAuth({ minRole: 'admin' });

export const tokenPageRoutes = new Hono<AppEnv>()
  // S-16: admin のみ。
  .get('/projects/:pid/tokens', adminOnly, async (c) => {
    const ctx = await loadProjectContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { project, csrf, user } = ctx;
    const deps = c.get('deps');
    const actor = c.get('actor');

    const tokens = await deps.storage.listApiTokens(orgScopeOf(actor), project.id);
    const flashKey = c.req.query('flash');
    const flash = flashKey === 'token_revoked'
      ? { kind: 'success', text: `トークン「${c.req.query('name') ?? ''}」を失効しました` } as Flash
      : resolveFlash(flashKey);

    return c.html(<TokensPage user={user} csrf={csrf} project={project} tokens={tokens} flash={flash} />);
  })

  // S-17 ステップ1ダイアログを開く: admin のみ。testcase-list.tsx の bulk-confirm と同じ「GET で
  // #dialog-root へフラグメントを取得」パターン。
  .get('/projects/:pid/tokens/new', adminOnly, async (c) => {
    const ctx = await loadProjectContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { project, csrf, user } = ctx;
    const deps = c.get('deps');

    if (c.req.header('HX-Request')) {
      return c.html(<TokenIssueDialog pid={project.id} csrf={csrf} />);
    }
    const tokens = await deps.storage.listApiTokens(orgScopeOf(c.get('actor')), project.id);
    return c.html(<TokensPage user={user} csrf={csrf} project={project} tokens={tokens} dialog={{ kind: 'issue' }} />);
  })

  // S-17 発行実行: admin + CSRF。成功時は 303 ではなく直接ステップ2を描画する(ファイル冒頭コメント参照)。
  .post('/projects/:pid/tokens', adminOnly, csrfProtect(), async (c) => {
    const ctx = await loadProjectContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { project, csrf, user } = ctx;
    const deps = c.get('deps');
    const actor = c.get('actor');
    const isHx = !!c.req.header('HX-Request');

    const body = await c.req.parseBody();
    const name = String(body.name ?? '').trim();
    const error = validateTokenName(name);

    if (error) {
      if (isHx) return c.html(<TokenIssueDialog pid={project.id} csrf={csrf} name={name} error={error} />, 200);
      // 非HXフォールバック: projects-pages.tsx の POST /projects と同じ規約で、背後の一覧は実データを
      // 再取得して描画する(空の一覧を仮置きしない)。
      const tokens = await deps.storage.listApiTokens(orgScopeOf(actor), project.id);
      return c.html(
        <TokensPage user={user} csrf={csrf} project={project} tokens={tokens} dialog={{ kind: 'issue', name, error }} />,
        200,
      );
    }

    const plaintext = deps.auth.newApiToken();
    const tokenHash = await deps.auth.hashApiToken(plaintext);
    const row = await deps.storage.createApiToken(orgScopeOf(actor), project.id, name, tokenHash, deps.now());

    // 平文はこのレスポンスでのみ露出する。Cache-Control: no-store でブラウザ/中間キャッシュへの
    // 保存を防ぐ(apis/tokens.md の POST レスポンスヘッダと同じ防御をUIページにも適用)。
    c.header('Cache-Control', 'no-store');
    if (isHx) return c.html(<TokenResultDialog pid={project.id} name={row.name} token={plaintext} projectName={project.name} />);
    // 非HXフォールバック: 発行後の一覧には新しいトークンも含めて再取得して描画する。
    const tokens = await deps.storage.listApiTokens(orgScopeOf(actor), project.id);
    const dialog: TokenDialog = { kind: 'result', name: row.name, token: plaintext, projectName: project.name };
    return c.html(<TokensPage user={user} csrf={csrf} project={project} tokens={tokens} dialog={dialog} />);
  })

  // S-16 失効確認ダイアログ: admin のみ。改ざん/直リンクで存在しないトークンIDを指定した場合は
  // 一覧へ穏当にフォールバックする(testcase-list.tsx の bulk-confirm と同じ方針。ドキュメントに
  // このエッジケースの定義は無い)。
  .get('/projects/:pid/tokens/:id/revoke-confirm', adminOnly, async (c) => {
    const ctx = await loadProjectContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { project, csrf } = ctx;
    const deps = c.get('deps');
    const tokenId = requiredParam(c, 'id');
    const isHx = !!c.req.header('HX-Request');

    // Storage に単一トークン取得 API は無い(listApiTokens/createApiToken/revokeApiToken のみ。
    // storage/interface.ts 参照)ため一覧から該当行を探す。GC-5 の scope 契約を満たしつつ
    // 追加の Storage メソッドは導入しない(本タスクのファイル一覧外)。
    const tokens = await deps.storage.listApiTokens(orgScopeOf(c.get('actor')), project.id);
    const token = tokens.find((t) => t.id === tokenId && t.revokedAt === null);
    if (!token) {
      if (isHx) return c.body(null, 204);
      return c.redirect(`/projects/${project.id}/tokens`, 303);
    }

    if (isHx) return c.html(<TokenRevokeConfirmDialog pid={project.id} token={token} csrf={csrf} />);
    return c.html(
      <TokensPage user={ctx.user} csrf={csrf} project={project} tokens={tokens} dialog={{ kind: 'revoke-confirm', token }} />,
    );
  })

  // S-16 失効実行: admin + CSRF。素のフォーム POST のまま(HTMX化しない。project-create/bulk と同じ
  // 理由: 303 リダイレクト本文がそのままスワップされる事故を避ける)。revokeApiToken は冪等
  // ソフト失効(apis/tokens.md)なので、既に失効済みのトークンに対して呼んでもエラーにならない。
  .post('/projects/:pid/tokens/:id/revoke', adminOnly, csrfProtect(), async (c) => {
    const ctx = await loadProjectContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { project } = ctx;
    const deps = c.get('deps');
    const actor = c.get('actor');
    const tokenId = requiredParam(c, 'id');

    const revoked = await deps.storage.revokeApiToken(orgScopeOf(actor), project.id, tokenId, deps.now());
    if (!revoked) return c.redirect(`/projects/${project.id}/tokens`, 303);

    const qs = new URLSearchParams({ flash: 'token_revoked', name: revoked.name });
    return c.redirect(`/projects/${project.id}/tokens?${qs.toString()}`, 303);
  });
