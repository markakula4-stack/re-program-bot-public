import {ADMIN_RELEASE_FRAME} from '../../src/v1.4.1.1/admin-release-frame.mjs';
// These are the exact two statements of reviewed additive migration0004.
// This controller neither replays the old migrations nor changes delivery rows.
export const SUPPORT_ADMIN_BRIDGE_STATEMENTS=Object.freeze([
`CREATE TABLE IF NOT EXISTS support_admin_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  origin_token TEXT NOT NULL UNIQUE,
  actor_id INTEGER NOT NULL,
  source_sha TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('reply','close')),
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  expected_last_message_id INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','rejected')),
  reason_code TEXT,
  message_id INTEGER REFERENCES support_messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
)`,
`CREATE INDEX IF NOT EXISTS support_admin_command_ticket
  ON support_admin_commands(ticket_id,created_at,id)`,
]);
export const SUPPORT_ADMIN_SCHEMA_SQL="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' AND substr(name,1,4)<>'_cf_' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name";
const snapshotSQL=`(SELECT json_group_array(json_array(type,name,tbl_name,sql)) FROM (${SUPPORT_ADMIN_SCHEMA_SQL}))`;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const frame=ADMIN_RELEASE_FRAME.support;
async function schema(db) {
  const result=await db.prepare(SUPPORT_ADMIN_SCHEMA_SQL).all();
  if(result?.success!==true||!Array.isArray(result.results)||!result.results.length||result.results.length>200)
    fail('support_admin_schema_unverified');
  const nativeRows=result.results;
  if(nativeRows.some(row=>!row||typeof row!=='object'||Array.isArray(row)||
    Object.keys(row).sort().join(',')!=='name,sql,tbl_name,type'||
    !['table','index','view','trigger'].includes(row.type)||
    ['name','tbl_name','sql'].some(field=>typeof row[field]!=='string'||!row[field].length)))
    fail('support_admin_schema_unverified');
  // The D1 binding and REST inventory can serialize these same columns in a
  // different property order. Preserve every field and SQL byte; only the
  // object construction order is fixed for the reviewed literal hashes.
  const rows=nativeRows.map(row=>({type:row.type,name:row.name,tbl_name:row.tbl_name,sql:row.sql}));
  return {rows,rawSchemaSha256:await hash(JSON.stringify(rows)),
    nativeRawSchemaSha256:await hash(JSON.stringify(nativeRows)),
    nativeRowPropertyOrder:Object.freeze(Object.keys(nativeRows[0])),
    snapshotJson:JSON.stringify(rows.map(row=>[row.type,row.name,row.tbl_name,row.sql]))};
}
export async function supportAdminBridgeSchemaStatus({env}) {
  if(!env?.SUPPORT_DB?.withSession)fail('support_admin_database_unavailable');
  const state=await schema(env.SUPPORT_DB.withSession('first-primary'));
  const prepared=state.rawSchemaSha256===frame.preparedRawSchemaSha256;
  return Object.freeze({schemaVersion:prepared?4:3,ready:prepared,
    phase:prepared?'prepared':state.rawSchemaSha256===frame.rawSchemaSha256?'accepted_base':'unrecognized',
    rawSchemaSha256:state.rawSchemaSha256,nativeRawSchemaSha256:state.nativeRawSchemaSha256,
    nativeRowPropertyOrder:state.nativeRowPropertyOrder});
}
export async function prepareSupportAdminBridge({env,envelope,configuration}) {
  if(!env?.SUPPORT_DB?.withSession||configuration?.enabled!==true||configuration.ownerId!==8987576334||
    env.SUPPORT_ADMIN_ID!=='8987576334'||envelope?.action!=='prepare'||
    envelope.actorId!==8987576334||envelope.sourceSha!==configuration.sourceSha||
    !envelope.params||typeof envelope.params!=='object'||Array.isArray(envelope.params)||Object.keys(envelope.params).length)
    fail('support_admin_prepare_identity_invalid');
  if(!/^[a-f0-9]{64}$/u.test(frame.rawSchemaSha256)||!/^[a-f0-9]{64}$/u.test(frame.preparedRawSchemaSha256)||
    !frame.schemaSnapshotJson.startsWith('[['))fail('support_admin_prepare_literal_frame_not_ready');
  const db=env.SUPPORT_DB.withSession('first-primary'),before=await schema(db);
  if(before.rawSchemaSha256!==frame.rawSchemaSha256||before.snapshotJson!==frame.schemaSnapshotJson)
    fail('support_admin_prepare_baseline_mismatch');
  const statements=[db.prepare(`SELECT CASE WHEN ${snapshotSQL}=? THEN 1 ELSE json_extract('!','$') END AS migration_guard`).bind(frame.schemaSnapshotJson),
    ...SUPPORT_ADMIN_BRIDGE_STATEMENTS.map(sql=>db.prepare(sql))];
  let committed;
  try {committed=await db.batch(statements);}catch{fail('support_admin_prepare_outcome_unverified');}
  if(!Array.isArray(committed)||committed.length!==3||committed.some(item=>item?.success!==true)||
    committed[0].results?.[0]?.migration_guard!==1)fail('support_admin_prepare_outcome_unverified');
  const after=await schema(db);
  if(after.rawSchemaSha256!==frame.preparedRawSchemaSha256)fail('support_admin_prepare_outcome_unverified');
  return Object.freeze({prepared:true,schemaVersion:4,rawSchemaSha256:after.rawSchemaSha256,
    liveMigrationsApplied:1,statements:3,businessRowsChanged:0,outboxReplays:0,oldMigrationsReplayed:0,retrySafe:false});
}
