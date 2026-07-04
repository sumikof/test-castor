// src/entry/maintenance-cli.ts
// task-23-brief.md「maintenance-cli」。オンプレ運用者が OS の cron から直接実行するスクリプト
// (docs/operations.md §4.3「パージ実行 | OS の cron / スケジューラから Storage のパージ操作を呼ぶ」)。
// src/maintenance/index.ts の runMaintenance(CF scheduled と共有する共通実装)をそのまま呼び、
// その後にオンプレ専用の `PRAGMA incremental_vacuum` を発行してファイルサイズを回収する
// (operations.md §4.3「実行タイミング | パージ後に PRAGMA incremental_vacuum でファイルサイズ回収」)。
// D1 には VACUUM 相当の公開 PRAGMA が無い(operations.md §4.2)ため、この一手順は better-sqlite3/libSQL
// のオンプレ環境専用であり、CF の scheduled ハンドラ(src/entry/workers.ts)には存在しない。
//
// GC-6: CF 型は一切参照しない(better-sqlite3 のみに依存)。
// GC-7: 新規依存追加なし。package.json の maintenance:node スクリプトは本ファイルを直接
// `node --import ./src/entry/node-ts-loader.mjs` で実行する(src/entry/node.ts と同じローダを使う。
// 理由・実装は node-ts-loader.mjs のコメント参照。tsx 等の新規パッケージは追加しない)。
// このファイル自体は import.meta.main の直下でのみ実行し、他モジュールから import されても
// 副作用(DB接続・vacuum・process.exitCode 変更)を起こさない(node-entry.test.ts と同じ規約)。
import { loadMaintenanceRetentionMs } from '../http/config';
import { createBetterSqlite3Storage } from '../storage/adapters/better-sqlite3';
import { runMaintenance } from '../maintenance';

/**
 * `dataPath`(既定は env `TMS_DB_PATH`、それも無ければ `./tms.sqlite`)に対して runMaintenance を実行し、
 * 続けて `PRAGMA incremental_vacuum` を発行してから接続を閉じる。runMaintenance 自体の構造化ログ
 * (`{"event":"maintenance_run",...}`)はそのまま標準出力に流れる(src/maintenance/index.ts 既定の
 * log()。CF scheduled と同じ形式)。
 * 署名鍵設定(SESSION_SIGNING_KEYS)は読まない(HANDOVER C11: maintenance に無関係な dev-key 警告や
 * 鍵設定不備での失敗を持ち込まない。必要な env は TMS_DB_PATH と OBSERVATION_RETENTION_MS のみ)。
 */
export async function runMaintenanceCli(dataPath = process.env.TMS_DB_PATH ?? './tms.sqlite'): Promise<void> {
  const retentionMs = loadMaintenanceRetentionMs(process.env);
  const { storage, sqlite } = createBetterSqlite3Storage(dataPath);
  try {
    await runMaintenance({
      storage,
      now: () => Date.now(), // GC-3: 実クロックを読むのは entry 層のみ
      retentionMs,
    });
    // オンプレのみ(operations.md §4.3): パージ後にファイルサイズを回収する。
    // auto_vacuum=INCREMENTAL は接続初期化時(better-sqlite3.ts)に設定済み前提。
    sqlite.pragma('incremental_vacuum');
  } finally {
    sqlite.close();
  }
}

/** CLI 失敗ラッパー(HANDOVER B8: テスト可能にするため export。import.meta.main はこれを呼ぶだけ)。
 * 失敗時は `maintenance_cli_failed` の構造化 JSON を stderr へ 1 行出し、exitCode=1 を設定する(throw しない)。 */
export async function maintenanceCliMain(dataPath?: string): Promise<void> {
  try {
    await runMaintenanceCli(dataPath);
  } catch (err) {
    console.error(JSON.stringify({
      event: 'maintenance_cli_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void maintenanceCliMain();
}
