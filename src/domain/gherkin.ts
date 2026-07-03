// src/domain/gherkin.ts
// テストケースの Gherkin/自然言語ビュー描画。docs/screens/testcase/S-13-gherkin-view.md
// 「要素カタログ」「API 呼び出し」のレンダリング仕様を正本とする:
//   - Feature 行: `Feature: <target or title>`(target があれば target、無ければ title)
//   - Scenario 行: `Scenario: <title>`(parameters が null/空の時)
//   - Scenario Outline 行: `Scenario Outline: <title>`(parameters が1件以上の時)
//   - Given/When/Then は原文そのまま(プレースホルダ `<age>` 等の展開はしない。Scenario Outline の
//     ステップ文自体にプレースホルダ文字列が含まれているのが正しい Gherkin の記法)
//   - Examples 表: parameters が1件以上の時のみ。列は name(いずれかの行にあれば)+ inputs のキー
//     (inputs がオブジェクトの場合。無ければ 'inputs' 列1本に JSON化)+ expected

import type { ParamRow } from './testcase-rules';

export type GherkinInput = {
  title: string;
  target?: string | null;
  given: string;
  when: string;
  then: string;
  parameters: ParamRow[] | null;
};

// S-13 の Examples 表は日本語(全角)を含む内容を人が読みやすいよう列揃えする想定のため、
// 東アジア表現幅(全角=2/半角=1)で桁を揃える。対象は代表的な全角範囲(ひらがな・カタカナ・
// CJK統合漢字・全角記号・ハングル等)の簡易判定。
// 注記(GC-1 突合): S-13 の Examples 表の例そのものは、行ごとに空白パディングの実測値が
// 一致しない(例: expected 列の空白幅が行によって 30/32/35 と揺れる)ため、単純な東アジア
// 幅ベースの最大値整列というアルゴリズムからの機械的な導出ではなく手作業での近似整形と判断した。
// そのため本実装は「決定的で一貫した」列幅整列を行い、ドキュメントの空白を1バイトも違わず
// 再現することは目的にしていない(内容・ヘッダ・行の並びは完全一致させる)。詳細はタスク報告参照。
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += isWide ? 2 : 1;
  }
  return w;
}

function padDisplay(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function stringifyCell(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function renderExamplesTable(parameters: ParamRow[]): string[] {
  const hasName = parameters.some((p) => p.name !== undefined);

  const inputKeys: string[] = [];
  for (const p of parameters) {
    if (isPlainObject(p.inputs)) {
      for (const k of Object.keys(p.inputs)) {
        if (!inputKeys.includes(k)) inputKeys.push(k);
      }
    }
  }
  const useRawInputsColumn = inputKeys.length === 0;

  const headerRow = [...(hasName ? ['name'] : []), ...(useRawInputsColumn ? ['inputs'] : inputKeys), 'expected'];

  const dataRows = parameters.map((p) => {
    const row: string[] = [];
    if (hasName) row.push(p.name ?? '');
    if (useRawInputsColumn) {
      row.push(stringifyCell(p.inputs));
    } else if (isPlainObject(p.inputs)) {
      const inputs = p.inputs;
      for (const k of inputKeys) row.push(stringifyCell(inputs[k]));
    } else {
      for (const _k of inputKeys) row.push('');
    }
    row.push(stringifyCell(p.expected));
    return row;
  });

  const allRows = [headerRow, ...dataRows];
  const colCount = headerRow.length;
  const colWidths = Array.from({ length: colCount }, (_, i) =>
    Math.max(...allRows.map((r) => displayWidth(r[i] ?? ''))),
  );

  return allRows.map((row) => `      | ${row.map((cell, i) => padDisplay(cell, colWidths[i] ?? 0)).join(' | ')} |`);
}

/** S-13 のレンダリング仕様に一致させる(Feature: target-or-title、Examples 表は parameters ありの時のみ)。 */
export function renderGherkin(tc: GherkinInput): string {
  const feature = tc.target && tc.target.trim().length > 0 ? tc.target : tc.title;
  const hasParams = Array.isArray(tc.parameters) && tc.parameters.length > 0;

  const lines: string[] = [];
  lines.push(`Feature: ${feature}`);
  lines.push('');
  lines.push(hasParams ? `  Scenario Outline: ${tc.title}` : `  Scenario: ${tc.title}`);
  lines.push(`    Given ${tc.given}`);
  lines.push(`    When ${tc.when}`);
  lines.push(`    Then ${tc.then}`);

  if (hasParams && tc.parameters) {
    lines.push('');
    lines.push('    Examples:');
    lines.push(...renderExamplesTable(tc.parameters));
  }

  return lines.join('\n');
}
