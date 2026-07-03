import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrationStatements } from '../helpers/apply-migrations-node';

describe('DDL(生成マイグレーション)', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    for (const stmt of migrationStatements()) db.exec(stmt);
  });
  const insertBase = () => {
    db.exec(`INSERT INTO organizations (id,name,created_at,updated_at) VALUES ('o1','org',1,1)`);
    db.exec(`INSERT INTO projects (id,organization_id,name,created_at,updated_at) VALUES ('p1','o1','proj',1,1)`);
  };
  it('12 テーブルが作成される', () => {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name);
    for (const t of ['organizations','users','sessions','projects','test_cases','test_case_identities',
      'test_case_observations','sync_sessions','sync_staging','sync_seen','api_tokens','test_case_history']) {
      expect(names).toContain(t);
    }
  });
  it('CHECK: 不正 status を拒否する(data-model「enum 二重防御」)', () => {
    insertBase();
    expect(() => db.exec(
      `INSERT INTO test_cases (id,project_id,title,category,given,"when","then",status,ownership,created_origin,version,is_stale,drift,created_at)
       VALUES ('t1','p1','x','normal','g','w','t','bogus','human','manual',1,0,0,1)`,
    )).toThrow(/CHECK/);
  });
  it('CHECK: approved + machine は到達不能(複合不変条件)', () => {
    insertBase();
    expect(() => db.exec(
      `INSERT INTO test_cases (id,project_id,title,category,given,"when","then",status,ownership,created_origin,version,is_stale,drift,created_at)
       VALUES ('t1','p1','x','normal','g','w','t','approved','machine','manual',1,0,0,1)`,
    )).toThrow(/CHECK/);
  });
  it('部分一意索引: 同一 (project,origin) の active セッションは1つ(uq_active_session)', () => {
    insertBase();
    db.exec(`INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s1','p1','discovery-v1','active',1,10)`);
    expect(() => db.exec(
      `INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s2','p1','discovery-v1','active',1,10)`,
    )).toThrow(/UNIQUE/);
    // committed が居ても新 active は作れる
    db.exec(`UPDATE sync_sessions SET status='committed' WHERE token='s1'`);
    db.exec(`INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s3','p1','discovery-v1','active',1,10)`);
  });
  it('冪等一意制約: 観測の (external_ref,origin,sync_token,fingerprint)', () => {
    insertBase();
    db.exec(`INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s1','p1','o','active',1,10)`);
    const ins = `INSERT INTO test_case_observations (id,external_ref,project_id,fingerprint,observed,sync_token,origin,created_at)
                 VALUES (?,?,?,?,?,?,?,?)`;
    db.prepare(ins).run('ob1', 'ref', 'p1', 'fp', '{}', 's1', 'o', 1);
    expect(() => db.prepare(ins).run('ob2', 'ref', 'p1', 'fp', '{}', 's1', 'o', 2)).toThrow(/UNIQUE/);
  });

  // task-15-brief.md「Step 1」: sync_seen(出現台帳)の DDL テスト2件(テーブル存在は上の
  // 「12 テーブルが作成される」に統合済み。ここでは一意制約 uq_seen(sync_token,external_ref)を検証する)。
  it('sync_seen テーブルが作成される(出現台帳)', () => {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name);
    expect(names).toContain('sync_seen');
  });

  it('一意制約: 出現台帳の (sync_token,external_ref) は一意(uq_seen)。別 token・別 ref は共存できる', () => {
    insertBase();
    db.exec(`INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s1','p1','o','active',1,10)`);
    db.exec(`INSERT INTO sync_seen (sync_token,external_ref) VALUES ('s1','ref1')`);
    expect(() => db.exec(`INSERT INTO sync_seen (sync_token,external_ref) VALUES ('s1','ref1')`)).toThrow(/UNIQUE/);
    // 別 ref・別 token は問題なく共存できる(s2 は別 origin にして uq_active_session と無関係にする)
    db.exec(`INSERT INTO sync_sessions (token,project_id,origin,status,started_at,expires_at) VALUES ('s2','p1','o2','active',11,20)`);
    db.exec(`INSERT INTO sync_seen (sync_token,external_ref) VALUES ('s1','ref2')`);
    db.exec(`INSERT INTO sync_seen (sync_token,external_ref) VALUES ('s2','ref1')`);
  });

  // task-16 review round 1(sync commit の重複 imported 防止): uq_active_session と同じ部分一意索引の
  // 手法で「test_case 1件につき action='imported' の履歴は厳密に1行」を DB 層で強制する
  // (occ-concurrency.test.ts の並行テストが実際の重複シナリオを検証するのに対し、こちらは DDL 自体が
  // 意図通りの制約になっていることを直接的に確認する)。
  it(
    "部分一意索引: test_case 1件につき action='imported' の履歴は1行のみ(uq_history_imported_per_tc)。" +
      '他 action は何度でも共存できる',
    () => {
      insertBase();
      db.exec(
        `INSERT INTO test_cases (id,project_id,title,category,given,"when","then",status,ownership,created_origin,version,is_stale,drift,created_at)
         VALUES ('t1','p1','x','normal','g','w','t','draft','machine','discovery-v1',1,0,0,1)`,
      );
      db.exec(`INSERT INTO test_case_history (id,test_case_id,actor,action,delta,created_at) VALUES ('h1','t1','token:tok','imported','{}',1)`);
      expect(() => db.exec(
        `INSERT INTO test_case_history (id,test_case_id,actor,action,delta,created_at) VALUES ('h2','t1','token:tok','imported','{}',2)`,
      )).toThrow(/UNIQUE/);
      // 別 action(created/updated 等)は部分索引の対象外のため何度でも共存できる
      db.exec(`INSERT INTO test_case_history (id,test_case_id,actor,action,delta,created_at) VALUES ('h3','t1','user:u1','updated','{}',3)`);
      db.exec(`INSERT INTO test_case_history (id,test_case_id,actor,action,delta,created_at) VALUES ('h4','t1','user:u1','updated','{}',4)`);
      // 別 test_case なら imported も別途1行持てる
      db.exec(
        `INSERT INTO test_cases (id,project_id,title,category,given,"when","then",status,ownership,created_origin,version,is_stale,drift,created_at)
         VALUES ('t2','p1','y','normal','g','w','t','draft','machine','discovery-v1',1,0,0,1)`,
      );
      db.exec(`INSERT INTO test_case_history (id,test_case_id,actor,action,delta,created_at) VALUES ('h5','t2','token:tok','imported','{}',5)`);
    },
  );
});
