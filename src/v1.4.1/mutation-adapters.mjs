import { isTrustedContext, readTrustedContext } from './trusted-context.mjs';
import { isTrustedActor, readActorFacts, readActorContext } from './authority-resolver.mjs';
import { isTrustedResource, readResourceFacts, readResourceContext } from './resource-resolver.mjs';
import { isTrustedDecision, readDecisionFacts, readDecisionContext } from './entitlement-engine.mjs';
import { databaseRow } from '../v1.4.0-rebuild/d1-cabinet-repository.mjs';
import { compileCabinetCommand } from '../v1.4.0-rebuild/command-sql.mjs';
import { buildPartnerApplicationSubmitCommand, buildPartnerApplicationDecisionCommand,
  buildApprovedPartnerProfileRepairCommand, buildLegalProfileDeclarationCommand,
  buildPublicUsernameCommand } from '../v1.4.0-rebuild/partner-identity.mjs';
import { buildOfferModerationCommand, buildOfferVisibilityCommand,
  buildOfferAssignmentCommand } from '../v1.4.0-rebuild/offer-lifecycle.mjs';

// These plans are produced from canonical private decisions. Atomic admission
// imports this fixed registry; transports cannot submit a plan or SQL callback.
export const RUNTIME_MUTATION_OPERATIONS = Object.freeze([
  'partner.apply', 'partner.legal_declare_own', 'partner.public_username.update_own',
  'admin.partner.review', 'admin.partner.repair', 'admin.offer.moderate',
  'admin.offer.visibility', 'admin.offer.assign',
]);
const registry = new Set(RUNTIME_MUTATION_OPERATIONS), plans = new WeakMap();
const positive = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export class RuntimeMutationError extends Error {
  constructor(code, status = 409) { super(code); this.name = 'RuntimeMutationError'; this.code = code; this.status = status; }
}
const fail = (code, status = 403) => { throw new RuntimeMutationError(code, status); };
const canonical = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  fail('invalid_intent', 400);
};
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const exact = (value, required, optional = []) => {
  if (!plain(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid_intent', 400);
  const detached = canonical(value);
  if (new TextEncoder().encode(JSON.stringify(detached)).length > 16_384) fail('invalid_intent', 400);
  return freeze(detached);
};
export function normalizeRuntimeMutationIntent(capability, payload) {
  if (!registry.has(capability)) fail('unsupported_atomic_operation');
  let value;
  if (capability === 'partner.apply') value = exact(payload, ['displayName', 'contact', 'ageConfirmed']);
  else if (capability === 'partner.legal_declare_own') value = exact(payload, ['profileKind', 'selfDeclarationAccepted']);
  else if (capability === 'partner.public_username.update_own') value = exact(payload, ['enabled']);
  else if (capability === 'admin.partner.review') value = exact(payload, ['decision'], ['reason']);
  else if (capability === 'admin.partner.repair') value = exact(payload, []);
  else if (capability === 'admin.offer.assign') {
    value = exact(payload, ['targetTelegramId', 'action'], ['reason', 'expectedVersionId']);
    if (Object.hasOwn(value,'expectedVersionId') && !positive(value.expectedVersionId)) fail('invalid_intent',400);
  }
  else {
    const action = capability === 'admin.offer.moderate' ? 'decision' : 'visibility';
    if (!plain(payload) || [Object.hasOwn(payload, 'version'), Object.hasOwn(payload, 'expectedVersionId')].filter(Boolean).length !== 1) {
      fail('invalid_intent', 400);
    }
    const version = Object.hasOwn(payload, 'version') ? 'version' : 'expectedVersionId';
    value = exact(payload, [version, action], ['reason']);
    if (!positive(value[version])) fail('invalid_intent', 400);
  }
  return value;
}
const row = value => value?.authoritySource === 'database' ? value : databaseRow(value);

async function bound(decision) {
  if (!isTrustedDecision(decision)) fail('untrusted_decision');
  const facts = readDecisionFacts(decision), context = readDecisionContext(decision);
  if (!isTrustedContext(context) || !isTrustedActor(facts.actor) || !isTrustedResource(facts.resource) ||
      readActorContext(facts.actor) !== context || readResourceContext(facts.resource) !== context) fail('proof_context_mismatch');
  const identity = readTrustedContext(context), actor = readActorFacts(facts.actor), resource = readResourceFacts(facts.resource);
  if (identity.actorKind !== 'customer' || !registry.has(facts.capability) || identity.operation !== facts.capability ||
      resource.capability !== facts.capability || resource.subjectTelegramId !== identity.telegramId ||
      !resource.exists || !actor.canonical?.user || !Array.isArray(actor.canonical.roleRows) || !resource.canonical) {
    fail('proof_scope_mismatch');
  }
  const intent = normalizeRuntimeMutationIntent(facts.capability, identity.requestPayload);
  if (await hash(JSON.stringify(intent)) !== identity.payloadHash) fail('intent_operation_mismatch');
  return { facts, context, identity, actor, resource, intent, capability: facts.capability };
}
const requireAdminTarget = ({ actor, identity, resource }) => {
  if (actor.canonicalOwner !== true || !actor.roles.includes('admin') ||
      !positive(resource.ownerTelegramId) || resource.ownerTelegramId === identity.telegramId) fail('admin_target_required');
};
const expectedVersion = (resource, intent) => {
  const version = row(resource.canonical.currentVersion);
  if (!version || !positive(version.id) || !positive(version.versionNumber) ||
      (intent.version !== undefined ? intent.version !== version.versionNumber : intent.expectedVersionId !== version.id)) {
    fail('version_conflict');
  }
  return version.id;
};

// Receipt acknowledgment has a separate fixed contour. It needs fresh current
// ownership/identity, not the pre-effect version/status or an expired tariff.
export async function compileRuntimeMutationReplayScope(decision) {
  const value = await bound(decision), { identity, resource, capability, intent } = value;
  if (capability.startsWith('admin.')) requireAdminTarget(value);
  if (capability === 'partner.apply') return freeze({ sql: 'EXISTS(SELECT 1 FROM partner_applications WHERE telegram_id=?)', params: [identity.telegramId] });
  if (capability === 'partner.legal_declare_own' || capability === 'partner.public_username.update_own') {
    const profile = row(resource.canonical.partnerProfile);
    if (!profile || profile.telegramId !== identity.telegramId || profile.status !== 'active') fail('replay_scope_conflict');
    return freeze({ sql: "EXISTS(SELECT 1 FROM partner_profiles WHERE id=? AND telegram_id=? AND status='active')",
      params: [profile.id, identity.telegramId] });
  }
  if (capability.startsWith('admin.partner.')) {
    const app = row(resource.canonical.application);
    if (!app || app.id !== resource.ref || app.telegramId !== resource.ownerTelegramId) fail('replay_scope_conflict');
    return freeze({ sql: "EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active') AND EXISTS(SELECT 1 FROM partner_applications WHERE id=? AND telegram_id=?)",
      params: [identity.telegramId, app.id, app.telegramId] });
  }
  const owner = row(resource.canonical.owner), profile = row(resource.canonical.ownerProfile ?? resource.canonical.partnerProfile);
  if (!owner || owner.offerCode !== resource.ref || owner.ownerKind !== 'partner' || !profile ||
      owner.partnerProfileId !== profile.id || profile.telegramId !== resource.ownerTelegramId) fail('replay_scope_conflict');
  const proof = { sql: `EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')
    AND EXISTS(SELECT 1 FROM offer_owners o JOIN partner_profiles p ON p.id=o.partner_profile_id
      WHERE o.offer_code=? AND o.owner_kind='partner' AND p.telegram_id=?)`,
    params: [identity.telegramId, resource.ref, profile.telegramId] };
  if (capability === 'admin.offer.assign') {
    const target = row(resource.canonical.targetUser);
    if (!target || target.telegramId !== intent.targetTelegramId || target.telegramId === identity.telegramId ||
        target.acceptedTerms !== 1 || target.isBlocked !== 0) fail('replay_scope_conflict');
    if (typeof target.referralCode !== 'string' || !target.referralCode) fail('replay_scope_conflict');
    proof.sql += ` AND EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0 AND joined_at IS ? AND referral_code IS ?)
      AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending'
        AND (unixepoch(expires_at) IS NULL OR unixepoch(expires_at)>unixepoch()))`;
    proof.params.push(target.telegramId, target.joinedAt, target.referralCode, target.telegramId);
  }
  return freeze(proof);
}

export async function createRuntimeMutation(decision, serverKey) {
  const value = await bound(decision), { facts, context, identity, actor, resource, intent, capability } = value;
  if (facts.publicDTO.allowed !== true) fail(facts.publicDTO.reasonCode ?? 'capability_denied');
  if (typeof serverKey !== 'string' || !/^mikey_[0-9a-f]{64}$/u.test(serverKey)) fail('invalid_server_key');
  if (capability.startsWith('admin.')) requireAdminTarget(value);
  const a = actor.canonical, r = resource.canonical;
  const base = { context: Object.freeze({ contextVersion: 1, authoritySource: 'database_session',
    telegramId: identity.telegramId, botId: identity.botId, sessionId: identity.requestId }),
    user: row(a.user), roleRows: a.roleRows.map(row), nowSeconds: identity.nowSeconds, idempotencyKey: serverKey };
  let command;
  switch (capability) {
    case 'partner.apply': command = await buildPartnerApplicationSubmitCommand({ ...base,
      existingApplication: row(r.application ?? a.application), payload: intent }); break;
    case 'partner.legal_declare_own': command = await buildLegalProfileDeclarationCommand({ ...base,
      partnerProfile: row(r.partnerProfile ?? a.partnerProfile), existingLegalProfile: row(r.existingLegalProfile ?? a.legalProfile), payload: intent }); break;
    case 'partner.public_username.update_own': command = await buildPublicUsernameCommand({ ...base,
      partnerProfile: row(r.partnerProfile ?? a.partnerProfile), currentSettings: row(r.publicSettings), enabled: intent.enabled }); break;
    case 'admin.partner.review': command = await buildPartnerApplicationDecisionCommand({ ...base,
      application: row(r.application), existingProfile: row(r.existingProfile), decision: intent.decision, reason: intent.reason }); break;
    case 'admin.partner.repair': command = await buildApprovedPartnerProfileRepairCommand({ ...base,
      application: row(r.application), existingProfile: row(r.existingProfile) }); break;
    case 'admin.offer.moderate': command = await buildOfferModerationCommand({ ...base,
      offer: row(r.offer), owner: row(r.owner), ownerProfile: row(r.ownerProfile ?? r.partnerProfile),
      currentVersion: row(r.currentVersion), visibilityRule: row(r.visibilityRule), currentRoute: r.currentRoute,
      expectedVersionId: expectedVersion(resource, intent), decision: intent.decision, reason: intent.reason }); break;
    case 'admin.offer.visibility': command = await buildOfferVisibilityCommand({ ...base,
      offer: row(r.offer), owner: row(r.owner), currentVersion: row(r.currentVersion),
      visibilityRule: row(r.visibilityRule), currentRoute: r.currentRoute,
      betaSettings: row(r.betaSettings ?? a.betaSettings), assignmentCount: row(r.assignmentCount),
      expectedVersionId: expectedVersion(resource, intent), visibility: intent.visibility, reason: intent.reason }); break;
    case 'admin.offer.assign':
      if (Object.hasOwn(intent,'expectedVersionId')) expectedVersion(resource,intent);
      command = await buildOfferAssignmentCommand({ ...base,
      offer: row(r.offer), owner: row(r.owner), currentVersion: row(r.currentVersion), visibilityRule: row(r.visibilityRule),
      assignmentCount: row(r.assignmentCount), existingAssignment: row(r.existingAssignment),
      targetTelegramId: intent.targetTelegramId, targetUser: row(r.targetUser), action: intent.action, reason: intent.reason }); break;
    default: fail('unsupported_atomic_operation');
  }
  const personalEvents = command.writes.filter(write => write.table === 'offer_visibility_assignment_events');
  const storageCommand = personalEvents.length ? { ...command, writes: command.writes.map(write =>
    write.table === 'offer_visibility_assignment_events' ? { ...write, values: { ...write.values, telegramId: 0, actorId: 0, reason: '' } } : write) } : command;
  const compiled = compileCabinetCommand(storageCommand), writes = [];
  for (let index = 0; index < compiled.length; index++) {
    writes.push(compiled[index]);
    const event = command.writes[index];
    if (event.table === 'offer_visibility_assignment_events') {
      // Accepted0020 keeps immutable assignment facts free of personal data.
      // The actual monolith uses this same private-history split; both halves
      // remain mandatory effects of the one atomic command.
      writes.push({ sql: `INSERT INTO offer_assignment_event_private(event_id,telegram_id,actor_id,reason)
        SELECT id,?,?,? FROM offer_visibility_assignment_events WHERE event_key=?`,
        params: [event.values.telegramId, event.values.actorId, event.values.reason, event.values.eventKey], minChanges: 1, maxChanges: 1 });
    }
  }
  const ack = freeze({ commitStatus: writes.length ? 'committed' : 'unchanged', capability,
    ...(command.offerCode ? { offerCode: command.offerCode } : {}) });
  const result = Object.freeze({ version: 1 });
  plans.set(result, freeze({ context, capability,
    subjectTelegramId: capability.startsWith('admin.') ? resource.ownerTelegramId : identity.telegramId,
    resourceScope: `${resource.kind}:${resource.ref}`, operation: identity.operation, domainOperation: command.operation,
    compiled: true, writes, ack, postconditions: command.postcondition ? [command.postcondition] : [], quotaDelta: 0,
    command }));
  return result;
}
export const isRuntimeMutation = value => Boolean(value && plans.has(value));
export function readRuntimeMutation(value) {
  const facts = plans.get(value);
  if (!facts) fail('untrusted_runtime_mutation');
  return facts;
}
