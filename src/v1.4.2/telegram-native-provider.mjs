import { readRuntimeAuthorization, requireRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readActorFacts } from '../v1.4.1/authority-resolver.mjs';

export const REFERRAL_SHARE_RELEASED_TEXT = 'Откройте RE Program: проверенные партнёрские программы и предложения.';
// A defensive application bound, not a promise about Telegram's validity period.
export const PREPARED_MESSAGE_MAX_LIFETIME_SECONDS = 86400;
const RESPONSE_BYTES = 16384, TIMEOUT_MS = 8000;
const fail = (code, status = 502) => { throw Object.assign(new Error(code), { code, status }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
export const canonicalReferralCode = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,56}$/u.test(value);
export function hasSameBotProvider(identity) {
  const token = identity.env?.BOT_TOKEN;
  return typeof token === 'string' && /^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{16,256}$/u.test(token)
    && Number(token.split(':')[0]) === identity.botId;
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

async function readBoundedJSON(response, signal) {
  if (!response || response.redirected || response.status >= 300 && response.status < 400
    || !/^application\/json(?:\s*;|$)/iu.test(response.headers?.get('content-type') ?? ''))
    fail('prepared_message_effect_unknown');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > RESPONSE_BYTES))
    fail('prepared_message_effect_unknown');
  const reader = response.body?.getReader?.();
  if (!reader) fail('prepared_message_effect_unknown');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      if (signal.aborted) fail('prepared_message_effect_unknown');
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        fail('prepared_message_effect_unknown');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('prepared_message_effect_unknown'); }
}

// The fixed method and all its identity/content fields come from server brands.
// This provider does not accept a bot token, target, text, URL or result from JSON.
export async function savePreparedOwnReferralMessage({ authorization, nowSeconds,
  fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  requireRuntimeAuthorization(authorization);
  const { context, actor } = readRuntimeAuthorization(authorization);
  const identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.actorKind !== 'customer' || identity.channel !== 'mini_app'
    || identity.operation !== 'referral.link.read_own' || facts.telegramId !== identity.telegramId
    || facts.botId !== identity.botId || !facts.account.exists || !facts.account.acceptedTerms
    || facts.account.isBlocked || facts.account.pendingDeletion || !facts.roles.includes('partner')
    || facts.partner.status !== 'active' || !facts.partner.approvedApplication
    || !facts.partner.ageConfirmed || !canonicalReferralCode(facts.canonical.user?.referral_code))
    fail('referral_share_not_allowed', 403);
  if (!hasSameBotProvider(identity) || typeof fetchImpl !== 'function')
    fail('prepared_message_provider_unavailable', 503);
  if (!positive(nowSeconds) || nowSeconds >= identity.expiresAt
    || nowSeconds >= facts.validUntil || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS)
    fail('expired_authentication', 401);
  const ownUrl = `https://t.me/RE_Program_Bot?start=partner_${facts.canonical.user.referral_code}`;
  const payload = {
    user_id: identity.telegramId,
    result: { type: 'article', id: `re_referral_${identity.telegramId}`, title: 'RE Program',
      description: REFERRAL_SHARE_RELEASED_TEXT,
      input_message_content: { message_text: `${REFERRAL_SHARE_RELEASED_TEXT}\n\n${ownUrl}` },
      reply_markup: { inline_keyboard: [[{ text: 'Открыть RE Program', url: ownUrl }]] } },
    allow_user_chats: true, allow_bot_chats: false, allow_group_chats: true, allow_channel_chats: true,
  };
  const controller = new AbortController(); let timer;
  const expiryMs = Math.max(1, (Math.min(identity.expiresAt, facts.validUntil) - nowSeconds) * 1000);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('prepared_message_effect_unknown'),
      { code: 'prepared_message_effect_unknown', status: 502 })); }, Math.min(timeoutMs, expiryMs));
  });
  try {
    const request = (async () => {
      let response;
      try { response = await fetchImpl(`https://api.telegram.org/bot${identity.env.BOT_TOKEN}/savePreparedInlineMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
      }); } catch { fail('prepared_message_effect_unknown'); }
      let result;
      try { result = await readBoundedJSON(response, controller.signal); }
      catch { fail('prepared_message_effect_unknown'); }
      // A valid API rejection is a known failed preparation; no blind retry is scheduled.
      if (plain(result) && result.ok === false) fail('prepared_message_rejected');
      const prepared = result?.result;
      if (!response.ok || !plain(result) || result.ok !== true || !plain(prepared)
        || typeof prepared.id !== 'string' || !/^[\x21-\x7E]{1,256}$/u.test(prepared.id)
        || !positive(prepared.expiration_date) || prepared.expiration_date <= nowSeconds
        || prepared.expiration_date > nowSeconds + PREPARED_MESSAGE_MAX_LIFETIME_SECONDS)
        fail('prepared_message_effect_unknown');
      return Object.freeze({ preparedMessageId: prepared.id, expiresAt: prepared.expiration_date });
    })();
    return await Promise.race([request, timeout]);
  } finally { clearTimeout(timer); }
}
