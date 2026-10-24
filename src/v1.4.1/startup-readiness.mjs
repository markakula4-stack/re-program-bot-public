import {readV141ReleaseConfig} from './release-config.mjs';
import {RELEASE_CONFIG_GLOBAL,validateCompiledReleaseConfig} from '../v1.4.0-rebuild/release-config.mjs';
import {canonicalRebuildPrivacyBinding} from '../v1.4.0-rebuild/privacy-binding.mjs';
import {V143_STARTUP_SCHEMA} from '../v1.4.3/startup-schema-manifest.mjs';

export const V141_STARTUP_RUNTIME_KEY='__RE_PROGRAM_V141_STARTUP_READINESS__';
const PREPARED_DDL_SHA256='73adf30ab1fbf46521d54df388422ceac174dc15a266a8b52299555cfb038132';
// Exact 0075 D1 schema and ledger, attested by the installed364 amendment.
// This adds the prepared package release to the existing startup shortcut.
const PACKAGE_PREPARED=Object.freeze({objectCount:1254,markerCount:70,
  schemaSha256:'11772521447867efa55f59e165522f27d95e5789c09cbb3de73d42d91b0973d9',
  ledgerSha256:'c226575640162cfed4d60c10269d1729eea90c5bb25e4d039200240d4951e025'});
const MARKERS=Object.freeze(['1.4.1-capability-policy','1.4.1-grants-overrides','1.4.1-audit-rollout','1.4.1-privacy-ai-journal']);
const SCHEMA_SQL="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name LIMIT 2001";
const METADATA_SQL=`SELECT
  (SELECT json_group_array(json_array(type,name,tbl_name,sql)) FROM (${SCHEMA_SQL})) schema_json,
  (SELECT json_group_array(version) FROM (SELECT version FROM re_schema_migrations ORDER BY version LIMIT 257)) ledger_json,
  EXISTS(SELECT 1 FROM mini_app_release_control WHERE id=1 AND candidate_sha=? AND revision=?
    AND state='closed' AND beta_enabled=0 AND owner_telegram_id IS NULL AND issued_at IS NULL AND expires_at IS NULL) lease_ready`;
const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');

// This is a schema bootstrap shortcut, never an authorization decision. It
// observes only a compiled owner/recovery release with the exact prepared DDL,
// fixed migration ledger and closed source epoch. Every effect still performs
// its existing fresh actor, role, consent, source and same-batch assertions.
export function createV141StartupReadiness({readRelease=readV141ReleaseConfig,
  readRebuild=()=>globalThis[RELEASE_CONFIG_GLOBAL]}={}) {
  return Object.freeze({schemaCacheKey:canonicalRebuildPrivacyBinding,async isPrepared(env) {
    let release,rebuild;
    try {release=readRelease();rebuild=validateCompiledReleaseConfig(readRebuild());}catch{return false;}
    if(!release||!['owner_only','recovery'].includes(release.V141_RELEASE_MODE)||
      Object.entries(release).some(([key,value])=>env?.[key]!==value)||
      ['REBUILD_V140_RC_SHA','REBUILD_V140_RELEASE_REVISION','REBUILD_V140_RELEASE_LEASE_REQUIRED'].some(key=>env?.[key]!==rebuild[key])||
      !env?.DB?.withSession)return false;
    let rows;
    try {const db=env.DB.withSession('first-primary');
      rows=await db.prepare(METADATA_SQL).bind(rebuild.REBUILD_V140_RC_SHA,Number(rebuild.REBUILD_V140_RELEASE_REVISION)).all();
    }catch(error){
      // A depleted account cannot initialize tables either. Preserve the error
      // instead of starting the historical migration batches after this read.
      if(/D1|free tier/iu.test(String(error?.message??''))&&
        /free tier daily row (?:read|write) limit/iu.test(String(error?.message??'')))throw error;
      return false;
    }
    if(rows?.success!==true||!Array.isArray(rows.results)||rows.results.length!==1)return false;
    const row=rows.results[0];if(row.lease_ready!==1||typeof row.schema_json!=='string'||
      typeof row.ledger_json!=='string'||new TextEncoder().encode(row.schema_json).length>8_388_608)return false;
    let objects,versions;
    try {objects=JSON.parse(row.schema_json);versions=JSON.parse(row.ledger_json);}catch{return false;}
    if(!Array.isArray(objects)||objects.length<1||objects.length>2000||objects.some(r=>!Array.isArray(r)||r.length!==4||r.some(v=>typeof v!=='string'))||
      !Array.isArray(versions)||versions.length>256||versions.some(v=>typeof v!=='string')||
      !MARKERS.every(v=>versions.includes(v))||versions.some(v=>/v?1\.4\.1|^006[2-5](?:-|$)/iu.test(v)&&!MARKERS.includes(v)))return false;
    const lifecycleVersions=versions.filter(v=>/v?1\.4\.3|^006[678](?:-|$)/iu.test(v));
    const schemaHash=await hash(JSON.stringify(objects));
    if(objects.length===PACKAGE_PREPARED.objectCount&&versions.length===PACKAGE_PREPARED.markerCount&&
      schemaHash===PACKAGE_PREPARED.schemaSha256&&await hash(JSON.stringify(versions))===PACKAGE_PREPARED.ledgerSha256)return true;
    if(lifecycleVersions.length===0)return schemaHash===PREPARED_DDL_SHA256;
    // Exact reviewed expansion only. A marker alone, partial migration, unknown
    // lifecycle marker or changed old guard cannot claim prepared readiness.
    return V143_STARTUP_SCHEMA.baselineSchemaSha256===PREPARED_DDL_SHA256&&
      V143_STARTUP_SCHEMA.profiles.some(profile=>profile.schemaSha256===schemaHash&&
        profile.objectCount===objects.length&&profile.markers.length===lifecycleVersions.length&&
        profile.markers.every(marker=>lifecycleVersions.includes(marker)));
  }});
}
export function installV141StartupReadiness() {
  globalThis[V141_STARTUP_RUNTIME_KEY]=createV141StartupReadiness();
}
