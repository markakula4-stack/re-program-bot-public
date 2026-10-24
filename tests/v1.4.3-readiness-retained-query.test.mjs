import test from 'node:test';
import assert from 'node:assert/strict';
import {runPublicPython} from './helpers/public-python.mjs';
import {buildReadinessRetainedQueries} from '../src/v1.4.3/readiness-retained-query.mjs';
import {V143_READINESS_INSTALL_PLAN as PLAN} from '../src/v1.4.3/readiness-install-plan.mjs';

test('one fixed VALUES query preserves all twenty snapshots under native compound SELECT limits',()=>{
  const q=buildReadinessRetainedQueries();
  assert.equal(q.entries.length,20);
  assert.deepEqual(q.entries.map(e=>e.table),Object.keys(PLAN.retainedColumns));
  assert.match(q.combined,/^WITH retained_snapshot\(ordinal,table_name,value\) AS \(VALUES /u);
  assert.match(q.combined,/ORDER BY ordinal$/u);
  assert.doesNotMatch(q.combined,/\b(?:UNION|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|ATTACH|PRAGMA)\b/iu);
  assert.ok(Buffer.byteLength(q.combined)<100000);
  const run=runPublicPython(['-c',`
import json,sqlite3,sys
p=json.load(sys.stdin)
db=sqlite3.connect(':memory:',cached_statements=0)
for k,v in [(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT,5),(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100),
 (sqlite3.SQLITE_LIMIT_FUNCTION_ARG,32),(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER,100),
 (sqlite3.SQLITE_LIMIT_VDBE_OP,25000),(sqlite3.SQLITE_LIMIT_TRIGGER_DEPTH,10)]:db.setlimit(k,v)
for table,columns in p['columns'].items():
 db.execute('CREATE TABLE "'+table+'"('+','.join('"'+c+'"' for c in columns)+')')
 # Read-only snapshot coverage: empty, duplicate, NULL, integer, float,
 # Unicode/quotes and nested JSON text. No financial/provider simulation.
 if table!='payment_refunds':
  values=[None,143,1.25,'Тест 🎯',"quote'\\\"",'[]']
  row=[values[i%len(values)] for i in range(len(columns))]
  sql='INSERT INTO "'+table+'" VALUES('+','.join('?' for c in columns)+')'
  db.execute(sql,row);db.execute(sql,row)
expected=[(e['table'],db.execute(e['sql']).fetchone()[0]) for e in p['entries']]
legacy=' UNION ALL '.join("SELECT '"+e['table']+"' table_name,("+e['sql']+") value" for e in p['entries'])
try:db.execute(legacy).fetchall();raise AssertionError('old query unexpectedly accepted')
except sqlite3.OperationalError as e:assert 'too many terms in compound SELECT' in str(e)
before=db.total_changes
result=db.execute(p['combined']).fetchall()
assert result==expected and len(result)==20
assert db.total_changes==before
instructions=len(db.execute('EXPLAIN '+p['combined']).fetchall())
assert instructions<25000
db.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT,1)
assert db.execute(p['combined']).fetchall()==expected
print(json.dumps({'status':'PASS','tables':len(result),'instructions':instructions,'writes':0}))
`],{input:JSON.stringify({...q,columns:PLAN.retainedColumns}),encoding:'utf8'});
  assert.equal(run.status,0,run.stdout+run.stderr);
  const proof=JSON.parse(run.stdout);
  assert.equal(proof.status,'PASS');assert.equal(proof.tables,20);assert.equal(proof.writes,0);
});
