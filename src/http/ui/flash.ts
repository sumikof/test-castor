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
 */
const FLASH_MESSAGES: Record<string, Flash> = {
  setup_complete: { kind: 'success', text: 'セットアップが完了しました。ログインしてください' },
  setup_already_complete: { kind: 'error', text: 'セットアップは既に完了しています' },
  session_expired: { kind: 'warn', text: 'セッションが失効しました。再度ログインしてください' },
  password_changed: { kind: 'success', text: 'パスワードを変更しました。再度ログインしてください' },
};

/** 未知のキー・未指定は null(呼び出し側は「トーストを表示しない」として扱う)。 */
export function resolveFlash(key: string | undefined | null): Flash | null {
  if (!key) return null;
  return FLASH_MESSAGES[key] ?? null;
}
