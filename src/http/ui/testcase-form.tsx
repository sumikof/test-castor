// src/http/ui/testcase-form.tsx
// S-09 テストケース作成(docs/screens/testcase/S-09-testcase-create.md)+ S-11 テストケース編集
// (docs/screens/testcase/S-11-testcase-edit.md)が共有するフォーム部品(要素カタログはほぼ同一。
// data-testid のプレフィックスのみ create='' / edit='edit-' で異なる)。task-20-brief.md。
//
// D-13-3(スペック正本・global-constraints.md「スペックが優先」): S-09 のアクションボタンは要素カタログに
// `btn-save-draft`(下書き保存)と `btn-create`(作成)の2つがあるが、両者は「status:draft で作成。
// 下書き保存と同義(MVPでは区別なし)」と明記されており、D-13-3 はこれを「作成」1ボタンに統合すると
// 決定している(UI タスク共通事項の除外リストにも明記)。本実装は `btn-create` のみを描画し
// `btn-save-draft` は描画しない(GC-1 突合メモ: タスク報告に明記)。
//
// パラメータ行(`<template>`+最小 inline JS で追加削除)・タグ入力(トークン入力の chip 追加削除)は
// ともに「JS 有効時のみ動的に追加/削除できる」progressive enhancement(task-20-brief.md 「ルート」欄・
// notes.md T17 レビュー所見と同じ考え方: no-JS でもサーバー検証は権威のまま機能するが、行/タグの
// 動的追加という UX 自体は JS 前提)。SSR 初期表示は create=0行/0タグ、edit=既存データそのままの行数/
// タグ数のみを描画する。
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { csrfProtect } from '../middleware/csrf';
import { ensureCsrfCookie, requirePageAuth } from '../middleware/page-auth';
import { orgScopeOf } from '../middleware/scope';
import { Layout } from './layout';
import { CATEGORY_LABEL, renderProjectNotFound } from './testcase-list';
import { LIMITS } from '../../schemas/limits';
import { createTestCaseInput } from '../../schemas/api';
import { CATEGORIES } from '../../schemas/enums';
import type { Category } from '../../schemas/enums';
import type { ProjectRow, UserRow, TestCaseRow } from '../../storage/schema';
import type { ParamRow } from '../../domain/testcase-rules';

// --- 値・エラーの型 ---

export interface ParamRowFormValue { name: string; inputs: string; expected: string }

export interface TestCaseFormValues {
  title: string;
  target: string;
  category: Category;
  given: string;
  when: string;
  then: string;
  parameters: ParamRowFormValue[];
  tags: string[];
}

/** キー: title/target/category/given/when/then/param-inputs-{i}/param-expected-{i}/form(バナー用)。 */
export type TestCaseFormErrors = Partial<Record<string, string>>;

export function emptyFormValues(): TestCaseFormValues {
  return { title: '', target: '', category: 'normal', given: '', when: '', then: '', parameters: [], tags: [] };
}

/** 既存の TestCaseRow(edit のプリフィル用)→ フォーム値。inputs/expected は文字列以外なら JSON 化して
 * テキスト入力へ復元する(S-09/S-11「inputs: JSON形式」「expected: 空でない」の非対称性どおり、
 * expected は文字列ならそのまま・非文字列のみ JSON 化。inputs は常に JSON テキストとして扱う)。 */
export function testCaseRowToFormValues(row: TestCaseRow): TestCaseFormValues {
  const parameters: ParamRow[] | null = row.parameters === null ? null : (JSON.parse(row.parameters) as ParamRow[]);
  const metadata: Record<string, unknown> | null = row.metadata === null ? null : (JSON.parse(row.metadata) as Record<string, unknown>);
  const rawTags = metadata && Array.isArray(metadata.tags) ? (metadata.tags as unknown[]) : [];
  return {
    title: row.title,
    target: row.target ?? '',
    category: row.category as Category,
    given: row.given,
    when: row.when,
    then: row.then,
    parameters: (parameters ?? []).map((p) => ({
      name: p.name ?? '',
      inputs: typeof p.inputs === 'string' ? p.inputs : JSON.stringify(p.inputs ?? null),
      expected: typeof p.expected === 'string' ? p.expected : JSON.stringify(p.expected ?? null),
    })),
    tags: rawTags.map(String),
  };
}

// --- フォーム本文(application/x-www-form-urlencoded)のパース ---

// review round 1 #1(Important): testcase-detail.tsx(S-11 編集保存等)からも再利用するため export する
// (元々は本ファイル・testcase-detail.tsx の双方に byte-for-byte 同一の型/関数が独立定義されていた重複)。
export type RawBody = Record<string, string | File | (string | File)[]>;

export function readString(body: RawBody, key: string): string {
  const v = body[key];
  if (Array.isArray(v)) return String(v[0] ?? '');
  return v === undefined ? '' : String(v);
}
function readArray(body: RawBody, key: string): string[] {
  const v = body[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

/** parseBody() の平坦なフィールド群(param_name[]/param_inputs[]/param_expected[]/tags[] を含む)を
 * TestCaseFormValues に組み立てる(S-09/S-11 共通)。 */
export function parseTestCaseFormBody(body: RawBody): TestCaseFormValues {
  const names = readArray(body, 'param_name[]');
  const inputs = readArray(body, 'param_inputs[]');
  const expecteds = readArray(body, 'param_expected[]');
  const rowCount = Math.max(names.length, inputs.length, expecteds.length);
  const parameters: ParamRowFormValue[] = [];
  for (let i = 0; i < rowCount; i++) {
    parameters.push({ name: names[i] ?? '', inputs: inputs[i] ?? '', expected: expecteds[i] ?? '' });
  }
  const tagsRaw = readArray(body, 'tags[]');
  const tags = [...new Set(tagsRaw.map((t) => t.trim()).filter((t) => t.length > 0))];

  const categoryRaw = readString(body, 'category');
  const category = (CATEGORIES as readonly string[]).includes(categoryRaw) ? (categoryRaw as Category) : 'normal';

  return {
    title: readString(body, 'title').trim(),
    target: readString(body, 'target').trim(),
    category,
    given: readString(body, 'given'),
    when: readString(body, 'when'),
    then: readString(body, 'then'),
    parameters,
    tags,
  };
}

/** クライアント側検証と同じ文言をサーバーでも判定する(S-09/S-11「フォームバリデーションエラー」)。 */
export function validateTestCaseForm(v: TestCaseFormValues): TestCaseFormErrors {
  const errors: TestCaseFormErrors = {};
  if (!v.title.trim()) errors.title = 'タイトルを入力してください';
  else if (v.title.length > LIMITS.title) errors.title = `タイトルは${LIMITS.title}文字以内で入力してください`;

  if (v.target.length > LIMITS.target) errors.target = `対象は${LIMITS.target}文字以内で入力してください`;

  if (!v.given.trim()) errors.given = 'Given を入力してください';
  else if (v.given.length > LIMITS.gwt) errors.given = `Given は${LIMITS.gwt}文字以内で入力してください`;

  if (!v.when.trim()) errors.when = 'When を入力してください';
  else if (v.when.length > LIMITS.gwt) errors.when = `When は${LIMITS.gwt}文字以内で入力してください`;

  if (!v.then.trim()) errors.then = 'Then を入力してください';
  else if (v.then.length > LIMITS.gwt) errors.then = `Then は${LIMITS.gwt}文字以内で入力してください`;

  v.parameters.forEach((row, i) => {
    if (!row.inputs.trim()) {
      errors[`param-inputs-${i}`] = 'inputs を JSON 形式で入力してください';
    } else {
      try {
        JSON.parse(row.inputs);
      } catch {
        errors[`param-inputs-${i}`] = 'inputs は正しい JSON 形式で入力してください';
      }
    }
    if (!row.expected.trim()) errors[`param-expected-${i}`] = 'expected を入力してください';
  });

  return errors;
}

/** zod の issues(byte 上限等、validateTestCaseForm ではカバーしない検証)を画面のエラー枠へ写像する。
 * title/target/category/given/when/then 以外(parameters/metadata 等)は個別スロットが無いため
 * フォーム全体エラー(`{prefix}form-error`)に落とす。 */
export function zodIssuesToFormErrors(issues: Array<{ path: PropertyKey[]; message: string }>): TestCaseFormErrors {
  const FIELD_KEYS = new Set(['title', 'target', 'category', 'given', 'when', 'then']);
  const errors: TestCaseFormErrors = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    if (FIELD_KEYS.has(key)) {
      if (!errors[key]) errors[key] = issue.message;
    } else if (!errors.form) {
      errors.form = issue.message;
    }
  }
  return errors;
}

/**
 * create(省略=未指定)と PATCH(null=クリア)で「空」の表現だけが異なる(HANDOVER C2)。
 * absent 哨兵をパラメータ化して行マッピングを単一実装に保つ。差異を将来ここ以外に足さないこと。
 */
export function buildTestCaseFields<A extends null | undefined>(v: TestCaseFormValues, absent: A) {
  const parameters = v.parameters.length > 0
    ? v.parameters.map((row) => ({
      ...(row.name.trim() ? { name: row.name.trim() } : {}),
      inputs: JSON.parse(row.inputs) as unknown,
      expected: row.expected as unknown,
    }))
    : absent;
  return {
    title: v.title.trim(),
    target: v.target.trim() ? v.target.trim() : absent,
    category: v.category,
    given: v.given,
    when: v.when,
    then: v.then,
    parameters,
    metadata: v.tags.length > 0 ? { tags: v.tags } : absent,
  };
}

/** 検証済みフォーム値 → createTestCaseInput の入力形へ(parameters/metadata は空なら未指定=省略)。 */
export function buildTestCasePayload(v: TestCaseFormValues) {
  return buildTestCaseFields(v, undefined);
}

// --- 動的行(パラメータ・タグ)の最小 inline JS ---

const PARAM_ROWS_SCRIPT = `
(function () {
  if (window.__tmsParamRowsBound) return;
  window.__tmsParamRowsBound = true;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    var addId = t.getAttribute && t.getAttribute('data-param-add');
    if (addId) {
      e.preventDefault();
      var body = document.getElementById(addId);
      var tpl = document.getElementById(addId + '-template');
      if (!body || !tpl) return;
      var idx = body.dataset.nextIndex ? parseInt(body.dataset.nextIndex, 10) : 0;
      var html = tpl.innerHTML.split('__INDEX__').join(String(idx));
      var scratch = document.createElement('tbody');
      scratch.innerHTML = html;
      while (scratch.firstChild) body.appendChild(scratch.firstChild);
      body.dataset.nextIndex = String(idx + 1);
      var table = body.closest('table');
      if (table) table.hidden = false;
      return;
    }
    var removeRow = t.closest && t.closest('[data-param-remove]');
    if (removeRow) {
      e.preventDefault();
      var row = removeRow.closest('.param-row');
      if (row) row.remove();
    }
  });
})();
`;

const TAGS_SCRIPT = `
(function () {
  if (window.__tmsTagsBound) return;
  window.__tmsTagsBound = true;
  function addTag(container, inputEl, raw) {
    var value = (raw || '').trim();
    if (!value) return;
    var existing = container.querySelectorAll('.tag-chip');
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].getAttribute('data-tag-value') === value) { inputEl.value = ''; return; }
    }
    var prefix = container.getAttribute('data-tag-prefix') || '';
    var chip = document.createElement('span');
    chip.className = 'tag-chip badge';
    chip.setAttribute('data-testid', prefix + 'tag-' + value);
    chip.setAttribute('data-tag-value', value);
    chip.appendChild(document.createTextNode(value + ' '));
    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '\\u00d7';
    removeBtn.setAttribute('data-tag-remove', value);
    chip.appendChild(removeBtn);
    var hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = 'tags[]';
    hidden.value = value;
    chip.appendChild(hidden);
    var inputRow = inputEl.closest('.tag-input-row');
    container.insertBefore(chip, inputRow);
    inputEl.value = '';
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    var addContainerId = t.getAttribute && t.getAttribute('data-tag-add');
    if (addContainerId) {
      e.preventDefault();
      var container = document.getElementById(addContainerId);
      if (!container) return;
      var input = container.querySelector('input[data-tag-input]');
      if (input) addTag(container, input, input.value);
      return;
    }
    if (t.matches('[data-tag-remove]')) {
      e.preventDefault();
      var chip = t.closest('.tag-chip');
      if (chip) chip.remove();
    }
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('input[data-tag-input]') || e.key !== 'Enter') return;
    e.preventDefault();
    var container = t.closest('[data-tag-container]');
    if (container) addTag(container, t, t.value);
  });
})();
`;

// --- フィールドコンポーネント ---

function FieldError(props: { testid: string; message?: string }) {
  return (
    <p id={props.testid} data-testid={props.testid} class="field-error" aria-live="polite">{props.message ?? ''}</p>
  );
}

function ParamRowFields(props: { prefix: string; index: number | string; row: ParamRowFormValue; errors: TestCaseFormErrors }) {
  const { prefix, index, row, errors } = props;
  const inputsErrKey = `param-inputs-${index}`;
  const expectedErrKey = `param-expected-${index}`;
  return (
    <tr class="param-row" data-testid={`${prefix}param-row-${index}`}>
      <td>
        <input
          type="text" name="param_name[]" value={row.name} maxlength={LIMITS.name}
          data-testid={`${prefix}param-name-${index}`} placeholder="name"
        />
      </td>
      <td>
        <input
          type="text" name="param_inputs[]" value={row.inputs} placeholder='{"age": -1}'
          data-testid={`${prefix}param-inputs-${index}`} aria-describedby={`${prefix}error-${inputsErrKey}`}
        />
        <FieldError testid={`${prefix}error-${inputsErrKey}`} message={errors[inputsErrKey]} />
      </td>
      <td>
        <input
          type="text" name="param_expected[]" value={row.expected} placeholder="エラー"
          data-testid={`${prefix}param-expected-${index}`} aria-describedby={`${prefix}error-${expectedErrKey}`}
        />
        <FieldError testid={`${prefix}error-${expectedErrKey}`} message={errors[expectedErrKey]} />
      </td>
      <td>
        <button type="button" class="btn btn-secondary" data-param-remove="true" data-testid={`${prefix}btn-param-remove-${index}`}>
          削除
        </button>
      </td>
    </tr>
  );
}

function ParametersSection(props: { prefix: string; rows: ParamRowFormValue[]; errors: TestCaseFormErrors }) {
  const { prefix, rows, errors } = props;
  const bodyId = `${prefix}param-rows-body`;
  return (
    <div class="section" data-testid={`${prefix}section-parameters`}>
      <h3>パラメータ(任意)</h3>
      <table class="param-table" hidden={rows.length === 0}>
        <thead>
          <tr><th>name</th><th>inputs</th><th>expected</th><th></th></tr>
        </thead>
        <tbody id={bodyId} data-next-index={rows.length}>
          {rows.map((row, i) => <ParamRowFields prefix={prefix} index={i} row={row} errors={errors} />)}
        </tbody>
      </table>
      <button type="button" class="btn btn-secondary" data-param-add={bodyId} data-testid={`${prefix}btn-param-add`}>
        + 行を追加
      </button>
      <template id={`${bodyId}-template`}>
        <ParamRowFields prefix={prefix} index="__INDEX__" row={{ name: '', inputs: '', expected: '' }} errors={{}} />
      </template>
    </div>
  );
}

function TagChip(props: { prefix: string; value: string }) {
  return (
    <span class="tag-chip badge" data-testid={`${props.prefix}tag-${props.value}`} data-tag-value={props.value}>
      {props.value}
      <button type="button" data-tag-remove={props.value}>×</button>
      <input type="hidden" name="tags[]" value={props.value} />
    </span>
  );
}

function MetadataSection(props: { prefix: string; tags: string[] }) {
  const { prefix, tags } = props;
  const containerId = `${prefix}tag-container`;
  return (
    <div class="section" data-testid={`${prefix}section-metadata`}>
      <h3>メタデータ(任意)</h3>
      <div class="tag-editor" id={containerId} data-tag-container data-tag-prefix={prefix}>
        {tags.map((v) => <TagChip prefix={prefix} value={v} />)}
        <span class="tag-input-row">
          <input type="text" data-tag-input placeholder="タグを入力して Enter" data-testid={`${prefix}input-tags`} />
          <button type="button" class="btn btn-secondary" data-tag-add={containerId} data-testid={`${prefix}btn-tag-add`}>
            + 追加
          </button>
        </span>
      </div>
    </div>
  );
}

/** S-09/S-11 共有フィールド群(タイトル/対象/カテゴリ/GWT/パラメータ/メタデータ)。アクションボタン行・
 * バージョン表示・machine 警告・OCC バナーは呼び出し側(create ページ/edit フォーム)が個別に描画する。 */
export function TestCaseFieldsForm(props: { prefix: string; values: TestCaseFormValues; errors: TestCaseFormErrors }) {
  const { prefix, values, errors } = props;
  return (
    <>
      <div class="field">
        <label for={`${prefix}input-title`}>タイトル</label>
        <input
          id={`${prefix}input-title`} name="title" type="text" required maxlength={LIMITS.title}
          value={values.title} data-testid={`${prefix}input-title`} aria-describedby={`${prefix}error-title`}
        />
        <FieldError testid={`${prefix}error-title`} message={errors.title} />
      </div>

      <div class="field">
        <label for={`${prefix}input-target`}>対象</label>
        <input
          id={`${prefix}input-target`} name="target" type="text" maxlength={LIMITS.target}
          value={values.target} data-testid={`${prefix}input-target`} aria-describedby={`${prefix}error-target`}
        />
        <p data-testid={`${prefix}hint-target`} class="hint">例: com.example.PaymentService#charge</p>
        <FieldError testid={`${prefix}error-target`} message={errors.target} />
      </div>

      <div class="field">
        <label for={`${prefix}select-category`}>カテゴリ</label>
        <select id={`${prefix}select-category`} name="category" data-testid={`${prefix}select-category`}>
          {CATEGORIES.map((cat) => (
            <option value={cat} selected={values.category === cat}>{CATEGORY_LABEL[cat]}</option>
          ))}
        </select>
        <FieldError testid={`${prefix}error-category`} message={errors.category} />
      </div>

      <div class="field">
        <label for={`${prefix}textarea-given`}>Given(事前条件)</label>
        <textarea
          id={`${prefix}textarea-given`} name="given" required rows={3} maxlength={LIMITS.gwt}
          data-testid={`${prefix}textarea-given`} aria-describedby={`${prefix}error-given`}
        >
          {values.given}
        </textarea>
        <FieldError testid={`${prefix}error-given`} message={errors.given} />
      </div>

      <div class="field">
        <label for={`${prefix}textarea-when`}>When(操作)</label>
        <textarea
          id={`${prefix}textarea-when`} name="when" required rows={3} maxlength={LIMITS.gwt}
          data-testid={`${prefix}textarea-when`} aria-describedby={`${prefix}error-when`}
        >
          {values.when}
        </textarea>
        <FieldError testid={`${prefix}error-when`} message={errors.when} />
      </div>

      <div class="field">
        <label for={`${prefix}textarea-then`}>Then(期待結果)</label>
        <textarea
          id={`${prefix}textarea-then`} name="then" required rows={3} maxlength={LIMITS.gwt}
          data-testid={`${prefix}textarea-then`} aria-describedby={`${prefix}error-then`}
        >
          {values.then}
        </textarea>
        <FieldError testid={`${prefix}error-then`} message={errors.then} />
      </div>

      <ParametersSection prefix={prefix} rows={values.parameters} errors={errors} />
      <MetadataSection prefix={prefix} tags={values.tags} />

      <script dangerouslySetInnerHTML={{ __html: PARAM_ROWS_SCRIPT }}></script>
      <script dangerouslySetInnerHTML={{ __html: TAGS_SCRIPT }}></script>
    </>
  );
}

// --- S-09 作成ページ ---

interface TestCaseCreatePageProps {
  user: UserRow;
  csrf: string;
  project: ProjectRow;
  values: TestCaseFormValues;
  errors: TestCaseFormErrors;
}

function TestCaseCreatePage(props: TestCaseCreatePageProps) {
  const { project } = props;
  const listUrl = `/projects/${project.id}/testcases`;
  const breadcrumb = [
    { label: 'プロジェクト', href: '/projects' },
    { label: project.name, href: listUrl },
    { label: 'テストケース', href: listUrl },
    { label: '新規作成' },
  ];
  return (
    <Layout title="テストケース作成" user={props.user} project={project} csrf={props.csrf} breadcrumb={breadcrumb}>
      <h1 data-testid="page-title">テストケース作成</h1>
      {errors_form(props.errors)}
      <form method="post" action={`/projects/${project.id}/testcases`} novalidate data-validate data-testid="testcase-create-form">
        <input type="hidden" name="_csrf" value={props.csrf} />
        <input type="hidden" name="status" value="draft" />
        <TestCaseFieldsForm prefix="" values={props.values} errors={props.errors} />
        <div class="dialog-actions">
          <a href={listUrl} class="btn btn-secondary" data-testid="btn-cancel">キャンセル</a>
          {/* D-13-3: 「作成」1ボタンに統合(btn-save-draft は描画しない)。status は常に draft 固定。 */}
          <button type="submit" class="btn btn-primary" data-testid="btn-create">作成</button>
        </div>
      </form>
    </Layout>
  );
}

function errors_form(errors: TestCaseFormErrors) {
  if (!errors.form) return null;
  return <div class="alert alert-error" data-testid="form-error">{errors.form}</div>;
}

// --- ルート ---

export const testCaseFormRoutes = new Hono<AppEnv>()
  // S-09: editor+。
  .get('/projects/:pid/testcases/new', requirePageAuth({ minRole: 'editor' }), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const pid = c.req.param('pid');
    const csrf = await ensureCsrfCookie(c);

    const project = await deps.storage.getProject(orgScopeOf(actor), pid);
    if (!project) return renderProjectNotFound(c, actor.user, csrf);

    return c.html(
      <TestCaseCreatePage user={actor.user} csrf={csrf} project={project} values={emptyFormValues()} errors={{}} />,
    );
  })

  // S-09 フォーム送信: editor+ + CSRF。成功 → 303 で S-10(作成物)へ。
  .post('/projects/:pid/testcases', requirePageAuth({ minRole: 'editor' }), csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const pid = c.req.param('pid');
    const csrf = await ensureCsrfCookie(c);

    const project = await deps.storage.getProject(orgScopeOf(actor), pid);
    if (!project) return renderProjectNotFound(c, actor.user, csrf);

    const rawBody = (await c.req.parseBody()) as RawBody;
    const values = parseTestCaseFormBody(rawBody);
    const errors = validateTestCaseForm(values);

    if (Object.keys(errors).length > 0) {
      return c.html(<TestCaseCreatePage user={actor.user} csrf={csrf} project={project} values={values} errors={errors} />, 200);
    }

    const payload = buildTestCasePayload(values);
    const parsed = createTestCaseInput.safeParse({ ...payload, status: 'draft' });
    if (!parsed.success) {
      const zodErrors = zodIssuesToFormErrors(parsed.error.issues);
      return c.html(<TestCaseCreatePage user={actor.user} csrf={csrf} project={project} values={values} errors={zodErrors} />, 200);
    }

    const row = await deps.storage.createTestCaseManual(
      orgScopeOf(actor),
      pid,
      {
        title: parsed.data.title,
        target: parsed.data.target ?? null,
        category: parsed.data.category,
        given: parsed.data.given,
        when: parsed.data.when,
        then: parsed.data.then,
        parameters: parsed.data.parameters ?? null,
        status: 'draft',
        confidence: null,
        sourceRef: null,
        metadata: parsed.data.metadata ?? null,
      },
      { actor: `user:${actor.user.id}`, action: 'created', delta: {} },
      deps.now(),
    );
    return c.redirect(`/projects/${pid}/testcases/${row.id}?flash=testcase_created`, 303);
  });
