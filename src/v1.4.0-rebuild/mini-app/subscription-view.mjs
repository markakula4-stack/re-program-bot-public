// A passive view of the server subscription projection. It never grants access or creates a payment.
const PLANS = Object.freeze({ free: 'Free', professional: 'Professional', dragon: 'Dragon' });
const STATES = Object.freeze({ none: 'Бесплатный доступ', trial: 'Пробный доступ', active: 'Активна',
  cancel_at_period_end: 'Продление отменено', payment_failed: 'Продление не оплачено', expired: 'Срок завершён',
  refunded: 'Возврат учтён', chargeback: 'Платёж оспорен', suspended: 'Доступ приостановлен' });
const PAYMENT_STATES = Object.freeze({ paid: 'Оплата учтена', retained: 'Оплата на проверке', refunded: 'Возврат',
  chargeback: 'Платёж оспорен', review: 'Нужна проверка', recorded: 'Операция записана' });
const SOURCES = Object.freeze({ free: 'Бесплатный тариф', paid: 'Оплата Telegram Stars', stars: 'Оплата Telegram Stars',
  stars_payment: 'Оплата Telegram Stars', package_payment: 'Оплаченный пакет', bonus: 'Реферальный бонус', referral_bonus: 'Реферальный бонус', preview: 'Dragon Preview' });
const QUOTAS = Object.freeze({ active_applications: { title: 'Активные заявки', unit: 'заявок', explanation: 'На рассмотрении и с подтверждённым результатом.' },
  own_working_offers: { title: 'Свои рабочие офферы', unit: 'офферов', explanation: 'Черновики, активные и приостановленные.' },
  active_campaigns: { title: 'Активные кампании', unit: 'кампаний', explanation: 'Кампании в активном состоянии.' } });
const REASONS = Object.freeze({
  stars_payments_disabled: 'Покупка сейчас закрыта. Stars не списываются.', stars_payments_not_ready: 'Оплата временно недоступна. Попробуйте позже.',
  stars_rollout_off: 'Покупка пока не открыта для этого аккаунта.', admin_canary_only: 'Покупка пока доступна только в закрытой проверке.',
  not_allowlisted: 'Покупка пока не открыта для этого аккаунта.', percentage_not_selected: 'Покупка пока не открыта для этого аккаунта.',
  server_price_unavailable: 'Актуальная цена пока недоступна.', server_price_ambiguous: 'Цена требует проверки. Покупка временно закрыта.',
  stars_terms_revision_not_released: 'Условия покупки временно недоступны.', mini_app_checkout_not_wired: 'Покупка в Mini App пока недоступна. Откройте меню бота.',
  payment_order_in_progress: 'Уже есть незавершённый счёт. Проверьте его в боте.', paid_plan_transition_not_released: 'Смена оплаченного тарифа пока недоступна.',
  paid_access_suspended: 'Доступ приостановлен. Обратитесь в поддержку.', general_terms_not_accepted: 'Сначала примите общие условия в боте.',
  payment_user_blocked: 'Покупка для этого аккаунта недоступна. Обратитесь в поддержку.', payment_user_not_found: 'Откройте бот и проверьте свой профиль.',
  access_review_required: 'Нужно проверить доступ. Обратитесь в поддержку.', authority_review_required: 'Данные доступа требуют проверки.',
  action_specific_limit: 'Персональный предел проверяется при конкретном действии.', quota_limit_unavailable: 'Предел пока неизвестен.',
  quota_counter_unavailable: 'Не удалось получить счётчик.', quota_scope_unavailable: 'Не удалось определить область счётчика.',
  role_required: 'Нужна подходящая роль аккаунта.', active_partner_required: 'Нужен активный профиль партнёра.',
  age_confirmation_required: 'Нужно подтверждение возраста для партнёрского профиля.', legal_declaration_required: 'Нужно подтвердить юридический статус.',
  partner_beta_disabled: 'Создание офферов сейчас закрыто.', partner_beta_access_required: 'Нужен действующий допуск Partner Beta.',
  account_restricted: 'В аккаунте действует ограничение.', access_required: 'Доступ к этому действию ограничен.', quota_exceeded: 'Достигнут текущий предел.',
  approved_campaign_issuer_required: 'Нужен допуск к созданию кампаний.', campaign_rollout_required: 'Запуск кампаний ограничен действующим допуском.',
  membership_check_required: 'Перед активацией бот проверит подписку на канал.', preview_active: 'Пробный доступ уже действует.',
  preview_already_used: 'Одноразовый пробный доступ уже использован.', preview_disabled: 'Пробный доступ сейчас недоступен.',
  preview_configuration_required: 'Пробный доступ временно недоступен.', preview_program_closed: 'Приём новых активаций временно закрыт.',
  access_source_unavailable: 'Сначала нужно проверить данные доступа.', preview_access_conflict: 'Пробный доступ недоступен при текущем состоянии тарифа.',
  terms_required: 'Сначала примите условия в боте.', user_unavailable: 'Активация для этого аккаунта недоступна.',
  stars_recurring_disabled: 'Месячные подписки сейчас закрыты.', stars_recurring_not_ready: 'Месячные подписки временно недоступны.',
  subscription_contract_in_progress: 'Уже есть договор подписки. Проверьте его состояние выше.',
  active_paid_period_present: 'Текущий период уже оплачен. Его срок сохраняется.',
  package_recurring_cancellation_unconfirmed: 'Сначала подтвердите отмену прежнего продления. Оплаченный срок сохраняется.',
  package_paid_source_review_required: 'Платёж или продление требует проверки. Обратитесь в поддержку.',
  package_disabled: 'Этот пакет пока не открыт для покупки.', package_duration_disabled: 'Этот срок пока не открыт для покупки.',
  package_price_unavailable: 'Цена этого пакета временно недоступна. Обновите условия или обратитесь в поддержку.',
  monthly_transition_not_due: 'Новый месячный счёт будет доступен с указанной даты.',
  package_monthly_invoice_not_due: 'Новый месячный счёт будет доступен с указанной даты.',
  monthly_reservation_expired_or_closed: 'Срок счёта завершён. Отмените изменение, затем проверьте возможность нового счёта.',
  monthly_transition_provider_unresolved: 'Состояние прежнего договора ещё уточняется. Поможет поддержка.',
});
const count = value => Number.isSafeInteger(value) && value >= 0;
const number = value => count(value) ? value.toLocaleString('ru-RU') : 'Неизвестно';
const date = value => {
  if (!Number.isSafeInteger(value) || value <= 0) return 'Дата неизвестна';
  try { return `${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value * 1000))} МСК`; }
  catch { return 'Дата неизвестна'; }
};
const duration = value => {
  if (!count(value)) return 'Срок неизвестен';
  if (value === 0) return 'Период закончился';
  const days = Math.floor(value / 86400), hours = Math.floor(value % 86400 / 3600), minutes = Math.floor(value % 3600 / 60);
  return [days ? `${days} дн.` : null, hours ? `${hours} ч.` : null, !days && minutes ? `${minutes} мин.` : null].filter(Boolean).join(' ') || 'Меньше минуты';
};
const reason = code => REASONS[code] ?? 'Доступность уточняется. Обновите данные или обратитесь в поддержку.';
export const subscriptionAvailabilityReason = reason;
const safeUrl = (value, kind) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.port || url.username || url.password || url.hash) return null;
    if (kind === 'bot' && url.pathname === '/RE_Program_Bot' && !url.search) return url.href;
    if (kind === 'support' && url.pathname === '/RE_Program_Support_Bot'
      && ['', '?start=paysupport', '?start=main_bot'].includes(url.search)) return url.href;
  } catch {}
  return null;
};

// This one acknowledged permission is not an unresolved provider command.
// The Worker must still publish the own cancellation action and its exact epoch.
export function isNativeRenewalPermissionPending(data) {
  const lifecycle = data?.lifecycle, actions = data?.renewalActions;
  return data?.readModelVersion === 1 && data.authority === 'worker' && data.access?.current?.status === 'verified' &&
    lifecycle?.billingMode === 'recurring' && lifecycle.renewalState === 'unknown' && lifecycle.pendingOperations === 1 &&
    lifecycle.reviewRequired === true && Array.isArray(lifecycle.reviewReasons) && lifecycle.reviewReasons.length === 1 &&
    lifecycle.reviewReasons[0] === 'provider_reenable_permission_pending' && typeof lifecycle.contractId === 'string' &&
    lifecycle.contractId.length > 0 && actions?.contractId === lifecycle.contractId &&
    Number.isSafeInteger(actions.expectedRevision) && actions.expectedRevision > 0 &&
    actions.pendingOperations === 1 && actions.renewalState === 'unknown' && actions.actionAdmissionRequired === true &&
    actions.cancel?.available === true;
}

const RECEIPT_SEEN_KEY = 're-subscription-receipt-seen-v1';
const receiptId = value => typeof value === 'string' && /^stars-[a-f0-9]{16,64}$/u.test(value);
const confirmedReceipt = value => value?.status === 'paid' && value.reviewRequired === false
  && receiptId(value.receiptId) && value.currency === 'XTR' && count(value.amountStars) && value.amountStars > 0
  && Number.isSafeInteger(value.paidPeriod?.startsAt) && value.paidPeriod.startsAt > 0
  && Number.isSafeInteger(value.paidPeriod?.endsAt) && value.paidPeriod.endsAt > value.paidPeriod.startsAt;

// Presentation bookkeeping only. An opaque ID is already bound on the server
// to the authenticated customer and ledger entry; no payment/identity data is
// cached. Every visible receipt is looked up again in the current own-history.
export function createSubscriptionReceiptPresenter({ storage = null } = {}) {
  let selected = null, awaiting = null, initialRead = true;
  const seen = new Set();
  try {
    const saved = JSON.parse(storage?.getItem(RECEIPT_SEEN_KEY) ?? '[]');
    if (Array.isArray(saved) && saved.length <= 256 && saved.every(receiptId)) saved.forEach(id => seen.add(id));
  } catch {}
  const remember = ids => {
    for (const id of ids) if (receiptId(id)) { seen.delete(id); seen.add(id); }
    while (seen.size > 256) seen.delete(seen.values().next().value);
    try { storage?.setItem(RECEIPT_SEEN_KEY, JSON.stringify([...seen])); } catch {}
  };
  const own = data => data?.readModelVersion === 1 && data.authority === 'worker'
    && data.history?.available === true && data.history.authority === 'worker' && Array.isArray(data.history.items)
    ? data.history.items.slice(0, 20).map(item => item.receipt ?? item).filter(item => receiptId(item?.receiptId)) : null;
  return Object.freeze({
    observe(data) {
      const items = own(data);
      if (!items) { selected = null; return { receipt: null, pending: awaiting !== null, remainingCount: 0 }; }
      const latest = items[0] ?? null;
      // Initial historical reads show only the latest receipt once. Future
      // newly observed confirmed purchases can be consumed one at a time.
      if (initialRead) {
        if (!items.some(item => seen.has(item.receiptId)))
          remember(items.filter(item => item.receiptId !== latest?.receiptId).map(item => item.receiptId));
        initialRead = false;
      }
      if (selected && !items.some(item => item.receiptId === selected)) selected = null;
      const fresh = items.filter(item => confirmedReceipt(item) && !seen.has(item.receiptId));
      if (!selected && fresh.length) {
        selected = fresh[0].receiptId; remember([selected]); awaiting = null;
      }
      const receipt = items.find(item => item.receiptId === selected) ?? null;
      return { receipt, pending: awaiting !== null && !receipt, remainingCount: fresh.filter(item => item.receiptId !== selected).length };
    },
    open(id, data) {
      const item = own(data)?.find(item => item.receiptId === id);
      if (!item) return false;
      selected = item.receiptId; remember([selected]); return true;
    },
    dismiss() { selected = null; },
    beginCheckout(planCode, data) {
      // A restored unpaid invoice need not yet have a subscription plan in the
      // access projection. Generic waiting still makes no assertion of a pay.
      if (planCode != null && !['professional', 'dragon'].includes(planCode)) return;
      remember((own(data) ?? []).map(item => item.receiptId));
      initialRead = false; selected = null; awaiting = planCode ?? 'unknown';
    },
    get pending() { return awaiting !== null; },
    clear() { selected = null; awaiting = null; initialRead = true; },
  });
}

export function renderSubscriptionScreen({ document, data, onRefresh = null, onPurchase = null, onRequestPreview = null,
  onRecurringPurchase = null, onRenewalAction = null, actionPending = false,
  receiptPresentation = null, onDismissReceipt = null, onOpenReceipt = null,
  packageSelection = {}, onPackageSelection = null, onPackagePurchase = null, onPackageSchedule = null,
  onCancelTransition = null, onMonthlyTransition = null, onRecoverPackageAction = null, packageActionPending = false,
  onCopyPendingDiagnostics = null, pendingActionRecoveryAvailable = false, onRecoverPendingAction = null,
  pendingRecoveryFeedback = null } = {}) {
  if (!document?.createElement) throw new Error('subscription_document_required');
  const e = (tag, text = null, className = '') => {
    const node = document.createElement(tag); if (text !== null && text !== undefined) node.textContent = String(text);
    if (className) node.className = className; return node;
  };
  const add = (node, ...children) => { node.append(...children.filter(Boolean)); return node; };
  const p = (text, className = 'subscription-muted') => e('p', text, className);
  const badge = (text, className = '') => e('span', text, `badge ${className}`);
  const button = (text, callback, disabled = false, className = '') => {
    const node = e('button', text, `button ${className}`); node.type = 'button'; node.disabled = disabled;
    if (typeof callback === 'function') node.addEventListener('click', () => { if (!node.disabled) callback(); });
    return node;
  };
  const link = (text, value, kind) => {
    const href = safeUrl(value, kind); if (!href) return null;
    const node = e('a', text, 'button'); node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
  };
  const card = (title, ...children) => add(e('section', null, 'card subscription-card'), e('h3', title), ...children);
  const facts = entries => {
    const list = e('dl', null, 'subscription-facts');
    for (const [name, value] of entries) add(list, add(e('div'), e('dt', name), e('dd', value)));
    return list;
  };
  const receiptPaper = receipt => {
    const confirmed = confirmedReceipt(receipt), adverse = ['refunded', 'chargeback'].includes(receipt.status);
    const paper = e('article', null, `subscription-receipt-paper ${confirmed ? 'is-confirmed' : adverse ? 'is-reversed' : 'is-pending'}`);
    paper.setAttribute('data-receipt-status', receipt.status);
    const seal = e('span', confirmed ? '✓' : adverse ? '↩' : '…', 'subscription-receipt-seal'); seal.setAttribute('aria-hidden', 'true');
    add(paper, add(e('header', null, 'subscription-receipt-brand'),
      add(e('div'), p('RE PROGRAM', 'subscription-eyebrow'), e('h3', 'Квитанция')), seal),
      p(PAYMENT_STATES[receipt.status] ?? 'Состояние уточняется', 'subscription-receipt-status'),
      add(e('div', null, 'subscription-receipt-total'), e('span', 'Сумма операции', 'subscription-muted'),
        add(e('p'), e('strong', number(receipt.amountStars)), e('span', ' Stars', 'subscription-receipt-currency'))),
      facts([['Тариф', PLANS[receipt.planCode] ?? 'Тариф'], ['Оплата', 'Telegram Stars · XTR'],
        ['Тип', receipt.billingMode === 'recurring' ? 'Месячная подписка' : 'Разовая предоплата'], ['Дата', date(receipt.occurredAt)]]));
    const period = e('section', null, 'subscription-receipt-period');
    if (receipt.paidPeriod) add(period, p(confirmed ? 'Оплаченный период' : 'Учтённый период', 'subscription-eyebrow'),
      facts([['С', date(receipt.paidPeriod.startsAt)], ['До', date(receipt.paidPeriod.endsAt)]]));
    else add(period, p('Оплаченный период по этой операции не подтверждён.'));
    add(paper, period, add(e('footer', null, 'subscription-receipt-foot'), e('span', 'Номер квитанции'), e('code', receipt.receiptId)),
      p('Квитанция RE Program по записи оплаты Telegram Stars. Текущий доступ показан отдельно.', 'subscription-receipt-note'));
    if (receipt.reviewRequired || ['retained', 'review', 'recorded'].includes(receipt.status)) add(paper,
      p('Операция требует уточнения. Она сама по себе не подтверждает платный доступ.', 'subscription-lock'));
    if (adverse) add(paper, p(receipt.status === 'refunded'
      ? 'Возврат учтён. Эта квитанция не подтверждает действующий платный доступ.'
      : 'Платёж оспорен. Уточните состояние операции в поддержке.', 'subscription-lock'));
    const packagePeriod = data?.packages?.paidPeriods?.find(item => item.receiptId === receipt.receiptId);
    if (packagePeriod) add(paper, p(packagePeriod.state === 'future'
      ? 'Пакет оплачен. Новый тариф начнёт действовать с указанной даты; текущий оплаченный срок сохраняется.'
      : packagePeriod.state === 'current' && packagePeriod.grantsCurrentAccess === true ? 'Этот пакет сейчас предоставляет доступ.'
        : packagePeriod.state === 'expired' ? 'Срок этого пакета завершён.'
          : 'Этот пакет не подтверждает действующий платный доступ.', 'subscription-receipt-note'));
    return paper;
  };
  const root = e('div', null, 'subscription-page'); root.setAttribute('data-subscription-screen', 'true');
  const heading = add(e('div', null, 'screen-head subscription-screen-head'), e('h2', 'Подписка'),
    typeof onRefresh === 'function' ? button('Обновить', onRefresh, false, 'small') : null);
  add(root, heading);
  if (data?.readModelVersion !== 1 || data?.authority !== 'worker' || !data?.access?.current || !Array.isArray(data?.quotas?.quotas) || !Array.isArray(data?.catalog?.offers)) {
    add(root, card('Не удалось получить условия', p('Обновите данные. Пока тариф и остатки не подтверждены, действия недоступны.')),
      card('Помощь с доступом', link('Открыть поддержку', 'https://t.me/RE_Program_Support_Bot?start=paysupport', 'support')));
    return root;
  }
  const { access, catalog } = data, current = access.current, preview = access.preview ?? {}, lifecycle = data.lifecycle ?? access.lifecycle;
  const reenablePermissionPending = lifecycle?.billingMode === 'recurring' && lifecycle.renewalState === 'unknown'
    && lifecycle.reviewReasons?.includes('provider_reenable_permission_pending') === true;
  if (receiptPresentation?.receipt) {
    const receipt = receiptPresentation.receipt;
    const featured = e('section', null, 'subscription-receipt-featured'); featured.setAttribute('data-featured-receipt', receipt.receiptId);
    featured.setAttribute('aria-label', 'Квитанция по вашей операции');
    add(featured, receiptPaper(receipt), add(e('div', null, 'subscription-receipt-actions'),
      typeof onDismissReceipt === 'function' ? button(receiptPresentation.remainingCount > 0
        ? `Следующая квитанция · ${number(receiptPresentation.remainingCount)}` : 'Вернуться к подписке', onDismissReceipt) : null,
      button('Все квитанции', () => {
        const history = root.querySelector('.subscription-history');
        history?.focus?.({ preventScroll: true });
        const reducedMotion = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        history?.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      }, false, 'small')));
    add(root, featured);
  } else if (receiptPresentation?.pending) {
    const pending = card('Ждём подтверждение оплаты', p('Если вы оплатили счёт, квитанция появится после подтверждения Telegram. Создание или открытие счёта не является оплатой.'),
      typeof onRefresh === 'function' ? button('Проверить оплату', onRefresh) : null);
    pending.classList.add('subscription-receipt-pending'); pending.setAttribute('data-pending-receipt', 'true');
    pending.setAttribute('role', 'status'); add(root, pending);
  }
  const periodKnown = current.durationKind === 'free_unlimited' && current.planCode === 'free'
    || ['finite', 'ended'].includes(current.durationKind) && Number.isSafeInteger(current.expiresAt) && current.expiresAt > 0;
  const verified = current.status === 'verified' && Object.hasOwn(PLANS, current.planCode) && periodKnown && Object.hasOwn(SOURCES, current.sourceKind);
  const previewActive = verified && current.previewActive === true && current.accessOverlay === 'dragon_preview';
  const currentName = !verified ? 'Нужно проверить доступ' : previewActive ? 'Dragon Preview' : PLANS[current.planCode];
  const stateName = verified ? lifecycle?.paidAccess && ['active', 'cancel_at_period_end'].includes(lifecycle.state)
    ? 'Активна' : STATES[lifecycle?.state ?? current.accessState] ?? 'Состояние уточняется' : 'Данные требуют проверки';
  const currentCard = e('section', null, `card subscription-current subscription-plan-${verified ? previewActive ? 'dragon' : current.planCode : 'unknown'}`);
  currentCard.setAttribute('data-current-plan', verified ? current.planCode : 'unknown');
  add(currentCard, p('Текущий тариф', 'subscription-eyebrow'),
    add(e('div', null, 'subscription-current-heading'), e('h3', currentName), badge(stateName, !verified ? 'warning' : previewActive ? 'red' : '')));
  if (!verified) add(currentCard, p('Не удалось подтвердить тариф и срок доступа. Обновите данные или обратитесь в поддержку.'));
  else if (current.durationKind === 'free_unlimited') add(currentCard, p('Бесплатно · без даты окончания', 'subscription-current-time'));
  else if (Number.isSafeInteger(current.expiresAt) && current.expiresAt > 0) {
    const closed = ['refunded', 'chargeback', 'suspended'].includes(current.accessState), ended = current.durationKind === 'ended' || current.remainingSeconds === 0;
    if (closed || ended) add(currentCard, p(closed ? current.accessState === 'refunded' ? 'Возврат учтён; платный доступ закрыт' : current.accessState === 'chargeback' ? 'Платёж оспорен; платный доступ закрыт' : 'Доступ приостановлен'
      : 'Период закончился', 'subscription-current-time'));
    else add(currentCard, p(`Осталось ${duration(current.remainingSeconds)}`, 'subscription-current-time'));
    const until = lifecycle?.paidAccess ? lifecycle.paidUntil : current.expiresAt;
    const period = e('div', null, 'subscription-paid-until');
    add(period, p(closed ? 'Сохранённый период до' : ended ? 'Период закончился' : lifecycle?.paidAccess ? 'Оплачено до' : 'Действует до', 'subscription-muted'),
      e('strong', date(until))); currentCard.append(period);
  } else add(currentCard, p('Срок и источник нужно уточнить.', 'subscription-current-time'));
  if (lifecycle && !lifecycle.paidAccess && Number.isSafeInteger(lifecycle.paidUntil) && lifecycle.paidUntil > 0 &&
      !['finite', 'ended'].includes(current.durationKind)) add(currentCard,
    facts([[['refunded', 'chargeback', 'suspended'].includes(lifecycle.state) ? 'Сохранённый период до' : 'Учтённый период до', date(lifecycle.paidUntil)]]),
    p('Этот период не подтверждает действующий платный доступ. Текущее состояние показано выше.'));
  const accessDetails = e('div', null, 'subscription-access-details');
  if (verified) add(accessDetails, facts([['Источник', SOURCES[current.sourceKind] ?? 'Источник уточняется']]));
  if (previewActive) add(currentCard, p('Пробные возможности поверх тарифа Free. Это не платная подписка Dragon.'));
  if (access.ownerException?.applies === true) add(accessDetails, p('У владельца есть отдельный персональный доступ. Он не является купленным тарифом.', 'subscription-owner-note'));
  if (['expired', 'refunded'].includes(current.accessState) || current.durationKind === 'ended') add(currentCard,
    p('Платные возможности закрываются; профиль, офферы, заявки и история сохраняются.'));
  if (current.accessState === 'suspended') add(currentCard, p('Доступ приостановлен. Уточните причину в поддержке.'));
  if (!lifecycle && current.accessState === 'cancel_at_period_end') add(currentCard, p('До конца оплаченного периода доступ сохраняется.'));
  if (lifecycle?.billingMode === 'prepaid') {
    add(currentCard, facts([['Продление', 'Вручную']]));
    add(accessDetails, p('Разовая предоплата. Автоматического списания нет; новый период оплачивается отдельно.'));
  }
  if (lifecycle?.billingMode === 'recurring') {
    const renewal = reenablePermissionPending ? 'Проверьте в Telegram'
      : { active: 'Автоматическое', canceled: 'Отменено', failed: 'Не удалось оплатить', unknown: 'Статус не подтверждён', inactive: 'Прежняя подписка неактивна' }[lifecycle.renewalState] ?? 'Требует проверки';
    add(currentCard, facts([['Продление', renewal]]));
    if (reenablePermissionPending) {
      const nextStep = e('section', null, 'subscription-state-note subscription-native-renewal');
      nextStep.setAttribute('data-native-renewal-permission', 'pending'); nextStep.setAttribute('role', 'status');
      add(nextStep, p('Разрешение получено. Проверьте продление: Telegram → Звёзды → Мои подписки.'),
        typeof onRefresh === 'function' ? button('Проверить статус', onRefresh, false, 'small') : null);
      add(accessDetails, p('Разрешение не включает автопродление за вас. Его состояние ещё не подтверждено; оплаченный срок не изменился. Если действие включения недоступно, обратитесь в поддержку.'));
      currentCard.append(nextStep);
    }
    if (lifecycle.renewalState === 'inactive') {
      add(currentCard, p('Прежняя подписка неактивна в Telegram.', 'subscription-state-note'));
      if (lifecycle.state === 'refunded') add(accessDetails, p('Возврат учтён; платный доступ по прежней подписке закрыт.'));
      const prepaidAvailable = !actionPending && !packageActionPending && data.packages?.offers?.some(item =>
        item.billingMode === 'prepaid' && item.published === true && item.available === true && item.invoice?.available === true);
      add(accessDetails, p(prepaidAvailable ? 'Новый разовый пакет доступен по условиям ниже.'
        : 'Доступность новой разовой покупки указана в условиях ниже.'));
    }
    else if (lifecycle.state === 'cancel_at_period_end') add(currentCard, p('Оплаченный срок сохраняется.', 'subscription-inline-note'));
    else if (lifecycle.state === 'payment_failed') add(currentCard, p(lifecycle.paidAccess
      ? 'Продление не оплачено. Доступ сохранён до конца уже оплаченного срока.' : 'Продление не оплачено. Для платного доступа нужна подтверждённая оплата.', 'subscription-state-note'));
    else add(accessDetails, p('Месячное продление — каждые 30 дней. Точное время следующего списания не подтверждено.'));
    const actions = data.renewalActions;
    const cancelAcknowledgedPermission = isNativeRenewalPermissionPending(data);
    const controls = e('div', null, 'subscription-renewal-controls');
    for (const [action, label] of [['cancel', 'Отменить продление'], ['enable', 'Разрешить включение']]) {
      if (lifecycle.renewalState === 'inactive' || actions?.[action]?.available !== true || action === 'cancel' && lifecycle.renewalState === 'canceled') continue;
      const unresolved = lifecycle.pendingOperations > 0 && !(action === 'cancel' && cancelAcknowledgedPermission);
      const node = button(label, () => onRenewalAction(action), actionPending || packageActionPending || unresolved || typeof onRenewalAction !== 'function', action === 'enable' ? 'primary' : '');
      node.setAttribute('data-renewal-action', action); controls.append(node);
    }
    if (controls.childNodes.length) currentCard.append(controls);
    if (lifecycle.pendingOperations > 0 && (!reenablePermissionPending || lifecycle.pendingOperations > 1)) add(currentCard,
      p('Ответ уточняется. Обновите статус; повторная отправка недоступна.', 'subscription-state-note'));
    if (lifecycle.reviewRequired && (!reenablePermissionPending || lifecycle.reviewReasons.some(code => code !== 'provider_reenable_permission_pending')))
      add(accessDetails, p('Состояние продления требует проверки. Оплаченный срок определяется подтверждёнными платежами.', 'subscription-lock'));
  }
  if (current.accessState === 'chargeback') add(currentCard, p('Платёж оспорен; платный доступ закрыт. Обратитесь в поддержку.'));
  if (actionPending) add(currentCard, p('Результат последнего действия ещё не подтверждён. Обновление страницы не отправляет его повторно. Для уточнения обратитесь в поддержку.', 'subscription-state-note'));
  if ((actionPending || packageActionPending) && typeof onCopyPendingDiagnostics === 'function') {
    const copy = button('Копировать диагностику', () => onCopyPendingDiagnostics(currentCard), false, 'small');
    copy.setAttribute('data-copy-pending-diagnostics', 'true'); add(currentCard, copy);
  }
  if (actionPending && pendingActionRecoveryAvailable === true && typeof onRecoverPendingAction === 'function') {
    const busy = pendingRecoveryFeedback?.busy === true;
    const recover = button(busy ? 'Восстанавливаем…' : 'Восстановить действие', onRecoverPendingAction, busy, 'small');
    recover.setAttribute('aria-busy', String(busy));
    recover.setAttribute('data-recover-pending-subscription', 'true'); add(currentCard, recover);
  }
  if (actionPending || pendingRecoveryFeedback?.text) {
    const feedback = p(pendingRecoveryFeedback?.text ?? '', 'subscription-state-note');
    feedback.setAttribute('data-pending-recovery-status', 'true'); feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite'); feedback.setAttribute('data-status', pendingRecoveryFeedback?.status ?? 'info');
    feedback.hidden = !pendingRecoveryFeedback?.text; add(currentCard, feedback);
  }
  if (accessDetails.childNodes.length) {
    accessDetails.classList.add('subscription-current-details');
    currentCard.append(accessDetails);
  }
  root.append(currentCard);

  let transitionCard = null;
  if (data.packages && (data.packages.canWrite || data.packages.paidPeriods?.length || data.packages.transitions?.length || packageActionPending)) {
    const packages = data.packages, transitions = card('Следующий период');
    transitions.classList.add('subscription-transitions');
    const future = packages.paidPeriods?.filter(item => item.state === 'future') ?? [];
    for (const item of future) {
      const row = e('section', null, 'subscription-next-period'); row.setAttribute('data-future-package', item.receiptId);
      add(row, badge('Оплачен · начнётся позже'), e('h4', PLANS[item.planCode]),
        facts([['Начало', date(item.startsAt)], ['Окончание', date(item.endsAt)]]),
        p('До этой даты действует текущий оплаченный тариф. Отмена намерения не возвращает оплату; по возврату — помощь с оплатой.'),
        typeof onOpenReceipt === 'function' ? button('Квитанция пакета', () => onOpenReceipt(item.receiptId), false, 'small') : null);
      transitions.append(row);
    }
    const scheduled = packages.transitions?.filter(item => item.state === 'scheduled') ?? [];
    for (const item of scheduled) {
      const row = e('section', null, 'subscription-next-period'); row.setAttribute('data-transition-id', item.transitionId);
      const label = { payment_recorded: 'Оплата записана · доступ уточняется', manual_review: 'Нужна проверка',
        source_compensated: 'Исходный платёж изменился', expired_reservation: 'Срок счёта завершён',
        ready_for_consent: 'Пора подтвердить новый месяц', awaiting_payment: 'Счёт готов · ждём оплату' }[item.status] ?? 'Запланировано · ещё не оплачено';
      add(row, badge(label), e('h4', `${PLANS[item.fromPlan]} → ${PLANS[item.toPlan]}`),
        facts([['С даты', date(item.effectiveAt)], ['Оплата', item.billingMode === 'recurring' ? 'Месячная · новое согласие' : 'Разовая предоплата']]),
        p('Планирование сохраняет текущий оплаченный срок. Новый платный доступ появляется после подтверждённой оплаты.'));
      if (item.status === 'expired_reservation') add(row, p('Отмените просроченное изменение. После обновления сервер проверит возможность обычного нового месячного счёта с отдельным согласием.'));
      if (['manual_review', 'payment_recorded', 'source_compensated'].includes(item.status)) add(row,
        p('Проверьте данные или обратитесь в помощь с оплатой. Возврат Stars не подтверждает отмену автопродления и не освобождает договор автоматически.', 'subscription-lock'));
      if (item.monthlyCheckout?.available === true) {
        const checkout = button('Открыть условия нового месяца', () => onMonthlyTransition(item),
          actionPending || packageActionPending || typeof onMonthlyTransition !== 'function', 'primary');
        checkout.setAttribute('data-transition-monthly', item.transitionId); row.append(checkout);
      } else if (item.billingMode === 'recurring') add(row, p(reason(item.monthlyCheckout?.reasonCode), 'subscription-lock'));
      if (item.cancel?.available === true) {
        const cancel = button('Отменить изменение', () => onCancelTransition(item),
          actionPending || packageActionPending || typeof onCancelTransition !== 'function');
        cancel.setAttribute('data-transition-cancel', item.transitionId); row.append(cancel);
      } else if (item.cancel?.reasonCode) add(row, p(reason(item.cancel.reasonCode), 'subscription-lock'));
      transitions.append(row);
    }
    if (!future.length && !scheduled.length) add(transitions, p('Пока нет оплаченного будущего пакета или запланированной смены тарифа.'));
    if (!packages.available && packages.reasonCode) add(transitions, p(reason(packages.reasonCode), 'subscription-lock'));
    if (packageActionPending) add(transitions, p('Ответ последнего действия уточняется. Новый запрос закрыт; проверка использует тот же сохранённый запрос.'),
      typeof onRecoverPackageAction === 'function' ? button('Проверить результат', onRecoverPackageAction, actionPending, 'small') : null);
    transitionCard = transitions;
  }

  let historyCard = null;
  if (data.history) {
    const history = e('div', null, 'subscription-history-content');
    history.setAttribute('tabindex', '-1');
    if (data.history.available !== true) add(history, p('История сейчас недоступна. Обновите данные или обратитесь в поддержку.'));
    else if (!data.history.items?.length) add(history, p('Пока нет платных операций.'));
    else for (const item of data.history.items.slice(0, 20)) {
      const detail = e('details', null, 'subscription-receipt'); detail.setAttribute('data-receipt-id', item.receiptId);
      const summary = add(e('summary'), add(e('span', null, 'subscription-receipt-heading'),
        e('strong', `${PLANS[item.planCode] ?? 'Тариф'} · ${number(item.amountStars)} Stars`),
        e('span', `${PAYMENT_STATES[item.status] ?? 'Состояние уточняется'} · ${date(item.occurredAt)}`, 'subscription-muted')));
      const receipt = item.receipt ?? item;
      add(detail, summary, receiptPaper(receipt));
      if (typeof onOpenReceipt === 'function') add(detail, button('Открыть квитанцию', () => onOpenReceipt(item.receiptId), false, 'small'));
      history.append(detail);
    }
    if (data.history.hasMore) add(history, p('Показаны последние 20 операций. За более ранними квитанциями обратитесь в поддержку.'));
    historyCard = card('Оплаты и квитанции',
      p('Собственные последние операции в Telegram Stars. Оплата в истории не заменяет текущий статус доступа.'), history);
    historyCard.classList.add('subscription-history');
    historyCard.setAttribute('tabindex', '-1');
  }

  const capacity = card('Ваши остатки', p('Вместимость по текущему доступу. Возможность выполнить действие проверяется отдельно.'));
  capacity.classList.add('subscription-capacity');
  for (const [key, definition] of Object.entries(QUOTAS)) {
    const quota = data.quotas.quotas.find(row => row.key === key), row = e('section', null, 'subscription-quota'); row.setAttribute('data-quota', key);
    if (![quota?.used, quota?.limit, quota?.remaining].every(count)) row.classList.add('subscription-quota-unknown');
    add(row, e('h4', definition.title), p(definition.explanation),
      facts([['Использовано', number(quota?.used)], ['Предел', number(quota?.limit)], ['Осталось', number(quota?.remaining)]]));
    if (count(quota?.used) && count(quota?.limit) && quota.limit > 0) {
      const meter = e('progress'); meter.max = quota.limit; meter.value = Math.min(quota.used, quota.limit);
      meter.setAttribute('aria-label', `${definition.title}: ${quota.used} из ${quota.limit}`); row.append(meter);
    }
    if (!quota || quota.status !== 'available') add(row, p(reason(quota?.reasonCode), 'subscription-lock'));
    else if (Array.isArray(quota.restrictions) && quota.restrictions.length) add(row,
      p([...new Set(quota.restrictions.map(reason))].join(' '), 'subscription-lock'));
    if (count(quota?.planLimit) && count(quota?.betaLimit) && quota.betaLimit < quota.planLimit)
      add(row, p(`Тариф: ${number(quota.planLimit)} ${definition.unit}. Действующий предел Beta: ${number(quota.betaLimit)}.`));
    if (count(quota?.used) && count(quota?.limit) && quota.used > quota.limit) add(row,
      p('Остаток равен 0. Существующие записи сохраняются; освободите место перед новым действием.'));
    capacity.append(row);
  }
  capacity.classList.add('subscription-capacity-details');

  const plans = card('Тарифы и покупка', p('Выберите срок. Способ оплаты и условия показаны под ценой.'));
  plans.classList.add('subscription-plans', 'subscription-catalog-details');
  const planGrid = e('div', null, 'subscription-plan-grid');
  const comparison = catalog.comparison?.version === 1 && catalog.comparison.authority === 'worker'
    && catalog.comparison.publishedPolicyOnly === true && catalog.comparison.grantsRoles === false && Array.isArray(catalog.comparison.rows)
    ? catalog.comparison.rows : [];
  for (const [planCode, name] of Object.entries(PLANS)) {
    const offer = catalog.offers.find(row => row.planCode === planCode), row = e('section', null, `subscription-plan-card subscription-plan-${planCode}`);
    row.setAttribute('data-plan', planCode);
    row.setAttribute('data-billing-mode', planCode === 'free' ? 'free' : 'prepaid');
    const isCurrent = verified && !previewActive && current.planCode === planCode;
    add(row, add(e('div', null, 'subscription-plan-heading'), e('h4', name), isCurrent ? badge('Текущий') : null));
    const priceKnown = offer?.published === true && count(offer.amountStars) && (planCode === 'free' || offer.amountStars > 0);
    const longOffers = planCode === 'free' ? [] : (data.packages?.offers ?? []).filter(item => item.planCode === planCode && item.billingMode === 'prepaid' && item.published === true && item.available === true);
    // Keep admitted manual checkout. In the native owner catalogue it is closed;
    // display the existing published monthly subscription with explicit consent.
    const monthlyPackage = data.packages?.offers?.find(item => item.planCode === planCode && item.packageCode === '30d'
      && item.billingMode === 'recurring' && item.published === true && item.available === true);
    const monthlyOffer = offer?.checkout?.available !== true && monthlyPackage && catalog.recurring?.ready === true
      ? catalog.recurring.offers.find(item => item.planCode === planCode && item.billingMode === 'recurring'
        && item.currency === 'XTR' && count(item.amountStars) && item.amountStars > 0) : null;
    const packageOffers = longOffers.length ? [{ planCode, packageCode: '30d', durationDays: 30, legacyOffer: offer, monthlyOffer }, ...longOffers] : [];
    const packageDetails = e('div', null, 'subscription-package-details');
    let selectedPackage = packageOffers.find(item => item.packageCode === packageSelection[planCode])
      ?? packageOffers.find(item => item.packageCode === '3m') ?? packageOffers[0] ?? null;
    const controls = e('div', null, 'subscription-duration-controls');
    controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', `Срок пакета ${name}`);
    const paintPackage = () => {
      if (!selectedPackage) return;
      const item = selectedPackage;
      row.setAttribute('data-billing-mode', item.monthlyOffer ? 'recurring' : 'prepaid');
      for (const node of controls.querySelectorAll('button')) node.setAttribute('aria-pressed', String(node.getAttribute('data-package-duration') === item.packageCode));
      const children = [];
      if (item.monthlyOffer) {
        const monthly = item.monthlyOffer;
        const readable = verified && count(monthly.amountStars) && monthly.amountStars > 0 && catalog.recurring.terms?.available === true
          && typeof onRecurringPurchase === 'function';
        const purchase = button('Купить подписку', () => onRecurringPurchase(planCode, purchase), !readable,
          `subscription-purchase ${planCode === 'dragon' ? 'subscription-dragon-button' : 'primary'}`);
        purchase.setAttribute('data-recurring-plan', planCode);
        children.push(p(`${number(monthly.amountStars)} ⭐`, 'subscription-price'), p('30 дней · месячная подписка'),
          p('Автопродление каждые 30 дней. Условия и согласие — перед счётом.'), purchase);
        if (monthly.purchaseEligibility?.eligible !== true) children.push(p(reason(monthly.purchaseEligibility?.reasonCode), 'subscription-lock'));
        packageDetails.replaceChildren(...children); return;
      }
      if (item.legacyOffer) {
        const available = verified && priceKnown && offer.purchaseEligibility?.eligible === true && offer.checkout?.available === true &&
          !actionPending && !packageActionPending && typeof onPurchase === 'function';
        const purchase = button(offer?.purchaseEligibility?.mode === 'renewal' ? 'Продлить на 30 дней' : `Выбрать ${name}`,
          () => onPurchase(planCode), !available, `subscription-purchase ${planCode === 'dragon' ? 'subscription-dragon-button' : 'primary'}`);
        purchase.setAttribute('data-purchase-plan', planCode);
        children.push(p(priceKnown ? `${number(offer.amountStars)} Stars` : 'Цена недоступна', 'subscription-price'),
          p('30 дней · разовая предоплата'), p('Продление вручную. Автоматического списания нет.'), purchase);
        if (!available) children.push(p(reason(offer?.purchaseEligibility?.reasonCode), 'subscription-lock'));
        packageDetails.replaceChildren(...children); return;
      }
      if (item.priceComparison && item.priceComparison.amountStars > item.amountStars) {
        const comparison = add(e('div', null, 'subscription-price-comparison'), e('s', `${number(item.priceComparison.amountStars)} ⭐`),
          e('span', `${item.priceComparison.periodCount} × 30 дней`, 'subscription-comparison-basis'));
        comparison.setAttribute('aria-label', `${item.priceComparison.periodCount} отдельных месячных периодов: ${item.priceComparison.amountStars} Stars`);
        children.push(comparison);
      }
      children.push(p(`${number(item.amountStars)} ⭐`, 'subscription-price'), p(`${item.durationDays} дней · разовая оплата`),
        p('Без автосписаний. Полная стоимость пакета.'), facts([['Начало', date(item.preview?.startsAt)], ['До', date(item.preview?.endsAt)]]),
        p('Даты предварительные: точный оплаченный период появится в квитанции.', 'subscription-price-note'));
      const available = verified && item.invoice?.available === true && !actionPending && !packageActionPending && typeof onPackagePurchase === 'function';
      const readable = verified && count(item.amountStars) && item.amountStars > 0 && item.terms?.available === true && typeof onPackagePurchase === 'function';
      const purchase = button(`Оплатить ${item.durationDays} дней`, () => onPackagePurchase(planCode, item.packageCode), !readable,
        `subscription-purchase ${planCode === 'dragon' ? 'subscription-dragon-button' : 'primary'}`);
      purchase.setAttribute('data-package-purchase', `${planCode}:${item.packageCode}`); children.push(purchase);
      if (!available && item.invoice?.reasonCode) children.push(p(reason(item.invoice.reasonCode), 'subscription-lock'));
      if (item.schedule?.available === true) {
        const schedule = button('Запланировать на следующий период', () => onPackageSchedule(planCode, item.packageCode),
          actionPending || packageActionPending || typeof onPackageSchedule !== 'function', 'subscription-package-schedule');
        schedule.setAttribute('data-package-schedule', `${planCode}:${item.packageCode}`); children.push(schedule);
      }
      if (item.terms?.available === true) {
        const detail = add(e('details', null, 'subscription-terms'), e('summary', 'Условия пакета и возврат'),
          p(item.terms.text, 'subscription-terms-text'), p(`Редакция: ${item.termsRevision}`, 'subscription-version'));
        detail.setAttribute('data-package-terms', `${planCode}:${item.packageCode}`); children.push(detail);
      }
      packageDetails.replaceChildren(...children);
    };
    if (packageOffers.length) {
      for (const item of packageOffers) {
        const durationButton = button(`${item.durationDays} дней`, () => {
          selectedPackage = item; if (typeof onPackageSelection === 'function') onPackageSelection(planCode, item.packageCode); paintPackage();
        }, false, 'subscription-duration');
        durationButton.setAttribute('data-package-plan', planCode); durationButton.setAttribute('data-package-duration', item.packageCode);
        controls.append(durationButton);
      }
      add(row, controls, packageDetails); paintPackage();
    } else {
      add(row, p(priceKnown ? `${number(offer.amountStars)} Stars` : 'Цена недоступна', 'subscription-price'));
      if (planCode === 'free') add(row, p('Бесплатный доступ без обязательной оплаты.'));
      else add(row, p(count(offer?.accessSeconds) && offer.accessSeconds > 0 ? `${duration(offer.accessSeconds)} доступа · предоплата` : 'Срок покупки недоступен.'),
        p('Продление вручную. Автоматического списания нет.'));
    }
    const values = comparison.filter(item => Object.hasOwn(QUOTAS, item.key) && count(item.limits?.[planCode]));
    if (values.length) add(row, facts(values.map(item => [QUOTAS[item.key].title, number(item.limits[planCode])])));
    else add(row, p('Точные пределы сравнения пока недоступны. Ваши фактические остатки показаны выше.'));
    if (offer?.matchesInitialPrice === false) add(row, p('Цена обновлена в серверном каталоге. Перед счётом проверьте её ещё раз.', 'subscription-price-note'));
    if (planCode !== 'free' && !packageOffers.length) {
      const available = verified && priceKnown && offer.purchaseEligibility?.eligible === true
        && offer.checkout?.available === true && typeof onPurchase === 'function' && !actionPending && !packageActionPending;
      const action = button(offer?.purchaseEligibility?.mode === 'renewal' ? 'Продлить на новый период' : `Выбрать ${name}`,
        () => onPurchase(planCode), !available, `subscription-purchase ${planCode === 'dragon' ? 'subscription-dragon-button' : 'primary'}`);
      action.setAttribute('data-purchase-plan', planCode);
      let code = !verified ? 'access_review_required' : !priceKnown ? 'server_price_unavailable'
        : offer.purchaseEligibility?.eligible !== true ? offer.purchaseEligibility?.reasonCode
          : offer.checkout?.available !== true ? offer.checkout?.reasonCode : typeof onPurchase !== 'function' ? 'mini_app_checkout_not_wired' : null;
      add(row, action, code ? p(reason(code), 'subscription-lock') : p('Сначала откроются условия. Покупка требует отдельного подтверждения счёта.'));
    }
    planGrid.append(row);
  }
  add(plans, planGrid,
    comparison.some(item => item.roleRequirement === 'active_partner')
      ? p('Офферы и кампании требуют активного партнёрского профиля. Для офферов действует также допуск Beta; фактический предел может быть ниже тарифного.') : null,
    catalog.comparison?.support?.basic === 'included' && catalog.comparison?.support?.paymentHelp === 'included'
      ? p('Обычная поддержка и помощь с оплатой доступны на всех трёх тарифах.') : null,
    p('Тариф не выдаёт роль партнёра или администратора и не обходит действующие ограничения.'),
    link('Открыть бот', 'https://t.me/RE_Program_Bot', 'bot')); root.append(plans);

  if (catalog.recurring) {
    const recurring = catalog.recurring, monthly = card('Месячная подписка',
      p('Автоматическое продление подключается только по отдельному согласию. Для разовых пакетов автосписаний нет.'));
    monthly.classList.add('subscription-monthly');
    if (!recurring.ready || !recurring.terms?.available) add(monthly, p(reason(recurring.reasonCode), 'subscription-lock'));
    for (const offer of recurring.offers ?? []) {
      const row = e('div', null, `subscription-monthly-offer subscription-plan-${offer.planCode}`);
      row.setAttribute('data-billing-mode', 'recurring');
      add(row, e('h4', PLANS[offer.planCode]), p(`${number(offer.amountStars)} Stars каждые 30 дней`, 'subscription-monthly-price'));
      // Reading published terms does not create an invoice or require purchase admission.
      const available = verified && count(offer.amountStars) && offer.amountStars > 0 && recurring.terms?.available === true &&
        typeof recurring.terms.text === 'string' && typeof onRecurringPurchase === 'function';
      const node = button('Посмотреть условия', () => onRecurringPurchase(offer.planCode, node), !available, 'subscription-purchase');
      node.setAttribute('data-recurring-plan', offer.planCode);
      add(row, node, !offer.purchaseEligibility?.eligible ? p(reason(offer.purchaseEligibility?.reasonCode), 'subscription-lock') : null); monthly.append(row);
      const transitionOffer = data.packages?.offers?.find(item => item.planCode === offer.planCode && item.packageCode === '30d');
      if (transitionOffer?.schedule?.available === true) {
        const schedule = button('Запланировать переход', () => onPackageSchedule(offer.planCode, '30d'),
          actionPending || packageActionPending || typeof onPackageSchedule !== 'function');
        schedule.setAttribute('data-package-schedule', `${offer.planCode}:30d`); row.append(schedule);
      }
    }
    add(monthly, p('Отмена сохраняет уже оплаченный срок. Разрешение продления не является новой оплатой.')); root.append(monthly);
  }

  add(root, transitionCard, historyCard, capacity);

  const previewCard = card('Dragon Preview', p('Одноразовый пробный доступ: 7 × 24 часа. Без карты и автоматических списаний.'));
  previewCard.classList.add('subscription-preview');
  add(previewCard, facts([['История', preview.historyUsed === true ? 'Уже использован' : preview.historyUsed === false ? 'Ещё не использован' : 'Неизвестна']]));
  if (Number.isSafeInteger(preview.startsAt) && preview.startsAt > 0) add(previewCard, facts([['Начало', date(preview.startsAt)], ['Окончание', date(preview.expiresAt)]]));
  if (previewActive) add(previewCard, badge('Пробный доступ активен', 'red'));
  add(previewCard, p(reason(preview.reasonCode)));
  if (preview.canRequestActivation === true) {
    const available = verified && typeof onRequestPreview === 'function';
    add(previewCard, button('Проверить и активировать Preview', () => onRequestPreview(), !available, 'primary subscription-preview-action'),
      p(available ? 'Подписку на канал проверит бот. Открытие этой страницы само по себе не включает Preview.'
        : 'Проверка активации доступна через меню бота. Подписка на канал на этой странице ещё не проверена.'));
  }
  previewCard.classList.add('subscription-preview-details'); root.append(previewCard);

  const terms = card('Оплата и помощь'); terms.classList.add('subscription-payment-help');
  if (catalog.terms?.available === true && typeof catalog.terms.text === 'string') {
    const longPackagesVisible = data.packages?.offers?.some(item => item.billingMode === 'prepaid' && item.published === true);
    const details = add(e('details', null, 'subscription-terms'), e('summary', longPackagesVisible ? 'Условия месячной покупки и возврат' : 'Условия и возврат'), p(catalog.terms.text, 'subscription-terms-text'));
    add(details, p(`Редакция: ${catalog.terms.revision ?? 'неизвестна'}`, 'subscription-version'),
      p(catalog.terms.accepted === true ? 'Эта редакция уже принята вашим аккаунтом. Перед новым счётом условия проверяются снова.'
        : 'Перед первым счётом потребуется отдельно принять эту редакцию условий.'));
    terms.append(details);
  } else add(terms, p('Текст действующих условий пока недоступен. Покупка остаётся закрытой.', 'subscription-lock'));
  add(terms, p('Поддержка по оплате доступна на любом тарифе. Возврат рассматривается по обстоятельствам и не обещается автоматически.'),
    link('Помощь с оплатой', catalog.support?.url, 'support'));
  if (!safeUrl(catalog.support?.url, 'support')) add(terms, p('Адрес поддержки сейчас недоступен. Откройте /paysupport в боте.'));
  root.append(terms);
  add(accessDetails, p(`Обновлено: ${date(data.observedAt)}. Данные повторно проверяются перед действием.`, 'subscription-observed'));
  return root;
}
