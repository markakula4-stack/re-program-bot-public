import test from 'node:test';
import assert from 'node:assert/strict';
import {materializeV1411AdminEnv,adminReleaseHealthProjection,validateCompiledV1411AdminConfig} from '../src/v1.4.1/admin-release-config.mjs';
const source='d'.repeat(40),key='e'.repeat(64);
const config=()=>({version:'1.4.1.1',sourceSha:source,mode:'owner_only',supportBridgeKey:key,supportCandidateSha:source});
const env=()=>({V141_RELEASE_MODE:'owner_only',V141_SOURCE_SHA:source,V141_AUTHORIZATION_ENABLED:'true'});
test('administrator shell and private support bridge need matching compiled owner-only release',()=>{
  const scoped=materializeV1411AdminEnv(env(),config());assert.equal(scoped.V141_ADMIN_MINI_APP_ENABLED,'true');assert.equal(scoped.V141_ADMIN_SUPPORT_BRIDGE_KEY,key);
  for(const base of [{...env(),V141_SOURCE_SHA:'a'.repeat(40)},{...env(),V141_RELEASE_MODE:'recovery'},{...env(),V141_AUTHORIZATION_ENABLED:'false'}]) {
    const denied=materializeV1411AdminEnv({...base,V141_ADMIN_MINI_APP_ENABLED:'true',V141_ADMIN_SUPPORT_BRIDGE_KEY:key},config());
    assert.equal(denied.V141_ADMIN_MINI_APP_ENABLED,'false');assert.equal(denied.V141_ADMIN_SUPPORT_BRIDGE_KEY,undefined);
  }
  assert.equal(materializeV1411AdminEnv({...env(),V141_ADMIN_MINI_APP_ENABLED:'true'},undefined).V141_ADMIN_MINI_APP_ENABLED,'false');
});
test('recovery and disabled product identity never reopen admin or retain bridge credentials',()=>{
  for(const mode of ['recovery','disabled']) {
    const c={...config(),mode,supportBridgeKey:''};const scoped=materializeV1411AdminEnv(env(),c);
    assert.equal(scoped.V141_ADMIN_MINI_APP_ENABLED,'false');assert.equal(scoped.V141_ADMIN_SUPPORT_BRIDGE_KEY,undefined);
    assert.equal(adminReleaseHealthProjection(c).version,'1.4.1.1');
  }
  assert.deepEqual(adminReleaseHealthProjection(undefined),{});
});
test('compiled credentials cannot choose a foreign candidate or an unreviewed feature mode',()=>{
  for(const c of [{...config(),supportCandidateSha:'a'.repeat(40)},{...config(),mode:'enabled'}, {...config(),supportBridgeKey:'short'}, {...config(),version:'1.5.0'}, {...config(),ownerId:123},{...config(),mode:'recovery'}])
    assert.throws(()=>validateCompiledV1411AdminConfig(c),/v1411_admin_compiled_config_invalid/u);
});
