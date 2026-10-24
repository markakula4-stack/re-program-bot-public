import { LIFECYCLE_SCHEMA } from './lifecycle-schema-manifest.mjs';

const fail=()=>{throw Object.assign(new Error('v143_schema_not_ready'),{code:'v143_schema_not_ready',status:503});};
const resultRows=result=>{if(result?.success!==true||!Array.isArray(result.results))fail();return result.results;};
const stageMarkers=Object.freeze(Object.keys(LIFECYCLE_SCHEMA.stages));
const markerSlots=stageMarkers.map(()=>'?').join(',');
export function lifecycleSchemaAssertion(state) {
  if(!state?.present) return Object.freeze({sql:`NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE tbl_name IN (${LIFECYCLE_SCHEMA.lifecycleTables.map(()=>'?').join(',')}))
    AND NOT EXISTS(SELECT 1 FROM re_schema_migrations WHERE version IN (${markerSlots}))`,
    params:Object.freeze([...LIFECYCLE_SCHEMA.lifecycleTables,...stageMarkers])});
  const stage=LIFECYCLE_SCHEMA.stages[state.marker];
  if(!stage)fail();
  return Object.freeze({sql:`(SELECT COALESCE(json_group_array(json(object)),'[]') FROM
    (SELECT json_object('type',type,'name',name,'table_name',tbl_name,'sql',sql) AS object
      FROM sqlite_schema WHERE tbl_name IN (${stage.tables.map(()=>'?').join(',')}) ORDER BY type,name)) IS ?
    AND (SELECT COALESCE(json_group_array(version),'[]') FROM
      (SELECT version FROM re_schema_migrations WHERE version IN (${markerSlots}) ORDER BY version)) IS ?`,
    params:Object.freeze([...stage.tables,JSON.stringify(stage.objects),...stageMarkers,JSON.stringify([...stage.markers].sort())])});
}
// Optional for the accepted 0065 runtime; once any extension is present, all
// constraints and migration markers must match its exact reviewed stage.
export async function inspectLifecycleSchema(db,{required=false}={}) {
  if(!db?.prepare||!db?.batch)fail();
  // The accepted Stars facade historically used first() for metadata reads.
  // An absent extension keeps that facade compatible; present stages require
  // the strict D1 batch results below and never accept an incomplete manifest.
  let presence;
  try {presence=await db.prepare(`SELECT
    (SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name IN (${LIFECYCLE_SCHEMA.lifecycleTables.map(()=>'?').join(',')})) AS table_count,
    (SELECT COUNT(*) FROM re_schema_migrations WHERE version IN (${markerSlots})) AS marker_count`)
    .bind(...LIFECYCLE_SCHEMA.lifecycleTables,...stageMarkers).first();}catch{fail();}
  if(!presence||!Number.isSafeInteger(Number(presence.table_count))||Number(presence.table_count)<0||
    !Number.isSafeInteger(Number(presence.marker_count))||Number(presence.marker_count)<0)fail();
  if(Number(presence.table_count)===0&&Number(presence.marker_count)===0){
    if(required)fail();return Object.freeze({ready:true,present:false,metadataOnly:true});
  }
  let metadata;
  try { metadata=await db.batch([
    db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${LIFECYCLE_SCHEMA.lifecycleTables.map(()=>'?').join(',')}) ORDER BY name`).bind(...LIFECYCLE_SCHEMA.lifecycleTables),
    db.prepare(`SELECT version FROM re_schema_migrations WHERE version IN (${markerSlots}) ORDER BY version`).bind(...stageMarkers),
  ]); } catch {fail();}
  const tables=resultRows(metadata[0]),markers=resultRows(metadata[1]).map(row=>row.version);
  if(!tables.length&&!markers.length){if(required)fail();return Object.freeze({ready:true,present:false,metadataOnly:true});}
  const marker=[...stageMarkers].reverse().find(value=>markers.includes(value));
  const stage=LIFECYCLE_SCHEMA.stages[marker];
  if(!stage)fail();
  if(JSON.stringify(markers)!==JSON.stringify([...stage.markers].sort()))fail();
  const expected=stage.tables.filter(table=>LIFECYCLE_SCHEMA.lifecycleTables.includes(table)).sort();
  if(JSON.stringify(tables.map(row=>row.name))!==JSON.stringify(expected))fail();
  let result;
  try {result=await db.prepare(`SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema
    WHERE tbl_name IN (${stage.tables.map(()=>'?').join(',')}) ORDER BY type,name`).bind(...stage.tables).all();}catch{fail();}
  const actual=resultRows(result).map(({type,name,table_name,sql})=>({type,name,table_name,sql}));
  if(JSON.stringify(actual)!==JSON.stringify(stage.objects))fail();
  return Object.freeze({ready:true,present:true,metadataOnly:true,marker,schemaSha256:stage.schemaSha256,
    migrationSha256:LIFECYCLE_SCHEMA.migrationSha256});
}
export { LIFECYCLE_SCHEMA };
