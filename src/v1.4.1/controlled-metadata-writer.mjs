import { isTrustedContext, readTrustedContext } from './trusted-context.mjs';
import { isTrustedActor, readActorFacts, readActorContext, accountGenerationFingerprint,
  manualGrantSourceFingerprint, canonicalAuthoritySealCore } from './authority-resolver.mjs';
import { isTrustedResource, readResourceFacts, readResourceContext } from './resource-resolver.mjs';
import { isTrustedDecision, readDecisionFacts, readDecisionContext, compileDecisionAssertions } from './entitlement-engine.mjs';
import { CAPABILITY_CATALOG, PLAN_CAPABILITIES, FOUNDATION_POLICY_VERSION } from './capability-policy.mjs';
import { inspectP04Schema, P04_SCHEMA } from './privacy-schema.mjs';

// Unwired controlled internal issuer. No HTTP/Telegram route imports it. The
// default-off candidate switch and branded current canonical-admin decision
// are both mandatory. The private signer accepts only this fixed constructed
// grant, never a caller row, source hash, author, role, or arbitrary policy.
export const CONTROLLED_METADATA_RUNTIME_WIRED = false;
export const CONTROLLED_MANUAL_CAPABILITIES = Object.freeze(CAPABILITY_CATALOG.filter(row =>
  row.actor_kind === 'customer' && !row.future_release && row.availability !== 'future_disabled' &&
  !/^(?:admin|service|crm|team|billing|preview)\./u.test(row.capability) && row.capability !== 'ai.provider.external.use'
).map(row => row.capability));
const allowed = new Set(CONTROLLED_MANUAL_CAPABILITIES), HASH = /^[0-9a-f]{64}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export class ControlledMetadataError extends Error {
  constructor(code, status = 403) { super(code); this.name = 'ControlledMetadataError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ControlledMetadataError(code, status); };
const bytes = new TextEncoder();
const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2,'0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', bytes.encode(value)));
async function hmac(secret, value, deriveDomain = null) {
  const material = deriveDomain === null ? bytes.encode(secret) : await crypto.subtle.digest('SHA-256', bytes.encode(deriveDomain + '\n' + secret));
  const key = await crypto.subtle.importKey('raw', material, { name:'HMAC',hash:'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,bytes.encode(value)));
}
const sameRow = (actual, expected) => actual && expected && Object.keys(expected).every(key => actual[key] === expected[key]);
const snakeRow = row => Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => key !== 'authoritySource').map(([key,value]) =>
  [key.replace(/[A-Z]/gu, letter => '_' + letter.toLowerCase()),value]));
const statement = (db,sql,params=[]) => db.prepare(sql).bind(...params);

export function createControlledMetadataWriter() {
  return Object.freeze({ runtimeWired:false,
    async issueManualCapabilityGrant(decision) {
      if (!isTrustedDecision(decision)) fail('untrusted_decision');
      const evaluated = readDecisionFacts(decision), context = readDecisionContext(decision);
      if (!isTrustedContext(context) || !isTrustedActor(evaluated.actor) || !isTrustedResource(evaluated.resource) ||
          readActorContext(evaluated.actor) !== context || readResourceContext(evaluated.resource) !== context) fail('proof_context_mismatch');
      const identity = readTrustedContext(context), actor = readActorFacts(evaluated.actor), resource = readResourceFacts(evaluated.resource);
      if (identity.actorKind !== 'customer' || identity.operation !== 'admin.entitlement.manage' ||
          evaluated.capability !== identity.operation || identity.env.V141_INTERNAL_METADATA_WRITER_ENABLED !== 'true' ||
          actor.canonicalOwner !== true || evaluated.publicDTO.allowed !== true) fail('controlled_issuer_unavailable');
      if (!actor.canonical.sealedMetadataTables.includes('entitlement_grants')) fail('metadata_schema_unavailable',503);
      await inspectP04Schema(identity.db);
      const input = identity.requestPayload, fields = ['subjectTelegramId','capability','scopeKind','scopeKey','expiresAt','reason'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length ||
          fields.some(field => !Object.hasOwn(input,field)) || !positive(input.subjectTelegramId) ||
          input.subjectTelegramId === identity.telegramId || !allowed.has(input.capability) || input.scopeKind !== 'actor' ||
          input.scopeKey !== 'actor:' + input.subjectTelegramId || !positive(input.expiresAt) ||
          input.expiresAt <= identity.nowSeconds || input.expiresAt > identity.nowSeconds + 2_592_000 ||
          typeof input.reason !== 'string' || input.reason.trim() !== input.reason || !input.reason || input.reason.length > 1000 ||
          resource.kind !== 'entitlement_subject' || resource.ref !== input.subjectTelegramId ||
          resource.ownerTelegramId !== input.subjectTelegramId || resource.domain.internalWriterReleased !== true ||
          resource.domain.publishedPolicyBoundaries !== true || resource.domain.authenticatedIssuer !== true) fail('invalid_controlled_grant');
      const target = snakeRow(resource.canonical.targetUser);
      const generation = await accountGenerationFingerprint(target);
      if (!HASH.test(generation ?? '') || target.telegram_id !== input.subjectTelegramId || target.accepted_terms !== 1 || target.is_blocked !== 0) fail('target_identity_unavailable');
      const expectedCatalog = CAPABILITY_CATALOG.find(row => row.capability === input.capability);
      const expectedPlans = PLAN_CAPABILITIES.filter(row => row.capability === input.capability);
      const catalog = resource.canonical.requestedCapabilityCatalog, projections = resource.canonical.requestedPlanCapabilities;
      if (!sameRow(snakeRow(catalog),expectedCatalog) ||
          !Array.isArray(projections) || projections.length !== 4 || expectedPlans.some(expected =>
            !projections.some(actual => sameRow(snakeRow(actual),expected)))) fail('published_policy_conflict');
      if (!HASH.test(identity.operationId ?? '') || !HASH.test(identity.payloadHash ?? '') ||
          typeof identity.env.MINI_APP_IDEMPOTENCY_SECRET !== 'string' || identity.env.MINI_APP_IDEMPOTENCY_SECRET.length < 32) fail('missing_operation_binding');
      const stable = JSON.stringify(['v1.4.1.controlled.manual-grant',identity.botId,identity.telegramId,actor.accountFingerprint,identity.operationId]);
      const operationKey = await hmac(identity.env.MINI_APP_IDEMPOTENCY_SECRET,stable), receiptKey = 'mikey_' + operationKey;
      const grantId = 'v141_manual_' + operationKey;
      const row = { grant_id:grantId,idempotency_key:operationKey,policy_version:FOUNDATION_POLICY_VERSION,
        capability:input.capability,subject_telegram_id:input.subjectTelegramId,subject_source_fingerprint:generation,
        scope_kind:'actor',scope_key:input.scopeKey,source_kind:'manual_capability',source_ref:'manual:' + grantId,
        source_revision:1,source_fingerprint:null,issued_by:identity.telegramId,reason:input.reason,
        starts_at:identity.nowSeconds,expires_at:input.expiresAt,revision:1,created_at:identity.nowSeconds,updated_at:identity.nowSeconds,
        revoked_at:null,revoked_by:null,revocation_reason:null,retention_until:null,issuer_anonymized:0,revoker_anonymized:0,
        authority_seal:null,seal_version:1 };
      row.source_fingerprint = await manualGrantSourceFingerprint(row,generation);
      const core = canonicalAuthoritySealCore('entitlement_grants',row);
      if (!core) fail('invalid_controlled_grant');
      row.authority_seal = await hmac(identity.env.BOT_TOKEN,core,'v1.4.1.authority-seal.key');
      const requestHash = await digest(JSON.stringify([identity.payloadHash,generation,FOUNDATION_POLICY_VERSION]));
      const db = identity.db, sourceProofs = compileDecisionAssertions(decision).assertions;
      const schemaProof = { sql: `(SELECT COALESCE(json_group_array(json(object)), '[]') FROM
        (SELECT json_object('type',type,'name',name,'table_name',tbl_name,'sql',sql) AS object
          FROM sqlite_schema WHERE tbl_name IN (${P04_SCHEMA.tables.map(() => '?').join(',')}) ORDER BY type,name)) IS ?
        AND (SELECT COUNT(*) FROM re_schema_migrations WHERE version=?)=1`,
        params: [...P04_SCHEMA.tables,JSON.stringify(P04_SCHEMA.objects),P04_SCHEMA.ledgerVersion] };
      const proofs = [...sourceProofs,schemaProof];
      const ack = freeze({ commitStatus:'committed',capability:'admin.entitlement.manage',grantId });
      const prior = await statement(db,'SELECT * FROM mini_app_command_receipts WHERE idempotency_key=?',[receiptKey]).first();
      if (prior) {
        if (prior.request_hash !== requestHash || prior.actor_telegram_id !== identity.telegramId || prior.bot_id !== identity.botId ||
            prior.operation !== identity.operation || prior.commit_status !== 'committed' || prior.precondition_ok !== 1 ||
            prior.response_json !== JSON.stringify(ack)) fail('controlled_operation_conflict',409);
        const checked = await db.batch(proofs.map(proof => statement(db,`SELECT CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END AS valid`,proof.params)));
        if (checked.some(result => result?.success !== true || result.results?.[0]?.valid !== 1)) fail('authority_stale',409);
        return ack;
      }
      const batch = [], guardKeys = [];
      const guard = proof => {
        const key = receiptKey + ':metadata:' + guardKeys.length; guardKeys.push(key);
        batch.push(statement(db,`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok)
          SELECT ?,CASE WHEN (${proof.sql}) THEN 1 ELSE 0 END`,[key,...proof.params]));
      };
      const write = (sql,params) => {
        batch.push(statement(db,sql,params));
        guard({ sql:'changes()=1',params:[] });
      };
      for (const proof of proofs) guard(proof);
      guard({ sql:"(SELECT COUNT(*) FROM entitlement_grants WHERE subject_telegram_id=? AND policy_version=?)<64",
        params:[input.subjectTelegramId,FOUNDATION_POLICY_VERSION] });
      write(`INSERT INTO mini_app_command_receipts(idempotency_key,request_hash,bot_id,actor_telegram_id,operation,
        commit_status,response_json,committed_at,precondition_ok) VALUES(?,?,?,?,?,?,?,unixepoch(),1)`,
      [receiptKey,requestHash,identity.botId,identity.telegramId,identity.operation,'committed',JSON.stringify(ack)]);
      const columns = Object.keys(row);
      write(`INSERT INTO entitlement_grants(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,columns.map(column => row[column]));
      const eventKey = await digest('v1.4.1.controlled.manual-grant.audit\n' + operationKey);
      write(`INSERT INTO entitlement_decision_audit(audit_id,event_key,policy_version,capability,actor_kind,
        subject_telegram_id,actor_telegram_id,resource_ref,decision,reason_code,source_fingerprint,operation_ref,evaluated_at,valid_until,retention_until)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,['v141_' + eventKey,eventKey,FOUNDATION_POLICY_VERSION,'admin.entitlement.manage','customer',
        input.subjectTelegramId,identity.telegramId,'entitlement_subject:' + input.subjectTelegramId,'allow','controlled_manual_grant_issued',
        actor.sourceFingerprint,receiptKey,identity.nowSeconds,evaluated.validUntil,null]);
      guard({ sql:'EXISTS(SELECT 1 FROM entitlement_grants WHERE grant_id=? AND authority_seal=? AND subject_source_fingerprint=?)',params:[grantId,row.authority_seal,generation] });
      batch.push(statement(db,`DELETE FROM mini_app_atomic_guards WHERE guard_key IN (${guardKeys.map(() => '?').join(',')})`,guardKeys));
      if (batch.length > 96) fail('controlled_query_budget_exhausted',503);
      try {
        const result = await db.batch(batch);
        if (!Array.isArray(result) || result.some(row => row?.success !== true)) fail('controlled_outcome_unknown',503);
      } catch (error) {
        if (/CHECK constraint failed|UNIQUE constraint failed|requires/u.test(String(error?.message))) fail('controlled_state_conflict',409);
        fail('controlled_outcome_unknown',503);
      }
      return ack;
    },
  });
}
