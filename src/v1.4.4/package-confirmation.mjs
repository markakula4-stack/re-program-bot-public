import { STARS_TERMS_REVISION } from '../v1.3.6/stars-core-foundation.mjs';
import { STARS_RECURRING_TERMS_REVISION } from '../v1.4.3/recurring-provider-config.mjs';

const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const FIELDS = ['amountStars', 'currency', 'priceVersion', 'offerVersion', 'campaignCode', 'termsRevision'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export async function packageConfirmationPayloadHash(quote) {
  const payload = { requestedPlanCode: quote.planCode, packageCode: quote.packageCode,
    confirmation: { acceptedTerms: true, ...Object.fromEntries(FIELDS.map(key => [key, quote[key]])) } };
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(payload)))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Display values are comparison guards. Only the private fresh server quote
// determines the immutable financial snapshot; client money never sets it.
export function readPackagePurchaseRequest(payload) {
  const confirmed = Object.hasOwn(payload ?? {}, 'confirmation');
  if (!exact(payload, ['requestedPlanCode', 'packageCode', ...(confirmed ? ['confirmation'] : [])]))
    fail('package_request_invalid', 400);
  const confirmation = confirmed ? payload.confirmation : null;
  if (confirmed && (!exact(confirmation, ['acceptedTerms', ...FIELDS]) || confirmation.acceptedTerms !== true ||
      !Number.isSafeInteger(confirmation.amountStars) || confirmation.amountStars <= 0 || confirmation.currency !== 'XTR' ||
      !Number.isSafeInteger(confirmation.priceVersion) || confirmation.priceVersion <= 0 ||
      !/^[0-9A-Za-z._-]{8,64}$/u.test(confirmation.termsRevision ?? '') ||
      typeof confirmation.offerVersion !== 'string' || confirmation.offerVersion.length < 1 || confirmation.offerVersion.length > 64 ||
      confirmation.campaignCode !== null && (typeof confirmation.campaignCode !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(confirmation.campaignCode)))) fail('package_confirmation_required', 400);
  return { request: { requestedPlanCode: payload.requestedPlanCode, packageCode: payload.packageCode }, confirmation };
}

export function assertConfirmedPackageOffer(identity, quote, confirmation) {
  if (!confirmation) return;
  if (identity.channel !== 'mini_app' || !identity.verifiedSessionId || !identity.payloadHash ||
      identity.transportBinding?.kind !== 'http' || !identity.transportBinding.idempotencyKey)
    fail('package_confirmation_context_required', 403);
  if (FIELDS.some(key => confirmation[key] !== quote[key])) fail('package_confirmation_changed');
  const releasedTerms = quote.billingMode === 'recurring' ? STARS_RECURRING_TERMS_REVISION : STARS_TERMS_REVISION;
  if (quote.termsRevision !== releasedTerms) fail('stars_terms_revision_not_released');
}

// Included in the same guarded D1 batch as the admitted order or intent.
// This purchase-terms acknowledgement never supplies recurring consent.
export function confirmedPackageTermsStatement(identity, quote, confirmation, now) {
  if (!confirmation) return [];
  assertConfirmedPackageOffer(identity, quote, confirmation);
  return [identity.db.prepare(`INSERT OR IGNORE INTO terms_acceptances
    (acceptance_id,telegram_id,terms_revision,acceptance_scope,evidence_sha256,telegram_update_id,accepted_at)
    VALUES(?,?,?,'stars_purchase',?,NULL,?)`).bind(crypto.randomUUID(), identity.telegramId,
    quote.termsRevision, identity.payloadHash, now)];
}

// A long package is a separate published offer. Preserve the historical
// monthly terms while disclosing its own fixed duration and total price.
export function buildPackageOfferTerms(quote) {
  const name = quote.planCode === 'dragon' ? 'Dragon' : 'Professional';
  if (quote.billingMode === 'recurring') return `${name}: ${quote.amountStars} Stars каждые 30 дней. ` +
    'Планирование не списывает Stars и не переносит прежнее согласие. На дату перехода потребуется новый счёт ' +
    'и отдельное согласие на автопродление. Отмена продления сохраняет уже оплаченный срок. Вопросы покупки и возврата — /paysupport.';
  return `Условия отдельного пакетного предложения ${name}: ${quote.amountStars} Stars за ${quote.durationDays} дней. ` +
    'Это полная разовая стоимость, без автоматического продления и будущих автосписаний. ' +
    'Месячные цены и срок 30 дней относятся к отдельной месячной покупке.\n\n' +
    'Доступ возникает только после подтверждённой оплаты Telegram. Пакет начинается после сохранённого оплаченного срока; ' +
    'до покупки даты предварительные, точные начало и окончание записываются в квитанции. ' +
    'Старый оплаченный остаток не пересчитывается и не исчезает. Неоплаченное запланированное изменение не выдаёт доступ.\n\n' +
    'Тариф не меняет системную роль, партнёрский статус или юридический профиль. После окончания сохраняются аккаунт, заявки, профиль и история.\n\n' +
    'Вопросы, спорные списания и запросы возврата рассматриваются через /paysupport. Возврат не обещается автоматически: ' +
    'решение принимается по обстоятельствам и правилам покупки. Поддержка Telegram не решает споры по товарам и услугам этого бота.\n\n' +
    `Общие условия Stars: ${quote.termsRevision}. Пакетное предложение: ${quote.offerVersion}. ` +
    'Перед покупкой отдельно подтвердите показанные цену, срок и условия этого предложения.';
}

// Public display data excludes the private actor, source rows and fingerprint.
export function projectPublicPackageQuote(quote) {
  const fields = ['planCode','packageCode','durationDays','periodSeconds','amountStars','currency','billingMode',
    'priceVersion','offerVersion','campaignCode','termsRevision','quotedStartsAt','quotedEndsAt','quotedDatesAreEstimate',
    'currentPlanCode','nextPaidPlan','automaticProration','recurringConsentTransferred','accessApplied','validUntil'];
  return Object.freeze(Object.fromEntries(fields.map(key => [key, quote[key]])));
}
