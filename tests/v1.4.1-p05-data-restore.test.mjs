import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runP05DataRestoreDrill} from './helpers/v1.4.1-p05-data-restore.mjs';

test('populated0065 restores exactly and accepted default-off Worker preserves foreign seal and anonymous AI cost/hold',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'v141-p05-data-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const proof=await runP05DataRestoreDrill({directory});
  assert.equal(proof.status,'PASS');assert.equal(proof.providerCalls,0);
  assert.equal(proof.sealedForeignGrantAfterIssuerDeletion,true);
  assert.equal(proof.knownCostMicrousd,15);assert.equal(proof.anonymousUnknownHoldMicrousd,15);
  assert.equal(proof.newDataPreservedAfterRuntimeRollback,true);
  assert.deepEqual(proof.production,{appliedMigrations:0,deployments:0,networkRequests:0});
});
