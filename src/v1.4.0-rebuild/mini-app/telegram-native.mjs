// Native dialogs affect presentation only. Account and tariff facts come from the Worker.
const HOME_STATES = new Set(['unsupported', 'unknown', 'added', 'missed']);
const USEFUL_ACTIONS = new Set(['committed_form', 'fresh_offer_open']);
const integer = value => Number.isSafeInteger(value) && value > 0;
const result = (status, reasonCode = null) => Object.freeze({ status, ...(reasonCode ? { reasonCode } : {}) });
const safeInvoiceUrl = value => {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.length <= 2048 && url.protocol === 'https:' && url.hostname === 't.me'
      && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/\$[A-Za-z0-9_-]+$/u.test(url.pathname) ? url.href : null;
  } catch { return null; }
};

export function safeOwnReferralUrl(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  // This validates format only; the owning account's link must come from a verified server DTO.
  return /^https:\/\/t\.me\/RE_Program_Bot\?start=partner_[A-Za-z0-9_-]{1,56}$/.test(value) ? value : null;
}

export function safeTelegramActionUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  if (/^https:\/\/t\.me\/RE_Program_Bot(?:\?start=[A-Za-z0-9_-]{1,64})?$/.test(value)) return value;
  if (/^https:\/\/t\.me\/RE_Program_Support_Bot(?:\?start=(?:paysupport|main_bot))?$/.test(value)) return value;
  return null;
}

export function createTelegramNativeAdapter({ telegram = null, document = null, clipboard = null,
  nowSeconds = () => Math.floor(Date.now() / 1000), timers = globalThis, timeoutMs = 15000 } = {}) {
  let disposed = false, privateCleared = false, generation = 0, usefulAction = false;
  let homeScreenStatus = 'unknown';
  const slots = new Map(), subscribers = new Set(), listeners = [];
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000 ? timeoutMs : 15000;
  const versionAtLeast = minimum => {
    if (!telegram || typeof telegram.version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(telegram.version)) return false;
    const [major, minor] = telegram.version.split('.').map(Number), [needMajor, needMinor] = minimum.split('.').map(Number);
    if (major < needMajor || major === needMajor && minor < needMinor) return false;
    try { return typeof telegram.isVersionAtLeast !== 'function' || telegram.isVersionAtLeast(minimum) === true; }
    catch { return false; }
  };
  const supported = (method, minimum = '8.0') => !disposed && versionAtLeast(minimum) && typeof telegram?.[method] === 'function';
  const hasEvents = () => typeof telegram?.onEvent === 'function' && typeof telegram?.offEvent === 'function';
  const capabilities = () => Object.freeze({
    fullscreen: supported('requestFullscreen') && supported('exitFullscreen') && hasEvents(),
    homeScreen: supported('checkHomeScreenStatus') && supported('addToHomeScreen') && hasEvents(),
    shareMessage: supported('shareMessage'), emojiStatus: supported('setEmojiStatus'),
    openTelegramLink: supported('openTelegramLink', '6.1'), openInvoice: supported('openInvoice', '6.1'),
    clipboard: !disposed && typeof clipboard?.writeText === 'function',
  });
  const snapshot = () => Object.freeze({ capabilities: capabilities(), fullscreen: telegram?.isFullscreen === true,
    homeScreenStatus: capabilities().homeScreen ? homeScreenStatus : 'unsupported', usefulAction,
    privateCleared, busy: Object.freeze(Object.fromEntries([...slots.keys()].map(key => [key, true]))) });
  const notify = () => { if (!disposed) for (const callback of [...subscribers]) { try { callback(snapshot()); } catch {} } };
  const listen = (name, callback) => {
    if (!hasEvents()) return;
    const handler = payload => { if (!disposed) callback(payload); };
    try { telegram.onEvent(name, handler); listeners.push([name, handler]); } catch {}
  };
  const css = document?.documentElement?.style, savedCss = new Map();
  const updateSafeArea = () => {
    if (!css || !versionAtLeast('8.0')) return;
    for (const [source, prefix] of [['safeAreaInset', '--re-safe-area-inset-'], ['contentSafeAreaInset', '--re-content-safe-area-inset-']]) {
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const name = `${prefix}${side}`, value = telegram?.[source]?.[side];
        if (!savedCss.has(name)) savedCss.set(name, [css.getPropertyValue(name), css.getPropertyPriority?.(name) ?? '']);
        css.setProperty(name, `${Number.isFinite(value) && value >= 0 && value <= 4096 ? Math.ceil(value) : 0}px`);
      }
    }
  };
  const settle = (key, slot, value, release = true) => {
    if (disposed || slot.generation !== generation || slots.get(key) !== slot) return;
    if (slot.timer !== null) timers.clearTimeout(slot.timer);
    slot.timer = null;
    const resolve = slot.resolve; slot.resolve = null;
    if (release) slots.delete(key);
    resolve?.(value); notify();
  };
  const start = (key, invoke, { privateAction = true, waitForClose = false } = {}) => {
    if (disposed || privateAction && privateCleared) return Promise.resolve(result('cleared', 'session_cleared'));
    if (slots.has(key)) return Promise.resolve(result('busy', 'native_dialog_unresolved'));
    return new Promise(resolve => {
      const slot = { generation, resolve, timer: null }; slots.set(key, slot);
      // An unknown outcome keeps its slot: uncorrelated late SDK events must not settle a new dialog.
      // A payment dialog waits for its correlated close callback. Time spent
      // reading or confirming an invoice is not an uncertain server mutation.
      if (!waitForClose) slot.timer = timers.setTimeout(() => settle(key, slot, result('unknown', 'native_response_timeout'), false), timeout);
      notify();
      try { invoke(value => settle(key, slot, value, value.status !== 'unknown')); }
      catch { settle(key, slot, result('unknown', 'native_call_failed'), false); }
    });
  };
  const callbackOutcome = (ok, successCode) => ok === true ? result('confirmed', successCode) : result('unknown', 'native_result_unconfirmed');
  const nativeFailure = key => payload => {
    const slot = slots.get(key); if (!slot) return;
    const code = payload?.error;
    if (code === 'USER_DECLINED') settle(key, slot, result('cancelled', 'user_declined'));
    else if (code === 'UNSUPPORTED') settle(key, slot, result('unsupported', 'client_unsupported'));
    else if (key === 'share' && code === 'MESSAGE_EXPIRED') settle(key, slot, result('unavailable', 'prepared_message_expired'));
    else settle(key, slot, result('unknown', 'native_result_unconfirmed'), false);
  };
  const toggleFullscreen = target => {
    if (!capabilities().fullscreen) return Promise.resolve(result('unsupported', 'client_unsupported'));
    if (telegram.isFullscreen === target) return Promise.resolve(result('confirmed'));
    return start('fullscreen', () => {
      slots.get('fullscreen').target = target;
      telegram[target ? 'requestFullscreen' : 'exitFullscreen']();
    }, { privateAction: false });
  };
  listen('fullscreenChanged', () => {
    updateSafeArea(); const slot = slots.get('fullscreen');
    if (slot && telegram.isFullscreen === slot.target) settle('fullscreen', slot, result('confirmed'));
    else notify();
  });
  listen('fullscreenFailed', nativeFailure('fullscreen'));
  for (const name of ['safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged']) listen(name, () => { updateSafeArea(); notify(); });
  listen('shareMessageFailed', nativeFailure('share'));
  listen('emojiStatusFailed', nativeFailure('emoji'));
  listen('homeScreenAdded', () => {
    homeScreenStatus = 'added'; const slot = slots.get('homeAdd');
    if (slot) settle('homeAdd', slot, result('confirmed', 'home_screen_added')); else notify();
  });
  updateSafeArea();

  const api = {
    snapshot, capabilities,
    subscribe(callback) { if (typeof callback !== 'function' || disposed) return () => {}; subscribers.add(callback); return () => subscribers.delete(callback); },
    requestFullscreen: () => toggleFullscreen(true), exitFullscreen: () => toggleFullscreen(false), exit: () => toggleFullscreen(false),
    checkHomeScreenStatus() {
      if (!capabilities().homeScreen) return Promise.resolve(result('unsupported', 'client_unsupported'));
      return start('homeCheck', done => telegram.checkHomeScreenStatus(status => {
        if (disposed || privateCleared) return;
        homeScreenStatus = HOME_STATES.has(status) ? status : 'unknown';
        done(result(homeScreenStatus === 'unsupported' ? 'unsupported' : homeScreenStatus === 'unknown' ? 'unknown' : 'confirmed', `home_screen_${homeScreenStatus}`));
      }));
    },
    markUsefulAction(kind) {
      if (!disposed && !privateCleared && USEFUL_ACTIONS.has(kind)) { usefulAction = true; notify(); return true; }
      return false;
    },
    addToHomeScreen() {
      if (!capabilities().homeScreen || homeScreenStatus === 'unsupported') return Promise.resolve(result('unsupported', 'client_unsupported'));
      if (!usefulAction) return Promise.resolve(result('unavailable', 'useful_action_required'));
      if (homeScreenStatus === 'added') return Promise.resolve(result('confirmed', 'home_screen_added'));
      return start('homeAdd', () => telegram.addToHomeScreen());
    },
    sharePreparedMessage(data) {
      if (!capabilities().shareMessage) return Promise.resolve(result('unsupported', 'client_unsupported'));
      if (data?.authority !== 'worker' || typeof data.preparedMessageId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(data.preparedMessageId)
        || !integer(data.expiresAt) || data.expiresAt <= nowSeconds() || data.expiresAt > nowSeconds() + 86400)
        return Promise.resolve(result('unavailable', 'prepared_message_unavailable'));
      return start('share', done => telegram.shareMessage(data.preparedMessageId, ok => done(callbackOutcome(ok, 'message_shared'))));
    },
    copyOwnReferral(data) {
      if (disposed || privateCleared) return Promise.resolve(result('cleared', 'session_cleared'));
      const url = data?.authority === 'worker' ? safeOwnReferralUrl(data.ownUrl) : null;
      if (!url) return Promise.resolve(result('unavailable', 'own_referral_unavailable'));
      if (!capabilities().clipboard) return Promise.resolve(result('unsupported', 'clipboard_unavailable'));
      return start('copy', done => {
        Promise.resolve(clipboard.writeText(url)).then(() => done(result('copied')), () => done(result('unavailable', 'clipboard_unavailable')));
      });
    },
    setDragonEmoji(data) {
      if (!capabilities().emojiStatus) return Promise.resolve(result('unsupported', 'client_unsupported'));
      const duration = integer(data?.expiresAt) && integer(data?.remainingSeconds)
        ? Math.min(data.expiresAt - nowSeconds(), data.remainingSeconds) : 0;
      if (data?.authority !== 'worker' || data.activeDragon !== true || data.planCode !== 'dragon' || data.previewActive !== false
        || !['active', 'cancel_at_period_end', 'payment_failed'].includes(data.accessState) || !Number.isSafeInteger(duration) || duration <= 0
        || typeof data.customEmojiId !== 'string' || !/^[1-9]\d{0,19}$/.test(data.customEmojiId)) return Promise.resolve(result('unavailable', 'active_dragon_required'));
      return start('emoji', done => telegram.setEmojiStatus(data.customEmojiId, { duration }, ok => done(callbackOutcome(ok, 'emoji_status_set'))));
    },
    openTelegramLink(value) {
      if (disposed || privateCleared) return result('cleared', 'session_cleared');
      const url = safeTelegramActionUrl(value); if (!url) return result('unavailable', 'telegram_link_invalid');
      if (!capabilities().openTelegramLink) return result('unsupported', 'client_unsupported');
      try { telegram.openTelegramLink(url); return result('opened'); } catch { return result('unknown', 'native_call_failed'); }
    },
    openInvoice(value) {
      if (disposed || privateCleared) return Promise.resolve(result('cleared', 'session_cleared'));
      const url = safeInvoiceUrl(value);
      if (!url) return Promise.resolve(result('unavailable', 'invoice_link_invalid'));
      if (!capabilities().openInvoice) return Promise.resolve(result('unsupported', 'client_unsupported'));
      return start('invoice', done => telegram.openInvoice(url, status => {
        // These are SDK presentation hints. They never grant paid access or
        // claim that the Worker has accepted the successful_payment update.
        done(['paid', 'cancelled', 'failed', 'pending'].includes(status)
          ? result(status, 'invoice_closed') : result('unknown', 'native_result_unconfirmed'));
      }), { waitForClose: true });
    },
    clearPrivate() {
      generation++; privateCleared = true; usefulAction = false;
      for (const [key, slot] of slots) { if (slot.timer !== null) timers.clearTimeout(slot.timer); slot.resolve?.(result('cleared', 'session_cleared')); slots.delete(key); }
      notify();
    },
    destroy() {
      if (disposed) return;
      api.clearPrivate(); disposed = true;
      for (const [name, handler] of listeners) { try { telegram.offEvent(name, handler); } catch {} }
      listeners.length = 0; subscribers.clear();
      if (css) for (const [name, [value, priority]] of savedCss) { if (value) css.setProperty(name, value, priority); else css.removeProperty(name); }
      savedCss.clear();
    },
  };
  return Object.freeze(api);
}
