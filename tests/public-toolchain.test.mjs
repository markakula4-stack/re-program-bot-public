import test from 'node:test';
import assert from 'node:assert/strict';
import {publicTestEnvironment} from '../scripts/public-test-environment.mjs';
import {runPublicPython} from './helpers/public-python.mjs';

test('public environment preserves Windows Path and Linux PATH without exposing named credentials',()=>{
  const windows=publicTestEnvironment({source:{Path:'C:\\Git;C:\\Windows',BOT_TOKEN:'fictional',API_KEY:'fictional',PUBLIC_TEST_PYTHON:'C:\\Python\\python.exe'},
    executable:'C:\\Node\\node.exe',platform:'win32',guard:'file:///C:/source/guard.mjs'});
  assert.deepEqual(Object.keys(windows).filter(key=>/^path$/iu.test(key)),['PATH']);
  assert.equal(windows.PATH,'C:\\Node;C:\\Git;C:\\Windows');
  assert.equal(windows.BOT_TOKEN,undefined);assert.equal(windows.API_KEY,undefined);
  assert.equal(windows.PUBLIC_TEST_PYTHON,'C:\\Python\\python.exe');
  assert.equal(windows.NODE_OPTIONS,'--import=file:///C:/source/guard.mjs');
  const linux=publicTestEnvironment({source:{PATH:'/usr/bin:/bin',NODE_OPTIONS:'--inspect'},executable:'/opt/node/bin/node',platform:'linux',guard:'file:///source/guard.mjs'});
  assert.equal(linux.PATH,'/opt/node/bin:/usr/bin:/bin');
  assert.equal(linux.NODE_OPTIONS,'--import=file:///source/guard.mjs');
});

test('Python helper retains SQLite checks but blocks sockets and nested processes',()=>{
  const result=runPublicPython(['-c',`import json, socket, sqlite3, subprocess, sys
db=sqlite3.connect(':memory:')
db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
blocked=[]
for operation in [lambda:socket.socket(),lambda:subprocess.run(['offline-not-a-real-command'])]:
 try:operation()
 except RuntimeError as error:blocked.append(str(error))
print(json.dumps({'isolated':sys.flags.isolated,'site':sys.flags.no_site,'depth':db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH),'blocked':blocked}))`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{isolated:1,site:1,depth:100,
    blocked:['PUBLIC_TEST_PYTHON_NETWORK_OR_CHILD_BLOCKED','PUBLIC_TEST_PYTHON_NETWORK_OR_CHILD_BLOCKED']});
  assert.equal(runPublicPython(['-c','raise SystemExit(7)'],{encoding:'utf8'}).status,7,'child failure is not reported as success');
});

test('Python entry list rejects schema writes, unexpected switches and unlisted files',()=>{
  for(const args of [
    ['scripts/v1.4.1-build-foundation-schema.py'],
    ['scripts/v1.4.3-build-lifecycle-schema.py','--check','extra'],
    ['scripts/v1.4.1-p05-probe-schema.py','--output','unused.sql'],
    ['scripts/public-probe-schema.py'],
  ]){
    const result=runPublicPython(args,{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/PUBLIC_TEST_PYTHON_ENTRY_BLOCKED/u);
  }
});
