// src/http/ui/testcase-list.tsx
// S-08 テストケース一覧(docs/screens/testcase/S-08-testcase-list.md。要素カタログが最大の画面)+
// S-15 一括操作確認ダイアログ(docs/screens/testcase/S-15-bulk-operation-confirm.md)。
// task-19-brief.md。スペック D-01(sync/status)・D-03(exact total・cursor pagination・前へ廃止)。
//
// ビジネスロジックは既存の Storage 直呼び出し(task-18 で確立した「承認済みアプローチ A」をそのまま
// 踏襲: listTestCases/syncStatus/bulkAction はいずれも読み取り専用または API ルートと同一の
// Storage 呼び出しであり、追加のドメインルールが無いため src/domain/services/testcase-service.ts の
// 抽出は行わない。判断根拠はタスク報告に明記)。
//
// HTMX フラグメット設計: GET /projects/:pid/testcases の HX-Request 応答は
// `#testcase-list-section` 1個(同期サマリー+フィルタ+件数+一括操作バー+テーブル+ページネーション)を
// まるごと返す(「一覧セクション」= クエリ結果に依存する部分全体、という解釈。ヘッダー行の
// 「← プロジェクト名」「+ 新規作成」はクエリに依存しない静的chromeのため外側に置く)。
// フィルタの各コントロール・ページネーションリンク・同期サマリー件数リンクは、いずれもこの
// `#testcase-list-section` を hx-target + hx-swap="outerHTML" + hx-push-url="true" で
// 差し替える(ブラウザ URL に反映 = D-03「前へはブラウザ履歴」の前提)。
//
// FORM_ENHANCE 再エンハンス(notes.md T19/T20 申し送り): S-15 ダイアログの `bulk-confirm-form` は
// #dialog-root への HTMX フラグメントスワップで挿入されるため、layout.tsx 側に追加した
// htmx:afterSwap リスナ(冪等ガード付き)が無いと「送信中は disabled+スピナー」が効かない。
// 本タスクで layout.tsx の FORM_ENHANCE_SCRIPT にそのリスナを追加済み(このファイル側の追加対応は不要)。
//
// 進捗的機能拡張: フィルタ(素の <form method=get> + 送信ボタンの no-JS フォールバック)とページネーション
// (素の <a href>)は JS 無しで動作する。一括操作バーは S-08 自身が「選択時表示は最小 JS」を許容して
// いる箇所であり、チェックボックス選択→ドロップダウン→S-15 確認ダイアログの一連は JS(HTMX)前提とする
// (無条件の no-JS 対応は本タスクのスコープ外と判断。タスク報告に明記)。
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { ROLE_RANK } from '../app';
import { AppError } from '../errors';
import { csrfProtect } from '../middleware/csrf';
import { ensureCsrfCookie, requirePageAuth } from '../middleware/page-auth';
import { orgScopeOf } from '../middleware/scope';
import { resolveFlash, type Flash } from './flash';
import { Layout } from './layout';
import { LIMITS } from '../../schemas/limits';
import { bulkInput } from '../../schemas/api';
import { STATUSES, CATEGORIES, OWNERSHIPS, BULK_ACTIONS } from '../../schemas/enums';
import type { Status, Category, Ownership, BulkAction, Role } from '../../schemas/enums';
import type { ProjectRow, TestCaseRow, UserRow } from '../../storage/schema';
import type { Paged, TestCaseFilters, SyncStatusResult } from '../../storage/interface';

/** S-08 はページサイズ選択 UI を持たない(要素カタログに無い)ため固定値。`?limit=` での
 * 上書きは(UI からは露出しないが)API と同じ 1〜100 の範囲で受理する(統合テストの利便性・
 * 将来の柔軟性のため。listTestCasesQuery と同じ上限)。 */
const PAGE_SIZE = 20;

// --- 表示ラベル(GC-1: S-08 ワイヤーフレームは status を生の英語(draft/approved/archived)で、
// category を日本語略称(正常/異常/境界/ｴﾗ-)で表示している。S-10-testcase-detail.md の
// display-category は「正常系/異常系/境界値/エラーハンドリング」というフルの日本語ラベルを明示して
// いるため、カテゴリは「セル=略称・フィルタ選択肢=フル表記」の2形態を用意し、S-10 と語彙を揃える) ---
const CATEGORY_SHORT: Record<Category, string> = { normal: '正常', abnormal: '異常', boundary: '境界', error_handling: 'エラー' };
const CATEGORY_LABEL: Record<Category, string> = {
  normal: '正常系', abnormal: '異常系', boundary: '境界値', error_handling: 'エラーハンドリング',
};
const ACTION_LABEL: Record<BulkAction, string> = { approve: '承認', archive: 'アーカイブ', restore: '復帰' };

/** epoch ms → "YYYY-MM-DD HH:mm"。UTC 固定で算出する(サーバ実行環境の TZ に依存させず、
 * テストの決定性も確保するため)。 */
function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** cell-updated-{id}(S-08「相対時刻表示（例: 2時間前）」)。閾値を跨いだ古い日時は絶対表記に落とす。 */
function formatRelativeTime(epochMs: number, now: number): string {
  const diff = Math.max(0, now - epochMs);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < MIN) return 'たった今';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}分前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}時間前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}日前`;
  return formatDateTime(epochMs);
}

// --- クエリ ⇄ URL ---

interface ParsedFilters {
  status?: Status;
  category?: Category;
  ownership?: Ownership;
  drift?: boolean;
  isStale?: boolean;
  target?: string;
}
interface ParsedQuery { filters: ParsedFilters; cursor?: string; limit: number }

/**
 * GET のクエリを寛容にパースする(zValidator は使わない: UI ページで 422 JSON を返すのは
 * UI タスク共通事項の「UI エラーは HTML/リダイレクトで返す」方針と食い違うため)。フィルタの
 * `<select>` は "all" を既定値として送信する(S-08 の選択肢定義どおり)。"all"・未指定・不正値は
 * いずれも「フィルタ無し」に丸める(decodeCursor が不正カーソルを null にフォールバックするのと
 * 同じ「寛容パース」の思想)。
 */
function parseListQuery(c: Context<AppEnv>): ParsedQuery {
  const status = c.req.query('status');
  const category = c.req.query('category');
  const ownership = c.req.query('ownership');
  const drift = c.req.query('drift');
  const isStale = c.req.query('is_stale');
  const target = c.req.query('target');
  const cursor = c.req.query('cursor');
  const limitRaw = Number(c.req.query('limit'));

  return {
    filters: {
      status: (STATUSES as readonly string[]).includes(status ?? '') ? (status as Status) : undefined,
      category: (CATEGORIES as readonly string[]).includes(category ?? '') ? (category as Category) : undefined,
      ownership: (OWNERSHIPS as readonly string[]).includes(ownership ?? '') ? (ownership as Ownership) : undefined,
      drift: drift === 'true' ? true : drift === 'false' ? false : undefined,
      isStale: isStale === 'true' ? true : isStale === 'false' ? false : undefined,
      target: target ? target.slice(0, LIMITS.target) : undefined,
    },
    cursor: cursor || undefined,
    limit: Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? Math.floor(limitRaw) : PAGE_SIZE,
  };
}

function hasActiveFilter(f: ParsedFilters): boolean {
  return !!(f.status || f.category || f.ownership || f.drift !== undefined || f.isStale !== undefined || f.target);
}

interface ListUrlParams {
  status?: string;
  category?: string;
  ownership?: string;
  drift?: boolean;
  is_stale?: boolean;
  target?: string;
  cursor?: string;
  limit?: number;
}

/** フィルタ/カーソル/limit を URL クエリへ組み立てる(ページネーション・同期サマリーのリンク先。
 * 「URL のクエリパラメータにフィルタ状態を反映(ブラウザバック・共有対応)」を満たす)。 */
function buildListUrl(pid: string, params: ListUrlParams): string {
  const sp = new URLSearchParams();
  if (params.status) sp.set('status', params.status);
  if (params.category) sp.set('category', params.category);
  if (params.ownership) sp.set('ownership', params.ownership);
  if (params.drift !== undefined) sp.set('drift', String(params.drift));
  if (params.is_stale !== undefined) sp.set('is_stale', String(params.is_stale));
  if (params.target) sp.set('target', params.target);
  if (params.cursor) sp.set('cursor', params.cursor);
  if (params.limit !== undefined) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  return `/projects/${pid}/testcases${qs ? `?${qs}` : ''}`;
}

function toUrlFilters(f: ParsedFilters): ListUrlParams {
  return { status: f.status, category: f.category, ownership: f.ownership, drift: f.drift, is_stale: f.isStale, target: f.target };
}

// --- インライン JS(S-08「一括操作バー(選択時表示は最小 JS)」の許容範囲) ---

/**
 * 一括操作バー: チェックボックス変更で選択件数表示・一括操作ボタンの有効化・全選択トグルを行う。
 * document への委譲 + 冪等ガード(既存の DIALOG_ESCAPE_SCRIPT と同じ流儀)により、HTMX が
 * #testcase-list-section をスワップし直して <script> が再実行されても、リスナーは1つしか
 * 貼られない。委譲イベントのため、スワップ後の新しい行のチェックボックスにも改めて
 * querySelectorAll し直す必要がない(常にイベント発火時点の生 DOM を見る)。
 */
const BULK_BAR_SCRIPT = `
(function () {
  if (window.__tmsBulkBarBound) return;
  window.__tmsBulkBarBound = true;
  function rowBoxes() { return Array.prototype.slice.call(document.querySelectorAll('input[name="ids[]"]')); }
  function refresh() {
    var boxes = rowBoxes();
    var n = boxes.filter(function (b) { return b.checked; }).length;
    var countEl = document.querySelector('[data-testid="selected-count"]');
    if (countEl) countEl.textContent = '選択中: ' + n + '件';
    var btn = document.querySelector('[data-testid="btn-bulk-action"]');
    if (btn) btn.disabled = n === 0;
    var selectAll = document.querySelector('[data-testid="checkbox-select-all"]');
    if (selectAll) selectAll.checked = boxes.length > 0 && n === boxes.length;
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('[data-testid="checkbox-select-all"]')) {
      rowBoxes().forEach(function (b) { b.checked = t.checked; });
      refresh();
    } else if (t.matches('input[name="ids[]"]')) {
      refresh();
    }
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-testid="btn-bulk-action"]')) {
      var list = t.parentElement && t.parentElement.querySelector('.bulk-action-list');
      if (list) list.hidden = !list.hidden;
    }
  });
})();
`;

/**
 * S-15 ダイアログの close(キャンセルボタン/Escape/背景クリックのいずれも同じ「選択状態は維持」)。
 * projects-pages.tsx の DIALOG_ESCAPE_SCRIPT は `/projects` への固定リダイレクト(ページ遷移)であり、
 * bulk-confirm では選択中チェックボックスの状態を壊してはいけないため流用できない
 * (#dialog-root を空にするだけで下の一覧 DOM には触れない)。ダイアログ単位で完結する小さな
 * スクリプトの意図的な重複であり、共通化の余地はタスク報告に明記する。
 */
const BULK_DIALOG_CLOSE_SCRIPT = `
(function () {
  if (window.__tmsBulkDialogBound) return;
  window.__tmsBulkDialogBound = true;
  function closeDialog() {
    var root = document.getElementById('dialog-root');
    if (root) root.innerHTML = '';
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.querySelector('.dialog-backdrop')) closeDialog();
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('[data-dialog-cancel]')) { e.preventDefault(); closeDialog(); return; }
    if (t.matches('.dialog-backdrop')) closeDialog();
  });
})();
`;

// --- 同期サマリーパネル ---

function SyncSummaryPanel(props: { pid: string; status: SyncStatusResult }) {
  const { origins, current } = props.status;
  const linkAttrs = (params: ListUrlParams) => ({
    href: buildListUrl(props.pid, params),
    'hx-get': buildListUrl(props.pid, params),
    'hx-target': '#testcase-list-section',
    'hx-swap': 'outerHTML',
    'hx-push-url': 'true',
  }) as const;

  return (
    <div class="sync-summary" data-testid="sync-summary">
      {origins.map((o) => (
        <div class="sync-summary-origin">
          <span class="sync-summary-origin-name">{o.origin}</span>
          <span data-testid={`sync-last-time-${o.origin}`}>最終同期: {formatDateTime(o.lastCommittedAt)}</span>
          <span>
            (新規 {o.lastSummary.created} / 変更 {o.lastSummary.changed} / stale {o.lastSummary.staled})
          </span>
        </div>
      ))}
      <div class="sync-summary-counts">
        <a data-testid="sync-new-count" {...linkAttrs({ status: 'draft', ownership: 'machine' })}>新規: {current.unreviewed}件</a>
        <a data-testid="sync-drift-count" {...linkAttrs({ drift: true })}>drift: {current.drift}件</a>
        <a data-testid="sync-stale-count" {...linkAttrs({ is_stale: true })}>stale: {current.stale}件</a>
      </div>
    </div>
  );
}

// --- フィルタフォーム ---

function FilterSelect(props: {
  testid: string;
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  current: string | undefined;
  hxAttrs: Record<string, string>;
}) {
  return (
    <div class="field">
      <label for={props.testid}>{props.label}</label>
      <select id={props.testid} name={props.name} data-testid={props.testid} {...props.hxAttrs}>
        <option value="all" selected={props.current === undefined}>すべて</option>
        {props.options.map((o) => (
          <option value={o.value} selected={props.current === o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * S-08 フィルタパネル。素の `<form method=get>`(no-JS フォールバック: `btn-apply-filters` で
 * 明示送信)を土台に、各コントロールへ `hx-get`(HTMX が有効なら change/keyup で自動送信)を重ねる。
 * 各コントロールが同一 `<form>` 内にあるため、HTMX は「最も近い祖先 form の全フィールド値」を
 * 自動的にリクエストへ含める(= 個別に hx-include を書く必要がない)。カーソルはこのフォームの
 * フィールドに存在しないため、フィルタ変更のたびに自然とリセットされる(cursorの hidden input を
 * 意図的に置かない)。
 */
function FilterForm(props: { pid: string; filters: ParsedFilters }) {
  const { filters, pid } = props;
  const action = `/projects/${pid}/testcases`;
  const hxAttrs = {
    'hx-get': action, 'hx-target': '#testcase-list-section', 'hx-swap': 'outerHTML', 'hx-push-url': 'true',
  } as const;

  return (
    <div class="filter-panel">
      <form method="get" action={action} class="filter-form" data-testid="filter-form">
        <FilterSelect
          testid="filter-status" name="status" label="ステータス" current={filters.status} hxAttrs={hxAttrs}
          options={STATUSES.map((s) => ({ value: s, label: s }))}
        />
        <FilterSelect
          testid="filter-category" name="category" label="カテゴリ" current={filters.category} hxAttrs={hxAttrs}
          options={CATEGORIES.map((cat) => ({ value: cat, label: CATEGORY_LABEL[cat] }))}
        />
        <FilterSelect
          testid="filter-ownership" name="ownership" label="所有権" current={filters.ownership} hxAttrs={hxAttrs}
          options={OWNERSHIPS.map((o) => ({ value: o, label: o }))}
        />
        <FilterSelect
          testid="filter-drift" name="drift" label="drift" hxAttrs={hxAttrs}
          current={filters.drift === undefined ? undefined : String(filters.drift)}
          options={[{ value: 'true', label: 'あり' }, { value: 'false', label: 'なし' }]}
        />
        <FilterSelect
          testid="filter-stale" name="is_stale" label="stale" hxAttrs={hxAttrs}
          current={filters.isStale === undefined ? undefined : String(filters.isStale)}
          options={[{ value: 'true', label: 'あり' }, { value: 'false', label: 'なし' }]}
        />
        <div class="field">
          <label for="filter-target">target</label>
          <input
            id="filter-target" name="target" type="text" value={filters.target ?? ''}
            placeholder="クラス・メソッド名で絞り込み" data-testid="filter-target"
            {...hxAttrs} hx-trigger="keyup changed delay:300ms, change"
          />
        </div>
        <button type="submit" class="btn btn-secondary" data-testid="btn-apply-filters">絞り込む</button>
      </form>
      {/* clear リンクは <form> の外に置く: HTMX は「最も近い祖先 form の全フィールド値」を自動的に
          リクエストに含めるため、form 内に置くと「現在の(クリアされていない)値」を道連れにしたまま
          リクエストしてしまい、見た目上クリアされない事故になる。 */}
      <a
        href={`/projects/${pid}/testcases`} class="hint" data-testid="btn-clear-filters"
        hx-get={`/projects/${pid}/testcases`} hx-target="#testcase-list-section" hx-swap="outerHTML" hx-push-url="true"
      >
        フィルタをクリア
      </a>
    </div>
  );
}

// --- 一括操作バー ---

function BulkBar(props: { pid: string }) {
  const hxAttrs = { 'hx-target': '#dialog-root', 'hx-swap': 'innerHTML' } as const;
  return (
    <div class="bulk-bar" data-testid="bulk-bar">
      <label class="bulk-bar-select-all">
        <input type="checkbox" data-testid="checkbox-select-all" />
        全選択
      </label>
      <span data-testid="selected-count">選択中: 0件</span>
      <div class="bulk-action-menu">
        {/* 選択0件が既定(SSR 時点で選択状態は必ず空)のため disabled で描画する。BULK_BAR_SCRIPT が
            チェック変更のたびに enabled/disabled を切り替える。 */}
        <button type="button" disabled class="btn btn-secondary" data-testid="btn-bulk-action">承認 ▼</button>
        <div class="bulk-action-list" hidden>
          <button
            type="button" data-testid="bulk-action-approve"
            hx-get={`/projects/${props.pid}/testcases/bulk-confirm?action=approve`}
            hx-include="[name='ids[]']:checked" {...hxAttrs}
          >
            承認
          </button>
          <button
            type="button" data-testid="bulk-action-archive"
            hx-get={`/projects/${props.pid}/testcases/bulk-confirm?action=archive`}
            hx-include="[name='ids[]']:checked" {...hxAttrs}
          >
            アーカイブ
          </button>
          <button
            type="button" data-testid="bulk-action-restore"
            hx-get={`/projects/${props.pid}/testcases/bulk-confirm?action=restore`}
            hx-include="[name='ids[]']:checked" {...hxAttrs}
          >
            復帰
          </button>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: BULK_BAR_SCRIPT }}></script>
    </div>
  );
}

// --- テーブル ---

function TestCaseTable(props: { pid: string; items: TestCaseRow[]; isEditorUp: boolean; now: number }) {
  return (
    <table data-testid="testcase-table">
      <thead>
        <tr>
          {props.isEditorUp && <th></th>}
          <th data-testid="th-title">タイトル</th>
          <th data-testid="th-target">target</th>
          <th data-testid="th-category">カテゴリ</th>
          <th data-testid="th-status">ステータス</th>
          <th data-testid="th-updated">更新日時</th>
        </tr>
      </thead>
      <tbody>
        {props.items.map((row) => {
          const category = row.category as Category;
          const updatedAt = Math.max(row.humanUpdatedAt ?? 0, row.systemUpdatedAt ?? 0, row.createdAt);
          return (
            <tr class="testcase-row" data-testid={`testcase-row-${row.id}`}>
              {props.isEditorUp && (
                <td>
                  <input type="checkbox" name="ids[]" value={row.id} data-testid={`checkbox-row-${row.id}`} />
                </td>
              )}
              <td>
                <a
                  href={`/projects/${props.pid}/testcases/${row.id}`} class="cell-title"
                  data-testid={`cell-title-${row.id}`} title={row.title}
                >
                  {row.title}
                </a>
              </td>
              <td data-testid={`cell-target-${row.id}`}>{row.target ?? '—'}</td>
              <td>
                <span class="badge" data-testid={`cell-category-${row.id}`}>{CATEGORY_SHORT[category]}</span>
              </td>
              <td>
                <span class={`badge badge-${row.status}`} data-testid={`cell-status-${row.id}`}>{row.status}</span>{' '}
                <span class="ownership-icon" data-testid={`cell-ownership-${row.id}`}>
                  {row.ownership === 'machine' ? '👻' : '👤'}
                </span>{' '}
                {!!row.drift && <span class="badge badge-drift" data-testid={`badge-drift-${row.id}`}>⚡</span>}{' '}
                {!!row.isStale && <span class="badge badge-stale" data-testid={`badge-stale-${row.id}`}>🔺</span>}
              </td>
              <td data-testid={`cell-updated-${row.id}`}>{formatRelativeTime(updatedAt, props.now)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- 一覧セクション(HX-Request の応答フラグメント本体) ---

interface TestCaseListSectionProps {
  pid: string;
  isEditorUp: boolean;
  filters: ParsedFilters;
  cursor?: string;
  limit: number;
  paged: Paged<TestCaseRow>;
  syncStatus: SyncStatusResult;
  now: number;
}

function TestCaseListSection(props: TestCaseListSectionProps) {
  const { pid, filters, paged, syncStatus, isEditorUp, now, cursor, limit } = props;
  const active = hasActiveFilter(filters);
  const isEmpty = paged.items.length === 0;
  const urlFilters = toUrlFilters(filters);

  return (
    <div id="testcase-list-section" data-testid="testcase-list-section">
      {syncStatus.origins.length > 0 && <SyncSummaryPanel pid={pid} status={syncStatus} />}
      <FilterForm pid={pid} filters={filters} />
      <p class="testcase-count-line">
        該当件数: <span data-testid="testcase-count">{paged.total}</span>件
      </p>

      {isEditorUp && !isEmpty && <BulkBar pid={pid} />}

      {isEmpty ? (
        active ? (
          <div class="empty-state" data-testid="empty-state-filtered">
            <p>該当するテストケースがありません</p>
            <p class="hint">上のフィルタをクリアすると全件を表示できます</p>
          </div>
        ) : (
          <div class="empty-state" data-testid="empty-state">
            <p>テストケースがありません</p>
            {isEditorUp && (
              <a href={`/projects/${pid}/testcases/new`} class="btn btn-primary" data-testid="empty-state-create">
                最初のテストケースを作成しましょう
              </a>
            )}
          </div>
        )
      ) : (
        <div class="testcase-results">
          <TestCaseTable pid={pid} items={paged.items} isEditorUp={isEditorUp} now={now} />
          <div class="pagination" data-testid="pagination">
            {cursor && (
              <a
                href={buildListUrl(pid, { ...urlFilters, limit })}
                hx-get={buildListUrl(pid, { ...urlFilters, limit })}
                hx-target="#testcase-list-section" hx-swap="outerHTML" hx-push-url="true"
                class="btn btn-secondary" data-testid="link-back-to-top"
              >
                先頭に戻る
              </a>
            )}
            {paged.hasMore && paged.nextCursor ? (
              <a
                href={buildListUrl(pid, { ...urlFilters, cursor: paged.nextCursor, limit })}
                hx-get={buildListUrl(pid, { ...urlFilters, cursor: paged.nextCursor, limit })}
                hx-target="#testcase-list-section" hx-swap="outerHTML" hx-push-url="true"
                class="btn btn-secondary" data-testid="btn-next-page"
              >
                次へ
              </a>
            ) : (
              // D-03: 前へボタンは廃止(GC-1 乖離メモ参照)。has_more=false 時の「次へ」は、ネイティブに
              // disabled 属性を持てる <a> が無いため <span aria-disabled> で非活性表現する。
              <span class="btn btn-secondary" aria-disabled="true" data-testid="btn-next-page">次へ</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- S-15 一括操作確認ダイアログ ---

function BulkConfirmDialog(props: { pid: string; csrf: string; action: BulkAction; ids: string[] }) {
  const label = ACTION_LABEL[props.action];
  return (
    <div class="dialog-backdrop" data-testid="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-confirm-title-h" data-testid="bulk-confirm-dialog">
        <h2 id="bulk-confirm-title-h" data-testid="bulk-confirm-title">一括操作の確認</h2>
        <p>
          <span data-testid="bulk-confirm-count">{props.ids.length} 件のテストケースを</span>{' '}
          <span data-testid="bulk-confirm-action-name">「{label}」</span>しますか？
        </p>
        {props.action === 'approve' && (
          <ul class="bulk-confirm-warnings">
            <li data-testid="bulk-confirm-warning-ownership">所有権が machine のテストケースは human に遷移します</li>
            <li data-testid="bulk-confirm-warning-auto-update">以後 Discovery の自動更新が停止します</li>
          </ul>
        )}
        {props.action === 'archive' && (
          <ul class="bulk-confirm-warnings">
            <li data-testid="bulk-confirm-warning-archive">
              アーカイブしてもデータは削除されません。archived フィルタから確認・復帰できます
            </li>
          </ul>
        )}
        {props.action === 'restore' && (
          <ul class="bulk-confirm-warnings">
            <li data-testid="bulk-confirm-warning-restore">draft に戻り、再レビューが必要になります</li>
          </ul>
        )}
        <form method="post" action={`/projects/${props.pid}/testcases/bulk-ui`} data-validate data-testid="bulk-confirm-form">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <input type="hidden" name="action" value={props.action} />
          {props.ids.map((id) => <input type="hidden" name="ids[]" value={id} />)}
          <div class="dialog-actions">
            <a
              href={`/projects/${props.pid}/testcases`} class="btn btn-secondary"
              data-testid="bulk-confirm-cancel" data-dialog-cancel="true"
            >
              キャンセル
            </a>
            <button type="submit" class="btn btn-primary" data-testid="bulk-confirm-execute">実行</button>
          </div>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: BULK_DIALOG_CLOSE_SCRIPT }}></script>
    </div>
  );
}

// --- ページ全体 ---

interface TestCaseListPageProps {
  user: UserRow;
  csrf: string;
  project: ProjectRow;
  flash?: Flash | null;
  isEditorUp: boolean;
  filters: ParsedFilters;
  cursor?: string;
  limit: number;
  paged: Paged<TestCaseRow>;
  syncStatus: SyncStatusResult;
  now: number;
  dialog?: { action: BulkAction; ids: string[] } | null;
}

function TestCaseListPage(props: TestCaseListPageProps) {
  const { project, isEditorUp } = props;
  return (
    <Layout title="テストケース一覧" user={props.user} project={project} csrf={props.csrf} flash={props.flash ?? null}>
      <div class="page-header">
        <a href="/projects" data-testid="link-back-to-project">
          ← <span data-testid="project-name">{project.name}</span>
        </a>
        {isEditorUp && (
          <a href={`/projects/${project.id}/testcases/new`} class="btn btn-primary" data-testid="btn-create-testcase">
            + 新規作成
          </a>
        )}
      </div>
      <TestCaseListSection
        pid={project.id} isEditorUp={isEditorUp} filters={props.filters} cursor={props.cursor} limit={props.limit}
        paged={props.paged} syncStatus={props.syncStatus} now={props.now}
      />
      {props.dialog && (
        <BulkConfirmDialog pid={project.id} csrf={props.csrf} action={props.dialog.action} ids={props.dialog.ids} />
      )}
    </Layout>
  );
}

/**
 * docs/screens/testcase/S-08-testcase-list.md「エラー状態」: プロジェクト未存在/権限なし → 404 +
 * 「プロジェクトが見つかりません」。汎用エラーページの data-testid は docs/screens/ に定義が無いため
 * layout.tsx の renderForbiddenPage(page-403-title)と同じ流儀でこのタスク内で採番する(GC-8 の趣旨に
 * 沿った内部一貫性のため)。
 */
function renderProjectNotFound(c: Context<AppEnv>, user: UserRow, csrf: string) {
  return c.html(
    <Layout title="プロジェクトが見つかりません" user={user} csrf={csrf}>
      <div class="empty-state">
        <h1 data-testid="page-404-title">プロジェクトが見つかりません</h1>
      </div>
    </Layout>,
    404,
  );
}

/**
 * 一括操作結果のトースト文言(S-15「トースト・通知メッセージ」表を優先採用。GC-1 乖離メモ: S-08 の
 * 「トースト/通知メッセージ」表は部分エラー時の文言が「N件更新、M件でエラーが発生しました」だが、
 * S-15 は action 別に「{updated}件を{action}しました（{errors.length}件でエラー発生）」という
 * より詳細なテンプレートを与えている。本タスクの主眼はS-15(ダイアログ)のため、より具体的な
 * S-15 側のテンプレートを採用する(タスク報告に明記)。skipped>0 かつ errors>0 が同時に起きた場合の
 * 文言は docs に明記が無いため、errors を優先する(エラーの方が利用者への影響が大きいため警告種別を
 * 優先表示する、という本実装の判断)。
 */
function buildBulkFlash(action: BulkAction, result: { updated: number; skipped: number; errors: number }): Flash {
  const label = ACTION_LABEL[action];
  if (result.errors > 0) {
    return { kind: 'warn', text: `${result.updated}件を${label}しました（${result.errors}件でエラー発生）` };
  }
  if (result.skipped > 0) {
    return { kind: 'success', text: `${result.updated}件を${label}しました（${result.skipped}件はスキップ）` };
  }
  return { kind: 'success', text: `${result.updated}件のテストケースを${label}しました` };
}

/** POST /bulk-ui の 303 リダイレクトに載せた `?flash=bulk_result&action=...&updated=...` を読み戻す。
 * flash.ts の固定文言テーブルには乗らない動的カウント入りのメッセージのため、この画面内で
 * 専用に組み立てる(flash.ts 自体は変更しない)。 */
function buildBulkFlashFromQuery(c: Context<AppEnv>): Flash | null {
  const actionRaw = c.req.query('action') ?? '';
  const action = (BULK_ACTIONS as readonly string[]).includes(actionRaw) ? (actionRaw as BulkAction) : null;
  if (!action) return null;
  const updated = Number(c.req.query('updated') ?? '0') || 0;
  const skipped = Number(c.req.query('skipped') ?? '0') || 0;
  const errors = Number(c.req.query('errors') ?? '0') || 0;
  return buildBulkFlash(action, { updated, skipped, errors });
}

async function loadListData(c: Context<AppEnv>, project: ProjectRow, q: ParsedQuery) {
  const deps = c.get('deps');
  const scope = orgScopeOf(c.get('actor'));
  const filters: TestCaseFilters = {
    status: q.filters.status,
    category: q.filters.category,
    ownership: q.filters.ownership,
    drift: q.filters.drift,
    isStale: q.filters.isStale,
    target: q.filters.target,
  };
  const [paged, syncStatus] = await Promise.all([
    deps.storage.listTestCases(scope, project.id, filters, { cursor: q.cursor, limit: q.limit }),
    deps.storage.syncStatus(scope, project.id),
  ]);
  return { paged, syncStatus };
}

// --- ルート ---

export const testCasePageRoutes = new Hono<AppEnv>()
  // S-08: viewer 以上。HX-Request なら一覧セクションのみのフラグメント。
  .get('/projects/:pid/testcases', requirePageAuth({ minRole: 'viewer' }), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const pid = c.req.param('pid');
    const csrf = await ensureCsrfCookie(c);

    const project = await deps.storage.getProject(orgScopeOf(actor), pid);
    if (!project) return renderProjectNotFound(c, actor.user, csrf);

    const q = parseListQuery(c);
    const { paged, syncStatus } = await loadListData(c, project, q);
    const isEditorUp = ROLE_RANK[actor.user.role as Role] >= ROLE_RANK.editor;
    const now = deps.now();

    if (c.req.header('HX-Request')) {
      return c.html(
        <TestCaseListSection
          pid={pid} isEditorUp={isEditorUp} filters={q.filters} cursor={q.cursor} limit={q.limit}
          paged={paged} syncStatus={syncStatus} now={now}
        />,
      );
    }

    const flashKey = c.req.query('flash');
    const flash = flashKey === 'bulk_result' ? buildBulkFlashFromQuery(c) : resolveFlash(flashKey);

    return c.html(
      <TestCaseListPage
        user={actor.user} csrf={csrf} project={project} flash={flash}
        isEditorUp={isEditorUp} filters={q.filters} cursor={q.cursor} limit={q.limit}
        paged={paged} syncStatus={syncStatus} now={now}
      />,
    );
  })

  // S-15 ダイアログを開く(task-18 の GET /projects/new と同じ形で本タスクが新設。S-15 自身の doc は
  // 「URL: なし(S-08上のモーダル)」だが、SSR/HTMX でダイアログを取得するには何らかの URL が要る)。
  // editor+ のみ(一括操作そのものが editor+ のため)。
  .get('/projects/:pid/testcases/bulk-confirm', requirePageAuth({ minRole: 'editor' }), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const pid = c.req.param('pid');
    const csrf = await ensureCsrfCookie(c);

    const project = await deps.storage.getProject(orgScopeOf(actor), pid);
    if (!project) return renderProjectNotFound(c, actor.user, csrf);

    const idsRaw = c.req.queries('ids[]') ?? [];
    const ids = [...new Set(idsRaw)];
    const actionRaw = c.req.query('action') ?? '';
    const action = (BULK_ACTIONS as readonly string[]).includes(actionRaw) ? (actionRaw as BulkAction) : null;
    const isHx = !!c.req.header('HX-Request');

    if (ids.length === 0 || !action) {
      // 改ざん/直リンク等の不正リクエスト: ダイアログを開かず一覧へ(docs にこのエッジケースの
      // 定義は無いため、エラーを出さず穏当にフォールバックする本実装の判断)。
      if (isHx) return c.body(null, 204);
      return c.redirect(`/projects/${pid}/testcases`, 303);
    }

    if (isHx) {
      return c.html(<BulkConfirmDialog pid={pid} csrf={csrf} action={action} ids={ids} />);
    }

    // no-JS フォールバック: S-08 フルページの上にダイアログを開いた状態で描画する
    // (task-18-brief.md の GET /projects/new 非HX経路と同じパターン)。
    const q = parseListQuery(c);
    const { paged, syncStatus } = await loadListData(c, project, q);
    const isEditorUp = ROLE_RANK[actor.user.role as Role] >= ROLE_RANK.editor;
    return c.html(
      <TestCaseListPage
        user={actor.user} csrf={csrf} project={project}
        isEditorUp={isEditorUp} filters={q.filters} cursor={q.cursor} limit={q.limit}
        paged={paged} syncStatus={syncStatus} now={deps.now()}
        dialog={{ action, ids }}
      />,
    );
  })

  // S-15 実行: editor+ + CSRF。素のフォーム POST のまま(HTMX化しない): 成功時は303リダイレクトを
  // 返す(PRG)ため、もし hx-post で #dialog-root 等をターゲットにすると、リダイレクト先(フルページ)の
  // 本文がそのまま断片としてスワップされ `<html>` 丸ごと注入という事故になる
  // (task-18-brief.md の POST /projects と同じ既知の落とし穴。同じ理由で回避する)。
  .post('/projects/:pid/testcases/bulk-ui', requirePageAuth({ minRole: 'editor' }), csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const pid = c.req.param('pid');

    const project = await deps.storage.getProject(orgScopeOf(actor), pid);
    if (!project) return renderProjectNotFound(c, actor.user, await ensureCsrfCookie(c));

    const body = await c.req.parseBody();
    const idsRaw = body['ids[]'];
    const ids = idsRaw === undefined ? [] : Array.isArray(idsRaw) ? idsRaw.map(String) : [String(idsRaw)];
    const actionRaw = String(body.action ?? '');

    const parsed = bulkInput.safeParse({ ids, action: actionRaw });
    if (!parsed.success) {
      // 選択0件・不正な action(UI 上は選択0件で実行ボタンに到達できないため通常は改ざんケース)。
      // docs に対応するエラー状態の定義が無いため、エラーを出さず一覧へ戻す。
      return c.redirect(`/projects/${pid}/testcases`, 303);
    }

    const result = await deps.storage.bulkAction(
      orgScopeOf(actor), pid, parsed.data.ids, parsed.data.action, `user:${actor.user.id}`, deps.now(),
    );
    const qs = new URLSearchParams({
      flash: 'bulk_result',
      action: parsed.data.action,
      updated: String(result.updated),
      skipped: String(result.skipped),
      errors: String(result.errors.length),
    });
    return c.redirect(`/projects/${pid}/testcases?${qs.toString()}`, 303);
  });
