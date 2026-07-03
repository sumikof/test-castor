// src/http/ui/flash.ts
// `?flash=<key>` クエリ → 日本語文言 + 種別への変換(D-13-5「リダイレクト時のメッセージ伝搬は
// ?flash= クエリ方式」)。各画面ドキュメントの「トースト / 通知」表に列挙された文言をキー化する。
//
// kind は screens.md「共通レイアウト > 通知・トースト」が定義する3種(成功・エラー・警告)に対応する
// 'success' | 'error' | 'warn' のみ(layout.tsx の Layout 型もこの3種)。S-02 の「情報（引き継ぎ）」
// トースト(session_expired)は screens.md に「情報」という第4の種別定義が無いため、意味的に最も近い
// 'warn' にマッピングする(タスク報告に明記する解釈上の決定)。
export type FlashKind = 'success' | 'error' | 'warn';

export interface Flash {
  kind: FlashKind;
  text: string;
}

/**
 * キー→文言表。
 * - setup_complete: S-01「トースト / 通知」成功 → S-02「トースト / 通知」成功(引き継ぎ)と同一文言。
 * - setup_already_complete: S-01「トースト / 通知」エラー(409 SETUP_ALREADY_COMPLETE)。
 * - session_expired: S-02「トースト / 通知」情報(引き継ぎ)。requirePageAuth が未認証/失効セッションを
 *   検出した際のリダイレクト先で使う。
 * - password_changed: S-02「トースト / 通知」成功(引き継ぎ)。S-04(パスワードリセット実行。MVP後)/
 *   S-20(プロフィール。Task 21)からの遷移で使う想定。S-02 のドキュメントが文言を明記しているため、
 *   本タスクの時点で先取りしてキーを登録しておく。
 * - project_created: S-06「トースト / 通知」成功(S-07 でプロジェクト作成完了後)。task-18-brief.md。
 * - testcase_created: S-09「トースト/通知」成功(遷移先の S-10 で表示)。task-20-brief.md。
 * - testcase_updated: S-11「トースト/通知」保存成功(ownership 遷移を伴わない場合)。
 * - testcase_ownership_transitioned: S-11「トースト/通知」保存成功 + machine→human 遷移時(「情報」種別。
 *   flash.ts の3種類(success/error/warn)には「情報」が無いため session_expired と同じ理由で 'warn' に
 *   マッピングする)。
 * - testcase_status_approved/reverted/archived/restored: S-10「トースト/通知」のステータス変更4パターン。
 * - testcase_status_invalid: S-10 の状態遷移マトリクスに違反する POST /status(通常は UI 上の選択肢
 *   から到達しない改ざんケース)。docs に文言定義が無いため本実装で採番(タスク報告に明記)。
 * - occ_conflict: S-10/S-12 共通の OCC 409 トースト文言(ステータス変更・accept-fingerprint で共有)。
 * - testcase_drift_accepted: S-12「トースト・通知」Accept Fingerprint 成功。
 * - testcase_no_drift: S-12「トースト・通知」NO_DRIFT(S-12 の文言を採用。S-10 の同エラーの文言
 *   「乖離が発生していません」とは表現が異なるが、accept-fingerprint は S-12 起点の操作のため
 *   S-12 の文言を正とする。GC-1 乖離としてタスク報告に明記)。
 */
const FLASH_MESSAGES: Record<string, Flash> = {
  setup_complete: { kind: 'success', text: 'セットアップが完了しました。ログインしてください' },
  setup_already_complete: { kind: 'error', text: 'セットアップは既に完了しています' },
  session_expired: { kind: 'warn', text: 'セッションが失効しました。再度ログインしてください' },
  password_changed: { kind: 'success', text: 'パスワードを変更しました。再度ログインしてください' },
  project_created: { kind: 'success', text: 'プロジェクトを作成しました' },
  testcase_created: { kind: 'success', text: 'テストケースを作成しました' },
  testcase_updated: { kind: 'success', text: 'テストケースを更新しました' },
  testcase_ownership_transitioned: {
    kind: 'warn',
    text: '所有権が machine から human に変更されました。以後 Discovery の自動更新は停止します',
  },
  testcase_status_approved: { kind: 'success', text: 'テストケースを承認しました' },
  testcase_status_reverted: { kind: 'success', text: 'テストケースを下書きに戻しました' },
  testcase_status_archived: { kind: 'success', text: 'テストケースをアーカイブしました' },
  testcase_status_restored: { kind: 'success', text: 'テストケースを復帰しました' },
  testcase_status_invalid: { kind: 'error', text: 'この操作は許可されていません' },
  occ_conflict: { kind: 'error', text: '更新が競合しました。最新の内容を確認してください' },
  testcase_drift_accepted: { kind: 'success', text: 'drift を解消しました' },
  testcase_no_drift: { kind: 'warn', text: 'このテストケースには drift が発生していません。' },
};

/** 未知のキー・未指定は null(呼び出し側は「トーストを表示しない」として扱う)。 */
export function resolveFlash(key: string | undefined | null): Flash | null {
  if (!key) return null;
  return FLASH_MESSAGES[key] ?? null;
}
