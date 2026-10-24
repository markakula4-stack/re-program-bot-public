import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {foundationFixture} from './helpers/v1.4.1-fixtures.mjs';
import {runP05AiScenarios,P05_AI_PHASES} from './helpers/v1.4.1-p05-ai-scenarios.mjs';

test('native-friendly AI scenario uses actual executors and preserves known cost plus unknown anonymous hold',async t=>{
  const f=foundationFixture(t);f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  const stages=[];
  for(const phase of P05_AI_PHASES){const before=f.binding.audit.length;const result=await runP05AiScenarios({binding:f.binding,env:{...f.serverEnv,V141_P05_ISOLATED_PROBE:'true'},phase});
    const statements=f.binding.audit.length-before;assert.ok(statements<1000,phase+':'+statements);t.diagnostic(phase+': '+statements+' SQL statements');stages.push(result);}
  const result={public:stages[0].public,partnerKnown:stages[3].partnerKnown,unknown:{...stages[3].unknown,replayProviderCalls:stages[2].replayProviderCalls},privacy:stages[3].privacy};
  assert.equal(result.public.state,'terminal_succeeded');assert.equal(result.public.providerCalls,1);
  assert.equal(result.partnerKnown.costMicrousd,15);assert.equal(result.unknown.state,'unknown');
  assert.equal(result.unknown.replayProviderCalls,0);assert.equal(result.privacy.anonymousJournalCount,2);
  assert.equal(result.privacy.aggregateCostMicrousd,15);
});
