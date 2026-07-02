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
  it('11 テーブルが作成される', () => {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name);
    for (const t of ['organizations','users','sessions','projects','test_cases','test_case_identities',
      'test_case_observations','sync_sessions','sync_staging','api_tokens','test_case_history']) {
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
});
