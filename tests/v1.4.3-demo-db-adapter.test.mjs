import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteD1 } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createDemoExecutionDb } from '../src/v1.4.3-demo/db-adapter.mjs';

const UUID = 'abcdef12-3456-4789-abcd-1234567890ab';
const PREFIX = 'stars_provider_'+UUID;
const COMPACT = 'stars_provider_'+UUID.replaceAll('-', '');
const INSERT = 'INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,?)';
const CLEANUP = 'DELETE FROM mini_app_atomic_guards WHERE guard_key LIKE ?';

test('provider temporary guards compact symmetrically and clean atomically under LIKE50', async t => {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE re_demo_generations(owner_id,generation,locked_operation_id);
    CREATE TABLE re_demo_operations(owner_id,generation,operation_id,state);
    CREATE TABLE mini_app_atomic_guards(guard_key TEXT PRIMARY KEY,precondition_ok INTEGER CHECK(precondition_ok=1));
    INSERT INTO re_demo_generations VALUES(900,1,'demo-adapter-operation');
    INSERT INTO re_demo_operations VALUES(900,1,'demo-adapter-operation','pending');`);
  const db = new SqliteD1(sqlite), original = db.prepare.bind(db); let rawCalls = 0;
  const native = statement => {
    const bind = statement.bind.bind(statement), execute = statement.execute.bind(statement);
    statement.bind = (...params) => native(bind(...params));
    statement.raw = async () => { rawCalls++; return []; };
    statement.execute = () => {
      if (statement.sql === CLEANUP && new TextEncoder().encode(statement.params[0]).length > 50) throw new Error('LIKE or GLOB pattern too complex');
      return execute();
    };
    return statement;
  };
  db.prepare = sql => native(original(sql));
  const adapter = createDemoExecutionDb({ db, ownerId: 900, generation: 1, operationId: 'demo-adapter-operation' });
  assert.equal((PREFIX+'_%').length, 53); assert.equal((COMPACT+'_%').length, 49);
  await adapter.batch([adapter.prepare(INSERT).bind(PREFIX+'_0',1), adapter.prepare(INSERT).bind(PREFIX+'_12',1), adapter.prepare(CLEANUP).bind(PREFIX+'_%')]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n, 0);
  const inserted = db.audit.filter(row => row.sql === INSERT).map(row => row.params);
  assert.deepEqual(inserted, [[COMPACT+'_0',1],[COMPACT+'_12',1]]);
  assert.deepEqual(db.audit.find(row => row.sql === CLEANUP).params, [COMPACT+'_%']);
  assert.equal(rawCalls, 0, 'native raw method must not be invoked while unwrapping batch statements');
  await assert.rejects(adapter.batch([adapter.prepare(INSERT).bind(PREFIX+'_0',1), adapter.prepare(INSERT).bind(PREFIX+'_1',0), adapter.prepare(CLEANUP).bind(PREFIX+'_%')]));
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n, 0, 'failed precondition rolls back every temporary guard');
  sqlite.exec("UPDATE re_demo_operations SET state='completed'; UPDATE re_demo_generations SET locked_operation_id=NULL");
  await assert.rejects(adapter.batch([adapter.prepare(INSERT).bind(PREFIX+'_0',1)]), error => error.code === 'demo_execution_obsolete');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM mini_app_atomic_guards').get().n, 0, 'obsolete request cannot reinsert a compact guard');
});

test('guard compaction changes no other SQL scope, binding, identifier or already compact key', () => {
  const bound = [];
  const db = { prepare(sql) { return { bind(...params) { bound.push({sql,params}); return this; } }; }, batch() { throw new Error('not needed'); } };
  const adapter = createDemoExecutionDb({ db, ownerId: 900, generation: 1, operationId: UUID });
  const cases = [
    [INSERT, [COMPACT+'_0',1]],
    [INSERT, [PREFIX+'_letter',1]],
    [INSERT, [PREFIX+'_%',1]],
    [INSERT, ['stars_provider_not-a-uuid_1',1]],
    [INSERT, ['unrelated_'+UUID+'_1',1]],
    [INSERT, ['other',PREFIX+'_0']],
    ['INSERT INTO mini_app_atomic_guards(precondition_ok,guard_key) VALUES(?,?)', [1,PREFIX+'_0']],
    [CLEANUP, [PREFIX+'_1']],
    [CLEANUP+' AND precondition_ok=?', [PREFIX+'_%',1]],
    ['DELETE FROM mini_app_atomic_guards WHERE guard_key=?', [PREFIX+'_0']],
    ['INSERT INTO payment_ledger(provider_charge_id) VALUES(?)', [PREFIX+'_0']],
  ];
  for (const [sql,params] of cases) adapter.prepare(sql).bind(...params);
  assert.deepEqual(bound, cases.map(([sql,params]) => ({sql,params})));
});
