import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {runP05HttpScenarios,P05_HTTP_FIXTURE_MARKER} from './helpers/v1.4.1-p05-http-scenarios.mjs';

test('P05 shared HTTP probe requires both isolated fixture markers before touching a binding',async()=>{
  const binding={prepare(){throw new Error('binding_touched');}};
  await assert.rejects(runP05HttpScenarios({binding,env:{}}),/p05_http_isolated_marker_required/u);
  await assert.rejects(runP05HttpScenarios({binding,env:{V141_P05_ISOLATED_PROBE:'true'}}),/p05_http_isolated_marker_required/u);
});
test('P05 native-friendly journey uses actual Worker HTTP with 1000 fixture rows and two competing requests',async t=>{
  const f=foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const insert=f.sqlite.prepare('INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES(?,?,1)');
  for(let offset=0;offset<995;offset++)insert.run(10000+offset,'p05_bulk_'+offset);
  const result=await runP05HttpScenarios({binding:f.binding,env:{...f.serverEnv,
    V141_AUTHORIZATION_ENABLED:'true',V141_P05_ISOLATED_PROBE:'true',
    V141_P05_FIXTURE_MARKER:P05_HTTP_FIXTURE_MARKER,REBUILD_V140_RC_SHA:'a'.repeat(40)}});
  assert.equal(result.fixtureUsers,1000);assert.equal(result.burstSize,2);
  assert.ok(Object.values(result.assertions).every(value=>value===true));assert.ok(result.maxQueries<=210);
  const statuses=result.calls.filter(row=>row.scenario.startsWith('last_slot_')).map(row=>row.status);
  assert.equal(statuses.filter(status=>status===200).length,1);
  assert.ok(statuses.every(status=>[200,403,409].includes(status)));
  t.diagnostic(JSON.stringify({maxQueries:result.maxQueries,calls:result.calls}));
  for(const secret of ['sessionToken','initData','offerCode','telegram_id','sourceFingerprint'])assert.ok(!JSON.stringify(result).includes(secret));
});
