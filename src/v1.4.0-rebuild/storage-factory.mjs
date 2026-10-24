import { createD1CabinetRepository } from './d1-cabinet-repository.mjs';
import { CabinetStorageError } from './command-sql.mjs';
import { REVIEWED_SCHEMA } from './reviewed-schema.mjs';
import {releaseLeaseFence,releaseAdminFence,assertReleaseLease} from './release-lease.mjs';

export const makeQueryBudget=()=>({limit:50,used:0});
export function budgetBinding(binding,budget=makeQueryBudget(),{fence=null}={}) {
  const consume=n=>{
    if (!Number.isSafeInteger(n)||budget.used+n>budget.limit) throw new CabinetStorageError('query_budget_unavailable');
    budget.used+=n;
  };
  const session=raw=>{
    const fencedBatch=(statements,readOnly=false)=>{
      consume(statements.length+(fence&&!readOnly?2:0));
      if(!fence||readOnly)return raw.batch(statements);
      const key='release_'+crypto.randomUUID();
      return raw.batch([
        raw.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN ${fence.sql} THEN 1 ELSE 0 END)`).bind(key,...fence.params),
        ...statements,raw.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(key)]).then(result=>result.slice(1,-1));
    };
    return {
    prepare(sql) {
      const readOnly=/^\s*(SELECT|PRAGMA|EXPLAIN)\b/iu.test(sql);
      const wrap=statement=>({native:statement,readOnly,
        bind(...values){return wrap(statement.bind(...values));},
        first(column){if(fence&&!readOnly)return fencedBatch([statement]).then(results=>{const r=results[0].results?.[0]??null;return column?r?.[column]??null:r;});consume(1);return statement.first(column);},
        all(...args){if(fence&&!readOnly)return fencedBatch([statement]).then(results=>results[0]);consume(1);return statement.all(...args);},
        run(...args){if(fence&&!readOnly)return fencedBatch([statement]).then(results=>results[0]);consume(1);return statement.run(...args);},
      });
      return wrap(raw.prepare(sql));
    },
    batch(statements){return fencedBatch(statements.map(s=>s.native),statements.every(s=>s.readOnly));},
    withSession(mode){return session(raw.withSession(mode));},
  };};
  return session(binding);
}
export function reviewedRepositoryFactory(env,options={}) {
  if (env.REBUILD_V140_STORAGE_ENABLED!=='true') throw new CabinetStorageError('storage_unavailable');
  if(options.accessScope!==undefined&&!['participant','admin'].includes(options.accessScope))throw new CabinetStorageError('release_lease_unavailable');
  const admin=options.accessScope==='admin',fence=admin?releaseAdminFence(env):releaseLeaseFence(env),
    binding=budgetBinding(env.DB,options.budget,{fence}),repo=createD1CabinetRepository(binding,{...options,schemaManifest:REVIEWED_SCHEMA});
  return Object.freeze({...repo,async assertCandidateSchema(){
    await repo.assertCandidateSchema();
    if(fence){const lease=await repo.one('mini_app_release_control','id=1');
      if(admin){
        if(!lease||lease.candidateSha!==fence.params[0]||lease.revision!==fence.params[1])throw new CabinetStorageError('release_lease_unavailable');
        await assertReleaseLease(binding,fence);return true;
      }
      const [sha,revision,owner,issued,expires]=fence.params;
      if(!lease||lease.state!=='open'||lease.candidateSha!==sha||lease.revision!==revision||lease.ownerTelegramId!==owner||
        lease.issuedAt!==issued||lease.expiresAt!==expires||expires<=Math.floor(Date.now()/1000))throw new CabinetStorageError('release_lease_unavailable');
      repo.deadline(expires);
    }return true;
  }});
}
