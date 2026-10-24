import assert from 'node:assert/strict';
import test from 'node:test';
import { MiniAppClient, readAuthorizationDTO, errorMessage } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';

const now = 1_791_000_000;
const decision = (capability = 'offer.create_private', patch = {}) => ({version:1,capability,
  allowed:false,reasonCode:'quota_exceeded',policyVersion:'2026-10-02.v1.4.1.policy-proposal.1',
  effectivePlan:'dragon',accessState:'active',validUntil:now+300,
  quota:{limit:3,used:3,remaining:0,resetsAt:null,scope:'own_partner_profile'},actionPolicy:'beta_cap',...patch});
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const setup = (handler, sessionPatch = {}) => new MiniAppClient({origin:'https://cabinet.example',now:()=>now*1000,
  fetchImpl:async(url,init)=>url.endsWith('/session') ? response({sessionToken:'rpms1_'+'a'.repeat(43),
    expiresAt:now+300,tokenType:'Bearer',authorizationVersion:1,
    features:{version:1,mutationsEnabled:true,offerActionsEnabled:true},...sessionPatch}) : handler(url,init)});

test('ten-key decision DTO retains effective server Beta quota and freezes nested quota',()=>{
  const dto=readAuthorizationDTO(decision(),'offer.create_private');
  assert.equal(dto.quota.limit,3);assert.equal(dto.quota.remaining,0);
  assert.ok(Object.isFrozen(dto));assert.ok(Object.isFrozen(dto.quota));
  assert.match(errorMessage({authorization:dto}),/Использовано 3 из 3; осталось 0/u);
});
test('extra source authority, malformed quota, unknown version and cross-operation DTO reject',()=>{
  for(const patch of [{version:2},{sourceFingerprint:'a'.repeat(64)},{quota:{...decision().quota,ownerTelegramId:101}},
    {quota:{...decision().quota,remaining:1}},{quota:{...decision().quota,used:-1}},{allowed:1},{validUntil:0}]) {
    assert.throws(()=>readAuthorizationDTO(decision('offer.create_private',patch)),{code:'invalid_response'});
  }
  assert.throws(()=>readAuthorizationDTO(decision(),'offer.edit_own'),{code:'invalid_response'});
});
test('negotiated server authorization is required for each successful read and capability matches route',async()=>{
  for(const body of [{readModelVersion:1},{readModelVersion:1,authorization:decision('offer.edit_own')}]) {
    const client=setup(()=>response(body));await client.authenticate('signed');
    await assert.rejects(client.read('profile'),{code:'invalid_response'});
  }
  const client=setup(()=>response({readModelVersion:1,authorization:decision('profile.read_own',{allowed:true,reasonCode:'allowed',quota:null,actionPolicy:'allow'})}));
  await client.authenticate('signed');assert.equal((await client.read('profile')).authorization.allowed,true);
});
test('old response contract remains compatible until server explicitly negotiates authorizationVersion',async()=>{
  const client=setup(()=>response({readModelVersion:1}),{authorizationVersion:undefined});
  await client.authenticate('signed');assert.equal((await client.read('profile')).readModelVersion,1);
});
test('server 403 quota denial is readable and does not claim an uncertain write',async()=>{
  const client=setup(()=>response({error:'quota_exceeded',authorization:decision()},403));await client.authenticate('signed');
  await assert.rejects(client.mutate('offer.create',{}),error=>error.code==='quota_exceeded' && error.authorization.quota.remaining===0);
  assert.equal(client.uncertain,false);
});
test('server success must carry matching decision and verified commit acknowledgement',async()=>{
  const client=setup(()=>response({commitStatus:'committed',authorization:decision('offer.create_private',{allowed:true,reasonCode:'allowed'})}));
  await client.authenticate('signed');assert.equal((await client.mutate('offer.create',{})).authorization.capability,'offer.create_private');
});
test('malformed successful mutation decision preserves the uncertain-effect fence',async()=>{
  const client=setup(()=>response({commitStatus:'committed',authorization:decision('offer.edit_own')}));
  await client.authenticate('signed');await assert.rejects(client.mutate('offer.create',{}),{code:'outcome_unknown'});
  assert.equal(client.uncertain,true);
});
test('a protected read can close controls after server readiness loss without a new POST',async()=>{
  let calls=0;
  const client=setup(()=>{calls++;return response({readModelVersion:1,
    authorization:decision('profile.read_own',{allowed:true,reasonCode:'allowed',quota:null,actionPolicy:'allow'}),
    features:{version:1,mutationsEnabled:false,offerActionsEnabled:false}});});
  await client.authenticate('signed');await client.read('profile');assert.equal(client.canMutate,false);
  await assert.rejects(client.mutate('offer.create',{}),{code:'writes_unavailable'});assert.equal(calls,1);assert.equal(client.uncertain,false);
});
test('closed visible action decision map rejects internal or future capability projections',async()=>{
  const client=setup(()=>response({readModelVersion:1,view:'mine',collection:'offers',items:[],nextCursor:null,
    authorization:decision('offer.read_own',{allowed:true,reasonCode:'allowed',quota:null}),
    decisions:{'team.members.manage':decision('team.members.manage')}}));await client.authenticate('signed');
  await assert.rejects(client.read('offers',{view:'mine'}),{code:'invalid_response'});
});
test('5xx remains an unknown outcome even when a server denial DTO is attached',async()=>{
  const client=setup(()=>response({error:'quota_exceeded',authorization:decision()},503));await client.authenticate('signed');
  await assert.rejects(client.mutate('offer.create',{}),{code:'outcome_unknown'});assert.equal(client.uncertain,true);
});
