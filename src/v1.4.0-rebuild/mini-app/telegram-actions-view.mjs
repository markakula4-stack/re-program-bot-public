import { safeOwnReferralUrl } from './telegram-native.mjs';

const REASONS = Object.freeze({
  referral_partner_required: 'Своя ссылка доступна после одобрения партнёрского профиля.',
  partner_required: 'Своя ссылка доступна после одобрения партнёрского профиля.',
  referral_link_unavailable: 'Своя реферальная ссылка пока недоступна.',
  approved_adult_partner_required: 'Своя ссылка доступна после одобрения партнёрской заявки и подтверждения возраста 18+.',
  general_terms_not_accepted: 'Сначала примите общие условия в Telegram-боте.',
  own_referral_code_unavailable: 'Своя ссылка ещё не готова. Откройте раздел партнёра в боте.',
  prepared_message_provider_unavailable: 'Подготовка сообщения сейчас недоступна. Свою ссылку можно скопировать.',
  referral_user_unavailable: 'Для этого аккаунта реферальные действия сейчас недоступны.',
  dragon_custom_emoji_not_configured: 'Значок Dragon пока недоступен. Поддержка тарифа от этого не меняется.',
  dragon_emoji_disabled: 'Установка значка Dragon пока недоступна.',
  dragon_emoji_unverified: 'Значок Dragon пока не подтверждён.',
  active_dragon_required: 'Значок доступен только при действующем тарифе Dragon.',
  client_unsupported: 'Эта функция недоступна в текущем клиенте Telegram. Обновите приложение.',
  prepared_message_unavailable: 'Сообщение для отправки недоступно. Обновите данные и повторите попытку.',
  prepared_message_expired: 'Подготовленное сообщение устарело. Подготовьте его заново.',
  clipboard_unavailable: 'Копирование не поддерживается. Выделите свою ссылку ниже и скопируйте вручную.',
});
const reason = code => REASONS[code] ?? 'Функция сейчас недоступна. Обновите данные или обратитесь в поддержку.';
const positiveTime = value => Number.isSafeInteger(value) && value > 0;

export function renderTelegramActions({ document, data, native, onPrepareReferral = null, onReadNative = null,
  onRefresh = null, isPreparationUncertain = () => false, nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!document?.createElement) throw new Error('telegram_actions_document_required');
  const e = (tag, text = null, className = '') => {
    const node = document.createElement(tag); if (text !== null) node.textContent = String(text);
    if (className) node.className = className; return node;
  };
  const add = (node, ...children) => { node.append(...children.filter(Boolean)); return node; };
  const p = text => e('p', text, 'subscription-muted');
  const card = title => add(e('section', null, 'card subscription-card'), e('h3', title));
  const element = e('div', null, 'subscription-page telegram-actions');
  element.setAttribute('data-telegram-actions', 'true');
  let destroyed = false, busy = false, preparationUncertain = false, viewEpoch = 0;
  let currentData = data;
  const status = e('p', '', 'subscription-lock'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  const say = text => { if (!destroyed) { status.textContent = text; status.hidden = !text; } };
  const snapshot = () => native?.snapshot?.() ?? { capabilities: {}, busy: {}, usefulAction: false, homeScreenStatus: 'unsupported', privateCleared: true };
  const privateAvailable = value => value?.authority === 'worker' && value?.readModelVersion === 1
    && positiveTime(value.access?.sessionExpiresAt) && value.access.sessionExpiresAt > nowSeconds()
    && snapshot().privateCleared !== true;
  const referral = value => value?.catalog?.nativeDependencies?.referralShare ?? {};
  const emoji = value => value?.catalog?.nativeDependencies?.dragonEmoji ?? {};
  const ownUrl = value => privateAvailable(value) ? safeOwnReferralUrl(referral(value).ownUrl) : null;
  const activeDragon = value => {
    const current = value?.access?.current;
    return privateAvailable(value) && current?.status === 'verified' && current.planCode === 'dragon' && current.activeDragon === true
      && current.previewActive === false && ['active', 'cancel_at_period_end', 'payment_failed'].includes(current.accessState)
      && positiveTime(current.expiresAt) && current.expiresAt > nowSeconds()
      && positiveTime(current.remainingSeconds) && !['preview', 'free', null, undefined].includes(current.sourceKind);
  };
  const freshData = async () => {
    if (typeof onReadNative !== 'function') throw new Error('native_fresh_read_unavailable');
    const value = await onReadNative();
    if (!privateAvailable(value)) throw new Error('native_session_unavailable');
    return value;
  };
  const showOutcome = (value, kind) => {
    if (value?.status === 'confirmed') say(kind === 'share' ? 'Сообщение отправлено в выбранный вами чат.'
      : kind === 'emoji' ? 'Значок установлен после вашего подтверждения в Telegram.' : 'Значок приложения добавлен на главный экран.');
    else if (value?.status === 'copied') say('Ваша ссылка скопирована.');
    else if (value?.status === 'cancelled') say('Вы отменили действие. Ничего не изменено.');
    else if (value?.status === 'unknown' || value?.status === 'busy') say('Результат не подтверждён. Проверьте Telegram; перед новой попыткой закройте и снова откройте кабинет.');
    else if (value?.status === 'cleared') say('Сессия закончилась. Откройте кабинет снова.');
    else say(reason(value?.reasonCode));
  };
  const run = callback => async () => {
    if (destroyed || busy || snapshot().privateCleared) return;
    const epoch = ++viewEpoch; busy = true; say('Проверяем доступность…'); update();
    try {
      const value = await callback(() => !destroyed && epoch === viewEpoch && !snapshot().privateCleared);
      if (!destroyed && epoch === viewEpoch && value) showOutcome(value.result, value.kind);
    } catch (error) {
      if (!destroyed && epoch === viewEpoch) {
        if (error?.code === 'prepared_message_effect_unknown') {
          preparationUncertain = true;
          say('Неизвестно, удалось ли подготовить сообщение. Автоматическая отправка не выполнялась. Перед новой попыткой закройте и снова откройте кабинет.');
        } else say(error?.message === 'native_session_unavailable'
          ? 'Сессия закончилась. Откройте кабинет снова.' : error?.code === 'prepared_message_rejected'
            ? 'Telegram не смог подготовить сообщение. Можно скопировать свою ссылку или повторить позже.'
            : 'Не удалось проверить действие. Обновите данные и повторите попытку.');
      }
    } finally { if (!destroyed && epoch === viewEpoch) { busy = false; update(); } }
  };
  const button = (text, key, callback) => {
    const node = e('button', text, 'button'); node.type = 'button'; node.setAttribute('data-telegram-action', key);
    const handler = run(callback);
    node.addEventListener('click', () => { if (!node.disabled) void handler(); });
    return node;
  };

  const referralCard = card('Поделиться своей ссылкой');
  add(referralCard, p('Вы сами выбираете чат в Telegram. Подготовка сообщения ничего не отправляет.'));
  const referralReason = p(''), visibleUrl = e('p', '', 'subscription-terms-text');
  visibleUrl.setAttribute('data-own-referral', 'true');
  const shareButton = button('Выбрать чат в Telegram', 'share', async alive => {
    const fresh = await freshData(); if (!alive()) return null;
    currentData = fresh;
    if (!ownUrl(fresh) || referral(fresh).available !== true) return { result: { status: 'unavailable', reasonCode: referral(fresh).reasonCode }, kind: 'share' };
    say('Подготавливаем сообщение…');
    const prepared = await onPrepareReferral(); if (!alive()) return null;
    if (prepared?.authority !== 'worker' || prepared.prepared !== true || prepared.sent !== false
      || prepared.ownUrl !== ownUrl(fresh) || prepared.releasedText !== referral(fresh).releasedText)
      throw new Error('native_prepared_message_invalid');
    say('Выберите чат в Telegram и подтвердите отправку.');
    return { result: await native.sharePreparedMessage(prepared), kind: 'share' };
  });
  const copyButton = button('Скопировать свою ссылку', 'copy', async alive => {
    const fresh = await freshData(); if (!alive()) return null; currentData = fresh;
    return { result: await native.copyOwnReferral({ authority: 'worker', ownUrl: ownUrl(fresh) }), kind: 'copy' };
  });
  add(referralCard, referralReason, visibleUrl, shareButton, copyButton); element.append(referralCard);

  const emojiCard = card('Значок Dragon в Telegram'), emojiReason = p('');
  add(emojiCard, p('Установка выполняется только по вашему желанию в диалоге Telegram, на оставшийся срок доступа. Значок не даёт дополнительных прав.'));
  const emojiButton = button('Установить значок Dragon', 'emoji', async alive => {
    const fresh = await freshData(); if (!alive()) return null; currentData = fresh;
    if (!activeDragon(fresh) || emoji(fresh).available !== true) return { result: { status: 'unavailable', reasonCode: emoji(fresh).reasonCode ?? 'active_dragon_required' }, kind: 'emoji' };
    const current = fresh.access.current;
    return { result: await native.setDragonEmoji({ authority: 'worker', activeDragon: true, planCode: current.planCode,
      accessState: current.accessState, previewActive: current.previewActive, expiresAt: current.expiresAt,
      remainingSeconds: current.remainingSeconds, customEmojiId: emoji(fresh).customEmojiId }), kind: 'emoji' };
  });
  add(emojiCard, emojiReason, emojiButton); element.append(emojiCard);

  const homeCard = card('Кабинет под рукой'), homeReason = p(''); homeCard.hidden = true;
  const homeButton = button('Добавить на главный экран', 'home', async alive => alive()
    ? { result: await native.addToHomeScreen(), kind: 'home' } : null);
  add(homeCard, p('Открывайте кабинет с главного экрана телефона.'), homeReason, homeButton); element.append(homeCard);
  const statusCard = e('div'); statusCard.append(status); element.append(statusCard);
  if (typeof onRefresh === 'function') {
    const refresh = e('button', 'Обновить условия', 'button small'); refresh.type = 'button';
    refresh.addEventListener('click', () => { if (!destroyed && !busy) onRefresh(); }); statusCard.append(refresh);
  }

  function update() {
    if (destroyed) return;
    const state = snapshot(), ready = privateAvailable(currentData), link = ownUrl(currentData), capabilities = state.capabilities ?? {};
    const freshReadAvailable = typeof onReadNative === 'function';
    visibleUrl.textContent = link ?? ''; visibleUrl.hidden = !link;
    referralReason.textContent = !link ? reason(referral(currentData).reasonCode)
      : !capabilities.shareMessage ? 'В этом клиенте выбор чата недоступен. Скопируйте свою ссылку и отправьте её самостоятельно.'
        : 'Будет отправлен утверждённый текст и ваша собственная ссылка.';
    shareButton.disabled = busy || !ready || !link || referral(currentData).available !== true || !capabilities.shareMessage
      || !freshReadAvailable || typeof onPrepareReferral !== 'function' || state.busy?.share === true || preparationUncertain || isPreparationUncertain() === true;
    copyButton.disabled = busy || !ready || !link || !capabilities.clipboard || !freshReadAvailable || state.busy?.copy === true;
    if (link && !capabilities.clipboard) referralReason.textContent += ' Выделите ссылку и скопируйте вручную.';
    const dragonReady = activeDragon(currentData), dependency = emoji(currentData);
    emojiReason.textContent = !dragonReady ? reason('active_dragon_required') : dependency.available !== true ? reason(dependency.reasonCode)
      : !capabilities.emojiStatus ? reason('client_unsupported') : 'Telegram запросит ваше отдельное подтверждение.';
    emojiButton.disabled = busy || !dragonReady || dependency.available !== true || !capabilities.emojiStatus || !freshReadAvailable || state.busy?.emoji === true;
    homeCard.hidden = !ready || state.usefulAction !== true || capabilities.homeScreen !== true || state.homeScreenStatus === 'unsupported';
    homeReason.textContent = state.homeScreenStatus === 'added' ? 'Значок уже добавлен.'
      : state.homeScreenStatus === 'unknown' ? 'Telegram не может определить, установлен ли уже значок. Можно открыть диалог добавления.'
        : 'Telegram откроет диалог добавления значка.';
    homeButton.disabled = busy || !ready || state.homeScreenStatus === 'added' || state.busy?.homeAdd === true;
    if (state.privateCleared === true) { visibleUrl.textContent = ''; visibleUrl.hidden = true; }
  }
  const unsubscribe = native?.subscribe?.(update) ?? (() => {}); update();
  return Object.freeze({ element, destroy() {
    if (destroyed) return;
    destroyed = true; viewEpoch++; unsubscribe();
    // This component holds private links and callbacks only for its visible lifetime.
    currentData = null; visibleUrl.textContent = ''; element.replaceChildren();
  } });
}
