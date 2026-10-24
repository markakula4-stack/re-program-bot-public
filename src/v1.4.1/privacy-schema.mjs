import { P04_SCHEMA } from './privacy-schema-manifest.mjs';

const fail=()=>{throw Object.assign(new Error('v141_schema_not_ready'),{code:'v141_schema_not_ready',status:503});};
export async function inspectP04Schema(db) {
  if(!db?.prepare||!db?.batch) fail();
  const placeholders=P04_SCHEMA.tables.map(()=>'?').join(',');
  let result,ledger;
  try {
    [result,ledger]=await db.batch([
      db.prepare(`SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema
        WHERE tbl_name IN (${placeholders}) ORDER BY type,name`).bind(...P04_SCHEMA.tables),
      db.prepare('SELECT version FROM re_schema_migrations WHERE version=?').bind(P04_SCHEMA.ledgerVersion),
    ]);
  } catch {fail();}
  if(result?.success!==true||ledger?.success!==true||!Array.isArray(result.results)||
      !Array.isArray(ledger.results)||ledger.results.length!==1||ledger.results[0].version!==P04_SCHEMA.ledgerVersion) fail();
  const actual=result.results.map(({type,name,table_name,sql})=>({type,name,table_name,sql}));
  if(JSON.stringify(actual)!==JSON.stringify(P04_SCHEMA.objects)) fail();
  return Object.freeze({ready:true,metadataOnly:true,schemaSha256:P04_SCHEMA.schemaSha256,
    migrationSha256:P04_SCHEMA.migrationSha256});
}
export async function assertP04SchemaReady({binding}={}) {
  if(!binding?.withSession||!binding?.prepare||!binding?.batch) fail();
  await inspectP04Schema(binding.withSession('first-primary'));
  return binding;
}
export { P04_SCHEMA };
