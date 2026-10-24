// Exact finite additive schema proof. No DDL or financial writers.
const freeze = value => Object.freeze(value);
export const PACKAGE_REFERRAL_SCHEMA = freeze({
  marker: '1.4.4-package-referral-compatibility',
  tables: freeze(['package_referral_candidates','package_referral_rewards','package_referral_transitions',
    'package_referral_protection_jobs','package_referral_protection_checks','referral_reward_lifetime_slots',
    'package_referral_bonus_grants','package_referral_bonus_segments','package_referral_bonus_effects',
    'package_referral_bonus_transitions','package_referral_bonus_reversals','referral_bonus_reward_slots']),
  attachedTriggers: freeze(['v144_legacy_referral_lifetime_guard','v144_legacy_referral_lifetime_claim',
    'v144_legacy_referral_bonus_slot_guard','v144_legacy_referral_bonus_slot_claim']),
  schemaSha256: 'a9a8aab36b2cac304aa49b969b596571e537a4d04ba738c68a3d7b6f0a6ac4f6', migrationSha256: '3a4cca77967607e098be817b6e85e41e7a2760d1aa4c63df094efe1d03de57b8', objectCount: 131,
});
const query = `SELECT type,name,tbl_name AS table_name,sql FROM sqlite_master WHERE tbl_name IN (${PACKAGE_REFERRAL_SCHEMA.tables.map(()=>'?')}) OR name IN (${PACKAGE_REFERRAL_SCHEMA.attachedTriggers.map(()=>'?')}) ORDER BY type,name`;
const scope = [...PACKAGE_REFERRAL_SCHEMA.tables,...PACKAGE_REFERRAL_SCHEMA.attachedTriggers];
const captured = new WeakMap();
const fail = code => {const error = new Error(code);error.code=code;throw error;};
const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
export async function inspectPackageReferralSchema(db,{required=false}={}) {
  if (!db?.prepare) fail('package_referral_storage_unavailable');
  const response = await db.prepare(query).bind(...scope).all();
  if(response?.success!==true) fail('package_referral_storage_unavailable');
  const rows = response.results;
  if (!Array.isArray(rows) || rows.length>256 || rows.some(r=>typeof r.type!=='string'||typeof r.name!=='string'||typeof r.table_name!=='string'||r.sql!==null&&typeof r.sql!=='string')) fail('package_referral_schema_invalid');
  const marker = await db.prepare('SELECT version FROM re_schema_migrations WHERE version=?').bind(PACKAGE_REFERRAL_SCHEMA.marker).first();
  if (!rows.length&&!marker) {
    if(required) fail('package_referral_schema_missing');
    const inspected=freeze({ready:true,present:false});captured.set(inspected,'[]');return inspected;
  }
  const serialized = JSON.stringify(rows);
  if (serialized.length>131072 || rows.length!==PACKAGE_REFERRAL_SCHEMA.objectCount || marker?.version!==PACKAGE_REFERRAL_SCHEMA.marker || await sha(serialized)!==PACKAGE_REFERRAL_SCHEMA.schemaSha256) fail('package_referral_schema_invalid');
  const inspected=freeze({ready:true,present:true,marker:PACKAGE_REFERRAL_SCHEMA.marker,schemaSha256:PACKAGE_REFERRAL_SCHEMA.schemaSha256,migrationSha256:PACKAGE_REFERRAL_SCHEMA.migrationSha256,objectCount:rows.length});
  captured.set(inspected,serialized);return inspected;
}
export function packageReferralSchemaAssertion(inspected) {
  const serialized=captured.get(inspected);
  if (!serialized) fail('package_referral_schema_assertion_invalid');
  // Exact SQL text, object identity and marker are captured in the same D1 write batch.
  return freeze({sql:`(SELECT json_group_array(json_object('type',type,'name',name,'table_name',table_name,'sql',sql)) FROM (${query}))=? AND ${inspected.present?'EXISTS':'NOT EXISTS'}(SELECT 1 FROM re_schema_migrations WHERE version=?)`,params:freeze([...scope,serialized,PACKAGE_REFERRAL_SCHEMA.marker])});
}
