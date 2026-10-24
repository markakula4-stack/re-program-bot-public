import { readRuntimeAuthorization, requireRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readResourceFacts } from '../v1.4.1/resource-resolver.mjs';
import { readActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { readPackageNativeFrameExtension } from '../v1.4.4/package-native-frame.mjs';
import { readV143NativeReadinessConfig, isV143NativeReadinessEnvelope,
  V143_NATIVE_READINESS_FRAME, isV143NativeOwnerCheckoutEnvelope,
  selectV143NativeOwnerCheckoutQuote } from './native-readiness-config.mjs';

// This is a source/epoch context admission, never financial or provider
// authority. The existing command/refund authorizers must still prove their
// exact contract, first charge, or already-applied owner-self refund.
const admissions = new WeakMap();
const invoiceAdmissions = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code, status: 403 }); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const SCHEMA_SQL = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name";
const SCHEMA_SNAPSHOT = `(SELECT json_group_array(json_array(type,name,tbl_name,sql)) FROM (${SCHEMA_SQL}))`;
const LEDGER_SQL = 'SELECT version FROM re_schema_migrations ORDER BY version';
const LEDGER_SNAPSHOT = `(SELECT json_group_array(version) FROM (${LEDGER_SQL}))`;
const LEASE_COLUMNS = 'id,candidate_sha,revision,state,beta_enabled,owner_telegram_id,issued_at,expires_at,updated_at';
const LEASE_SNAPSHOT = `(SELECT json_array(${LEASE_COLUMNS}) FROM mini_app_release_control WHERE id=1)`;
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');

async function rows(db, sql, maximum) {
  let result;
  try { result = await db.prepare(sql).all(); } catch { fail('native_recovery_source_unavailable'); }
  if (result?.success !== true || !Array.isArray(result.results) || result.results.length > maximum)
    fail('native_recovery_source_unavailable');
  return result.results;
}

async function nativeFrameAssertions(identity) {
  const config = readV143NativeReadinessConfig(), db = identity.db;
  const schema = await rows(db, SCHEMA_SQL + ' LIMIT 2001', 2000),
    ledger = await rows(db, LEDGER_SQL + ' LIMIT 257', 256),
    leases = await rows(db, `SELECT ${LEASE_COLUMNS} FROM mini_app_release_control WHERE id=1 LIMIT 2`, 1);
  if (ledger.length === 0 || leases.length !== 1 ||
      schema.some(row => !exact(row, ['type', 'name', 'tbl_name', 'sql']) ||
        Object.values(row).some(value => typeof value !== 'string')) ||
      ledger.some(row => !exact(row, ['version']) || typeof row.version !== 'string'))
    fail('native_recovery_frame_unverified');
  const schemaJson = JSON.stringify(schema.map(row => [row.type, row.name, row.tbl_name, row.sql])),
    ledgerJson = JSON.stringify(ledger.map(row => row.version)), lease = leases[0],
    leaseJson = JSON.stringify(LEASE_COLUMNS.split(',').map(key => lease[key]));
  const extension = await readPackageNativeFrameExtension({ db, schema, ledger });
  const baselineSchemaJson = JSON.stringify(extension.baselineSchema.map(row => [row.type, row.name, row.tbl_name, row.sql])),
    baselineLedgerJson = JSON.stringify(extension.baselineLedger.map(row => row.version));
  if (extension.baselineSchema.length !== 1149 ||
      await hash(baselineSchemaJson) !== V143_NATIVE_READINESS_FRAME.schemaSha256 ||
      await hash(baselineLedgerJson) !== V143_NATIVE_READINESS_FRAME.ledgerSha256 ||
      lease.id !== 1 || lease.candidate_sha !== config.sourceSha ||
      lease.revision !== V143_NATIVE_READINESS_FRAME.preparedRevision || lease.state !== 'closed' ||
      lease.beta_enabled !== 0 || lease.owner_telegram_id !== null || lease.issued_at !== null ||
      lease.expires_at !== null || !Number.isSafeInteger(lease.updated_at) || lease.updated_at <= 0)
    fail('native_recovery_frame_unverified');
  const assertions = Object.freeze([
    { sql: `${SCHEMA_SNAPSHOT} IS ?`, params: Object.freeze([schemaJson]) },
    { sql: `${LEDGER_SNAPSHOT} IS ?`, params: Object.freeze([ledgerJson]) },
    { sql: `${LEASE_SNAPSHOT} IS ?`, params: Object.freeze([leaseJson]) },
    ...extension.extensionAssertions,
  ].map(piece => Object.freeze({ sql: piece.sql, params: Object.freeze([...piece.params]) })));
  return assertions;
}

export async function authorizeV143NativeCancellationContext(authorization) {
  requireRuntimeAuthorization(authorization);
  const bundle = readRuntimeAuthorization(authorization), identity = readTrustedContext(bundle.context),
    facts = readActorFacts(bundle.actor), payload = identity.requestPayload;
  if (!isV143NativeReadinessEnvelope(identity.env) || identity.actorKind !== 'customer' ||
      identity.telegramId !== V143_NATIVE_READINESS_FRAME.ownerId || !facts.canonicalOwner ||
      !facts.policyReady || !facts.financialSourceAvailable || facts.protectedAuthorityFallback ||
      !Array.isArray(facts.degradedTables) || facts.degradedTables.length || !facts.account?.exists ||
      !facts.account.acceptedTerms || facts.account.isBlocked || facts.account.pendingDeletion ||
      identity.channel !== 'mini_app' || !identity.verifiedSessionId ||
      identity.transportBinding?.kind !== 'http' || identity.transportBinding.actor !== identity.telegramId ||
      !identity.operationId || typeof identity.transportBinding.idempotencyKey !== 'string')
    fail('native_recovery_cancellation_context_required');
  let kind;
  if (identity.operation === 'access.read_own' && exact(payload,
    ['subscriptionAction', 'contractId', 'expectedRevision']) && payload.subscriptionAction === 'cancel_renewal' &&
    identifier(payload.contractId) && Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision > 0)
    kind = 'existing_own_cancel';
  else if (identity.operation === 'access.read_own' && isV143NativeOwnerCheckoutEnvelope(identity.env) && exact(payload,
    ['subscriptionAction', 'contractId', 'expectedRevision']) && payload.subscriptionAction === 'reenable_renewal' &&
    identifier(payload.contractId) && Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision > 0)
    kind = 'existing_own_enable';
  else if (identity.operation === 'admin.cabinet.open' && exact(payload, ['refundCompletionId']) &&
    identifier(payload.refundCompletionId)) kind = 'applied_owner_self_refund_cancel';
  else fail('native_recovery_cancellation_context_required');
  const assertions = await nativeFrameAssertions(identity);
  const token = Object.freeze({ version: 1, authority: 'native_existing_cancellation_context' });
  admissions.set(token, Object.freeze({ authorization, kind, assertions }));
  return token;
}

export function compileV143NativeCancellationAssertions(token, authorization, expectedKind) {
  requireRuntimeAuthorization(authorization);
  const proof = admissions.get(token);
  if (!proof || proof.authorization !== authorization || proof.kind !== expectedKind ||
      !['existing_own_cancel', 'existing_own_enable', 'applied_owner_self_refund_cancel'].includes(expectedKind))
    fail('native_recovery_cancellation_context_required');
  return Object.freeze({ assertions: proof.assertions });
}

// This additional admission only narrows the genuine recurring invoice
// authorization. Every consumer retains its complete financial decision.
export async function authorizeV143NativeOwnerInvoiceContext(authorization) {
  requireRuntimeAuthorization(authorization);
  const bundle = readRuntimeAuthorization(authorization), identity = readTrustedContext(bundle.context),
    facts = readActorFacts(bundle.actor), payload = identity.requestPayload,
    quote = readResourceFacts(bundle.resource).canonical.serverPrice, frame = selectV143NativeOwnerCheckoutQuote(quote);
  if (!isV143NativeOwnerCheckoutEnvelope(identity.env) || identity.actorKind !== 'customer' ||
      !frame || identity.telegramId !== frame.ownerId || !facts.canonicalOwner || !facts.policyReady ||
      !facts.financialSourceAvailable || facts.protectedAuthorityFallback ||
      !Array.isArray(facts.degradedTables) || facts.degradedTables.length || !facts.account?.exists ||
      !facts.account.acceptedTerms || facts.account.isBlocked || facts.account.pendingDeletion ||
      identity.operation !== 'billing.purchase_monthly' || identity.channel !== 'mini_app' ||
      !identity.verifiedSessionId || identity.transportBinding?.kind !== 'http' ||
      identity.transportBinding.actor !== identity.telegramId || !identity.operationId ||
      typeof identity.transportBinding.idempotencyKey !== 'string' ||
      !exact(payload, ['action','billingMode','recurringConsent','requestedPlanCode','termsRevision','priceVersion']) ||
      payload.action !== 'accept' || payload.billingMode !== 'recurring' || payload.recurringConsent !== true ||
      payload.requestedPlanCode !== frame.planCode || payload.termsRevision !== frame.termsRevision ||
      payload.priceVersion !== frame.priceVersion || !quote || quote.publicationState !== 'approved' ||
      quote.billingMode !== 'recurring' || quote.planCode !== frame.planCode || quote.currency !== frame.currency ||
      quote.amountStars !== frame.amountStars || quote.accessSeconds !== frame.periodSeconds ||
      quote.priceVersion !== frame.priceVersion || quote.termsRevision !== frame.termsRevision)
    fail('native_owner_invoice_context_required');
  const assertions = await nativeFrameAssertions(identity),
    token = Object.freeze({version:1,authority:'native_owner_invoice_context'});
  invoiceAdmissions.set(token,Object.freeze({authorization,assertions}));
  return token;
}
export function compileV143NativeOwnerInvoiceAssertions(token, authorization) {
  requireRuntimeAuthorization(authorization);
  const proof = invoiceAdmissions.get(token);
  if (!proof || proof.authorization !== authorization) fail('native_owner_invoice_context_required');
  return Object.freeze({assertions:proof.assertions});
}
