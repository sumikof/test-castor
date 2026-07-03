// src/http/ui/projects-pages.tsx
// S-06 プロジェクト一覧(docs/screens/main/S-06-project-list.md)・S-07 プロジェクト作成ダイアログ
// (docs/screens/main/S-07-project-create-dialog.md)。task-18-brief.md。
//
// ビジネスロジックは既存の storage 直呼び出し(承認済みアプローチ A。task-18 の指示: 「Project
// service が無ければ UI ルートから storage を直接呼ぶ」— src/domain/services/ にはまだ
// project 用のサービス関数が無いため、src/http/api/projects.ts の POST 実装と同じ形
// (storage.createProject を直接呼ぶ)を UI ルートでも踏襲する)。
//
// HTMX フラグメント判定(HX-Request ヘッダ)をここで確立する(Task 19 以降が多用する基盤)。
// GET /projects/new は HX-Request があればダイアログ本体のみ(Layout 無し)を返し、無ければ
// S-06 一覧ページの上にダイアログを開いた状態(dialog prop 付き)で描画する。
//
// 新規作成フォーム自体は素の <form method="post" action="/projects"> のままにする(HTMX 化
// しない)。理由: POST 成功時は 303 リダイレクトを返す(D-13-5 の PRG 規約)が、HTMX の
// fetch/XHR は 3xx を透過的に追従するため、リダイレクト先(/projects、フル Layout の HTML)の
// 本文がそのまま #dialog-root に swap されてしまい `<html>` 丸ごと注入という事故になる
// (HTMX の既知の落とし穴)。素のフォーム送信ならブラウザが 303 を正しくトップレベルナビゲーション
// として追従するため、この事故を避けられる。「新規プロジェクト」ボタン(GET のみ)は安全なので
// hx-get で強化する。
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { csrfProtect } from '../middleware/csrf';
import { ensureCsrfCookie, requirePageAuth } from '../middleware/page-auth';
import { orgScopeOf } from '../middleware/scope';
import { resolveFlash, type Flash } from './flash';
import { Layout } from './layout';
import { nameSchema, repoUrlSchema, LIMITS } from '../../schemas/limits';
import type { ProjectRow, UserRow } from '../../storage/schema';

// --- 文言(S-07「フォームバリデーション」表と一致させる。GC-1) ---
const MSG = {
  nameRequired: 'プロジェクト名を入力してください',
  nameTooLong: 'プロジェクト名が長すぎます',
  repoInvalid: '有効な URL を入力してください',
} as const;

interface ProjectFormInput {
  name: string;
  repo_url: string;
}
type ProjectFormErrors = Partial<Record<keyof ProjectFormInput, string>>;

/**
 * D-07: 共有 Zod スキーマ(nameSchema/repoUrlSchema。src/schemas/api.ts の createProjectInput が
 * API ルートで使うのと同じもの)で可否を判定し、S-07 の文言をそのまま返す(UI・API 同一検証)。
 * repo_url は「空文字なら未入力として無視(オプショナル)」(S-07: 「空の場合は null として送信」)。
 *
 * GC-1 突合で発見した乖離(タスク報告に明記): S-07「サーバーサイド」表はプロジェクト名の重複を
 * 422 VALIDATION_FAILED として弾く仕様を記載するが、projects テーブルに name の一意制約は無く
 * (src/storage/schema.ts)、Task 10 で実装済みの POST /api/v1/projects も重複チェックを一切
 * 行っていない(task-18-brief.md 自体の POST 検証範囲も「name required, repo_url http/https
 * optional」のみで重複は対象外)。本タスクは UI から storage を直接呼ぶだけで新たな業務ルールを
 * 追加しない方針のため、重複検出はここでも実装しない(API と挙動を一致させるため。勝手に UI 側
 * だけ厳格化すると API と不整合になる)。
 */
function validateProjectForm(input: ProjectFormInput): ProjectFormErrors {
  const errors: ProjectFormErrors = {};

  if (!input.name) errors.name = MSG.nameRequired;
  else if (!nameSchema.safeParse(input.name).success) errors.name = MSG.nameTooLong;

  if (input.repo_url && !repoUrlSchema.safeParse(input.repo_url).success) {
    errors.repo_url = MSG.repoInvalid;
  }

  return errors;
}

/** Escape キーでダイアログを閉じる(S-07「キーボード操作」)。Tab/Enter はブラウザ既定動作で
 * 満たされる(フォーム内の要素順がそのまま Tab 順になり、単一の submit ボタンがあるフォームは
 * Enter で送信される)ため JS 不要。フラグメント単体でも標準ページ内でも常にこのダイアログの
 * マークアップと一緒に埋め込まれるため、どちらの読み込み経路でも Escape ハンドラが効く。
 * `window.__tmsDialogEscapeBound` ガードは、HTMX でダイアログを開閉し直しても(フル
 * ナビゲーション無しに)リスナーが多重登録されないようにするため。 */
const DIALOG_ESCAPE_SCRIPT = `
(function () {
  if (window.__tmsDialogEscapeBound) return;
  window.__tmsDialogEscapeBound = true;
  document.addEventListener('keydown', function (e) {
    // .dialog-backdrop(CSS クラス)で存在確認する(data-testid 文字列で確認すると、この
    // <script> 自身のソース文字列がテスト側の data-testid 部分一致検索に紛れ込むため避ける)。
    if (e.key === 'Escape' && document.querySelector('.dialog-backdrop')) {
      window.location.href = '/projects';
    }
  });
})();
`;

/** S-07 のフォーム1フィールド分(ラベル・input・任意ヒント・エラー表示スロット)。 */
function DialogField(props: {
  inputTestid: string;
  labelTestid: string;
  errorTestid: string;
  label: string;
  name: string;
  type: 'text' | 'url';
  value?: string;
  required?: boolean;
  maxlength?: number;
  error?: string;
  errRequired?: string;
  errType?: string;
  hint?: { testid: string; text: string };
}) {
  return (
    <div class="field">
      <label for={props.inputTestid} data-testid={props.labelTestid}>{props.label}</label>
      <input
        id={props.inputTestid}
        name={props.name}
        type={props.type}
        value={props.value ?? ''}
        required={props.required}
        maxlength={props.maxlength}
        data-testid={props.inputTestid}
        data-err-required={props.errRequired}
        data-err-type={props.errType}
        aria-describedby={props.errorTestid}
      />
      {props.hint && <p data-testid={props.hint.testid} class="hint">{props.hint.text}</p>}
      <p id={props.errorTestid} data-testid={props.errorTestid} class="field-error" aria-live="polite">
        {props.error ?? ''}
      </p>
    </div>
  );
}

/**
 * S-07 プロジェクト作成ダイアログ本体。GET /projects/new(HX-Request)はこれを単独で返し、
 * それ以外(標準ページ)は ProjectsPage の子要素として同じコンポーネントを埋め込む(Layout 側の
 * `#dialog-root` は空のままでよい。`.dialog-backdrop` は position:fixed のため DOM 上の
 * 位置に関わらず画面全体にオーバーレイ表示される)。
 */
function ProjectCreateDialog(props: {
  csrf: string;
  values?: Partial<ProjectFormInput>;
  errors?: ProjectFormErrors;
}) {
  const v = props.values ?? {};
  const e = props.errors ?? {};
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-create-dialog-title"
        data-testid="project-create-dialog"
      >
        <div class="dialog-header">
          <h2 id="project-create-dialog-title" data-testid="project-create-dialog-title">プロジェクト作成</h2>
          <a href="/projects" class="dialog-close" data-testid="project-create-dialog-close" aria-label="閉じる">✕</a>
        </div>
        <form method="post" action="/projects" novalidate data-validate data-testid="project-create-form">
          <input type="hidden" name="_csrf" value={props.csrf} />

          <DialogField
            inputTestid="project-name-input" labelTestid="project-name-label" errorTestid="project-name-error"
            label="プロジェクト名" name="name" type="text" value={v.name} required maxlength={LIMITS.name}
            error={e.name} errRequired={MSG.nameRequired}
          />
          <DialogField
            inputTestid="project-repo-input" labelTestid="project-repo-label" errorTestid="project-repo-error"
            label="リポジトリ URL" name="repo_url" type="url" value={v.repo_url} maxlength={LIMITS.repoUrl}
            error={e.repo_url} errType={MSG.repoInvalid}
            hint={{ testid: 'project-repo-hint', text: '(任意)' }}
          />

          <div class="dialog-actions">
            <a href="/projects" class="btn btn-secondary" data-testid="project-create-cancel">キャンセル</a>
            {/* progressive enhancement: layout.tsx の共通スクリプトと同じ理由で SSR は disabled を
                持たない(no-JS でも送信できる)。「送信中は disabled + ローディング表示」は
                form[data-validate] を対象にする Layout の FORM_ENHANCE_SCRIPT が担う。 */}
            <button type="submit" class="btn btn-primary" data-testid="project-create-submit">作成</button>
          </div>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: DIALOG_ESCAPE_SCRIPT }}></script>
    </div>
  );
}

interface ProjectsPageProps {
  user: UserRow;
  csrf: string;
  flash?: Flash | null;
  projects: Array<ProjectRow & { testcaseCount: number }>;
  dialog?: { values?: Partial<ProjectFormInput>; errors?: ProjectFormErrors } | null;
}

/** S-06 プロジェクト一覧本体。dialog が渡された場合は S-07 をオーバーレイ表示する(GET /projects/new
 * の非 HX-Request 経路、および POST /projects のバリデーションエラー再描画(非 HX-Request)が使う)。 */
function ProjectsPage(props: ProjectsPageProps) {
  const isAdmin = props.user.role === 'admin';
  const { projects } = props;
  const newProjectAttrs = {
    href: '/projects/new',
    'hx-get': '/projects/new',
    'hx-target': '#dialog-root',
    'hx-swap': 'innerHTML',
  } as const;

  return (
    <Layout title="プロジェクト一覧" user={props.user} csrf={props.csrf} flash={props.flash ?? null}>
      <div class="page-header">
        <h1 data-testid="page-title">プロジェクト一覧</h1>
        {isAdmin && (
          <a {...newProjectAttrs} class="btn btn-primary" data-testid="project-create-button">新規プロジェクト</a>
        )}
      </div>

      {projects.length === 0 ? (
        <div class="empty-state" data-testid="project-empty-state">
          <p>プロジェクトがありません</p>
          {isAdmin && (
            <a {...newProjectAttrs} class="btn btn-primary" data-testid="project-empty-create">
              最初のプロジェクトを作成しましょう
            </a>
          )}
        </div>
      ) : (
        <table data-testid="project-table">
          <thead>
            <tr>
              <th data-testid="project-table-header-name">名前</th>
              <th data-testid="project-table-header-repo">リポジトリ</th>
              <th data-testid="project-table-header-count">テスト数</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr data-testid={`project-row-${p.id}`}>
                <td>
                  <a href={`/projects/${p.id}/testcases`} data-testid={`project-name-${p.id}`}>{p.name}</a>
                </td>
                <td>
                  {p.repoUrl ? (
                    <a href={p.repoUrl} target="_blank" rel="noreferrer" data-testid={`project-repo-${p.id}`}>
                      {p.repoUrl}
                    </a>
                  ) : (
                    <span data-testid={`project-repo-${p.id}`}>—</span>
                  )}
                </td>
                <td data-testid={`project-testcase-count-${p.id}`}>{p.testcaseCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {props.dialog && (
        <ProjectCreateDialog csrf={props.csrf} values={props.dialog.values} errors={props.dialog.errors} />
      )}
    </Layout>
  );
}

// --- ルート ---

export const projectPageRoutes = new Hono<AppEnv>()
  // S-06: viewer 以上(全認証済みユーザー)。
  .get('/projects', requirePageAuth({ minRole: 'viewer' }), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');

    const csrf = await ensureCsrfCookie(c);
    const flash = resolveFlash(c.req.query('flash'));
    const projects = await deps.storage.listProjects(orgScopeOf(actor));
    return c.html(<ProjectsPage user={actor.user} csrf={csrf} flash={flash} projects={projects} />);
  })

  // S-07: admin のみ。HX-Request ならダイアログ本体のみ(フラグメント)、それ以外は S-06 の上に
  // ダイアログを開いた状態の標準ページを返す(task-18-brief.md)。
  .get('/projects/new', requirePageAuth({ minRole: 'admin' }), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const csrf = await ensureCsrfCookie(c);

    if (c.req.header('HX-Request')) {
      return c.html(<ProjectCreateDialog csrf={csrf} />);
    }
    const projects = await deps.storage.listProjects(orgScopeOf(actor));
    return c.html(<ProjectsPage user={actor.user} csrf={csrf} projects={projects} dialog={{}} />);
  })

  // S-07 フォーム送信: admin のみ + CSRF。成功時は 303 + ?flash=project_created(D-13-5)。
  .post('/projects', requirePageAuth({ minRole: 'admin' }), csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');

    const body = await c.req.parseBody();
    const input: ProjectFormInput = {
      name: String(body.name ?? '').trim(),
      repo_url: String(body.repo_url ?? '').trim(),
    };

    const errors = validateProjectForm(input);
    if (Object.keys(errors).length > 0) {
      const csrf = await ensureCsrfCookie(c);
      if (c.req.header('HX-Request')) {
        return c.html(<ProjectCreateDialog csrf={csrf} values={input} errors={errors} />, 200);
      }
      const projects = await deps.storage.listProjects(orgScopeOf(actor));
      return c.html(
        <ProjectsPage user={actor.user} csrf={csrf} projects={projects} dialog={{ values: input, errors }} />,
        200,
      );
    }

    // S-07: リポジトリ URL が空の場合は null として送信。
    await deps.storage.createProject(
      orgScopeOf(actor),
      { name: input.name, repoUrl: input.repo_url ? input.repo_url : null },
      deps.now(),
    );
    return c.redirect('/projects?flash=project_created', 303);
  });
