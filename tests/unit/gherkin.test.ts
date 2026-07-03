// Gherkin ビュー描画のテスト。docs/screens/testcase/S-13-gherkin-view.md「要素カタログ」「API 呼び出し」、
// docs/usecase.md UC-20 の例と一致させる。
import { describe, it, expect } from 'vitest';
import { renderGherkin } from '../../src/domain/gherkin';

describe('renderGherkin', () => {
  it('パラメータなし・target あり: S-13/UC-20 の例と完全一致する(Feature には target を使用)', () => {
    const out = renderGherkin({
      title: '有効期限切れカードで決済を試みるとエラーが返る',
      target: '決済処理',
      given: '有効期限が過去のカード情報が登録されている',
      when: 'そのカードで 1,000 円の決済を実行する',
      then: '決済が拒否され、エラーコード CARD_EXPIRED が返る',
      parameters: null,
    });
    expect(out).toBe(
      [
        'Feature: 決済処理',
        '',
        '  Scenario: 有効期限切れカードで決済を試みるとエラーが返る',
        '    Given 有効期限が過去のカード情報が登録されている',
        '    When そのカードで 1,000 円の決済を実行する',
        '    Then 決済が拒否され、エラーコード CARD_EXPIRED が返る',
      ].join('\n'),
    );
  });

  it('target なし: Feature にはタイトルを使用する(S-13 状態バリエーション「target なし」)', () => {
    const out = renderGherkin({
      title: 'マイタイトル',
      target: null,
      given: 'G',
      when: 'W',
      then: 'T',
      parameters: null,
    });
    expect(out).toBe(['Feature: マイタイトル', '', '  Scenario: マイタイトル', '    Given G', '    When W', '    Then T'].join('\n'));
  });

  it('target が空文字の場合もタイトルにフォールバックする', () => {
    const out = renderGherkin({ title: 'X', target: '', given: 'G', when: 'W', then: 'T', parameters: null });
    expect(out.startsWith('Feature: X\n')).toBe(true);
  });

  it('パラメータなし: Scenario 行(Scenario Outline ではない)を使う', () => {
    const out = renderGherkin({ title: 'X', target: null, given: 'G', when: 'W', then: 'T', parameters: [] });
    expect(out).toContain('  Scenario: X');
    expect(out).not.toContain('Scenario Outline');
  });

  it('パラメータあり: Feature/Scenario Outline/Given/When/Then が S-13 の例と完全一致し、Examples 表に全行が含まれる', () => {
    const out = renderGherkin({
      title: '年齢フィールドのバリデーション',
      target: '年齢バリデーション',
      given: 'ユーザー登録フォームが表示されている',
      when: '年齢フィールドに <age> を入力して送信する',
      then: '<expected> が返る',
      parameters: [
        { name: '負の値', inputs: { age: -1 }, expected: 'エラー「0以上を入力してください」' },
        { name: '下限境界', inputs: { age: 0 }, expected: '成功' },
        { name: '上限境界', inputs: { age: 150 }, expected: '成功' },
        { name: '上限超過', inputs: { age: 151 }, expected: 'エラー「150以下を入力してください」' },
      ],
    });

    const expectedHead = [
      'Feature: 年齢バリデーション',
      '',
      '  Scenario Outline: 年齢フィールドのバリデーション',
      '    Given ユーザー登録フォームが表示されている',
      '    When 年齢フィールドに <age> を入力して送信する',
      '    Then <expected> が返る',
      '',
      '    Examples:',
    ].join('\n');
    expect(out.startsWith(expectedHead)).toBe(true);

    const lines = out.split('\n');
    const tableLines = lines.slice(8);
    expect(tableLines).toHaveLength(5); // ヘッダ + 4行

    for (const line of tableLines) {
      expect(line.startsWith('      |')).toBe(true);
      expect(line.endsWith('|')).toBe(true);
    }

    const cellsOf = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
    expect(cellsOf(tableLines[0] ?? '')).toEqual(['name', 'age', 'expected']);
    expect(cellsOf(tableLines[1] ?? '')).toEqual(['負の値', '-1', 'エラー「0以上を入力してください」']);
    expect(cellsOf(tableLines[2] ?? '')).toEqual(['下限境界', '0', '成功']);
    expect(cellsOf(tableLines[3] ?? '')).toEqual(['上限境界', '150', '成功']);
    expect(cellsOf(tableLines[4] ?? '')).toEqual(['上限超過', '151', 'エラー「150以下を入力してください」']);
  });

  it('Examples 表: name が無く inputs が複数キーの場合、列は inputs のキー名 + expected(name 列なし)', () => {
    const out = renderGherkin({
      title: 'X',
      target: null,
      given: 'G',
      when: 'W',
      then: 'T',
      parameters: [
        { inputs: { balance: 50, amount: 1000 }, expected: 'error' },
        { inputs: { balance: 0, amount: 500 }, expected: 'error' },
      ],
    });
    const lines = out.split('\n');
    const tableLines = lines.slice(lines.indexOf('    Examples:') + 1);
    const cellsOf = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
    expect(cellsOf(tableLines[0] ?? '')).toEqual(['balance', 'amount', 'expected']);
    expect(cellsOf(tableLines[1] ?? '')).toEqual(['50', '1000', 'error']);
    expect(cellsOf(tableLines[2] ?? '')).toEqual(['0', '500', 'error']);
  });
});
