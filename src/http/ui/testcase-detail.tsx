// src/http/ui/testcase-detail.tsx
// S-10 テストケース詳細 + S-11 編集(ページ内モード)+ S-12 構造化Diff / S-13 Gherkin / S-14 変更履歴 /
// Identity情報タブ(docs/screens/testcase/S-10〜S-14)。task-20-brief.md。
//
// GC-1 突合メモ(タブの data-testid 不一致): S-10 の要素カタログは基本情報タブ/Identityタブの
// data-testid を `tab-basic`/`tab-identity` と定義するが、S-12/S-13/S-14 の3ファイルは同じ物理的な
// タブバー(この5タブは全画面で共有)を `tab-basic-info`/`tab-identities` と定義しており、6ファイル中
// 3対1で後者が多数派。本実装はタブバーが全タブ共通の単一コンポーネントである以上どちらか一方に統一する
// 必要があるため、多数派である `tab-basic-info`/`tab-identities` を採用する(S-10 側が誤記と判断。
// タスク報告に明記。T23 で docs 側の統一を検討)。
//
// ビジネスロジックは API ルート(src/http/api/testcases.ts)と同じ domain 関数(computeHumanPatch/
// canTransition/buildHistoryEntries)・Storage メソッド(patchTestCase/acceptFingerprint/listHistory等)・
// シリアライザ(toDiffJson)をそのまま再利用する(task-18/19 で確立した「承認済みアプローチ A」を踏襲。
// UI 専用の service 抽出は行わない。理由はタスク報告に明記)。
//
// ダイアログ設計: S-10 のステータス確認4種(承認/差し戻し/アーカイブ/復帰)+ S-12 の accept-fingerprint
// 確認は、いずれも task-19 の S-15 一括操作確認ダイアログと同じ「GET で #dialog-root にフラグメントを
// 取得 → 素の form POST で実行(PRG)」パターンを踏襲する(HTMX化しない POST でリダイレクト本文が
// そのままスワップされる事故を避ける。testcase-list.tsxの既存コメント参照)。
//
// タブフラグメント(HX-Request → #tab-panel の中身のみ返す。hx-push-url で URL 同期): 基本情報タブ自体も
// メインの GET /testcases/:id が HX-Request を見て bare パネルを返す(S-08 一覧の HX 分岐と同じ規約)。
import { Hono, type Context } from 'hono';
import type { AppDeps, AppEnv, Actor } from '../app';
import { ROLE_RANK } from '../app';
import { AppError } from '../errors';
import { csrfProtect } from '../middleware/csrf';
import { ensureCsrfCookie, requirePageAuth } from '../middleware/page-auth';
import { orgScopeOf } from '../middleware/scope';
import { resolveFlash, type Flash } from './flash';
import { requiredParam } from './params';
import { Layout } from './layout';
import { CATEGORY_LABEL, formatDateTime, renderProjectNotFound } from './testcase-list';
import {
  TestCaseFieldsForm, testCaseRowToFormValues, parseTestCaseFormBody, validateTestCaseForm,
  zodIssuesToFormErrors, readString, buildTestCaseFields,
  type RawBody, type TestCaseFormValues, type TestCaseFormErrors,
} from './testcase-form';
import { STATUSES } from '../../schemas/enums';
import type { Status, Category, Ownership, Role, HistoryAction } from '../../schemas/enums';
import { canTransition, computeHumanPatch } from '../../domain/testcase-rules';
import type { ParamRow } from '../../domain/testcase-rules';
import { buildHistoryEntries } from '../../domain/history-delta';
import { renderGherkin } from '../../domain/gherkin';
import { toDiffJson } from '../api/serializers';
import { patchTestCaseInput } from '../../schemas/api';
import type { Paged } from '../../storage/interface';
import type { ProjectRow, UserRow, TestCaseRow, TestCaseHistoryRow, TestCaseIdentityRow } from '../../storage/schema';

// --- 汎用ヘルパ ---

function renderParamCell(v: unknown): string {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function renderSourceRef(ref: Record<string, unknown>): string {
  const file = typeof ref.file === 'string' ? ref.file : typeof ref.path === 'string' ? ref.path : null;
  if (file) {
    const line = ref.line !== undefined ? `:${String(ref.line)}` : '';
    return `${file}${line}`;
  }
  return JSON.stringify(ref);
}

function ParametersDisplay(props: { parameters: ParamRow[] | null; testid: string; rowPrefix?: string }) {
  if (!props.parameters || props.parameters.length === 0) {
    return <p data-testid={props.testid}>パラメータ: なし</p>;
  }
  return (
    <table data-testid={props.testid}>
      <thead><tr><th>name</th><th>inputs</th><th>expected</th></tr></thead>
      <tbody>
        {props.parameters.map((row, i) => (
          <tr data-testid={props.rowPrefix ? `${props.rowPrefix}-${i}` : undefined}>
            <td>{row.name ?? ''}</td>
            <td>{renderParamCell(row.inputs)}</td>
            <td>{renderParamCell(row.expected)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- タブ種別 ---

type TabName = 'basic-info' | 'gherkin' | 'diff' | 'history' | 'identities';

function normalizeTab(raw: string | undefined | null): TabName {
  return raw === 'gherkin' || raw === 'diff' || raw === 'history' || raw === 'identities' ? raw : 'basic-info';
}

// --- タブバー ---

function TabBar(props: { pid: string; id: string; active: TabName; hasDrift: boolean }) {
  const { pid, id, active, hasDrift } = props;
  const base = `/projects/${pid}/testcases/${id}`;
  const tabs: Array<{ name: TabName; testid: string; label: string }> = [
    { name: 'basic-info', testid: 'tab-basic-info', label: '基本情報' },
    { name: 'gherkin', testid: 'tab-gherkin', label: 'Gherkin' },
    { name: 'diff', testid: 'tab-diff', label: '構造化Diff' },
    { name: 'history', testid: 'tab-history', label: '変更履歴' },
    { name: 'identities', testid: 'tab-identities', label: 'Identity情報' },
  ];
  return (
    <nav class="tab-bar" data-testid="tab-bar">
      {tabs.map((t) => {
        const isBasic = t.name === 'basic-info';
        const href = isBasic ? base : `${base}?tab=${t.name}`;
        const hxGet = isBasic ? base : `${base}/tabs/${t.name}`;
        return (
          <a
            href={href} hx-get={hxGet} hx-target="#tab-panel" hx-swap="innerHTML" hx-push-url={href}
            class={`tab${active === t.name ? ' tab-active' : ''}`} data-testid={t.testid}
          >
            {t.label}
            {t.name === 'diff' && hasDrift && <span class="tab-dot"> ●</span>}
          </a>
        );
      })}
    </nav>
  );
}

// --- ヘッダー(ステータス操作・所有権・drift/stale バッジ・編集/アーカイブ/復帰ボタン) ---

function DetailHeader(props: { pid: string; tc: TestCaseRow; isEditorUp: boolean }) {
  const { pid, tc, isEditorUp } = props;
  const id = tc.id;
  const status = tc.status as Status;
  const ownership = tc.ownership as Ownership;
  const editUrl = `/projects/${pid}/testcases/${id}/edit`;
  const confirmBase = `/projects/${pid}/testcases/${id}/status-confirm`;

  return (
    <div class="testcase-header">
      <a href={`/projects/${pid}/testcases`} data-testid="link-back-to-list">← テストケース一覧</a>
      <h1 data-testid="testcase-title">{tc.title}</h1>
      <div class="testcase-status-row">
        {isEditorUp ? (
          <form method="get" action={confirmBase} class="status-select-form" data-testid="status-select-form">
            <select
              name="to" data-testid="select-status"
              hx-get={confirmBase} hx-trigger="change" hx-target="#dialog-root" hx-swap="innerHTML"
            >
              {STATUSES.filter((s) => canTransition(status, s)).map((s) => (
                <option value={s} selected={s === status}>{s}</option>
              ))}
            </select>
            <button type="submit" class="btn btn-secondary status-select-submit">変更</button>
          </form>
        ) : (
          <span class="badge" data-testid="select-status">{status}</span>
        )}
        {/* S-10「状態バリエーション」: ownership=machine は 👻 アイコン(testcase-list.tsx の S-08 一覧行と
            同じアイコン語彙に揃える。history-actor-icon の🤖(トークン=ロボット)とは別の記号)。 */}
        <span data-testid="display-ownership">{ownership === 'machine' ? '👻 machine' : '👤 human'}</span>
        {!!tc.drift && <span class="badge badge-drift" data-testid="badge-drift">⚡ drift</span>}
        {/* stale origin 名: canonical.is_stale は per-origin TestCaseIdentity のロールアップ集約
            (data-model.md「is_stale」)であり、canonical 行自体はどの origin が stale かを持たない。
            正確な origin 名を出すには listIdentities の追加取得が要る(Identity タブが提供済み)ため、
            ヘッダーバッジでは近似として mirror_origin(drift 判定と同じ基準列)を表示する
            (単一 origin の典型ケースでは実質一致する。複数 origin の場合は不正確になりうる近似で
            あることをタスク報告に明記)。 */}
        {!!tc.isStale && <span class="badge badge-stale" data-testid="badge-stale">🔺 {tc.mirrorOrigin ?? 'stale'}</span>}
      </div>
      {isEditorUp && (
        <div class="testcase-actions">
          {status !== 'archived' && (
            <a
              href={editUrl} hx-get={editUrl} hx-target="#tab-panel" hx-swap="innerHTML"
              class="btn btn-secondary" data-testid="btn-edit"
            >
              編集
            </a>
          )}
          {status !== 'archived' && (
            <a
              href={`${confirmBase}?to=archived`} hx-get={`${confirmBase}?to=archived`}
              hx-target="#dialog-root" hx-swap="innerHTML" class="btn btn-secondary" data-testid="btn-archive"
            >
              アーカイブ
            </a>
          )}
          {status === 'archived' && (
            <a
              href={`${confirmBase}?to=draft`} hx-get={`${confirmBase}?to=draft`}
              hx-target="#dialog-root" hx-swap="innerHTML" class="btn btn-primary" data-testid="btn-restore"
            >
              復帰
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// --- 基本情報タブ(閲覧モード) ---

function BasicInfoView(props: { tc: TestCaseRow }) {
  const { tc } = props;
  const parameters: ParamRow[] | null = tc.parameters === null ? null : (JSON.parse(tc.parameters) as ParamRow[]);
  const sourceRef: Record<string, unknown> | null = tc.sourceRef === null ? null : (JSON.parse(tc.sourceRef) as Record<string, unknown>);
  const metadata: Record<string, unknown> | null = tc.metadata === null ? null : (JSON.parse(tc.metadata) as Record<string, unknown>);
  const tags: string[] = metadata && Array.isArray(metadata.tags) ? (metadata.tags as unknown[]).map(String) : [];
  const updatedAt = Math.max(tc.humanUpdatedAt ?? 0, tc.systemUpdatedAt ?? 0, tc.createdAt);

  return (
    <div data-testid="testcase-basic-info">
      <div class="field">
        <span class="field-label">対象:</span> <span data-testid="display-target">{tc.target ?? '—'}</span>
      </div>
      <div class="field">
        <span class="field-label">カテゴリ:</span>{' '}
        <span class="badge" data-testid="display-category">{CATEGORY_LABEL[tc.category as Category]}</span>
      </div>
      <div class="field"><h3>Given</h3><p class="multiline" data-testid="display-given">{tc.given}</p></div>
      <div class="field"><h3>When</h3><p class="multiline" data-testid="display-when">{tc.when}</p></div>
      <div class="field"><h3>Then</h3><p class="multiline" data-testid="display-then">{tc.then}</p></div>
      <div class="field">
        <h3>パラメータ</h3>
        <ParametersDisplay parameters={parameters} testid="display-parameters" rowPrefix="param-display-row" />
      </div>
      <div class="field" data-testid="display-metadata">
        <h3>メタデータ</h3>
        <p>
          タグ:{' '}
          {tags.length === 0
            ? 'なし'
            : tags.map((t) => <span class="badge" data-testid={`display-tag-${t}`}>{t}</span>)}
        </p>
      </div>
      <p><span class="field-label">作成元:</span> <span data-testid="display-origin">{tc.createdOrigin}</span></p>
      {tc.confidence != null && <p data-testid="display-confidence">信頼度: {tc.confidence}</p>}
      {sourceRef && <p data-testid="display-source-ref">ソース参照: {renderSourceRef(sourceRef)}</p>}
      <p data-testid="display-created-at">作成日時: {formatDateTime(tc.createdAt)}</p>
      <p data-testid="display-updated-at">更新日時: {formatDateTime(updatedAt)}</p>
      <p data-testid="display-version">バージョン: {tc.version}</p>
    </div>
  );
}

// --- S-11 編集フォーム(machine 警告ゲート・OCC バナー含む) ---

function MachineWarningDialog(props: { pid: string; id: string }) {
  const { pid, id } = props;
  const viewUrl = `/projects/${pid}/testcases/${id}`;
  const continueUrl = `/projects/${pid}/testcases/${id}/edit?confirmed=1`;
  return (
    <div class="dialog-backdrop" data-testid="dialog-machine-warning">
      <div class="dialog" role="dialog" aria-modal="true">
        <p data-testid="machine-warning-text">
          ⚠ このテストケースは現在 Discovery が自動管理しています。編集すると以後 Discovery による自動更新が停止し、
          コード側の変化は drift として検知されるようになります。
        </p>
        <div class="dialog-actions">
          <a
            href={viewUrl} hx-get={viewUrl} hx-target="#tab-panel" hx-swap="innerHTML"
            class="btn btn-secondary" data-testid="machine-warning-btn-cancel"
          >
            キャンセル
          </a>
          <a
            href={continueUrl} hx-get={continueUrl} hx-target="#tab-panel" hx-swap="innerHTML"
            class="btn btn-primary" data-testid="machine-warning-btn-continue"
          >
            編集を続ける
          </a>
        </div>
      </div>
    </div>
  );
}

function TestCaseEditForm(props: {
  pid: string; id: string; csrf: string; version: number;
  values: TestCaseFormValues; errors: TestCaseFormErrors; occConflict?: boolean; ownership: Ownership;
}) {
  const { pid, id, csrf, version, values, errors, occConflict, ownership } = props;
  const action = `/projects/${pid}/testcases/${id}/edit`;
  const viewUrl = `/projects/${pid}/testcases/${id}`;
  // review round 1 #3(Important): OCC 競合時の再読み込みリンクは GET /edit へ遷移する。この行が
  // ownership=machine の場合、confirmed=1 を付けないと GET /edit ハンドラ(~845行)が machine 警告
  // ダイアログを再度表示してしまい、S-11「画面遷移: OCC 競合 → 再読み込み | S-11 編集モード(最新データで
  // 再描画)」(docs/screens/testcase/S-11-testcase-edit.md:204)に反する(一度警告を承認して編集画面に
  // 入っているユーザーを、再読み込みのたびに警告へ差し戻すのは文書の期待と矛盾する)。human 所有行は
  // 元々警告ゲートが無いため confirmed=1 を付けない(素の URL のまま。挙動不変)。
  const reloadUrl = ownership === 'machine' ? `${action}?confirmed=1` : action;
  return (
    <div data-testid="testcase-edit-mode">
      {errors.form && <div class="alert alert-error" data-testid="edit-form-error">{errors.form}</div>}
      {occConflict && (
        <div class="alert alert-error" data-testid="occ-conflict-banner">
          他のユーザーが先に更新しました。最新の内容を確認してください。
          <a href={reloadUrl} class="btn btn-secondary" data-testid="btn-reload-latest">最新の内容を読み込む</a>
        </div>
      )}
      <form method="post" action={action} novalidate data-validate data-testid="testcase-edit-form">
        <input type="hidden" name="_csrf" value={csrf} />
        <input type="hidden" name="version" value={version} />
        <p data-testid="edit-display-version">バージョン: {version}</p>
        <TestCaseFieldsForm prefix="edit-" values={values} errors={errors} />
        <div class="dialog-actions">
          <a href={viewUrl} class="btn btn-secondary" data-testid="edit-btn-cancel">キャンセル</a>
          <button type="submit" class="btn btn-primary" data-testid="edit-btn-save">保存</button>
        </div>
      </form>
    </div>
  );
}

/** 検証済みフォーム値 → patchTestCaseInput の入力形へ(空は null = クリア指示。create との差は absent 哨兵のみ)。 */
function buildEditPatchInput(v: TestCaseFormValues) {
  return buildTestCaseFields(v, null);
}

// --- S-12 構造化Diff タブ ---

interface DiffViewData {
  has_drift: boolean;
  origin: string | null;
  observed_at: number | null;
  canonical: { given: string; when: string; then: string; parameters: ParamRow[] | null };
  latest_observation: { given: string; when: string; then: string; parameters: ParamRow[] | null } | null;
  diff: Record<string, { before: unknown; after: unknown }> | null;
}

const DIFF_FIELD_LABEL: Record<string, string> = { given: 'Given', when: 'When', then: 'Then', parameters: 'Parameters' };

const DIALOG_CLOSE_SCRIPT = `
(function () {
  if (window.__tmsDetailDialogBound) return;
  window.__tmsDetailDialogBound = true;
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

function DiffTabContent(props: { pid: string; id: string; isEditorUp: boolean; diff: DiffViewData }) {
  const { pid, id, isEditorUp, diff } = props;

  if (!diff.has_drift) {
    const canonical = diff.canonical;
    return (
      <div data-testid="diff-tab-content">
        <p data-testid="diff-no-drift">現在 drift は発生していません。canonical のみ表示します。</p>
        <p class="multiline" data-testid="canonical-given">{canonical.given}</p>
        <p class="multiline" data-testid="canonical-when">{canonical.when}</p>
        <p class="multiline" data-testid="canonical-then">{canonical.then}</p>
        <ParametersDisplay parameters={canonical.parameters} testid="canonical-parameters" />
      </div>
    );
  }

  const fields = ['given', 'when', 'then', 'parameters'] as const;
  const changes = diff.diff ?? {};
  const confirmUrl = `/projects/${pid}/testcases/${id}/accept-fingerprint-confirm`;

  return (
    <div data-testid="diff-tab-content">
      <p data-testid="diff-header">canonical(現在の仕様) ←→ 最新の観測</p>
      <p data-testid="diff-origin">{diff.origin}</p>
      <p data-testid="diff-observed-at">{diff.observed_at != null ? formatDateTime(diff.observed_at) : '—'}</p>
      {fields.map((f) => (
        <div data-testid={`diff-section-${f}`}>
          <h3>{DIFF_FIELD_LABEL[f]}</h3>
          {changes[f] ? (
            <>
              <div class="diff-row diff-remove" data-testid="diff-line-removed">- {renderParamCell(changes[f]?.before)}</div>
              <div class="diff-row diff-add" data-testid="diff-line-added">+ {renderParamCell(changes[f]?.after)}</div>
            </>
          ) : (
            <div class="diff-row diff-unchanged" data-testid="diff-no-change">(変更なし)</div>
          )}
        </div>
      ))}
      {isEditorUp && (
        <a
          href={confirmUrl} hx-get={confirmUrl} hx-target="#dialog-root" hx-swap="innerHTML"
          class="btn btn-primary" data-testid="btn-accept-fingerprint"
        >
          この観測を正として受け入れる
        </a>
      )}
    </div>
  );
}

function AcceptFingerprintConfirmDialog(props: { pid: string; id: string; csrf: string; version: number }) {
  const { pid, id, csrf, version } = props;
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true" data-testid="dialog-confirm-accept-fp">
        <h2>drift の解消</h2>
        <p>最新の観測を正として受け入れ、drift を解消しますか？</p>
        <form
          method="post" action={`/projects/${pid}/testcases/${id}/accept-fingerprint`}
          data-validate data-testid="accept-fingerprint-confirm-form"
        >
          <input type="hidden" name="_csrf" value={csrf} />
          <input type="hidden" name="version" value={version} />
          <div class="dialog-actions">
            <a
              href={`/projects/${pid}/testcases/${id}?tab=diff`} class="btn btn-secondary"
              data-testid="btn-dialog-cancel" data-dialog-cancel="true"
            >
              キャンセル
            </a>
            <button type="submit" class="btn btn-primary" data-testid="btn-dialog-confirm">解消する</button>
          </div>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: DIALOG_CLOSE_SCRIPT }}></script>
    </div>
  );
}

// --- S-13 Gherkin タブ ---

const GHERKIN_COPY_SCRIPT = `
(function () {
  if (window.__tmsGherkinCopyBound) return;
  window.__tmsGherkinCopyBound = true;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('[data-testid="btn-copy-gherkin"]')) return;
    var pre = document.querySelector('[data-testid="gherkin-content"]');
    if (!pre) return;
    var raw = pre.textContent || '';
    try { raw = JSON.parse(pre.getAttribute('data-raw') || 'null') || raw; } catch (err) { /* keep textContent fallback */ }
    var restoreText = t.textContent;
    function done(ok) {
      t.textContent = ok ? 'コピーしました \\u2713' : 'コピーに失敗しました';
      setTimeout(function () { t.textContent = restoreText; }, 2500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(raw).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  });
})();
`;

function GherkinExamplesTable(props: { parameters: ParamRow[] }) {
  const hasName = props.parameters.some((p) => p.name !== undefined);
  return (
    <table data-testid="gherkin-examples">
      <thead><tr>{hasName && <th>name</th>}<th>inputs</th><th>expected</th></tr></thead>
      <tbody>
        {props.parameters.map((p) => (
          <tr>
            {hasName && <td>{p.name ?? ''}</td>}
            <td>{renderParamCell(p.inputs)}</td>
            <td>{renderParamCell(p.expected)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GherkinTabContent(props: { tc: TestCaseRow }) {
  const { tc } = props;
  const parameters: ParamRow[] | null = tc.parameters === null ? null : (JSON.parse(tc.parameters) as ParamRow[]);
  const hasParams = !!parameters && parameters.length > 0;
  const feature = tc.target && tc.target.trim().length > 0 ? tc.target : tc.title;
  const raw = renderGherkin({ title: tc.title, target: tc.target, given: tc.given, when: tc.when, then: tc.then, parameters });

  return (
    <div data-testid="gherkin-tab-content">
      <pre data-testid="gherkin-content" data-raw={JSON.stringify(raw)}>
        <div data-testid="gherkin-feature">{`Feature: ${feature}`}</div>
        {'\n'}
        <div data-testid={hasParams ? 'gherkin-scenario-outline' : 'gherkin-scenario'}>
          {hasParams ? `  Scenario Outline: ${tc.title}` : `  Scenario: ${tc.title}`}
        </div>
        <div data-testid="gherkin-given">{`    Given ${tc.given}`}</div>
        <div data-testid="gherkin-when">{`    When ${tc.when}`}</div>
        <div data-testid="gherkin-then">{`    Then ${tc.then}`}</div>
        {hasParams && parameters && (
          <>
            {'\n'}
            <div>    Examples:</div>
            <GherkinExamplesTable parameters={parameters} />
          </>
        )}
      </pre>
      <div class="gherkin-actions">
        <button type="button" class="btn btn-secondary" data-testid="btn-copy-gherkin">クリップボードにコピー</button>
        {/* S-13: エクスポートボタンは MVP 除外(UI タスク共通事項の除外リストに明記)のため描画しない。 */}
      </div>
      <script dangerouslySetInnerHTML={{ __html: GHERKIN_COPY_SCRIPT }}></script>
    </div>
  );
}

// --- S-14 変更履歴タブ ---

const HISTORY_ACTION_LABEL: Record<HistoryAction, string> = {
  created: '作成', updated: '更新', status_changed: 'ステータス変更', imported: '取り込み',
};

/**
 * D-04 表示ルールの actor_display 組み立て。task-14-brief.md の Storage 実装(drizzle-storage.ts
 * listHistory)は `actorDisplay` を `COALESCE(users.displayName, apiTokens.name, actor)` で算出しており、
 * token actor の場合は素のトークン名(例: "discovery-ci")のみを返す(`token:` 接頭辞は付かない)。
 * S-14 の「実行者の表示ルール」表は `token:<uuid>` → `token:` + トークン名(例: `token:discovery-ci`)を
 * 期待するため、UI 側でトークンにのみ `token:` 接頭辞を補って表示する。
 *
 * GC-1 突合メモ: 同表は user actor を「表示名 + ロールバッジ」(例: `田中太郎 (editor)`)と定義するが、
 * listHistory の actorDisplay にはロール情報が含まれない(Task 14 の実装済み契約。列 JOIN を増やす
 * Storage 変更は本タスクのスコープ外)。そのため本実装は表示名のみを表示する(ロールバッジは省略)。
 * タスク報告に明記。
 */
function historyActorLabel(row: { actor: string; actorDisplay: string }): string {
  return row.actor.startsWith('token:') ? `token:${row.actorDisplay}` : row.actorDisplay;
}

function HistoryEntryView(props: { row: TestCaseHistoryRow & { actorDisplay: string } }) {
  const { row } = props;
  const delta = JSON.parse(row.delta) as Record<string, { before: unknown; after: unknown }>;
  const isTokenActor = row.actor.startsWith('token:');
  const action = row.action as HistoryAction;
  const showDelta = action !== 'created' && action !== 'imported';

  return (
    <div class="history-entry" data-testid="history-entry" data-history-id={row.id}>
      <span data-testid="history-datetime">{formatDateTime(row.createdAt)}</span>{' '}
      <span data-testid="history-actor-icon">{isTokenActor ? '🤖' : '👤'}</span>{' '}
      <span data-testid="history-actor">{historyActorLabel(row)}</span>{' '}
      <span class="badge" data-testid="history-action">{HISTORY_ACTION_LABEL[action]}</span>
      {action === 'imported' && <p data-testid="history-initial-import">(初回取り込み)</p>}
      {showDelta && (
        <div class="history-delta" data-testid="history-delta">
          {Object.entries(delta).map(([field, change]) => (
            <div class="history-delta-row">
              <span data-testid="history-delta-field">{field}</span>{': '}
              <span class="diff-row diff-remove" data-testid="history-delta-before">{renderParamCell(change.before)}</span>
              {' → '}
              <span class="diff-row diff-add" data-testid="history-delta-after">{renderParamCell(change.after)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryTabContent(props: {
  pid: string; id: string; limit: number; paged: Paged<TestCaseHistoryRow & { actorDisplay: string }>;
}) {
  const { pid, id, limit, paged } = props;
  const base = `/projects/${pid}/testcases/${id}`;
  const nextQuery = paged.nextCursor
    ? `cursor=${encodeURIComponent(paged.nextCursor)}&limit=${limit}`
    : '';
  return (
    <div data-testid="history-tab-content">
      {paged.items.length === 0 ? (
        <p data-testid="history-empty">変更履歴はありません。</p>
      ) : (
        <div data-testid="history-list">
          {paged.items.map((row) => <HistoryEntryView row={row} />)}
        </div>
      )}
      {paged.hasMore && paged.nextCursor && (
        <>
          <a
            href={`${base}?tab=history&${nextQuery}`}
            hx-get={`${base}/tabs/history?${nextQuery}`}
            hx-target="#tab-panel" hx-swap="innerHTML" hx-indicator="#history-loading"
            hx-push-url={`${base}?tab=history&${nextQuery}`}
            class="btn btn-secondary" data-testid="btn-load-more-history"
          >
            もっと見る
          </a>
          {/* htmx 標準の .htmx-indicator(既定 opacity:0 → リクエスト中に表示)を使う追加読み込み中の
              インジケーター(S-14「ローディングスピナー」)。htmx.min.js が該当 CSS を自動注入する。 */}
          <span id="history-loading" class="htmx-indicator" data-testid="history-loading">読み込み中…</span>
        </>
      )}
    </div>
  );
}

// --- Identity情報タブ ---

function IdentityTabContent(props: { items: TestCaseIdentityRow[] }) {
  const { items } = props;
  return (
    <div data-testid="identity-tab-content">
      {items.length === 0 ? (
        <p data-testid="identity-empty">Identity 情報はありません。</p>
      ) : (
        <table data-testid="identity-table">
          <thead><tr><th>origin</th><th>external_ref</th><th>stale</th><th>最終観測</th></tr></thead>
          <tbody>
            {items.map((row) => (
              <tr data-testid={`identity-row-${row.id}`}>
                <td data-testid={`identity-origin-${row.id}`}>{row.origin}</td>
                <td data-testid={`identity-ref-${row.id}`}>{row.externalRef}</td>
                <td>
                  <span class={row.isStale ? 'badge badge-stale' : 'badge'} data-testid={`identity-stale-${row.id}`}>
                    {row.isStale ? '🔺 stale' : '—'}
                  </span>
                </td>
                <td data-testid={`identity-last-seen-${row.id}`}>{row.lastSeenAt ? formatDateTime(row.lastSeenAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- ページ全体シェル ---

interface DetailPageShellProps {
  project: ProjectRow; user: UserRow; csrf: string; flash: Flash | null;
  tc: TestCaseRow; isEditorUp: boolean; activeTab: TabName; panel: unknown; dialog?: unknown;
}

function DetailPageShell(props: DetailPageShellProps) {
  const { project, tc, isEditorUp, activeTab, panel, dialog } = props;
  const listUrl = `/projects/${project.id}/testcases`;
  const breadcrumb = [
    { label: 'プロジェクト', href: '/projects' },
    { label: project.name, href: listUrl },
    { label: 'テストケース', href: listUrl },
    { label: tc.title },
  ];
  return (
    <Layout title={tc.title} user={props.user} project={project} csrf={props.csrf} flash={props.flash} breadcrumb={breadcrumb}>
      <DetailHeader pid={project.id} tc={tc} isEditorUp={isEditorUp} />
      <TabBar pid={project.id} id={tc.id} active={activeTab} hasDrift={!!tc.drift} />
      <div id="tab-panel" data-testid="tab-panel">{panel}</div>
      {dialog}
    </Layout>
  );
}

/** S-10「エラー状態」テストケース未存在: page-404-title(project 未存在時と同じ内部規約を使い回す)。 */
function renderTestCaseNotFound(c: Context<AppEnv>, user: UserRow, csrf: string, project: ProjectRow | null) {
  return c.html(
    <Layout title="テストケースが見つかりません" user={user} project={project} csrf={csrf}>
      <div class="empty-state"><h1 data-testid="page-404-title">テストケースが見つかりません</h1></div>
    </Layout>,
    404,
  );
}

// --- 共通コンテキスト解決 ---

interface LoadedContext {
  kind: 'ok';
  deps: AppDeps;
  actor: Extract<Actor, { kind: 'user' }>;
  project: ProjectRow;
  tc: TestCaseRow;
  csrf: string;
  isEditorUp: boolean;
}
// response は Response | Promise<Response>(Hono の c.html() は JSX 引数の型上 Promise を返しうる
// シグネチャのため。呼び出し側の route ハンドラは async 関数なのでそのまま return して問題ない)。
type ContextResult = LoadedContext | { kind: 'response'; response: Response | Promise<Response> };

async function loadContext(c: Context<AppEnv>): Promise<ContextResult> {
  const deps = c.get('deps');
  const actor = c.get('actor');
  if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
  const csrf = await ensureCsrfCookie(c);
  const pid = requiredParam(c, 'pid');
  const id = requiredParam(c, 'id');

  const project = await deps.storage.getProject(orgScopeOf(actor), pid);
  if (!project) return { kind: 'response', response: renderProjectNotFound(c, actor.user, csrf) };

  const tc = await deps.storage.getTestCase(orgScopeOf(actor), pid, id);
  if (!tc) return { kind: 'response', response: renderTestCaseNotFound(c, actor.user, csrf, project) };

  const isEditorUp = ROLE_RANK[actor.user.role as Role] >= ROLE_RANK.editor;
  return { kind: 'ok', deps, actor, project, tc, csrf, isEditorUp };
}

async function renderTabPanel(p: {
  c: Context<AppEnv>; deps: AppDeps; project: ProjectRow; tc: TestCaseRow; isEditorUp: boolean; tab: TabName;
}) {
  const { c, deps, project, tc, isEditorUp, tab } = p;
  const scope = orgScopeOf(c.get('actor'));
  const pid = project.id;
  const id = tc.id;

  switch (tab) {
    case 'gherkin':
      return <GherkinTabContent tc={tc} />;
    case 'diff': {
      const latestObs = await deps.storage.getLatestCommittedObservation(scope, pid, id);
      const diffData: DiffViewData = toDiffJson(tc, latestObs);
      return <DiffTabContent pid={pid} id={id} isEditorUp={isEditorUp} diff={diffData} />;
    }
    case 'history': {
      const cursor = c.req.query('cursor') || undefined;
      // S-14 は既定 limit を「実装で決定」としているため 20 をデフォルトにするが、S-08 一覧と同じ
      // 規約で `?limit=` の上書きも受理する(1〜100。テスト容易性・将来の柔軟性のため)。
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? Math.floor(limitRaw) : 20;
      const paged = await deps.storage.listHistory(scope, pid, id, { cursor, limit });
      return <HistoryTabContent pid={pid} id={id} limit={limit} paged={paged} />;
    }
    case 'identities': {
      const items = await deps.storage.listIdentities(scope, pid, id);
      return <IdentityTabContent items={items} />;
    }
    default:
      return <BasicInfoView tc={tc} />;
  }
}

// --- ステータス確認ダイアログ ---

interface StatusDialogSpec { testid: string; title: string; body: string; confirmLabel: string }

function statusDialogSpec(from: Status, to: Status): StatusDialogSpec {
  if (to === 'archived') {
    return { testid: 'dialog-confirm-archive', title: 'アーカイブ', body: 'このテストケースをアーカイブしますか？', confirmLabel: 'アーカイブ' };
  }
  if (from === 'archived' && to === 'draft') {
    return { testid: 'dialog-confirm-restore', title: '復帰', body: 'このテストケースを復帰しますか？', confirmLabel: '復帰' };
  }
  if (from === 'approved' && to === 'draft') {
    return { testid: 'dialog-confirm-revert', title: 'ステータスの変更', body: '承認を取り消し、下書きに戻しますか？', confirmLabel: '差し戻し' };
  }
  return { testid: 'dialog-confirm-approve', title: 'ステータスの変更', body: 'このテストケースを承認しますか？', confirmLabel: '承認' };
}

function statusFlashKey(from: Status, to: Status): string {
  if (to === 'archived') return 'testcase_status_archived';
  if (from === 'archived' && to === 'draft') return 'testcase_status_restored';
  if (from === 'approved' && to === 'draft') return 'testcase_status_reverted';
  return 'testcase_status_approved';
}

function StatusConfirmDialog(props: { pid: string; id: string; csrf: string; version: number; to: Status; spec: StatusDialogSpec }) {
  const { pid, id, csrf, version, to, spec } = props;
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true" data-testid={spec.testid}>
        <h2>{spec.title}</h2>
        <p>{spec.body}</p>
        <form method="post" action={`/projects/${pid}/testcases/${id}/status`} data-validate data-testid="status-confirm-form">
          <input type="hidden" name="_csrf" value={csrf} />
          <input type="hidden" name="to" value={to} />
          <input type="hidden" name="version" value={version} />
          <div class="dialog-actions">
            <a
              href={`/projects/${pid}/testcases/${id}`} class="btn btn-secondary"
              data-testid="btn-dialog-cancel" data-dialog-cancel="true"
            >
              キャンセル
            </a>
            <button type="submit" class="btn btn-primary" data-testid="btn-dialog-confirm">{spec.confirmLabel}</button>
          </div>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: DIALOG_CLOSE_SCRIPT }}></script>
    </div>
  );
}

// --- ルート ---

export const testCaseDetailRoutes = new Hono<AppEnv>()
  // S-10: viewer 以上。HX-Request なら #tab-panel の中身のみ(基本情報タブ含む全タブ共通の規約)。
  .get('/projects/:pid/testcases/:id', requirePageAuth({ minRole: 'viewer' }), async (c) => {
    const ctx = await loadContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { deps, project, tc, csrf, isEditorUp, actor } = ctx;
    const tab = normalizeTab(c.req.query('tab'));
    const panel = await renderTabPanel({ c, deps, project, tc, isEditorUp, tab });

    if (c.req.header('HX-Request')) return c.html(panel as Parameters<typeof c.html>[0]);

    const flash = resolveFlash(c.req.query('flash'));
    return c.html(
      <DetailPageShell project={project} user={actor.user} csrf={csrf} flash={flash} tc={tc} isEditorUp={isEditorUp} activeTab={tab} panel={panel} />,
    );
  })

  // S-12/13/14/Identity タブフラグメント: viewer 以上。常に #tab-panel 用の bare フラグメントを返す
  // (このパスへは htmx の hx-get からのみ到達する想定。tabName 不明は normalizeTab の既定=基本情報)。
  .get('/projects/:pid/testcases/:id/tabs/:tabName', requirePageAuth({ minRole: 'viewer' }), async (c) => {
    const ctx = await loadContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { deps, project, tc, isEditorUp } = ctx;
    const tab = normalizeTab(c.req.param('tabName'));
    const panel = await renderTabPanel({ c, deps, project, tc, isEditorUp, tab });
    return c.html(panel as Parameters<typeof c.html>[0]);
  })

  // S-11: editor+。ownership=machine かつ ?confirmed=1 が無ければ machine 警告ゲートを表示する。
  .get('/projects/:pid/testcases/:id/edit', requirePageAuth({ minRole: 'editor' }), async (c) => {
    const ctx = await loadContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { project, tc, csrf, actor, isEditorUp } = ctx;
    const pid = project.id;
    const id = tc.id;
    const confirmed = c.req.query('confirmed') === '1';

    const panel = tc.ownership === 'machine' && !confirmed
      ? <MachineWarningDialog pid={pid} id={id} />
      : (
        <TestCaseEditForm
          pid={pid} id={id} csrf={csrf} version={tc.version} values={testCaseRowToFormValues(tc)} errors={{}}
          ownership={tc.ownership as Ownership}
        />
      );

    if (c.req.header('HX-Request')) return c.html(panel);

    const flash = resolveFlash(c.req.query('flash'));
    return c.html(
      <DetailPageShell project={project} user={actor.user} csrf={csrf} flash={flash} tc={tc} isEditorUp={isEditorUp} activeTab="basic-info" panel={panel} />,
    );
  })

  // S-11 保存: editor+ + CSRF。素のフォーム POST のまま(HTMX化しない。project-create/bulk と同じ
  // 理由: 303 リダイレクト本文がそのままスワップされる事故を避ける)。常に「200 の全ページ再描画」か
  // 「303 リダイレクト」のいずれかを返す。
  .post('/projects/:pid/testcases/:id/edit', requirePageAuth({ minRole: 'editor' }), csrfProtect(), async (c) => {
    const ctx = await loadContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { deps, project, tc: current, csrf, actor, isEditorUp } = ctx;
    const pid = project.id;
    const id = current.id;

    const rawBody = (await c.req.parseBody()) as RawBody;
    const formVersion = Number(readString(rawBody, 'version'));
    const values = parseTestCaseFormBody(rawBody);
    const fieldErrors = validateTestCaseForm(values);

    const rerender = (errors: TestCaseFormErrors, occConflict?: boolean) => {
      const panel = (
        <TestCaseEditForm
          pid={pid} id={id} csrf={csrf} version={Number.isFinite(formVersion) ? formVersion : current.version}
          values={values} errors={errors} occConflict={occConflict} ownership={current.ownership as Ownership}
        />
      );
      return c.html(
        <DetailPageShell project={project} user={actor.user} csrf={csrf} flash={null} tc={current} isEditorUp={isEditorUp} activeTab="basic-info" panel={panel} />,
        200,
      );
    };

    if (Object.keys(fieldErrors).length > 0) return rerender(fieldErrors);

    // review round 1 #2(Important): create ルート(testcase-form.tsx)は createTestCaseInput.safeParse
    // で parameters/metadata の byte 上限(LIMITS.parametersBytes/metadataBytes)を強制するが、この
    // 編集保存ルートは validateTestCaseForm(JS文字列長のみ)しか通していなかったため、SSR 編集フォーム
    // 経由でのみ byte 上限を回避できてしまっていた。API の PATCH(src/http/api/testcases.ts)が
    // zValidator('json', patchTestCaseInput, ...) を通すのと同じ検証をここでも行い、両ルートで
    // 上限を揃える。
    const patchInput = buildEditPatchInput(values);
    const parsed = patchTestCaseInput.safeParse(patchInput);
    if (!parsed.success) {
      const zodErrors = zodIssuesToFormErrors(parsed.error.issues);
      return rerender(zodErrors);
    }

    const patchResult = computeHumanPatch(current, parsed.data);
    // 編集フォームは status を送らないため canTransition 違反は構造上発生しない(型の discriminated
    // union を満たすための防御的分岐)。
    if (!patchResult.ok) return rerender({ form: 'この操作は許可されていません' });

    if (Object.keys(patchResult.changes).length === 0) {
      return c.redirect(`/projects/${pid}/testcases/${id}?flash=testcase_updated`, 303);
    }

    const now = deps.now();
    const historyEntries = buildHistoryEntries({
      changes: patchResult.changes, statusChange: null, actor: `user:${actor.user.id}`, now,
    }).map((e) => ({ action: e.action, delta: e.delta, actor: `user:${actor.user.id}` }));

    const result = await deps.storage.patchTestCase(orgScopeOf(actor), pid, id, {
      expectedVersion: Number.isFinite(formVersion) ? formVersion : -1,
      columnValues: patchResult.columnValues,
      ownershipTransition: patchResult.ownershipTransition,
      historyEntries,
      now,
    });

    if (result.kind === 'not_found') return renderTestCaseNotFound(c, actor.user, csrf, project);
    if (result.kind === 'conflict') return rerender({}, true);

    const flashKey = patchResult.ownershipTransition ? 'testcase_ownership_transitioned' : 'testcase_updated';
    return c.redirect(`/projects/${pid}/testcases/${id}?flash=${flashKey}`, 303);
  })

  // S-10 ステータス確認ダイアログ: editor+。to が現在値からの合法遷移でなければダイアログを開かない
  // (S-15 の bulk-confirm と同じ「改ざん/直リンクは静かにフォールバック」方針。injection耐性)。
  .get('/projects/:pid/testcases/:id/status-confirm', requirePageAuth({ minRole: 'editor' }), async (c) => {
    const ctx = await loadContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { deps, project, tc, csrf, actor, isEditorUp } = ctx;
    const pid = project.id;
    const id = tc.id;
    const isHx = !!c.req.header('HX-Request');
    const fromStatus = tc.status as Status;
    const toRaw = c.req.query('to') ?? '';
    const validTo = (STATUSES as readonly string[]).includes(toRaw) ? (toRaw as Status) : null;

    if (!validTo || validTo === fromStatus || !canTransition(fromStatus, validTo)) {
      if (isHx) return c.body(null, 204);
      return c.redirect(`/projects/${pid}/testcases/${id}`, 303);
    }

    const spec = statusDialogSpec(fromStatus, validTo);
    const dialog = <StatusConfirmDialog pid={pid} id={id} csrf={csrf} version={tc.version} to={validTo} spec={spec} />;
    if (isHx) return c.html(dialog);

    const panel = await renderTabPanel({ c, deps, project, tc, isEditorUp, tab: 'basic-info' });
    return c.html(
      <DetailPageShell project={project} user={actor.user} csrf={csrf} flash={null} tc={tc} isEditorUp={isEditorUp} activeTab="basic-info" panel={panel} dialog={dialog} />,
    );
  })

  // S-10 ステータス変更実行: editor+ + CSRF。素のフォーム POST(常に 303 リダイレクト)。
  .post('/projects/:pid/testcases/:id/status', requirePageAuth({ minRole: 'editor' }), csrfProtect(), async (c) => {
    const ctx = await loadContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { deps, project, tc: current, csrf, actor } = ctx;
    const pid = project.id;
    const id = current.id;

    const rawBody = (await c.req.parseBody()) as RawBody;
    const toRaw = readString(rawBody, 'to');
    const formVersion = Number(readString(rawBody, 'version'));
    const validTo = (STATUSES as readonly string[]).includes(toRaw) ? (toRaw as Status) : undefined;

    const patchResult = computeHumanPatch(current, { status: validTo });
    if (!validTo || !patchResult.ok) {
      return c.redirect(`/projects/${pid}/testcases/${id}?flash=testcase_status_invalid`, 303);
    }
    if (Object.keys(patchResult.changes).length === 0) {
      return c.redirect(`/projects/${pid}/testcases/${id}`, 303);
    }

    const now = deps.now();
    const historyEntries = buildHistoryEntries({
      changes: patchResult.changes, statusChange: patchResult.statusChange, actor: `user:${actor.user.id}`, now,
    }).map((e) => ({ action: e.action, delta: e.delta, actor: `user:${actor.user.id}` }));

    const result = await deps.storage.patchTestCase(orgScopeOf(actor), pid, id, {
      expectedVersion: Number.isFinite(formVersion) ? formVersion : -1,
      columnValues: patchResult.columnValues,
      ownershipTransition: patchResult.ownershipTransition,
      historyEntries,
      now,
    });

    if (result.kind === 'not_found') return renderTestCaseNotFound(c, actor.user, csrf, project);
    if (result.kind === 'conflict') return c.redirect(`/projects/${pid}/testcases/${id}?flash=occ_conflict`, 303);

    const flashKey = statusFlashKey(current.status as Status, validTo);
    return c.redirect(`/projects/${pid}/testcases/${id}?flash=${flashKey}`, 303);
  })

  // S-12 accept-fingerprint 確認ダイアログ: editor+。drift=false ならダイアログを開かない。
  .get('/projects/:pid/testcases/:id/accept-fingerprint-confirm', requirePageAuth({ minRole: 'editor' }), async (c) => {
    const ctx = await loadContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { deps, project, tc, csrf, actor, isEditorUp } = ctx;
    const pid = project.id;
    const id = tc.id;
    const isHx = !!c.req.header('HX-Request');

    if (!tc.drift) {
      if (isHx) return c.body(null, 204);
      return c.redirect(`/projects/${pid}/testcases/${id}?tab=diff`, 303);
    }

    const dialog = <AcceptFingerprintConfirmDialog pid={pid} id={id} csrf={csrf} version={tc.version} />;
    if (isHx) return c.html(dialog);

    const panel = await renderTabPanel({ c, deps, project, tc, isEditorUp, tab: 'diff' });
    return c.html(
      <DetailPageShell project={project} user={actor.user} csrf={csrf} flash={null} tc={tc} isEditorUp={isEditorUp} activeTab="diff" panel={panel} dialog={dialog} />,
    );
  })

  // S-12 accept-fingerprint 実行: editor+ + CSRF。素のフォーム POST(常に 303 リダイレクト。diff タブへ)。
  .post('/projects/:pid/testcases/:id/accept-fingerprint', requirePageAuth({ minRole: 'editor' }), csrfProtect(), async (c) => {
    const ctx = await loadContext(c);
    if (ctx.kind === 'response') return ctx.response;
    const { deps, project, csrf, actor } = ctx;
    const pid = project.id;
    const id = c.req.param('id');

    const rawBody = (await c.req.parseBody()) as RawBody;
    const formVersion = Number(readString(rawBody, 'version'));
    const result = await deps.storage.acceptFingerprint(
      orgScopeOf(actor), pid, id, Number.isFinite(formVersion) ? formVersion : -1, `user:${actor.user.id}`, deps.now(),
    );

    const base = `/projects/${pid}/testcases/${id}?tab=diff`;
    if (result.kind === 'not_found') return renderTestCaseNotFound(c, actor.user, csrf, project);
    if (result.kind === 'no_drift') return c.redirect(`${base}&flash=testcase_no_drift`, 303);
    if (result.kind === 'conflict') return c.redirect(`${base}&flash=occ_conflict`, 303);
    return c.redirect(`${base}&flash=testcase_drift_accepted`, 303);
  });
