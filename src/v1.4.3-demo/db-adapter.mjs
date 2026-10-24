// Request-local execution fence. It applies to the real financial modules as
// well as demo metadata; a lagging retry cannot write after its winner unlocks.
const providerGuardInsert = /^\s*INSERT\s+INTO\s+mini_app_atomic_guards\s*\(\s*guard_key\s*,\s*precondition_ok\s*\)\s*VALUES\s*\(\s*\?/iu;
const providerGuardCleanup = /^\s*DELETE\s+FROM\s+mini_app_atomic_guards\s+WHERE\s+guard_key\s+LIKE\s+\?\s*;?\s*$/iu;
const providerGuardKey = /^stars_provider_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_(\d+|%)$/u;

export function createDemoExecutionDb({db,ownerId,generation,operationId}) {
 const underlying=new WeakMap();
 const wrap = (statement,scope=null) => {
  const wrapped={
  bind(...params){
   // D1 limits LIKE patterns to50bytes. Compact only temporary provider guard
   // UUIDs; retain every entropy bit, suffix, SQL predicate and other binding.
   const match=scope&&typeof params[0]==='string'?providerGuardKey.exec(params[0]):null;
   if(match&&(scope==='insert'?match[2]!=='%':match[2]==='%'))params[0]='stars_provider_'+match[1].replaceAll('-','')+'_'+match[2];
   return wrap(statement.bind(...params),scope);
  },
  first(...args){return statement.first(...args);},
  all(...args){return statement.all(...args);},
  raw(...args){return statement.raw(...args);},
  async run(){return (await adapter.batch([statement]))[0];},
  };
  underlying.set(wrapped,statement);
  return wrapped;
 };
 const adapter = {
  prepare(sql){return wrap(db.prepare(sql),providerGuardInsert.test(sql)?'insert':providerGuardCleanup.test(sql)?'cleanup':null);},
  withSession(){return adapter;},
  async batch(statements){
   const guard='demo-execution-'+crypto.randomUUID();
   try {
    const result=await db.batch([
     db.prepare(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
      VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM re_demo_generations g JOIN re_demo_operations o
       ON o.owner_id=g.owner_id AND o.generation=g.generation
       WHERE g.owner_id=? AND g.generation=? AND g.locked_operation_id=?
       AND o.operation_id=? AND o.state='pending') THEN 1 ELSE 0 END)`)
      .bind(guard,ownerId,generation,operationId,operationId),
     // D1's native statement already owns raw(), a query method. Only unwrap
     // our own privately branded wrappers, never a public property name.
     ...statements.map(s=>underlying.get(s)??s),
     db.prepare('DELETE FROM mini_app_atomic_guards WHERE guard_key=?').bind(guard),
    ]);
    if(!Array.isArray(result)||result.length!==statements.length+2||result.some(row=>row?.success!==true))throw Object.assign(new Error('demo_commit_unverified'),{code:'demo_commit_unverified',status:503});
    return result.slice(1,-1);
   } catch(error) {
    const op=await db.prepare('SELECT state FROM re_demo_operations WHERE owner_id=? AND operation_id=?').bind(ownerId,operationId).first();
    if(op?.state==='completed')throw Object.assign(new Error('demo_execution_obsolete'),{code:'demo_execution_obsolete',status:409});
    throw error;
   }
  },
 };
 return Object.freeze(adapter);
}
