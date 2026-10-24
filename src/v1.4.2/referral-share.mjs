import { readRuntimeAuthorization, requireRuntimeAuthorization,
  assertRuntimeAuthorizationFresh } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { REFERRAL_SHARE_RELEASED_TEXT, canonicalReferralCode, hasSameBotProvider,
  savePreparedOwnReferralMessage } from './telegram-native-provider.mjs';

const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const empty = value => plain(value) && Reflect.ownKeys(value).length === 0;
function referralContext(authorization, preparation = false) {
  const { context, actor } = readRuntimeAuthorization(authorization);
  const identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.actorKind !== 'customer' || identity.channel !== 'mini_app'
    || facts.actorKind !== 'customer' || facts.telegramId !== identity.telegramId || facts.botId !== identity.botId
    || !(preparation ? identity.operation === 'referral.link.read_own'
      : ['access.read_own', 'referral.link.read_own'].includes(identity.operation)))
    fail('referral_share_scope_mismatch');
  return { identity, facts };
}

// A safe catalog projection; no partner profile creation or referral code mutation.
export function readOwnReferralDescriptor(authorization) {
  requireRuntimeAuthorization(authorization);
  const { identity, facts } = referralContext(authorization);
  const reasonCode = !facts.account.exists || facts.account.isBlocked || facts.account.pendingDeletion
    ? 'referral_user_unavailable' : !facts.account.acceptedTerms ? 'general_terms_not_accepted'
      : !facts.roles.includes('partner') || facts.partner.status !== 'active'
        || !facts.partner.approvedApplication || !facts.partner.ageConfirmed ? 'approved_adult_partner_required'
        : !canonicalReferralCode(facts.canonical.user?.referral_code) ? 'own_referral_code_unavailable'
          : !hasSameBotProvider(identity) ? 'prepared_message_provider_unavailable' : 'eligible';
  const available = reasonCode === 'eligible';
  return Object.freeze({ available, reasonCode, ownUrl: available
    ? `https://t.me/RE_Program_Bot?start=partner_${facts.canonical.user.referral_code}` : null,
  releasedText: REFERRAL_SHARE_RELEASED_TEXT, preparationRequired: true, preparedMessageId: null });
}

// Preparation is an external side effect, not delivery. There is deliberately no
// process-global success cache or retry. The client coalesces clicks; HTTP binds
// the key to authenticated transport, without durable server replay deduplication.
// A repeated POST can prepare another UNSENT message. An unknown provider outcome
// must be shown to the user without automatically issuing another request.
export async function prepareOwnReferralMessage({ authorization, body, assertFence,
  nowSeconds = () => Math.floor(Date.now() / 1000), fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  requireRuntimeAuthorization(authorization);
  const { identity, facts } = referralContext(authorization, true);
  if (!empty(body) || !empty(identity.requestPayload)) fail('invalid_referral_share_payload', 400);
  if (!identity.verifiedSessionId || identity.transportBinding?.kind !== 'http'
    || identity.transportBinding.actor !== identity.telegramId || identity.transportBinding.botId !== identity.botId
    || !identity.operationId || !identity.payloadHash || typeof assertFence !== 'function')
    fail('referral_share_transport_required');
  const descriptor = readOwnReferralDescriptor(authorization);
  if (!descriptor.available) fail(descriptor.reasonCode);
  const clock = () => {
    const now = typeof nowSeconds === 'function' ? nowSeconds() : nowSeconds;
    if (!Number.isSafeInteger(now) || now < identity.nowSeconds || now >= identity.expiresAt || now >= facts.validUntil)
      fail('expired_authentication', 401);
    return now;
  };
  clock();
  await assertFence();
  await assertRuntimeAuthorizationFresh(authorization);
  const before = clock();
  const prepared = await savePreparedOwnReferralMessage({ authorization, nowSeconds: before, fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  // Never return a prepared ID after the owning session/source/actor was revoked.
  await assertFence();
  await assertRuntimeAuthorizationFresh(authorization);
  const after = clock();
  if (prepared.expiresAt <= after) fail('prepared_message_expired', 409);
  return Object.freeze({ version: 1, authority: 'worker', preparedMessageId: prepared.preparedMessageId,
    expiresAt: prepared.expiresAt, ownUrl: descriptor.ownUrl,
    releasedText: REFERRAL_SHARE_RELEASED_TEXT, prepared: true, sent: false });
}
