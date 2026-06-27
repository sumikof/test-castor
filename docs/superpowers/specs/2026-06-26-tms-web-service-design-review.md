# TMS Web Service 設計レビュー報告書（第3次・独立5観点）

- **作成日:** 2026-06-26
- **対象:** `2026-06-26-tms-web-service-design.md`（第2次Grilling G1〜G11 反映後の状態）
- **方法:** Grillingに関与していない独立レビュア5観点を並行起動し、アドバーサリアル（粗探し）にレビュー。結果を重複統合・重大度整理。
  - ①データモデル・状態機械 ②並行制御・整合性 ③D1/プラットフォーム制約（公式ドキュメント裏取り）④セキュリティ・認証 ⑤API契約の完全性

---

## 0. エグゼクティブサマリ

設計書は**データモデル・状態機械・テナント境界の内部設計が非常に精緻**である一方、レビューは**3つの構造的な盲点**を系統的に検出した。いずれも「個々の修正」ではなく「設計の前提の張り直し」を要する。

### 根本原因（横断テーマ）

| RC | テーマ | 症状の出どころ | 影響観点 |
|----|--------|----------------|----------|
| **RC-1** | **D1の check-then-act 非原子性**。「SELECTで読む→分岐→UPDATE/INSERT」を暗黙に要求する箇所が多数。D1はインタラクティブTX非対応のため**原子化できない** | ownershipゲート / セッション一意性 / chunk upsert / パージのsurvivor選択 / PATCH組み立て | ②①③ |
| **RC-2** | **per-origin 概念の取りこぼし**。REV-08でマルチホーミングを導入したのに、`is_stale`/`drift`/`mirror_origin`/`last_seen` が **canonicalレベルの単一値/単一台帳**のまま。複数originの状態を表現しきれない | is_staleの「他オリジン未観測」述語が実装不能 / 観測爆発 / Diff足場 | ①② |
| **RC-3** | **境界面（執行点・対外契約）の薄さ**。データモデルは精緻だが、(a)認証・認可ミドルウェアの執行仕様、(b)衛星向けAPI契約（JSONスキーマ・エラー・冪等）が**独立した節として存在しない** | 失効トークン素通り / CSRF / IDOR / 越権 / エラー二義性 / 戻り値契約ゼロ | ④⑤ |

さらに横断する第4の因子として **RC-4: committed境界の片側適用** がある。G4は「判定はcommitted由来のみ」と読み手側に課したが、**書き手側**（chunkのlast_seen更新、commit途中のis_stale可視化）には適用しきれておらず、未確定データが判定を汚染する。

### 「実装着手前に必ず潰すべき」最重要クラスタ（Critical）

1. **未commit昇格 vs G4 の正面衝突**（①C1）— chunkが未commitでcanonical生成・ミラー。クラッシュでゾンビcanonical残留。
2. **per-origin staleness が単一boolで表現不能**（①C2 / ②C-1）— commitの「他オリジン未観測」が凍結originで永久取りこぼし。
3. **ownershipゲートのcheck-then-actで人間の初編集を無音上書き**（②A-1）— 設計が最も防ぎたい「承認/編集の機械的消失」が再発。
4. **セッション一意性がアプリ層check-then-actでD1上原子保証不能**（②B-1）— active 2本でstale正しさが崩壊。
5. **chunk再送/並行が非冪等**（②D-1/D-2）— 重複canonical・観測二重INSERT・last_seen巻き戻し。
6. **chunk ≤1,000件がD1の bind=100/queries=1,000上限に抵触**（③#1）— 取り込み口が実機で動かない。
7. **認証執行点の空白**（④A-1/E-1/F-2/D-1）— 失効トークン素通り・CSRF・IDOR・衛星トークン越権。
8. **API契約が衛星実装着手水準に未達**（⑤全般）— 統一エラー/戻り値/リクエストスキーマ未定義。

---

## 1. データモデル・状態機械（観点①）

| ID | 重大度 | 指摘 | 修正方針 |
|----|--------|------|----------|
| DM-C1 | **Critical** | chunk(3)(4)が未commitでcanonical生成・ミラーし、G4「未commit観測は昇格させない」と衝突。クラッシュ→失効でゾンビcanonical残留・回収手順なし | canonical作成/ミラー/fingerprint更新を**commit時に遅延実行**へ移す（chunkはObservation＋台帳蓄積のみ）。または失効時の明示回収を§4.7に追加 |
| DM-C2 | **Critical** | canonicalレベル単一 `is_stale` boolでは per-origin staleness を表現できず、「他オリジン未観測」述語が定義不能。decommissionした凍結originで永久取りこぼし | is_staleを `(test_case_id, origin)` 単位（identity側）へ降格、canonical集約は「全originがstale」で導出。last_seenにTTL/しきい値で凍結identity除外 |
| DM-H2 | High | `mirror_origin` 権威の孤児化に再指定手段がない。mirror衛星が恒久停止→machine-owned canonicalが永久凍結 | inactive一定期間で別active originへ自動委譲、or admin再指定API |
| DM-H3 | High | human-owned `drift` がMVPで解除不能（fingerprint更新パスが存在しない）。承認ケースが永久driftバッジ化 | 「最新committed観測のfingerprintを採用」する明示操作（accept-fingerprint）をPATCH/専用APIに用意（②A-4と統合） |
| DM-H4 | High | `external_ref` 改変でidentity増殖＋approved canonical stale化。同一origin内ref移行の救済（merge/alias）なし | external_refのエイリアス/リマップAPI、or 衛星に「前ref」申告経路 |
| DM-H5 | High | chunk(4)が machine-owned/archived にも `drift` 記録し、「driftはhuman-ownedのみ意味」「archived内容不変」と矛盾。driftバッジ誤発火 | driftの立ちをownership=human かつ非archivedに限定と§5.2(4)へ明記 |
| DM-H6 | High | 「変化点のみ記録」の比較基準が per-origin/per-canonical 未定義。マルチホーミングで観測爆発 | 変化点判定を `(test_case_id, origin)` の直前観測比較に固定 |
| DM-M1 | Medium | `archived × is_stale` の意味未定義。「再出現」と「通常」をis_stale=falseで区別不能（`archived_at`なし） | commit UPDATEで archived も除外、再出現は `archived_at` と last_seen_at 比較で導出 |
| DM-M2 | Medium | `ownership` 列が二分のどちらにも未分類。version bump規則未定義 | ownership所属と遷移時version扱いを明記（human PATCHと同一TXでbump推奨） |
| DM-M3 | Medium | システム可変列に残る「システム由来status遷移」がG3後に死んだ記述。矛盾状態の実装余地 | システム可変列からstatusを削除、statusを完全に人間所有列へ |
| DM-M4 | Medium | 「最低1 committed観測保持」が per-canonical で、per-origin Diff足場を保証しない | 不変条件を `(test_case_id, origin)` ごと最低1件へ強化 |
| DM-M5 | Medium | machine→human不可逆遷移に救済なし。誤操作の同値PATCHで恒久ミラー停止 | 再adopt(admin)操作＋遷移トリガを「値が実変化した人間所有列PATCH」に限定 |
| DM-M6 | Medium | 一意制約上、1 external_ref→複数canonicalのケース分割が表現不能 | 分割時の挙動を契約として明文化 |
| DM-L1 | Low | 手動作成（fingerprint=null）が後続観測で偽drift | null基準は drift 未評価(false)と明記 |
| DM-L2 | Low | 到達不能状態（approved+machine 等）がCHECK未強制 | テーブルCHECKで複合不変条件 `status IN (approved,archived) ⇒ ownership=human` |

---

## 2. 並行制御・整合性（観点②）

| ID | 重大度 | 指摘 | 修正方針 |
|----|--------|------|----------|
| CC-A1 | **Critical** | ミラー経路は「importは人間所有列を触らない」が偽（machine-owned中は触る）。ownershipゲートがcheck-then-actで、人間の初編集をimportが無音上書き。OCC圏外 | ミラーUPDATEを `… WHERE id=? AND ownership='machine' AND status!='archived' AND mirror_origin=?` の**単一文**へ畳み込み、人間初編集も `WHERE ownership='machine'` 付き単一文で相互排他 |
| CC-B1 | **Critical** | 「能動セッション1つ」がアプリ層 SELECT→expire→INSERT で、D1上原子保証不能。active 2本でstale正しさ崩壊 | `CREATE UNIQUE INDEX … ON SyncSession(project_id,origin) WHERE status='active'`（部分一意索引）でDBに強制 |
| CC-D1 | **High** | chunkの「identity無ければ作成」「変化点なら観測作成」がSELECT→INSERTで並行再送に非冪等。重複canonical・観測二重INSERT | 全面upsert化：identityは `ON CONFLICT(project_id,origin,external_ref) DO UPDATE`、observationは `(test_case_id,sync_token,fingerprint)` 一意＋`ON CONFLICT DO NOTHING`、canonicalは「identity INSERTに勝った時のみ」生成 |
| CC-D2 | **High** | last_seen に単調性フェンスなし。旧token chunkの遅延到達でlast_seen巻き戻し→次セッションがstale誤爆。失効セッション上chunkの可否も曖昧 | chunkは対象セッションがactive未失効でなければ409/410で拒否（last_seenも書かない）。last_seen書き込みにtokenフェンス付与 |
| CC-A2 | High | PATCHを `.set(fullObject)` で実装するとシステム可変列が混入、importがversion非bumpのためOCC素通りでロストアップデート | PATCHのUPDATEは人間所有列+versionのみSET句に。システム可変列を絶対にSET句へ入れない（型レベル強制） |
| CC-B2 | High | mid-commitクラッシュで「is_stale一部だけ立つ＋session active」。遅延失効まで新startが409で詰む。torn is_staleが即可視 | is_staleの有効判定を「対応sessionがcommittedの時のみ」にガード（`staled_in_token`列）。失効を短いハートビート式に |
| CC-C1 | High | stale判定がchunk時のlast_seen（未確定）に依存し、G4「committed由来のみ」に反する。放棄セッションが他originのstaleを永久抑止 | last_seenをchunkでは仮置きにしcommit時に「committed last_seen」へ昇格。or stale述語で他origin sessionがcommitted であることをjoin確認 |
| CC-E1 | High | 「最低1 committed観測保持」がパージ⇄commit並行で破れる。未確定観測をsurvivor誤認しcommitted観測0件化 | パージの削除・残置両述語に `status='committed'` 強制（observation→SyncSession join）。単一相関サブクエリ集合DELETEで原子化 |
| CC-A3 | Medium | `updated_at` を人間PATCHもimportも書く共有列で後勝ち。監査・整列汚染 | `human_updated_at`/`system_updated_at` 分離 |
| CC-A4 | Medium | drift解消（再承認）が fingerprint（システム可変列）を人間が書く＝二分の越境。mirror更新と競合 | 再承認を `UPDATE SET fingerprint=?, version=version+1 WHERE version=?`（採用観測id引数化）でOCC保護下に（DM-H3と統合） |
| CC-C2 | Medium | 別origin/同origin再commit割り込みで集合UPDATE結果が順序依存（origin間で収束結果が非決定） | stale判定の基準時刻（started_at）をフェンスに、時刻順序で決定的化 |
| CC-C3 | Medium | 「is_stale=true は冪等」はセッション跨ぎ回復を含まない | 「同一token再開のみ冪等／失効後は新tokenで再計算・収束」と明示 |
| CC-D3 | Medium | D1リードレプリカのラグでidentity「不在」誤判定→重複作成 | 取り込み経路の読みをprimary固定 or Sessions API bookmarkでread-your-writes（CC-D1 upsertで根治） |
| CC-E2 | Medium | パージのLIMITバッチがcommitと非原子に交錯しE1の窓を拡大 | パージを単一述語の集合DELETEのみで構成、アプリ側ループ禁止 |

**横断:** OCC version は「人間↔人間」競合しか守らない。**import↔人間（ミラー経路・システム列巻き戻し）はversion圏外**＝本設計最大の穴。「importはOCC不使用」を保つなら、ミラー/システム列UPDATEを ownership・status・mirror_origin の**WHERE述語ガード付き単一文**にするのが必須条件。

---

## 3. D1 / プラットフォーム制約（観点③・公式裏取り済み）

| ID | 重大度 | 指摘 | 修正方針 |
|----|--------|------|----------|
| D1-1 | **Critical** | chunk ≤1,000件が **bind params=100/query**・**queries=1,000/invocation（Free 50）** に抵触。1件3〜4文なら chunk=1,000で3,000〜4,000クエリ＝破綻 | 上限を「件数×1件あたり文数 ≤1,000、単一文bind ≤100」で定義。一括同定は ≤100件単位に内部分割 |
| D1-2 | **High** | レートリミットの「暴走サテライトはイソレートに集中」は**事実誤認**。同一キーでも複数イソレートに分散・頻繁リサイクル。公式 **Rate Limiting binding が2025-09 GA済**でポータビリティ境界に収まる | MVPのCF実装を公式Rate Limiting bindingに変更（自前インメモリ廃止）。「best-effort・eventually consistent」だけ明記 |
| D1-3 | High | 90日パージの大量DELETEが **30秒/クエリ・数十万行上限**に抵触し単一ライタを長時間占有→sync をブロック。`DELETE…LIMIT` バッチ化が未明記 | パージを `DELETE…LIMIT N`（最低1件保持WHERE付き）の小バッチ反復、1Cron実行のクエリ数<1,000、複数実行に分割 |
| D1-4 | High | 「10GB手前でshard」のshard単位（org別D1）が肥大の真因（**単一org内の時系列増加**）と不一致。MVPは単一org固定で適用先がない | 容量shardの単位を「project別/時間レンジ別D1」と再定義。org別テナント分離（§7将来）と容量分割を別軸に。第一義はパージ＋上限監視 |
| D1-5 | Medium | `UPDATE…LIMIT` は**D1サポート済**（懸念は杞憂）。ただし`ORDER BY`なしは対象行非決定、冪等収束は `WHERE is_stale=0 AND …` 前提。古いlibSQLビルドで非対応の互換リスク | §5.2に冪等WHERE前提を明記、§8.1契約テストに `UPDATE…LIMIT` 互換チェック追加 |
| D1-6 | Medium | D1セッション毎リクエスト読み＋`last_used_at` 毎回書きが単一ライタ圧迫（D1カウンタを退けた理由と同型の自己矛盾）。read replica(Sessions API)未言及 | `last_used_at` をサンプリング/間引き更新。セッション検証読みにD1 Sessions API採用 |
| D1-7 | Medium | observed/metadata JSONが **行2MB上限**・結果セットが **Workers 128MBメモリ**に当たり得る | chunk受理時にバイトサイズをZod上限検証、一覧APIに強制ページング上限 |
| D1-8 | Low | Smart Placementを「アダプタ裏に隠す」は誤解（コードでなくWorker設定値） | 「ランタイム設定（コード非依存）」と分類し直しポータビリティ議論から外す |

**事実確認:** 10GB上限=正 / VACUUM非公開=おおむね正 / インタラクティブTX非対応=正 / `UPDATE…LIMIT`=サポート済（リスク認識は過剰）。**見落とされた効く上限: bind=100・queries/invocation=1,000・30秒/数十万行・行2MB**。

---

## 4. セキュリティ・認証（観点④）

| ID | 重大度 | 指摘 | 修正方針 |
|----|--------|------|----------|
| SE-A1 | **Critical** | 失効トークンを認証ミドルウェアがブロックする記述なし。`revoked_at` は記録列で執行点が空白。失効済トークンでsync継続可能 | 認証SELECT述語に `revoked_at IS NULL AND 未失効` を含め、ヒット後も再検証 |
| SE-D1 | **Critical** | CSRF対策が皆無（HTMXのPOST/PATCH/DELETE）。クロスサイトから archive/改竄/トークン乱発 | `SameSite=Lax`＋状態変更にCSRFトークン/Origin検証必須、HTMXに`hx-headers`付与 |
| SE-E1 | **Critical** | フラットパス `/api/testcases/:id` のorg/projectスコープ突合が未定義。他テナントidを直接PATCHするIDOR | id→testcase→project→org を1クエリ解決し不一致404。理想は `/api/projects/:pid/testcases/:id` へ階層化 |
| SE-F2 | **Critical** | 衛星トークン（role無し）が叩けるAPIのallowlistなし。トークンでPATCH/DELETE到達ならimport不可侵設計をAPI表面から迂回 | トークンは `sync/*` と参照GETのみホワイトリスト。PATCH/DELETE/status/token管理はセッション認証＋role必須 |
| SE-B1 | High | 平文トークンのログ/プロキシ/キャッシュ漏洩面。`Cache-Control: no-store`・ログ/履歴除外の記述なし | no-store＋平文をログ/履歴/監査から除外、`token:<id>`のみ記録 |
| SE-C1 | High | PBKDF2のイテレーション・salt・pepperが未確定（「十分な」止まり）。salt列もない | per-user 16Bソルト内包、OWASP基準（PBKDF2-SHA256 600,000回）を数値固定 |
| SE-C2 | High | `password_hash` 単一列にアルゴリズム識別子なし。argon2移行で全ユーザログイン不能 | **PHC string形式**（alg＋params＋salt＋hash内包）、検証はプレフィックスdispatch、ログイン時透過再ハッシュ |
| SE-D2 | High | Cookie属性（HttpOnly/Secure/SameSite）未規定 | `HttpOnly; Secure; SameSite=Lax; Path=/` を必須属性に |
| SE-D3 | High | 署名鍵の管理・ローテーション未定義 | Secret管理＋鍵IDプレフィックスでローテ可、検証は「署名→DB存在→未失効」三段AND |
| SE-D4 | High | UIセッションの `expires_at` 検証の所在なし（SyncSessionには遅延評価執行があるのに非対称） | 認証ミドルウェアで毎リクエスト `now<expires_at` 検証、超過401＋行削除 |
| SE-D5 | High | セッション固定攻撃対策（ログイン時ID再生成）なし | 認証成功時に新ID発行＋旧ID破棄 |
| SE-E2 | High | 衛星トークンがフラットtestcase APIに到達可能か未定義（SE-F2と連動） | importパス以外はトークン拒否を明記 |
| SE-F1 | High | testcase編集・status変更・archiveにroleチェックなし。viewerがPATCH/DELETE可能になりうる | API別必要roleを表で固定・強制（viewer=GETのみ等） |
| SE-H1 | High | ベストエフォート制限はログイン総当たりに不十分。未認証ログイン/Bearer失敗への制限主体（IP/アカウント別）なし | ログインはアカウント別＋IP別の永続カウンタでロックアウト/指数バックオフ、認証失敗を監査記録 |
| SE-D6 | Medium | ログアウト/全セッション失効なし | ログアウトAPI＋パスワード/role変更時の全セッション無効化 |
| SE-G1 | Medium | history改竄/削除保護（追記専用）の記述なし。token actorのaction限定なし | history追記専用、token actorは `imported` のみと不変条件化 |
| SE-A2/A3 | Medium/Low | トークン長/エントロピー最低要件が生成API仕様に未固定 | 発行を「32B以上CSPRNG・base64url・識別プレフィックス」と固定しZod長下限検証 |
| SE-H2 | Low | `last_used_at` 更新失敗時の認証可否未規定 | best-effort・非ブロッキングと明記 |

**根本所見:** **「認証・認可ミドルウェア仕様」が独立した節として存在しない**ことがCritical大半（SE-A1/E1/F2/D系）の共通原因。SyncSessionには明示的執行モデル（G4）があるのに、UIセッション・トークン認証・RBAC・CSRFには同等の執行記述がない非対称が最大ギャップ。**「各パス×認証方式×必要role×テナント突合×失効チェック」の一覧表**を1節追加すべき。

---

## 5. API契約の完全性（観点⑤）

| ID | 重大度 | 指摘 | 修正方針 |
|----|--------|------|----------|
| API-1 | **Critical** | 機械可読な統一エラーボディ未定義。409が「重複start」か「OCC不一致」か判別不能で冪等再開が壊れる | `{error:{code, message, details[], retryable}}` 単一スキーマ。codeで409二義性を分離 |
| API-2 | **Critical** | start応答に `expires_at` なし。衛星が失効を知れず投入データがサイレント破棄 | start応答を `{sync_token, expires_at, server_time, max_chunk_size}` に |
| API-3 | **Critical** | chunkの戻り値（処理サマリ）が完全未定義。created/mirrored/drift/ignored/skipped/unchanged を衛星が知れない | `{accepted, results:[{external_ref, outcome, test_case_id}]}`（大きければ集計＋差分） |
| API-4 | **Critical** | commitの戻り値（stale件数・再開要否・カーソル）未定義＝G9冪等再開の核心欠落。衛星が「続きから」を判定不能 | `{status:"completed|in_progress", staled_count, processed_cursor, more}`、more中は同一token再commit契約 |
| API-5 | **Critical** | chunkの観測1件リクエストスキーマ未定義。3衛星すべて実装着手不可 | `Observation` Zodスキーマ明示（external_ref/fingerprint/observed必須、originはセッション継承） |
| API-6 | High | `observed` の `schema_version` 欠落。衛星バージョン更新でREV-09構造化Diffが偽陽性化（最低1件永久保持で旧形が長期残存） | `observed` に `schema_version` を埋め、Diffエンジンがバージョン跨ぎを区別 |
| API-7 | High | `external_ref`/`fingerprint` の長さ・文字種契約なし。索引キー肥大でD1 10GB上限と矛盾 | 最大長（例256〜512）・文字種（printable ASCII）を契約に |
| API-8 | High | Idempotency-Key の明示契約なし（「自然に冪等」依存が脆い）。リトライで `imported` 二重記録 | chunk/commitに `Idempotency-Key` ヘッダ、短期メモ化で同一レスポンス |
| API-9 | High | APIバージョン（`/v1/`）と互換方針なし。必須フィールド追加で旧衛星が一斉422 | `/api/v1/` 導入＋互換ルール（必須追加は新版のみ等）明記 |
| API-10 | High | DELETE が archive固定か物理削除可か曖昧。物理削除でidentity消滅→再syncでゾンビ復活（G7破れ） | DELETEは archive固定と断言、物理削除は管理者別操作に分離 |
| API-11 | High | OCC version の渡し方（If-Match vs body）未定義 | `If-Match` か body`version` に固定、GET応答でversion必須返却 |
| API-12 | High | ページング契約（カーソル/安定ソート/total）皆無。同期中の一覧でpage跨ぎ重複/欠落 | カーソルベース `(created_at,id)` 安定タイブレーク、`{items, next_cursor, has_more}` |
| API-13 | Medium | observed `observed`内部スキーマが「等」で未閉。Diff破綻 | 固定キーセットのZodスキーマ、未知キー方針明記 |
| API-14 | Medium | PATCH部分更新（null と未指定の区別）未定義。未送信フィールドが意図せずnull化 | 「キー存在=更新、未指定=不変、明示null=クリア」を明文化 |
| API-15 | Medium | origin値ドメイン契約なし（CHECK外しZodのみ）。`"discovery"`/`"Discovery"` 揺れでmirror不一致・stale緩み | originの正規化規則（小文字・許可文字・既知プレフィックス）を契約に |
| API-16 | Medium | 日時表現（epoch ms数値かISO8601か）・gherkinビューのContent-Type未定義 | 全JSON日時はepoch ms数値固定、Content-Type明記 |
| API-17 | Low | コレクション応答エンベロープ不統一（裸配列 vs `{items}`）／成功ステータス（200/201/202）未定義 | `{items,...}` 統一、作成=201・部分完了commit=202・完了=200 |

**総括:** サーバ内部設計書としては優秀だが、**衛星向けインタフェース契約書（OpenAPI相当）としては未成立**。リクエスト/レスポンスZodスキーマ全文・統一エラー・ステータス対照表・origin/external_ref/fingerprint/observedの安定性契約を§5に追記し、OpenAPI/Zod定義を正本化すべき。

---

## 6. 推奨アクション

レビューは「個別パッチ」より「前提の張り直し」を要する項目が多い。以下の順を推奨：

1. **第3次Grilling（RC-1〜RC-3クラスタ）** — 特に DM-C1/C2・CC-A1/B1/D1・SE執行点・API契約は相互依存が強く、1問ずつ降りて確定する価値が高い。前回同様の方式で再開可能。
2. **設計書への構造反映** — Grilling確定後、以下の新節を追加する見込み：
   - §5.x「**認証・認可ミドルウェア執行仕様**」（パス×認証方式×role×テナント突合×失効）
   - §5.x「**API契約**」（統一エラー・リクエスト/レスポンスZodスキーマ・冪等・バージョニング・ページング）
   - §4.x の **per-origin 降格**（is_stale/last_seen/最低1観測をidentity粒度へ）
   - §5.2 の **単一文ガード化**（check-then-act撤廃、upsert/部分一意索引）
   - §8.3a の **D1実上限反映**（chunk上限の文数換算、パージのLIMITバッチ、Rate Limiting binding、shard単位再定義）
3. **即値修正（Grill不要の事実反映）** — D1-2（公式Rate Limiting binding）、D1-5（`UPDATE…LIMIT`はサポート済）、D1-8（Smart Placement分類）、SE-C1/C2（ハッシュパラメータ数値化）等は事実確定済みで即反映可能。

---

## 付録: 観点別の根本所見

- **①データモデル:** 単一オリジン前提では概ね閉じているが、REV-08マルチホーミングと単一フラグ/単一台帳の組合せに per-origin の取りこぼしが系統的に残る。
- **②並行制御:** 「SELECTで読んで分岐してUPDATE/INSERT」がD1のインタラクティブTX非対応と最悪の相性。**(a)単一文へ述語畳み込み (b)upsert/部分一意索引でDBに不変条件委譲** のどちらかへ全面書き換えが必要。
- **③D1制約:** 事実誤認2件（レートリミット集中前提、UPDATE…LIMIT懸念）と楽観見積もり複数（chunk上限、パージ、shard単位）。効く上限の見落とし（bind=100/queries=1,000/30秒/2MB）。
- **④セキュリティ:** データモデルの堅牢性に対し、認証ミドルウェアの執行仕様・Cookie/セッションライフサイクル・CSRF・暗号パラメータがほぼ未記述。
- **⑤API契約:** 内部設計は優秀だが対外契約が未成立。衛星3種は現状の設計だけでは実装着手不可。
