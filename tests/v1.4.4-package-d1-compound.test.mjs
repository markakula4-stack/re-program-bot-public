import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {packageSubscriptionHttpFixture} from './helpers/v1.4.4-package-subscription-http-fixture.mjs';

// This public SQL is the exact seven-source preload emitted by the accepted
// owner350 raw bundle ad75cec3... in an isolated native Worker request. It
// contains placeholders only, and no live account or credential values.
const historicalSql=fs.readFileSync(new URL('./fixtures/v1.4.4/package-preload-owner350.sql',import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const isPreload=sql=>sql.startsWith('SELECT (SELECT COALESCE(json_group_array(json(snapshot))')&&sql.includes('AS package_snapshot_6');

// Enforce the observed D1 compound bound by parsing only SQL tokens outside
// strings/comments. Distinct parenthesized SELECT expressions are independent
// compounds; scalar subqueries do not add terms to their containing SELECT.
function compoundTerms(sql){
 const tokens=sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\n]*|\/\*[\s\S]*?\*\/|\(|\)|[A-Za-z_][A-Za-z_0-9]*/gu)??[];
 const stack=[0],counts=new Map();let frame=0;
 for(const token of tokens){
  if(token==='(')stack.push(++frame);
  else if(token===')'){assert.ok(stack.length>1);stack.pop();}
  else if(['UNION','INTERSECT','EXCEPT'].includes(token.toUpperCase()))counts.set(stack.at(-1),(counts.get(stack.at(-1))??1)+1);
 }
 return Math.max(1,...counts.values());
}
function guarded(f,{historical=false,alter=null}={}){
 const original=f.binding.prepare.bind(f.binding),seen=[],rejected=[];
 f.binding.prepare=sql=>{
  const legacy=historical&&isPreload(sql),actual=legacy?historicalSql:sql;
  const terms=compoundTerms(actual);seen.push({sql:actual,terms,legacy});
  if(terms>5){rejected.push({sql:actual,terms});throw new Error('too many terms in compound SELECT: SQLITE_ERROR');}
  const statement=original(actual);
  if(!alter||!isPreload(sql))return statement;
  const wrap=st=>{
   const bind=st.bind.bind(st),all=st.all.bind(st);
   st.bind=(...values)=>wrap(bind(...values));
   st.all=async()=>{const result=await all();return alter(result);};
   return st;
  };
  return wrap(statement);
 };
 return {seen,rejected};
}
const read=f=>f.call(900,'subscription',{token:f.session.sessionToken,customEnv:f.serverEnv});
const cash=f=>JSON.stringify(['subscription_orders','payment_ledger','subscription_access_grants',
 'subscription_billing_contracts','subscription_provider_commands','subscription_package_periods',
 'subscription_plan_transitions','terms_acceptances'].map(table=>f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));

test('genuine historical owner350 seven-branch preload is refused under the D1 compound bound and HTTP preserves its503',async t=>{
 assert.equal(Buffer.byteLength(historicalSql),8968);
 assert.equal(hash(historicalSql),'fb388caa09119627299df1b0c698a67405894df9b8ae8e4f2f645b867ec4b48b');
 assert.equal(compoundTerms(historicalSql),7);
 assert.equal(compoundTerms("SELECT 'UNION ALL (' AS label UNION ALL SELECT '-- UNION'"),2);
 const f=await packageSubscriptionHttpFixture(t),before=cash(f),guard=guarded(f,{historical:true});f.binding.audit.length=0;
 const result=await read(f);
 assert.equal(result.status,503);assert.equal(result.data.error,'unavailable');
 assert.equal(guard.rejected.length,1);assert.equal(guard.rejected[0].sql,historicalSql);
 assert.equal(cash(f),before);assert.ok(f.binding.audit.every(row=>row.mode==='read'));
});

test('current scalar package preload returns200 with every source fresh, one preload read and the unchanged160 budget',async t=>{
 const f=await packageSubscriptionHttpFixture(t),before=cash(f),guard=guarded(f);f.binding.audit.length=0;
 const result=await read(f);
 assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.packages.available,true);
 assert.equal(result.data.packages.offers.find(row=>row.planCode==='professional'&&row.packageCode==='3m').amountStars,699);
 assert.equal(guard.rejected.length,0);assert.equal(guard.seen.filter(row=>isPreload(row.sql)).length,1);
 assert.ok(guard.seen.every(row=>row.terms<=5));assert.ok(f.binding.audit.length<=160);
 assert.ok(f.binding.audit.every(row=>row.mode==='read'));assert.equal(cash(f),before);
 t.diagnostic(`subscription reads=${f.binding.audit.length}, original authorization budget=160`);
});

test('scalar source packing still rejects a changed price at its final freshness fence',async t=>{
 const f=await packageSubscriptionHttpFixture(t),guard=guarded(f),original=f.binding.batch.bind(f.binding);let changed=false;
 f.binding.batch=async statements=>{
  if(!changed&&statements.some(st=>st.sql.startsWith('SELECT CASE WHEN')&&st.sql.includes('AS allowed'))){changed=true;
   f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,
    billing_mode,publication_state,terms_revision,valid_from,created_at)
    VALUES('professional-90d-prepaid-v2',2,'professional','XTR',699,7776000,'prepaid','approved',?,?,?)`)
    .run(f.serverEnv.STARS_TERMS_REVISION,f.now-1,f.now-1);
  }
  return original(statements);
 };
 const result=await read(f);assert.equal(changed,true);assert.equal(result.status,409);assert.equal(result.data.error,'package_read_stale');
 assert.equal(guard.rejected.length,0);
});

for(const [name,alter] of [
 ['missing snapshot',result=>{delete result.results[0].package_snapshot_2;return result;}],
 ['extra snapshot',result=>{result.results[0].package_snapshot_7='[]';return result;}],
 ['wrong snapshot type',result=>{result.results[0].package_snapshot_2=[];return result;}],
 ['malformed snapshot JSON',result=>{result.results[0].package_snapshot_2='not-json';return result;}],
 ['non-array snapshot JSON',result=>{result.results[0].package_snapshot_2='{}';return result;}],
 ['more than128 source rows',result=>{result.results[0].package_snapshot_2=JSON.stringify(Array.from({length:129},()=>({transition_id:'offline'})));return result;}],
 ['more than1MB source snapshot',result=>{result.results[0].package_snapshot_2=' '.repeat(1000001);return result;}],
 ['extra result row',result=>{result.results.push({...result.results[0]});return result;}],
 ])test(`scalar preload fails closed for ${name}`,async t=>{
  const f=await packageSubscriptionHttpFixture(t),before=cash(f);guarded(f,{alter});f.binding.audit.length=0;
  const result=await read(f);assert.equal(result.status,503);assert.equal(result.data.error,'unavailable');
  assert.equal(cash(f),before);assert.ok(f.binding.audit.every(row=>row.mode==='read'));
 });
