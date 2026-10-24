import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer, requireRuntimeAuthorization, readRuntimeAuthorization,
  assertRuntimeAuthorizationFresh } from '../v1.4.1/runtime-authorizer.mjs';
import { readSubscriptionData } from '../v1.4.2/subscription-read-model.mjs';

export const SUBSCRIPTION_BOT_VERSION = '2026-10-07.v1.4.4.p03';
export const SUBSCRIPTION_BOT_CALLBACKS = Object.freeze([
  'sub143:status', 'sub143:history', 'sub143:cancel', 'sub143:enable', 'sub143:optin', 'sub143:packages',
  ...Array.from({ length: 5 }, (_, index) => 'sub143:receipt:' + index),
]);
const STATES = Object.freeze({ active: 'Активна', cancel_at_period_end: 'Продление отменено',
  payment_failed: 'Продление не оплачено', expired: 'Срок завершён', refunded: 'Возврат учтён',
  chargeback: 'Платёж оспорен', suspended: 'Доступ приостановлен' });
const PLANS = Object.freeze({ free: 'Free', professional: 'Professional', dragon: 'Dragon' });
const PAYMENTS = Object.freeze({ paid: 'Оплата учтена', retained: 'Оплата сохранена для проверки',
  refunded: 'Возврат учтён', chargeback: 'Платёж оспорен', recorded: 'Операция записана', review: 'Требует проверки' });
const PACKAGE_STATES = Object.freeze({ current: 'Доступ активен', future: 'Оплачен, ожидает начала',
  expired: 'Оплаченный период завершён', refunded: 'Возврат учтён; этот платёж больше не предоставляет доступ',
  chargeback: 'Компенсация учтена; этот платёж больше не предоставляет доступ', review_required: 'Требует проверки' });
const TRANSITION_STATES = Object.freeze({ scheduled: 'Запланирована, ещё не оплачена',
  cancelled: 'Изменение отменено', fulfilled: 'Изменение оплачено', failed: 'Изменение требует проверки' });
const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const date = seconds => Number.isSafeInteger(seconds) && seconds > 0
  ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(seconds * 1000)) + ' МСК' : 'Не подтверждён';
function viewName(view = 'status') {
  if (typeof view === 'string' && (['status', 'history', 'cancel', 'enable', 'optin', 'packages'].includes(view) || /^receipt:[0-4]$/u.test(view))) return view;
  fail('subscription_bot_view_invalid', 400);
}
export function subscriptionBotViewForCallback(selector) {
  return SUBSCRIPTION_BOT_CALLBACKS.includes(selector) ? selector.slice('sub143:'.length) : null;
}
function telegramIdentity(context) {
  const identity = readTrustedContext(context);
  if (identity.actorKind !== 'customer' || identity.operation !== 'access.read_own' ||
      !['telegram_command', 'telegram_callback'].includes(identity.channel) ||
      identity.transportBinding?.kind !== 'telegram' || identity.transportBinding.actor !== identity.telegramId)
    fail('subscription_bot_context_required');
  return identity;
}
function cabinetButton(identity, label = 'Открыть мою подписку') {
  try {
    const url = new URL(identity.env.MINI_APP_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return { text: label, web_app: { url: url.origin + '/v1.4.0/cabinet/#subscription' } };
  } catch { return null; }
}
const callback = (text, view) => ({ text, callback_data: 'sub143:' + view });
const packageDays = item => [30, 90, 180, 360].includes(item?.durationDays) ? item.durationDays : null;
const packagePeriods = data => Array.isArray(data.packages?.paidPeriods) ? data.packages.paidPeriods : [];
const transitions = data => Array.isArray(data.packages?.transitions) ? data.packages.transitions : [];
function futureText(data) {
  const future = packagePeriods(data).filter(item => item.state === 'future').sort((left, right) => left.startsAt - right.startsAt);
  const pending = transitions(data).filter(item => item.state === 'scheduled');
  const lines = [];
  if (future.length) {
    const item = future[0];
    lines.push('', `Следующий оплаченный тариф: <b>${escape(PLANS[item.planCode] ?? 'Требует проверки')}</b>`,
      `Начало: <b>${escape(date(item.startsAt))}</b>`, `Окончание: <b>${escape(date(item.endsAt))}</b>`);
    if (future.length > 1) lines.push('Все следующие оплаченные периоды — в кабинете.');
  }
  if (pending.length) {
    const item = pending[0];
    lines.push('', `Запланированная смена: <b>${escape(PLANS[item.toPlan] ?? 'Требует проверки')}</b>`,
      `Граница перехода: <b>${escape(date(item.effectiveAt))}</b>`);
    if (item.status === 'payment_recorded') lines.push('Платёж записан. Результат доступа требует проверки в /paysupport.');
    else lines.push('До подтверждённой оплаты новый тариф не включится.');
    if (item.billingMode === 'recurring' && ['scheduled', 'ready_for_consent'].includes(item.status))
      lines.push('На границе периода нужны новый счёт и отдельное согласие на автопродление.');
    if (item.cancel?.available || item.cancel?.reasonCode === 'cabinet_session_required')
      lines.push('Проверить отмену неоплаченного изменения можно в кабинете.');
    else if (item.cancel?.reasonCode) lines.push('Действие ожидает подтверждения или проверки. Помощь — /paysupport.');
    if (item.status === 'source_compensated') lines.push('Исходный платёж компенсирован. Дальнейшее оформление требует проверки.');
    else if (item.status === 'expired_reservation') lines.push('Срок счёта истёк. Новый счёт доступен после разрешённого сервером закрытия прежнего намерения.');
  }
  return lines;
}
function renewalText(lifecycle) {
  if (lifecycle?.billingMode === 'prepaid') return 'Вручную, без автосписания';
  if (lifecycle?.billingMode !== 'recurring') return 'Подписка с автопродлением не оформлена';
  return ({ active: 'Автопродление подтверждено', canceled: 'Будущее продление отменено',
    failed: 'Подтверждена ошибка продления', pending: 'Ожидает подтверждения',
    unknown: 'Продление требует проверки' })[lifecycle.renewalState] ?? 'Продление требует проверки';
}
function statusText(data) {
  const lifecycle = data.lifecycle, current = data.access.current;
  const plan = PLANS[current.planCode] ?? 'Требует проверки';
  const state = STATES[lifecycle?.state] ?? (lifecycle?.reasonCode === 'verified_paid_period_not_started'
    ? 'Оплаченный период ещё не начался' : current.status === 'verified' ? 'Подписка не оформлена' : 'Требует проверки');
  const lines = ['<b>💎 Моя подписка</b>', '', `Тариф: <b>${escape(plan)}</b>`, `Статус: <b>${escape(state)}</b>`,
    `Платный доступ: <b>${lifecycle?.paidAccess === true ? 'действует' : 'выключен'}</b>`];
  if (Number.isSafeInteger(lifecycle?.paidUntil) && lifecycle.paidUntil > 0)
    lines.push(`Оплачено до: <b>${escape(date(lifecycle.paidUntil))}</b>`);
  const paidPackage = packagePeriods(data).find(item => item.state === 'current' && item.planCode === current.planCode);
  if (paidPackage && packageDays(paidPackage)) lines.push(`Пакет: <b>${packageDays(paidPackage)} дней · разовая оплата</b>`);
  lines.push(`Продление: <b>${escape(renewalText(lifecycle))}</b>`);
  if (lifecycle?.billingMode === 'recurring') lines.push('Дата следующего списания: не подтверждена');
  if (lifecycle?.state === 'cancel_at_period_end' && lifecycle.paidAccess)
    lines.push('', 'Оплаченный остаток сохраняется до указанного срока.');
  if (lifecycle?.state === 'payment_failed' && lifecycle.paidAccess)
    lines.push('', 'Оплаченный остаток действует до указанного срока. Дополнительный неоплаченный период — 0 дней.');
  if (lifecycle?.reviewRequired || current.status !== 'verified')
    lines.push('', 'Статус требует проверки. Помощь с оплатой доступна через /paysupport.');
  if (current.previewActive) lines.push('', 'Dragon Preview действует отдельно: до ' + escape(date(current.expiresAt)) + '.');
  lines.push(...futureText(data));
  return lines.join('\n');
}
function historyView(history) {
  if (!history?.available) return { text: '<b>🧾 История оплат</b>\n\nИстория сейчас недоступна. Откройте /paysupport.', keyboard: [] };
  const items = history.items.slice(0, 5);
  if (!items.length) return { text: '<b>🧾 История оплат</b>\n\nУчтённых оплат пока нет.', keyboard: [] };
  const text = ['<b>🧾 История оплат</b>', '', ...items.map((item, index) =>
    `${index + 1}. ${escape(PLANS[item.planCode] ?? 'Тариф')} · ${escape(item.amountStars)} ⭐${packageDays(item) ? ' · ' + packageDays(item) + ' дней' : ''}\n` +
    `${escape(date(item.occurredAt))} · ${escape(PAYMENTS[item.status] ?? 'Требует проверки')}`)];
  if (history.hasMore || history.items.length > 5) text.push('', 'Здесь показаны последние 5 оплат. Полная доступная история — в кабинете.');
  return { text: text.join('\n'), keyboard: items.map((_, index) => [callback('Квитанция ' + (index + 1), 'receipt:' + index)]) };
}
function receiptView(history, index, data) {
  const item = history?.available ? history.items[index]?.receipt ?? history.items[index] : null;
  if (!item) return '<b>🧾 Квитанция</b>\n\nЭта запись сейчас недоступна. Обновите историю оплат.';
  const lines = ['<b>🧾 Квитанция</b>', '', `Тариф: <b>${escape(PLANS[item.planCode] ?? 'Требует проверки')}</b>`,
    `Сумма: <b>${escape(item.amountStars)} ⭐</b>`, `Дата: ${escape(date(item.occurredAt))}`,
    `Статус: ${escape(PAYMENTS[item.status] ?? 'Требует проверки')}`,
    `Оплата: ${item.billingMode === 'recurring' ? 'Подписка с автопродлением' : item.billingMode === 'prepaid' ? 'Разовая предоплата' : 'Требует проверки'}`];
  if (item.paidPeriod) lines.push(`Оплаченный период: ${escape(date(item.paidPeriod.startsAt))} — ${escape(date(item.paidPeriod.endsAt))}`);
  const paidPackage = packagePeriods(data).find(period => period.receiptId === item.receiptId);
  if (paidPackage) {
    if (packageDays(paidPackage)) lines.push(`Пакет: <b>${packageDays(paidPackage)} дней</b>`);
    if (!item.paidPeriod) lines.push(`Оплаченный период: ${escape(date(paidPackage.startsAt))} — ${escape(date(paidPackage.endsAt))}`);
    lines.push(`Доступ по квитанции: ${escape(PACKAGE_STATES[paidPackage.state] ?? 'Требует проверки')}`);
    if (paidPackage.state === 'future') lines.push('Текущий тариф действует до начала этого оплаченного периода.');
  }
  if (item.reviewRequired) lines.push('Операция требует проверки. Откройте /paysupport.');
  lines.push(`Номер квитанции: <code>${escape(item.receiptId)}</code>`);
  return lines.join('\n');
}
function packagesText(data) {
  const packages = data.packages, offers = (Array.isArray(packages?.offers) ? packages.offers : [])
    .filter(offer => packageDays(offer) && PLANS[offer.planCode] && Number.isSafeInteger(offer.amountStars) && offer.amountStars > 0);
  const lines = ['<b>📦 Пакеты и смена тарифа</b>', '', '⚪ Free — основные функции без обязательной оплаты.'];
  for (const offer of offers) {
    const days = packageDays(offer);
    const comparison = offer.priceComparison;
    const comparable = comparison?.basis === 'same_plan_monthly_equivalent' &&
      Number.isSafeInteger(comparison.amountStars) && Number.isSafeInteger(comparison.monthlyAmountStars) &&
      Number.isSafeInteger(comparison.periodCount) && comparison.periodCount * 30 === days &&
      comparison.amountStars === comparison.periodCount * comparison.monthlyAmountStars && comparison.amountStars > offer.amountStars;
    const price = `${comparable ? '<s>' + comparison.amountStars + ' ⭐</s> → ' : ''}<b>${offer.amountStars} ⭐</b>`;
    lines.push('', `<b>${escape(PLANS[offer.planCode])} · ${days} дней</b>`, price,
      offer.billingMode === 'recurring' ? 'Автопродление; отдельное согласие перед счётом.' : 'Разовая оплата, без автосписания.');
    if (comparable) lines.push('Сравнение с оплатой того же тарифа по 30 дней.');
    if (offer.invoice?.available || offer.schedule?.available || offer.invoice?.reasonCode === 'cabinet_session_required' ||
        offer.schedule?.reasonCode === 'cabinet_session_required') lines.push('Выбор и точная дата — в кабинете.');
    else lines.push('Оформление сейчас недоступно.');
  }
  if (!offers.length) lines.push('', 'Новые пакеты сейчас недоступны вашему аккаунту. Уже оплаченные периоды сохраняются.');
  lines.push(...futureText(data));
  const previous = transitions(data).filter(item => item.state !== 'scheduled').slice(0, 3);
  for (const item of previous) lines.push('', `${escape(PLANS[item.toPlan] ?? 'Тариф')} · ${escape(TRANSITION_STATES[item.state] ?? 'Требует проверки')}`);
  lines.push('', 'Стоимость и сроки проверяются сервером перед покупкой. Полные условия — по кнопке ниже.');
  return lines.join('\n');
}

// A genuine own Telegram authorization supplies identity and the server clock.
// These views only present the shared verified DTO. Financial buttons open the
// actual cabinet, where the existing private HTTP action admission applies.
export async function renderOwnSubscriptionBotView({ authorization, view = 'status' } = {}) {
  view = viewName(view);
  const { context } = readRuntimeAuthorization(requireRuntimeAuthorization(authorization));
  const identity = telegramIdentity(context), data = await readSubscriptionData({ authorization });
  const lifecycle = data.lifecycle, keyboard = [], native = cabinetButton(identity);
  let text = statusText(data);
  if (view === 'status') {
    keyboard.push([callback('🧾 История оплат', 'history')]);
    if (data.packages?.available || packagePeriods(data).length || transitions(data).length)
      keyboard.push([callback('📦 Пакеты и смена тарифа', 'packages')]);
    if (data.renewalActions.cancel.available) keyboard.push([callback('Отменить будущее продление', 'cancel')]);
    if (data.renewalActions.enable.available) keyboard.push([callback('Разрешить возобновление', 'enable')]);
    if (data.catalog.recurring?.enabled) keyboard.push([callback('Подписка с автопродлением', 'optin')]);
  } else if (view === 'history' || view.startsWith('receipt:')) {
    const history = data.history;
    if (view === 'history') { const result = historyView(history); text = result.text; keyboard.push(...result.keyboard); }
    else { text = receiptView(history, Number(view.slice('receipt:'.length)), data); keyboard.push([callback('🧾 История оплат', 'history')]); }
  } else if (view === 'packages') {
    text = packagesText(data);
    keyboard.push([{ text: '📜 Условия покупки', callback_data: 'stars_buy:terms' }]);
  } else if (view === 'cancel') {
    text = '<b>Отменить будущее продление</b>\n\n' + (data.renewalActions.cancel.available
      ? 'Отмена сохраняет подтверждённый оплаченный остаток. Откройте свою подписку в кабинете, проверьте срок и подтвердите отмену.'
      : 'Действие сейчас недоступно. Обновите собственный статус; помощь с оплатой — /paysupport.');
  } else if (view === 'enable') {
    text = '<b>Разрешить возобновление</b>\n\n' + (data.renewalActions.enable.available
      ? 'Разрешение позволяет вам возобновить отменённую ботом подписку в Telegram. Подтвердите действие в своей подписке в кабинете. Новый оплаченный период появится после подтверждённой оплаты.'
      : 'Возобновление сейчас недоступно. Обновите собственный статус; помощь с оплатой — /paysupport.');
  } else if (view === 'optin') {
    const ready = data.catalog.recurring?.ready && data.catalog.recurring.offers?.some(item => item.purchaseEligibility.eligible);
    text = '<b>Подписка с автопродлением</b>\n\n' + (ready
      ? 'Это отдельный вариант покупки на 30 дней. В кабинете выберите тариф, проверьте цену и отдельно подтвердите условия автопродления перед счётом. Для запланированной смены новый счёт оформляется на границе текущего оплаченного периода.'
      : 'Оформление подписки с автопродлением сейчас недоступно вашему аккаунту. Разовая предоплата продлевается вручную.');
  }
  if (native) keyboard.push([native]);
  else text += '\n\nКабинет сейчас недоступен. Помощь с оплатой — /paysupport.';
  if (view !== 'status') keyboard.push([callback('⬅️ Моя подписка', 'status')]);
  keyboard.push([{ text: '💳 Помощь с оплатой', callback_data: 'paysupport' }], [{ text: '⬅️ В меню', callback_data: 'menu' }]);
  await assertRuntimeAuthorizationFresh(authorization);
  return freeze({ version: SUBSCRIPTION_BOT_VERSION, text, keyboard, observedAt: data.observedAt,
    paidAccess: lifecycle?.paidAccess === true, planCode: data.access.current.planCode,
    lifecycleState: lifecycle?.state ?? null, paidUntil: lifecycle?.paidUntil ?? null,
    renewalState: lifecycle?.renewalState ?? 'unknown' });
}

export async function readOwnSubscriptionBotView({ context, view = 'status' } = {}) {
  telegramIdentity(context); view = viewName(view);
  const authorization = await createRuntimeAuthorizer().authorize(context, null);
  return renderOwnSubscriptionBotView({ authorization, view });
}
