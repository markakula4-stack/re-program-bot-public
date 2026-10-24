import { CabinetNavigator, errorMessage, authorizationMessage, formatAge, formatDate, formatMoney, formatUtcPeriod, privacyValue,
  safeActionUrl, safeStarsInvoiceUrl } from "./cabinet-client.mjs";
import { renderSubscriptionScreen, createSubscriptionReceiptPresenter, isNativeRenewalPermissionPending, subscriptionAvailabilityReason } from "./subscription-view.mjs";
import { createTelegramNativeAdapter, safeTelegramActionUrl } from "./telegram-native.mjs";
import { renderTelegramActions } from "./telegram-actions-view.mjs";

const LABELS = Object.freeze({ profile: "Профиль", offers: "Офферы", applications: "Заявки",
  analytics: "Аналитика", subscription: "Подписка" });
const ROLE = { user: "Пользователь", partner: "Партнёр", admin: "Администратор" };
const LEGAL = { individual: "Физическое лицо", self_employed: "Самозанятый", individual_entrepreneur: "ИП" };
const LEGAL_VERIFICATION = { verified: "Подтверждена", self_declared: "Указан партнёром", rejected: "Не подтверждена" };
const legalVerification = profile => profile
  ? LEGAL_VERIFICATION[profile.verificationState] ?? "Требуется проверка" : "Не указан";
const savedLegalDeclaration = profile => Object.hasOwn(LEGAL, profile?.profileKind ?? "") &&
  ["self_declared", "verified"].includes(profile?.verificationState);
const PARTNER = { no_application: "Станьте партнёром", pending_review: "Заявка на рассмотрении",
  rejected: "Заявка отклонена", active_partner: "Партнёрский профиль", paused_partner: "Профиль приостановлен",
  profile_repair_required: "Профиль требует восстановления" };
const LEAD = { pending: "На рассмотрении", confirmed: "Результат подтверждён", rejected: "Отклонена", paid: "Выплачено" };
const MODERATION = { not_submitted: "Не отправлен", pending: "На модерации", changes_requested: "Нужны изменения", approved: "Одобрен", rejected: "Отклонён" };
const BUSINESS = { draft: "Черновик", active: "Активен", paused: "Приостановлен", archived: "В архиве" };
const VISIBILITY = { private: "Приватный", assigned: "По назначению", public: "Публичный" };
const ACCESS = { none: "Нет активного доступа", trial: "Пробный доступ", active: "Активен",
  cancel_at_period_end: "До конца оплаченного периода", expired: "Истёк", refunded: "Возвращён", suspended: "Приостановлен" };
const NAV_ICONS = Object.freeze({
  profile: ["M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0"],
  offers: ["M4 7h16v13H4z", "M8 7V4h8v3", "M4 12h16", "M10 12v3h4v-3"],
  applications: ["M7 3h10l3 3v15H4V3h3", "M8 8h8", "M8 12h8", "M8 16h5"],
  analytics: ["M4 20h16", "M7 16V9", "M12 16V4", "M17 16v-5"],
  subscription: ["M4 5h16v14H4z", "M4 10h16", "M8 15h3"],
});
const CATEGORIES = { debit: "Дебетовая карта", credit: "Кредитная карта", business: "Для бизнеса",
  loan: "Займ", deposit: "Вклад", insurance: "Страхование", job: "Работа", other: "Другое" };

export async function copyPendingSubscriptionDiagnostics({ document, client, container, onStatus = () => {} } = {}) {
  const diagnostics = client?.pendingSubscriptionDiagnostics;
  if (!diagnostics || !diagnostics.subscription && !diagnostics.package) return false;
  const text = JSON.stringify(diagnostics, null, 2);
  try {
    const clipboard = document.defaultView?.navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard_unavailable');
    await clipboard.writeText(text);
    onStatus('Диагностика скопирована. Можно отправить её в поддержку.');
    return true;
  } catch {
    // Telegram WebView may deny clipboard access. Keep a phone-usable manual
    // copy path; neither copying nor exposing this text sends a payment POST.
    if (!container?.isConnected) return false;
    let field = container.querySelector('[data-subscription-diagnostics]');
    if (!field) {
      field = document.createElement('textarea'); field.readOnly = true; field.rows = 8;
      field.setAttribute('data-subscription-diagnostics', 'true');
      field.setAttribute('aria-label', 'Диагностика сохранённого запроса');
      container.append(field);
    }
    field.value = text; field.focus?.(); field.select?.();
    onStatus('Диагностика показана в поле. Удерживайте текст, выберите «Выделить всё» и «Копировать».');
    return false;
  }
}

export function mountCabinet({ document, client, telegram = null, native = null }) {
  const root = document.getElementById("cabinet");
  const screen = document.getElementById("screen");
  const notice = document.getElementById("notice");
  const nav = document.getElementById("navigation");
  native ??= createTelegramNativeAdapter({ telegram, document, clipboard: document.defaultView?.navigator?.clipboard });
  const display = document.getElementById("native-display");
  const fullscreenButton = document.getElementById("native-fullscreen");
  const fullscreenStatus = document.getElementById("native-display-status");
  let nativeView = null;
  let subscriptionRefreshTimer = null;
  let receiptRefreshTimer = null, receiptRefreshBudget = 0, lastFeaturedReceipt = null, lastSubscriptionData = null, revealReceipt = false;
  const packageSelection = Object.create(null);
  let receiptStorage = null;
  try { receiptStorage = document.defaultView?.localStorage ?? null; } catch {}
  const receiptPresenter = createSubscriptionReceiptPresenter({ storage: receiptStorage });
  const detachNativeView = () => { nativeView?.destroy(); nativeView = null; clearTimeout(subscriptionRefreshTimer); subscriptionRefreshTimer = null;
    clearTimeout(receiptRefreshTimer); receiptRefreshTimer = null; };
  let bootstrap = null;
  let current = { section: "profile", view: undefined, period: "7d" };
  let disposed = false;
  let lifecycle = 0;
  let navigationEpoch = 0;
  let renderedSection = null;
  let preservingVisualState = false;
  const receiptContext = node => node?.closest?.('[data-receipt-id]')?.getAttribute('data-receipt-id') ?? null;
  const focusIdentity = node => node ? {
    tag: node.tagName, id: node.id ?? '', name: node.getAttribute?.('name') ?? null,
    section: node.getAttribute?.('data-section') ?? null,
    recurringPlan: node.getAttribute?.('data-recurring-plan') ?? null,
    renewalAction: node.getAttribute?.('data-renewal-action') ?? null,
    packagePlan: node.getAttribute?.('data-package-plan') ?? null,
    packageDuration: node.getAttribute?.('data-package-duration') ?? null,
    packagePurchase: node.getAttribute?.('data-package-purchase') ?? null,
    packageSchedule: node.getAttribute?.('data-package-schedule') ?? null,
    transitionCancel: node.getAttribute?.('data-transition-cancel') ?? null,
    transitionMonthly: node.getAttribute?.('data-transition-monthly') ?? null,
    packageTerms: node.closest?.('[data-package-terms]')?.getAttribute('data-package-terms') ?? null,
    receipt: receiptContext(node), action: node.closest?.('form[data-action]')?.getAttribute('data-action') ?? null,
    text: node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT'
      ? null : node.textContent,
  } : null;
  const captureVisualState = () => ({
    focusNode: document.activeElement,
    focus: focusIdentity(document.activeElement),
    details: [...screen.querySelectorAll('details')].map(node => ({
      receipt: node.getAttribute('data-receipt-id'), terms: node.classList.contains('subscription-terms'),
      packageTerms: node.getAttribute('data-package-terms'),
      open: node.hasAttribute('open'),
    })).filter(row => row.receipt !== null || row.terms),
  });
  const restoreVisualState = state => {
    // Only presentation survives a read. Fresh access, eligibility, prices,
    // consent and financial controls always come from the new server response.
    for (const row of state.details) {
      const detail = [...screen.querySelectorAll('details')].find(node => row.receipt !== null
        ? node.getAttribute('data-receipt-id') === row.receipt : row.packageTerms !== null
          ? node.getAttribute('data-package-terms') === row.packageTerms : node.classList.contains('subscription-terms') && !node.hasAttribute('data-package-terms'));
      if (detail) detail.toggleAttribute('open', row.open);
    }
    const active = document.activeElement;
    // Do not steal focus if the user selected another live control while the
    // refresh was pending (for example a theme button outside the screen).
    if (active?.isConnected && active !== state.focusNode && active !== screen && active !== document.body) return;
    const same = node => JSON.stringify(focusIdentity(node)) === JSON.stringify(state.focus);
    const target = state.focusNode?.isConnected ? state.focusNode
      : [...document.querySelectorAll('button,a,input,select,textarea,summary,[tabindex]')].find(same);
    if (target?.isConnected && !target.disabled && !target.closest?.('[hidden]')) target.focus?.({ preventScroll: true });
    else if (state.focusNode && !state.focusNode.isConnected) screen.focus?.({ preventScroll: true });
  };
  let submitting = false;
  let expiryTimer = null;
  let noticeAction = null;
  let checkoutPending = false;
  let pendingRecoveryFeedback = null;
  let invoiceDialogPending = false;
  let issuedSubscriptionInvoice = null;
  const pages = new Map();
  // Unsaved input belongs only to this live cabinet instance. No persistent
  // storage, identity state or client-owned authority is introduced.
  const drafts = new Map();
  const savedResults = new Map();
  const savedInputs = new Map();
  const finishLaunch = state => {
    if (document.documentElement.getAttribute("data-launch-state") === "loading") {
      document.documentElement.setAttribute("data-launch-state", state);
      document.getElementById("launch-screen")?.setAttribute("aria-hidden", "true");
    }
  };
  const e = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const add = (node, ...children) => { node.append(...children.filter(Boolean)); return node; };
  const p = (text, className = "muted") => e("p", text, className);
  const button = (text, action, className = "button", disabled = false) => {
    const node = e("button", text, className); node.type = "button"; node.disabled = disabled;
    node.addEventListener("click", action); return node;
  };
  const badge = (text, kind = "") => e("span", text, `badge ${kind}`);
  const card = (title, ...children) => add(e("section", null, "card"), e("h3", title), ...children);
  const link = (text, href) => {
    const node = e("a", text, "button"); node.href = href;
    node.target = "_blank"; node.rel = "noopener noreferrer"; return node;
  };
  const support = () => link("Открыть поддержку", "https://t.me/RE_Program_Support_Bot");
  const facts = entries => {
    const list = e("dl", null, "facts");
    for (const [label, value] of entries) {
      add(list, add(e("div", null, "fact"), e("dt", label), e("dd", value ?? "Не указано")));
    }
    return list;
  };
  const head = (title, refresh = true) => add(e("div", null, "screen-head"), e("h2", title),
    refresh ? button("Обновить", () => navigate(current.section, { ...current, cursor: undefined, preserveScroll: true }), "button small") : null);
  const setNotice = (text, status = "info", action = null) => {
    notice.textContent = text;
    notice.setAttribute("data-status", status);
    noticeAction = action;
  };
  const syncFullscreen = () => {
    const state = native.snapshot();
    if (display) display.hidden = disposed || !bootstrap || !client.authenticated || state.capabilities.fullscreen !== true;
    if (fullscreenButton) {
      fullscreenButton.textContent = state.fullscreen ? "Обычный размер окна" : "На весь экран";
      fullscreenButton.setAttribute("aria-pressed", String(state.fullscreen));
      fullscreenButton.disabled = submitting || state.busy?.fullscreen === true;
    }
  };
  const fullscreenClick = async () => {
    if (disposed || !bootstrap || !client.authenticated || submitting || fullscreenButton?.disabled) return;
    const generation = lifecycle;
    if (fullscreenStatus) { fullscreenStatus.hidden = false; fullscreenStatus.textContent = "Меняем размер окна…"; }
    const outcome = await (native.snapshot().fullscreen ? native.exitFullscreen() : native.requestFullscreen());
    if (disposed || generation !== lifecycle) return;
    if (fullscreenStatus) {
      fullscreenStatus.hidden = outcome.status === "confirmed";
      fullscreenStatus.textContent = outcome.status === "confirmed" ? "" : "Telegram не подтвердил смену размера. Кабинет остаётся доступен в текущем окне.";
    }
    syncFullscreen();
  };
  fullscreenButton?.addEventListener("click", fullscreenClick);
  const unsubscribeNative = native.subscribe(syncFullscreen);
  const reconcileLegalResult = partner => {
    if (partner?.legalProfile?.verificationState !== "rejected") return;
    const key = JSON.stringify(["partner.legal", null]);
    savedResults.delete(key); savedInputs.delete(key);
    // A later canonical rejection supersedes this declaration's old success,
    // while another action's acknowledgement still describes its own result.
    if (noticeAction === "partner.legal" && notice.getAttribute("data-status") === "success") setNotice("");
  };
  const status = (node, text, kind) => {
    node.textContent = text; node.setAttribute("data-status", kind);
  };
  const activePartner = () => bootstrap?.partner.state === "active_partner";
  const ownPartnerHistory = () => Boolean(bootstrap?.partner.profile) &&
    ["active_partner", "paused_partner"].includes(bootstrap?.partner.state);
  const editorAllowed = () => activePartner() && bootstrap?.systemRole === "partner" &&
    bootstrap?.partner.actions.manageOffers === true;
  const createDecision = () => pages.get("offers:mine")?.decisions?.["offer.create_private"] ?? null;
  // The CREATE DTO may carry a stricter Beta slot cap. It cannot decide edit
  // permission; every edit receives its own current server admission.
  const canManage = () => editorAllowed() && bootstrap.partner.beta?.canCreatePrivateOffers === true;
  const canCreate = () => canManage() && (createDecision() === null || createDecision().allowed === true);
  const canSubmit = () => editorAllowed() && bootstrap.partner.beta?.canSubmitOffers === true;
  const writable = () => client.canMutate && !client.uncertain;
  const writeHint = () => !client.canMutate
    ? p("Отправка из кабинета пока недоступна. Воспользуйтесь меню бота.")
    : client.uncertain ? p(errorMessage({ code: "outcome_unknown" })) : null;
  const empty = (title, text) => {
    const node = card(title, p(text)); node.classList.add("empty"); return node;
  };
  const verifyActionStep = () => {
    const node = card("Ваш следующий шаг",
      p("Последнее действие могло сохраниться. Сначала обновите данные и проверьте результат. Не отправляйте его повторно."),
      button("Обновить данные", () => navigate("profile", { preserveScroll: true })));
    node.classList.add("next-steps"); node.setAttribute("data-next-step", "verify_action");
    return node;
  };
  const field = (label, { name, type = "text", value = "", maxLength, required = false, options } = {}) => {
    const wrap = e("label", null, "field");
    const input = e(options ? "select" : type === "textarea" ? "textarea" : "input");
    if (input.tagName === "INPUT") input.type = type;
    input.name = name; input.required = required;
    if (maxLength) input.maxLength = maxLength;
    if (type === "number") { input.min = "0"; input.step = "1"; input.inputMode = "numeric"; }
    if (options) for (const [key, text] of Object.entries(options)) {
      const option = e("option", text); option.value = key;
      option.selected = key === value; input.append(option);
    }
    if (!options) input.value = value ?? "";
    return { node: add(wrap, e("span", label), input), input };
  };
  const check = (text, checked = false) => {
    const wrap = e("label", null, "check"); const input = e("input");
    input.type = "checkbox"; input.checked = checked;
    return { node: add(wrap, input, e("span", text)), input };
  };
  const redrawNavigation = () => {
    // Keep each control mounted while its active surface fades. Replacing all
    // buttons on every read/click resets CSS transitions and keyboard focus.
    const mounted = new Map([...nav.children].map(node => [node.getAttribute("data-section"), node]));
    nav.hidden = !bootstrap;
    for (const [section, label] of Object.entries(LABELS)) {
      let node = mounted.get(section);
      if (!node) {
        node = button(null, () => navigate(section), "nav-button", submitting);
        node.setAttribute("data-section", section);
        const icon = e("span", null, "nav-icon"); icon.setAttribute("aria-hidden", "true");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "24", height: "24",
          fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round" })) {
          svg.setAttribute(name, value);
        }
        for (const path of NAV_ICONS[section]) {
          const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
          shape.setAttribute("d", path); svg.append(shape);
        }
        icon.append(svg); add(node, icon, e("span", label, "nav-label"));
        nav.append(node);
      }
      node.disabled = submitting;
      if (current.section === section) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    }
  };
  const refreshBootstrap = async () => {
    const generation = lifecycle;
    const data = await client.read("bootstrap");
    if (disposed || generation !== lifecycle || !client.authenticated) return false;
    bootstrap = data;
    reconcileLegalResult(data.partner);
    redrawNavigation();
    syncFullscreen();
    return true;
  };
  const commandForm = ({ fields = [], checks = [], submitText, action, payload, target,
    enabled = true, after, persisted = false }) => {
    const form = e("form", null, "form");
    form.setAttribute("data-action", action);
    const draftKey = JSON.stringify([action, target ?? null]);
    const draft = drafts.get(draftKey);
    // This baseline comes from the current profile response, before restoring
    // unsaved edits. A saved privacy setting is not another command to send.
    const canonicalInputs = {
      fields: fields.map(({ input }) => input.value), checks: checks.map(({ input }) => input.checked),
    };
    fields.forEach(({ input }, index) => { if (draft?.fields[index] !== undefined) input.value = draft.fields[index]; });
    checks.forEach(({ input }, index) => { if (draft?.checks[index] !== undefined) input.checked = draft.checks[index]; });
    const readInputs = () => ({
      fields: fields.map(({ input }) => input.value), checks: checks.map(({ input }) => input.checked),
    });
    // A persisted legal declaration is a server fact, not new consent. Show
    // its saved state until explicitly edited, then require fresh consent.
    let editing = !persisted || Boolean(draft);
    const acknowledged = () => action === "partner.legal" ? persisted && !editing
      : action === "partner.username" ? JSON.stringify(readInputs()) === JSON.stringify(canonicalInputs)
        : savedInputs.has(draftKey) && JSON.stringify(readInputs()) === JSON.stringify(savedInputs.get(draftKey));
    const remember = () => drafts.set(draftKey, readInputs());
    const msg = e("p", null, "form-message"); msg.setAttribute("role", "status");
    if (action === "partner.username") status(msg, acknowledged()
      ? "✅ Настройка сохранена." : "Изменение ещё не сохранено.", acknowledged() ? "success" : "idle");
    else if (savedResults.has(draftKey) && (action === "partner.legal" ? acknowledged()
      : !savedInputs.has(draftKey) || acknowledged())) {
      status(msg, savedResults.get(draftKey), "success");
    } else if (action === "partner.legal" && acknowledged()) status(msg, "Юридический статус сохранён.", "success");
    const submit = e("button", submitText, "button primary"); submit.type = "submit";
    const consentHint = p(action === "partner.legal"
      ? "Отметьте подтверждение, чтобы сохранить выбранный статус. Это ваше заявление, без проверки документов."
      : "Отметьте подтверждение, чтобы отправить заявку.", "form-hint");
    consentHint.hidden = true;
    let committed = false;
    let mutationScrollTop = null;
    const editButton = action === "partner.legal" && persisted ? button("Изменить статус", () => {
      if (committed || submitting || !writable()) return;
      editing = true;
      for (const { input } of checks) input.checked = false;
      remember(); status(msg, "", "idle"); syncSubmit();
    }, "button small") : null;
    editButton?.setAttribute("data-write-action", "partner.legal");
    const cancelButton = action === "partner.legal" && persisted ? button("Отмена", () => {
      if (committed || submitting || !writable()) return;
      fields.forEach(({ input }, index) => { input.value = canonicalInputs.fields[index]; });
      for (const { input } of checks) input.checked = false;
      drafts.delete(draftKey); editing = false;
      status(msg, "Юридический статус сохранён.", "success"); syncSubmit();
    }, "button small") : null;
    cancelButton?.setAttribute("data-write-action", "partner.legal");
    const syncSubmit = () => {
      const missingConsent = checks.some(({ input }) => input.required && !input.checked);
      const saved = acknowledged();
      submit.disabled = committed || saved || !enabled || !writable() || submitting || missingConsent;
      submit.textContent = committed || saved ? "Сохранено" : submitText;
      submit.hidden = action === "partner.legal" && (committed || saved)
        || action === "partner.username" && (committed || saved);
      consentHint.hidden = !editing || !missingConsent;
      if (action === "partner.legal") {
        form.setAttribute("data-editing", String(editing));
        for (const { input, node } of fields) {
          input.disabled = committed || !editing || submitting; node.hidden = !editing;
        }
        for (const { input, node } of checks) {
          input.disabled = committed || !editing || submitting; node.hidden = !editing;
        }
        msg.hidden = !editing && !committed;
        if (editButton) { editButton.hidden = editing; editButton.disabled = committed || submitting || !writable(); }
        if (cancelButton) { cancelButton.hidden = !editing || committed; cancelButton.disabled = submitting || !writable(); }
      }
    };
    for (const { input } of [...fields, ...checks]) {
      const edit = () => {
        if (committed) return;
        if (action === "partner.legal" && fields.some(item => item.input === input)) {
          for (const { input: consent } of checks) consent.checked = false;
        }
        remember();
        if (action === "partner.username") status(msg, acknowledged()
          ? "✅ Настройка сохранена." : "Изменение ещё не сохранено.", acknowledged() ? "success" : "idle");
        else if (!acknowledged()) status(msg, "", "idle");
        else if (savedResults.has(draftKey)) status(msg, savedResults.get(draftKey), "success");
        syncSubmit();
      };
      input.addEventListener("input", edit); input.addEventListener("change", edit);
    }
    syncSubmit();
    add(form, ...fields.map(item => item.node), ...checks.map(item => item.node), consentHint, msg, writeHint(), submit, editButton, cancelButton);
    const reloadResult = async () => {
      const generation = lifecycle;
      if (!await refreshBootstrap() || disposed || generation !== lifecycle) return;
      if (after) await after(); else await navigate(current.section, {
        ...current, cursor: undefined, preserveScroll: true, scrollTop: mutationScrollTop,
      });
    };
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (committed || acknowledged() || submitting || !enabled || !writable()) return;
      if (checks.some(({ input }) => input.required && !input.checked) || !form.reportValidity()) { syncSubmit(); return; }
      remember();
      // Capture before loading/status/notice nodes can change scroll anchoring.
      // The same origin is used by the canonical render and a GET-only retry.
      mutationScrollTop = document.defaultView?.scrollY ?? 0;
      const generation = lifecycle;
      submitting = true;
      const controls = [...root.querySelectorAll("button,input,select,textarea")]
        .map(node => [node, node.disabled]);
      for (const [node] of controls) node.disabled = true;
      submit.classList.add("is-loading"); submit.setAttribute("aria-busy", "true");
      status(msg, "Отправляем…", "loading");
      try {
        const result = await client.mutate(action, payload(), target);
        if (disposed || generation !== lifecycle) return;
        // A verified commit is final even when its following read is offline.
        // Retrying the read must never create a new mutation/key.
        committed = true; drafts.delete(draftKey); pages.clear();
        if (result.commitStatus === "committed") native.markUsefulAction("committed_form");
        const saved = result.commitStatus === "unchanged" ? "Данные уже сохранены." : "Изменения сохранены.";
        savedResults.set(draftKey, saved);
        if (["partner.legal", "partner.username"].includes(action)) savedInputs.set(draftKey, readInputs());
        status(msg, saved, "success");
        if (["partner.legal", "partner.username"].includes(action)) setNotice("");
        else setNotice(saved, "success", action);
        try {
          if (!await refreshBootstrap() || disposed || generation !== lifecycle) return;
          submitting = false;
          if (after) await after(); else await navigate(current.section, {
            ...current, cursor: undefined, preserveScroll: true, scrollTop: mutationScrollTop,
          });
        } catch (error) {
          if (disposed || generation !== lifecycle || !client.authenticated) return;
          status(msg, `${saved} Не удалось обновить экран. ${errorMessage(error)}`, "success");
          const next = card("Ваш следующий шаг",
            p(`${saved} Обновите данные, чтобы увидеть новый статус.`),
            p("Нажмите «Обновить данные» в сохранённой форме."));
          next.classList.add("next-steps"); next.setAttribute("data-next-step", "refresh_after_saved");
          screen.querySelector(".next-steps")?.replaceWith(next);
          const retry = button("Обновить данные", async () => {
            if (submitting || !client.authenticated) return;
            retry.disabled = true; status(msg, `${saved} Обновляем данные…`, "loading");
            try { await reloadResult(); }
            catch (readError) {
              if (!disposed && generation === lifecycle) {
                status(msg, `${saved} ${errorMessage(readError)}`, "success");
              }
            } finally { retry.disabled = false; }
          }, "button small");
          form.append(retry);
        }
      } catch (error) {
        if (disposed || generation !== lifecycle) return;
        status(msg, errorMessage(error), "error");
        if (error.code === "outcome_unknown") {
          setNotice(errorMessage(error), "error");
          screen.querySelector(".next-steps")?.replaceWith(verifyActionStep());
          for (const node of screen.querySelectorAll('button[type="submit"],button[data-write-action]')) node.disabled = true;
        }
      } finally {
        submitting = false;
        for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled;
        if (committed && form.isConnected) for (const { input } of [...fields, ...checks]) input.disabled = true;
        syncSubmit();
        submit.classList.remove("is-loading"); submit.setAttribute("aria-busy", "false");
        for (const node of nav.querySelectorAll("button")) node.disabled = false;
        if (client.uncertain) for (const node of screen.querySelectorAll('button[type="submit"],button[data-write-action]')) node.disabled = true;
      }
    });
    return form;
  };

  const profileScreen = data => {
    const partner = data.partner;
    reconcileLegalResult(partner);
    const identity = partner.profile;
    const access = data.access;
    const summary = card(identity?.displayName || "Ваш профиль",
      badge(ROLE[data.systemRole] ?? "Неизвестная роль", "profile-role"),
      facts([["Дата регистрации", formatDate(data.account.memberSince)],
        ["Условия использования", data.account.generalTermsAccepted ? "Приняты" : "Не приняты"],
        ["Тариф", access.planName], ["Состояние доступа", ACCESS[access.accessState] ?? "Требуется проверка"]]));
    summary.classList.add("profile-summary"); summary.querySelector("h3").classList.add("profile-name");
    const initials = identity?.displayName?.trim().split(/\s+/u).slice(0, 2)
      .map(word => Array.from(word)[0]).join("").toLocaleUpperCase("ru-RU") || "RE";
    const avatar = e("span", initials, "profile-avatar"); avatar.setAttribute("aria-hidden", "true");
    const summaryHead = add(e("div", null, "profile-summary-head"), avatar,
      add(e("div"), summary.querySelector("h3"), summary.querySelector(".profile-role")));
    summary.prepend(summaryHead);
    add(screen, head("Профиль"), summary);
    if (access.reviewRequired) add(screen, card("Тариф требует проверки",
      p("Данные доступа ещё не согласованы. Обратитесь в поддержку."), support()));
    if (access.readPath === "preview_overlay") add(screen, card("Dragon Preview",
      p("Пробный доступ отображается отдельно. Ваш тариф — Free.")));
    const partnerCard = card(PARTNER[partner.state] ?? "Партнёрский профиль");
    if (identity) add(partnerCard, facts([["ID партнёра", identity.partnerId],
      ["Публичный Telegram username", identity.publicUsernameEnabled ? `@${identity.telegramUsername}` : "Скрыт"],
      ["Partner Beta", partner.beta?.expired ? "Истекла" : partner.beta?.accessStatus === "active" ? "Активна" : "Недоступна"]]));
    if (partner.application || identity) {
      const age = partner.application?.ageConfirmed;
      const ageBlock = e("div", null, "age-confirmation");
      ageBlock.setAttribute("data-age-confirmation", age === true ? "confirmed" : age === false ? "not_confirmed" : "unknown");
      add(ageBlock, facts([["Подтверждение 18+", age === true ? "Заявитель подтвердил 18+"
        : age === false ? "Подтверждение не сохранено" : "Нет данных"]]),
      p(age === true ? "Возраст подтверждён заявителем при подаче заявки. Документальная проверка не проводилась."
        : "Для участия партнёром требуется 18+. Если подтверждение отсутствует, обратитесь в поддержку для проверки заявки."));
      add(partnerCard, ageBlock);
    }
    if (partner.state === "pending_review") add(partnerCard,
      p("Мы проверяем вашу заявку. Статус обновится после решения администратора."));
    if (partner.state === "rejected") add(partnerCard, p(partner.application?.rejectionReason || "Причина не указана."));
    if (partner.state === "paused_partner") add(partnerCard, p("Действия партнёра приостановлены."), support());
    if (partner.state === "profile_repair_required") add(partnerCard,
      p("Заявка одобрена, но профиль пока недоступен."), support());
    if (partner.actions.submitApplication) {
      const name = field("Имя или название", { name: "displayName", value: partner.application?.displayName,
        maxLength: 80, required: true }); name.input.minLength = 2;
      const contact = field("Контакт для связи", { name: "contact", value: partner.application?.contact, maxLength: 120 });
      const age = check("Мне исполнилось 18 лет"); age.input.required = true;
      add(partnerCard, p("Отправьте заявку, чтобы получить партнёрский профиль."),
        !data.account.generalTermsAccepted ? p("Сначала примите условия использования в меню бота.") : null,
        commandForm({ fields: [name, contact], checks: [age], submitText: "Отправить заявку",
          action: "partner.apply", enabled: data.account.generalTermsAccepted,
          payload: () => ({ displayName: name.input.value.trim(), contact: contact.input.value.trim(), ageConfirmed: age.input.checked }) }));
    }
    add(screen, partnerCard);
    if (client.uncertain) add(screen, verifyActionStep());
    else {
      const next = card("Ваш следующий шаг"); next.classList.add("next-steps");
      const setStep = code => next.setAttribute("data-next-step", code);
      if (data.systemRole === "admin") {
        setStep("admin"); add(next,
          p("Админский аккаунт подключён. Здесь доступны ваш профиль, каталог и личные данные. Рассмотрение партнёрских заявок и выдача Partner Beta доступны в админском меню Telegram-бота."));
      } else if (partner.state === "pending_review") {
        setStep("review"); add(next, p("Дождитесь решения администратора по вашей заявке."),
          button("Обновить статус заявки", () => navigate("profile", { preserveScroll: true })));
      } else if (partner.state === "active_partner") {
        if (partner.application?.ageConfirmed !== true) {
          setStep("age"); add(next, p("В сохранённой заявке нет подтверждения 18+. Обратитесь в поддержку: одобрение партнёрского профиля не заменяет подтверждение возраста."), support());
        } else if (!client.canMutate) {
          setStep("read_only"); add(next, p("Отправка из кабинета сейчас недоступна. Откройте меню Telegram-бота или обратитесь в поддержку."), support());
        } else if (!savedLegalDeclaration(partner.legalProfile)) {
          setStep("legal"); add(next, p(partner.legalProfile && partner.legalProfile.verificationState !== "rejected"
            ? "Состояние юридического статуса требует уточнения. Обновите данные или укажите действующий статус в блоке ниже."
            : "Укажите свой действующий юридический статус в блоке ниже. Он будет сохранён как ваше заявление."));
        } else if (partner.beta?.expired || partner.beta?.accessStatus !== "active") {
          setStep("beta"); add(next, p("Создание офферов откроется после выдачи Partner Beta администратором. Обратитесь в поддержку, чтобы запросить доступ."), support());
        } else if (data.systemRole === "partner" && partner.actions.manageOffers && partner.beta.canCreatePrivateOffers) {
          setStep("offers"); add(next, p("Создайте приватный черновик оффера. Он станет доступен другим пользователям после модерации и публикации."),
            button("Перейти к моим офферам", () => navigate("offers", { view: "mine" })));
        } else {
          setStep("support"); add(next, p("Партнёрский профиль активен, но создание офферов сейчас недоступно. Проверьте доступ со службой поддержки."), support());
        }
      } else if (partner.state === "no_application" ||
          (partner.state === "rejected" && partner.actions.submitApplication)) {
        if (!data.account.generalTermsAccepted) {
          setStep("terms"); add(next, p("Сначала примите условия использования в меню Telegram-бота. После этого заполните заявку партнёра."),
            link("Открыть Telegram-бота", "https://t.me/RE_Program_Bot"));
        } else {
          setStep("application"); add(next, p(partner.state === "rejected"
            ? "Прочитайте причину отказа выше, исправьте данные и отправьте заявку снова. Подтверждение 18+ отмечается самостоятельно."
            : "Чтобы стать партнёром, отправьте заявку выше и самостоятельно подтвердите 18+."));
        }
      } else {
        setStep("support"); add(next, p("Уточните состояние партнёрского профиля в поддержке."), support());
      }
      add(screen, next);
    }
    if (partner.actions.declareLegalProfile) {
      const kind = field("Юридический статус", { name: "profileKind", options: LEGAL,
        value: partner.legalProfile?.profileKind ?? "individual" });
      const agreement = check("Подтверждаю, что указал свой действующий статус"); agreement.input.required = true;
      add(screen, card("Юридический статус",
        savedLegalDeclaration(partner.legalProfile) ? badge("✅ Статус сохранён", "success legal-saved") : null,
        facts([["Сохранённый статус", LEGAL[partner.legalProfile?.profileKind] ?? "Не указан"],
          ["Проверка", legalVerification(partner.legalProfile)]]),
        p(partner.legalProfile?.verificationState === "verified"
          ? "Статус подтверждён. Измените его, если ваши данные поменялись."
          : savedLegalDeclaration(partner.legalProfile)
            ? "Статус указан вами. Сохранение не означает проверку документов."
            : "Укажите свой действующий юридический статус. Сохранение фиксирует ваше заявление и не означает проверку документов."),
        commandForm({ fields: [kind], checks: [agreement], submitText: "Сохранить статус", action: "partner.legal",
          persisted: savedLegalDeclaration(partner.legalProfile),
          payload: () => ({ profileKind: kind.input.value, selfDeclarationAccepted: agreement.input.checked }) })));
      const username = check("Показывать мой Telegram username в публичной карточке", identity?.publicUsernameEnabled);
      add(screen, card("Приватность профиля",
        facts([["Сохранённая видимость", identity?.publicUsernameEnabled ? "Публичный Telegram username" : "Telegram username скрыт"]]),
        p("Username становится публичным только с вашего согласия."),
        commandForm({ checks: [username], submitText: "Сохранить видимость", action: "partner.username",
          payload: () => ({ enabled: username.input.checked }) })));
    } else if (partner.legalProfile) add(screen, card("Юридический статус",
      facts([["Статус", LEGAL[partner.legalProfile.profileKind] ?? "Не указан"],
        ["Проверка", legalVerification(partner.legalProfile)]])));
    if (bootstrap?.counts) add(screen, card("В кабинете", facts([["Доступные офферы", bootstrap.counts.visibleOffers],
      ["Мои заявки", bootstrap.counts.ownApplications]])));
  };

  const segments = (choices, selected, choose) => {
    const group = e("div", null, "segments"); group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Фильтр раздела");
    for (const [key, label] of Object.entries(choices)) {
      const node = button(label, () => choose(key), "button small");
      node.setAttribute("aria-pressed", String(key === selected)); group.append(node);
    }
    return group;
  };
  const offerEditor = offer => {
    const inputs = [];
    const specs = [
      ["title", "Название", "text", 180], ["buttonText", "Текст кнопки", "text", 60],
      ["description", "Описание", "textarea", 1200], ["provider", "Компания", "text", 120],
      ["category", "Категория", "select"], ["payoutText", "Условия вознаграждения", "text", 200],
      ["requiredAction", "Что нужно сделать", "textarea", 500], ["geo", "География", "text", 160],
      ["minAge", "Возраст от", "number"], ["maxAge", "Возраст до", "number"],
      ["holdDays", "Холд, дней", "number"], ["trafficSources", "Источники трафика", "textarea", 500],
      ["sourceName", "Название источника", "text", 160],
      ["startsAt", "Начало, UTC (ГГГГ-ММ-ДД ЧЧ:ММ:СС)", "text", 19],
      ["expiresAt", "Окончание, UTC (ГГГГ-ММ-ДД ЧЧ:ММ:СС)", "text", 19],
    ];
    for (const [name, label, type, maxLength] of specs) {
      const raw = offer.content[name];
      const item = field(label, { name, type, maxLength, value: raw,
        required: ["title", "buttonText"].includes(name), options: type === "select" ? CATEGORIES : undefined });
      if (["minAge", "maxAge"].includes(name)) item.input.max = "100";
      if (name === "holdDays") item.input.max = "3650";
      inputs.push(item);
    }
    // No URL input: only a canonical approved route reference is accepted.
    const route = field("ID одобренной партнёрской ссылки (если меняете маршрут)",
      { name: "partnerLinkId", type: "number" }); route.input.min = "1";
    inputs.push(route);
    screen.replaceChildren(head("Редактирование оффера", false), card(`Версия ${offer.version}`,
      p("Сохранение создаёт новую версию. После изменений оффер нужно отправить на модерацию."),
      commandForm({ fields: inputs, submitText: "Сохранить новую версию", action: "offer.edit",
        enabled: offer.canEdit && canManage(), target: { code: offer.code, version: offer.version },
        payload: () => Object.fromEntries(inputs.flatMap(({ input }) => {
          if (input.name === "partnerLinkId" && !input.value) return [];
          const value = input.type === "number" ? (input.value ? Number(input.value) : null)
            : ["startsAt", "expiresAt"].includes(input.name) ? input.value || null : input.value;
          return [[input.name, value]];
        })) }), button("Вернуться к офферам", () => navigate("offers", { view: "mine" }))));
    screen.focus(); showBack(true);
  };
  const leadConfirmation = code => {
    screen.replaceChildren(head("Отправить заявку", false), card("Подтвердите отправку",
      p(`Оффер: ${code}. Заявка будет привязана к вашему профилю.`),
      commandForm({ submitText: "Подтвердить заявку", action: "lead.submit",
        payload: () => ({ offerCode: code }), after: () => navigate("applications", { view: "mine" }) }),
      button("Назад к офферам", () => navigate("offers", { view: "catalog" }))));
    screen.focus(); showBack(true);
  };
  const appendMore = (collection, data) => {
    if (data.nextCursor) add(screen, button("Показать ещё", () => navigate(collection,
      { ...current, cursor: data.nextCursor }), "button"));
  };
  const offersScreen = data => {
    add(screen, head("Офферы"), segments({ catalog: "Каталог", ...(ownPartnerHistory() ? { mine: "Мои офферы" } : {}) },
      data.view, view => navigate("offers", { view })));
    if (data.view === "mine" && canCreate()) add(screen,
      card("Новый оффер", commandForm({ submitText: "Создать приватный черновик", action: "offer.create", payload: () => ({}) })));
    if (data.view === "mine" && createDecision()) {
      const decision = createDecision();
      if (!decision.allowed) add(screen, card("Лимит и доступ", p(authorizationMessage(decision))));
      else if (decision.quota) add(screen, p(`Офферы: ${decision.quota.used} из ${decision.quota.limit}. Осталось ${decision.quota.remaining}.`));
    }
    if (!data.items.length) add(screen, empty("Пока нет офферов", data.view === "mine"
      ? "Здесь появятся ваши партнёрские офферы." : "Доступные офферы появятся здесь после публикации."));
    for (const item of data.items) {
      if (item.scope === "own") {
        const own = card(item.content.title, add(e("div", null, "actions"),
          badge(BUSINESS[item.businessStatus] ?? "Неизвестный статус"), badge(MODERATION[item.moderationStatus] ?? "Неизвестная модерация")),
        facts([["Код", item.code], ["Версия", item.version], ["Видимость", VISIBILITY[item.visibility] ?? "Неизвестна"]]));
        if (item.canEdit && canManage()) add(own,
          button("Редактировать", () => offerEditor(item)));
        if (item.canSubmit && canSubmit()) add(own,
          commandForm({ submitText: "Отправить на модерацию", action: "offer.submit", payload: () => ({}),
            target: { code: item.code, version: item.version } }));
        if (item.moderationStatus === "pending") add(own, p("Отправленная версия заблокирована на время модерации."));
        if (item.businessStatus === "draft") add(own, p("Черновик. Для активации и проверки маршрута используйте меню партнёра в боте."));
        add(screen, own);
      } else if (["public", "assigned"].includes(item.scope)) {
        const offer = item.offer;
        const offerCard = card(offer.title, badge(CATEGORIES[offer.category] ?? "Оффер", "blue"),
          offer.provider ? p(offer.provider) : null, offer.payoutText ? p(offer.payoutText, "offer-payout") : null,
          offer.description ? p(offer.description, "offer-description") : null,
          facts([["Необходимое действие", offer.requiredAction || "Смотрите условия оффера"],
            ["География", offer.geo || "Не указана"],
            ["Возраст", formatAge(offer.minAge, offer.maxAge)],
            ["Холд", offer.holdDays === null ? "Не указан" : `${offer.holdDays} дн.`]]));
        const url = safeActionUrl(offer.actionUrl);
        if (url) {
          const action = button(offer.buttonText || "Открыть предложение", async () => {
            const generation = lifecycle, navigation = navigationEpoch; action.disabled = true;
            try {
              const fresh = await client.resolveOfferAction(offer.code);
              if (disposed || generation !== lifecycle || navigation !== navigationEpoch || !client.authenticated) return;
              if (telegram?.openLink) { telegram.openLink(fresh); native.markUsefulAction("fresh_offer_open"); }
              else setNotice("Откройте предложение через Telegram-бота.");
            } catch (error) {
              if (!disposed && generation === lifecycle) setNotice(errorMessage(error));
            } finally { action.disabled = !client.canOpenOffers; }
          }, "button", !client.canOpenOffers);
          add(offerCard, action);
          if (!client.canOpenOffers) add(offerCard, p("Переход по предложению доступен в меню бота."));
        }
        else add(offerCard, p("Ссылка недоступна. Обновите карточку."));
        add(offerCard, button("Подать заявку", () => leadConfirmation(offer.code)), writeHint());
        add(screen, offerCard);
      }
    }
    appendMore("offers", data);
  };
  const applicationDetails = (data, view) => {
    const lead = data.application;
    add(screen, head("Заявка", false), card(`Заявка №${lead.leadId}`,
      badge(LEAD[lead.status] ?? "Неизвестный статус", lead.status === "confirmed" || lead.status === "paid" ? "blue" : ""),
      facts([["Оффер", lead.offerCode], ["Создана", formatDate(lead.createdAt)], ["Обновлена", formatDate(lead.updatedAt)]]),
      lead.result.rejectionReason ? p(lead.result.rejectionReason, "offer-description") : null,
      view === "attributed" && Object.hasOwn(lead.result, "rewardKopecks")
        ? facts([["Вознаграждение", formatMoney(lead.result.rewardKopecks)]]) : null,
      lead.canResubmit ? commandForm({ submitText: "Отправить повторно", action: "lead.submit",
        payload: () => ({ offerCode: lead.offerCode }) }) : null,
      button("К списку заявок", () => navigate("applications", { view: current.view ?? "mine" }))));
    showBack(true);
  };
  const applicationsScreen = data => {
    if (data.application) { applicationDetails(data, data.view); return; }
    add(screen, head("Заявки"), segments({ mine: "Мои заявки", ...(ownPartnerHistory() ? { attributed: "По моим офферам" } : {}) },
      data.view, view => navigate("applications", { view })));
    if (!data.items.length) add(screen, empty("Пока нет заявок", data.view === "mine"
      ? "Выберите предложение в каталоге офферов." : "Здесь появятся заявки, связанные с вашими офферами."));
    for (const lead of data.items) add(screen, card(`Заявка №${lead.leadId}`,
      badge(LEAD[lead.status] ?? "Неизвестный статус"),
      facts([["Оффер", lead.offerCode], ["Создана", formatDate(lead.createdAt)]]),
      button("Открыть заявку", () => navigate("applications", { view: data.view, leadId: lead.leadId }))));
    appendMore("applications", data);
  };
  const analyticsScreen = data => {
    add(screen, head("Аналитика"), segments({ "7d": "7 дней", "30d": "30 дней" }, data.period.code,
      period => navigate("analytics", { period })),
    p(formatUtcPeriod(data.period)),
    p(data.freshness === "stale" ? "Данные устарели. Обновите раздел." : "Последний доступный срез данных."));
    const stats = e("div", null, "stats");
    for (const [key, label] of Object.entries({ linkClicks: "Переходы", uniqueLinkClicks: "Уникальные переходы",
      applications: "Заявки", confirmedApplications: "Подтверждено" })) {
      add(stats, add(e("div", null, "stat"), e("span", data.leads[key], "stat-value"), e("span", label, "stat-label")));
    }
    add(screen, stats, card("Результаты заявок", facts([["На рассмотрении", data.leads.pendingApplications],
      ["Отклонено", data.leads.rejectedApplications], ["Выплачено", data.leads.paidApplications],
      ["Подтверждённое вознаграждение", formatMoney(data.leads.confirmedResultKopecks)]])));
    const ambassador = data.ambassador;
    if (ambassador.status === "ready") {
      add(screen, card("Амбассадор", facts(Object.entries({ tracking_opens: "Открытия ссылки",
        attributed_registrations: "Регистрации", attributed_leads: "Заявки", applied_paid_access: "Платный доступ",
        confirmed_referral_rewards: "Реферальные вознаграждения" }).map(([key, label]) => [label, privacyValue(ambassador.metrics[key])])),
      p("Часть значений может быть скрыта для защиты приватности.")));
    } else add(screen, card("Амбассадор", p(ambassador.status === "not_enrolled"
      ? "Вы не участвуете в программе амбассадоров." : ambassador.status === "unavailable"
        ? "Данные амбассадора пока недоступны." : "Участие амбассадора приостановлено или ещё не активировано.")));
  };
  const subscriptionScreen = data => {
    lastSubscriptionData = data;
    const outcome = client.verifiedSubscriptionOutcome;
    if (outcome && pendingRecoveryFeedback?.operationKey === outcome.key && pendingRecoveryFeedback.operationKind === outcome.kind) {
      pendingRecoveryFeedback = { text: outcome.state === 'rejected'
        ? 'Сохранённое действие отклонено. Доступные действия обновлены.'
        : 'Сохранённое действие подтверждено. Доступные действия обновлены.', status: 'info', busy: false };
      setNotice(pendingRecoveryFeedback.text);
    }
    // A recovered operation-status DTO confirms the original invoice, not a
    // new purchase. Retire only that operation's stale transport warning.
    if (noticeAction === "subscription.invoice_outcome_unknown" && !client.subscriptionOutcomePending &&
        safeStarsInvoiceUrl(client.recoveredSubscriptionInvoiceUrl))
      setNotice("Счёт подтверждён. Его можно открыть; оплата подтверждается отдельно.");
    if (noticeAction === "subscription.enable_outcome_unknown" && !client.subscriptionOutcomePending &&
        client.recoveredSubscriptionRenewalPermission?.contractId === data.lifecycle?.contractId)
      setNotice("Разрешение получено. В разделе Stars в Telegram включите продление. Статус включения ещё не подтверждён; оплаченный срок сохранён.");
    const onRefresh = () => navigate("subscription", { ...current, cursor: undefined, preserveScroll: true });
    const receiptPresentation = receiptPresenter.observe(data);
    const newlyFeatured = receiptPresentation.receipt?.receiptId && receiptPresentation.receipt.receiptId !== lastFeaturedReceipt;
    lastFeaturedReceipt = receiptPresentation.receipt?.receiptId ?? null;
    const page = renderSubscriptionScreen({ document, data, onRefresh,
      onPurchase: planCode => openSubscriptionCheckout(planCode, data),
      onRecurringPurchase: (planCode, focusOrigin) => openRecurringConfirmation(planCode, data, focusOrigin),
      onRenewalAction: action => openRenewalConfirmation(action, data),
      actionPending: client.subscriptionOutcomePending === true, packageActionPending: client.packageOutcomePending === true, receiptPresentation,
      packageSelection, onPackageSelection: (planCode, packageCode) => { packageSelection[planCode] = packageCode; },
      onPackagePurchase: (planCode, packageCode) => openPackageConfirmation('invoice', planCode, packageCode, data),
      onPackageSchedule: (planCode, packageCode) => openPackageConfirmation('schedule', planCode, packageCode, data),
      onCancelTransition: transition => openTransitionCancellation(transition),
      onMonthlyTransition: transition => openMonthlyTransitionConfirmation(transition),
      onRecoverPackageAction: () => recoverPackageAction(),
      onCopyPendingDiagnostics: container => copyPendingSubscriptionDiagnostics({ document, client, container,
        onStatus: message => setNotice(message) }),
      pendingActionRecoveryAvailable: client.pendingSubscriptionRecoveryAvailable === true,
      pendingRecoveryFeedback,
      onRecoverPendingAction: () => recoverMissingSubscriptionAction(),
      onDismissReceipt: () => { receiptPresenter.dismiss(); void onRefresh(); },
      onOpenReceipt: id => { if (receiptPresenter.open(id, data)) { lastFeaturedReceipt = null; void onRefresh(); } } });
    if (client.pendingCancellationReconfirmationMode && typeof client.reconfirmSubscriptionCancellation === 'function') {
      const reconfirm = button(client.pendingCancellationReconfirmationMode === 'continue'
        ? 'Продолжить подтверждение отмены' : 'Подтвердить отмену заново', () => openCancellationReconfirmation(), 'button small');
      reconfirm.setAttribute('data-reconfirm-pending-cancellation', 'true');
      page.querySelector('[data-current-plan]')?.append(reconfirm);
    }
    nativeView = renderTelegramActions({ document, data, native, onRefresh,
      onReadNative: () => client.read("subscription"),
      onPrepareReferral: typeof client.prepareOwnReferralMessage === "function" ? () => client.prepareOwnReferralMessage() : null,
      isPreparationUncertain: () => client.referralPreparationUncertain === true });
    nativeView.element.classList.add('subscription-telegram-details');
    page.append(nativeView.element); screen.append(page);
    if (newlyFeatured) {
      const featured = page.querySelector('[data-featured-receipt]');
      featured?.setAttribute('tabindex', '-1');
      revealReceipt = true;
    }
    scheduleReceiptRefresh();
    const sourceDeadline = data.authorization?.validUntil;
    if (Number.isSafeInteger(sourceDeadline) && sourceDeadline < client.expiresAt) {
      const generation = lifecycle, navigation = navigationEpoch;
      subscriptionRefreshTimer = setTimeout(() => {
        if (currentSubscription(generation, navigation) && !submitting && !invoiceDialogPending)
          void navigate("subscription", { ...current, preserveScroll: true });
      }, Math.max(0, sourceDeadline * 1000 - Date.now()));
    }
    if (data.lifecycle?.paidAccess === true) issuedSubscriptionInvoice = null;
    const recoveredInvoice = safeStarsInvoiceUrl(client.recoveredSubscriptionInvoiceUrl);
    const invoice = recoveredInvoice ?? issuedSubscriptionInvoice?.url;
    if (invoice && data.lifecycle?.paidAccess !== true)
      appendInvoiceCard(invoice, issuedSubscriptionInvoice?.planCode ?? data.lifecycle?.planCode, data, !!recoveredInvoice);
    const ownInvoices = [
      ...(data.packages?.pendingInvoices ?? []).filter(item => item.state === 'issued').map(item => ({ ...item, kind: 'package' })),
      ...(data.packages?.transitions ?? []).filter(item => item.monthlyCheckout?.invoiceUrl).map(item => ({ kind: 'transition',
        planCode: item.toPlan, invoiceUrl: item.monthlyCheckout.invoiceUrl, expiresAt: item.monthlyCheckout.expiresAt })),
    ];
    for (const own of ownInvoices) appendInvoiceCard(own.invoiceUrl, own.planCode, data, true, own);
    for (const own of (data.packages?.pendingInvoices ?? []).filter(item => item.state !== 'issued')) {
      const item = card(own.state === 'expired' ? 'Срок счёта завершён' : own.state === 'manual_review' ? 'Выдача счёта уточняется' : 'Счёт в обработке',
        p(`${own.planCode === 'dragon' ? 'Dragon' : 'Professional'} · ${own.amountStars} Stars · ${own.durationDays} дней`),
        p(own.state === 'expired' ? 'Срок оплаты этого счёта истёк. Для нового счёта выберите доступный пакет ниже.'
          : 'Обновите данные или обратитесь в помощь с оплатой. Доступ обновится после подтверждения Telegram.'));
      item.setAttribute('data-package-invoice-state', own.state); page.querySelector('.subscription-catalog-details')?.before(item);
    }
  };
  const scheduleReceiptRefresh = () => {
    clearTimeout(receiptRefreshTimer); receiptRefreshTimer = null;
    if (!receiptPresenter.pending || receiptRefreshBudget <= 0 || disposed || document.hidden || invoiceDialogPending
      || current.section !== 'subscription' || !client.authenticated) return;
    const generation = lifecycle, navigation = navigationEpoch;
    const wait = [20000, 10000, 5000, 1500][receiptRefreshBudget - 1] ?? 1500;
    receiptRefreshTimer = setTimeout(() => {
      receiptRefreshTimer = null;
      if (!currentSubscription(generation, navigation) || document.hidden) return;
      if (!submitting && !checkoutPending && !invoiceDialogPending) {
        receiptRefreshBudget--;
        void navigate('subscription', { ...current, preserveScroll: true });
      }
      else scheduleReceiptRefresh();
    }, wait);
  };
  const beginReceiptWait = (planCode, data) => {
    receiptPresenter.beginCheckout(planCode, data); receiptRefreshBudget = 4; lastFeaturedReceipt = null;
    scheduleReceiptRefresh();
  };
  function appendInvoiceCard(invoice, planCode, data, recovered = false, ownDescriptor = null) {
    const packageInvoice = ownDescriptor?.kind === 'package';
    const invoiceCard = card(packageInvoice ? "Счёт Telegram" : recovered ? "Счёт восстановлен" : "Счёт Telegram",
      p(packageInvoice ? 'Для оплаты нажмите «Открыть счёт». Доступ обновится после подтверждения Telegram.'
        : recovered ? "Это тот же сохранённый счёт Telegram. Новый счёт не создавался; оплата подтверждается отдельно."
        : "Создание счёта не является оплатой. После оплаты данные обновятся из Telegram."));
    invoiceCard.setAttribute("data-subscription-invoice", "true");
    if (ownDescriptor) invoiceCard.setAttribute('data-package-invoice', 'true');
    if (ownDescriptor?.kind === 'package') invoiceCard.append(p(`${planCode === 'dragon' ? 'Dragon' : 'Professional'} · ${ownDescriptor.amountStars} Stars · ${ownDescriptor.durationDays} дней`));
    if (native.capabilities().openInvoice && typeof native.openInvoice === "function") {
      const open = button("Открыть счёт", async () => {
        if (disposed || submitting || checkoutPending || invoiceDialogPending || !client.authenticated) return;
        const generation = lifecycle;
        if (ownDescriptor) {
          const navigation = navigationEpoch; checkoutPending = true; open.disabled = true;
          try {
            const fresh = await client.read('subscription');
            if (!currentSubscription(generation, navigation)) return;
            const own = ownDescriptor.kind === 'package'
              ? fresh.packages?.pendingInvoices?.some(item => item.state === 'issued' && item.invoiceUrl === invoice && item.expiresAt * 1000 > Date.now())
              : fresh.packages?.transitions?.some(item => item.monthlyCheckout.invoiceUrl === invoice && item.monthlyCheckout.expiresAt * 1000 > Date.now());
            if (!own) { setNotice('Этот счёт больше недоступен. Проверьте обновлённые данные.'); await navigate('subscription', { ...current, preserveScroll: true }); return; }
          } catch (error) { setNotice(errorMessage(error), 'error'); return; }
          finally { checkoutPending = false; if (open.isConnected) open.disabled = false; }
        }
        invoiceDialogPending = true; open.disabled = true;
        clearTimeout(receiptRefreshTimer); receiptRefreshTimer = null;
        beginReceiptWait(planCode, data);
        setNotice("Подтвердите оплату в окне Telegram. Проверим её после закрытия счёта.");
        try {
          const outcome = await native.openInvoice(invoice);
          if (disposed || generation !== lifecycle || !client.authenticated) return;
          setNotice(outcome.status === "paid" || outcome.status === "pending"
            ? "Telegram закрыл счёт. Проверяем подтверждение оплаты…"
            : outcome.status === "cancelled" ? "Счёт закрыт без подтверждения оплаты."
              : outcome.status === "failed" ? "Telegram не завершил оплату. Проверьте состояние счёта."
                : "Статус окна оплаты пока неизвестен. Обновите данные или откройте тот же счёт в Telegram.");
        } finally {
          invoiceDialogPending = false;
          if (!disposed && generation === lifecycle && client.authenticated) {
            if (open.isConnected) open.disabled = false;
            receiptRefreshBudget = 4;
            if (current.section === "subscription") await navigate("subscription", { ...current, preserveScroll: true });
          }
        }
      }, "button primary", invoiceDialogPending);
      open.setAttribute("data-native-invoice-open", "true"); invoiceCard.append(open);
    }
    if (!ownDescriptor) {
      const fallback = link(native.capabilities().openInvoice ? "Открыть в Telegram" : "Открыть счёт", invoice);
      fallback.addEventListener('click', () => beginReceiptWait(planCode, data)); invoiceCard.append(fallback);
    } else if (!native.capabilities().openInvoice) {
      // The SDK-free link is enabled only while its server-issued lifetime is
      // current. A refresh re-projects ownership and its availability.
      const fallback = link('Открыть тот же счёт в Telegram', invoice);
      fallback.addEventListener('click', event => {
        if (ownDescriptor.expiresAt * 1000 <= Date.now() || !client.authenticated) { event.preventDefault(); setNotice('Срок счёта завершён. Обновите данные.'); return; }
        beginReceiptWait(planCode, data);
      }); invoiceCard.append(fallback);
    }
    if (ownDescriptor) pageForCheckout()?.querySelector('.subscription-catalog-details')?.before(invoiceCard);
    else pageForCheckout()?.append(invoiceCard);
  }
  async function openSubscriptionCheckout(planCode, shownData) {
    if (disposed || submitting || checkoutPending || current.section !== "subscription" || !client.authenticated
      || client.packageOutcomePending || !["professional", "dragon"].includes(planCode)) return;
    const generation = lifecycle, navigation = navigationEpoch;
    checkoutPending = true;
    const purchaseButtons = [...screen.querySelectorAll("[data-purchase-plan]")].map(node => [node, node.disabled]);
    for (const [node] of purchaseButtons) node.disabled = true;
    setNotice("Проверяем условия выбранного тарифа…");
    try {
      const fresh = await client.read("subscription");
      if (disposed || generation !== lifecycle || navigation !== navigationEpoch || !client.authenticated) return;
      const offer = fresh.catalog?.offers?.find(row => row.planCode === planCode);
      const shown = shownData.catalog?.offers?.find(row => row.planCode === planCode);
      if (offer?.purchaseEligibility?.eligible !== true || offer.checkout?.available !== true) {
        setNotice("Покупка сейчас недоступна. Обновлённые условия показаны ниже.");
        await navigate("subscription", { ...current, preserveScroll: true }); return;
      }
      if (offer.amountStars !== shown?.amountStars || offer.priceVersion !== shown?.priceVersion
        || offer.accessSeconds !== shown?.accessSeconds || fresh.catalog.termsRevision !== shownData.catalog?.termsRevision) {
        setNotice("Условия или цена изменились. Проверьте обновлённый тариф и выберите его ещё раз.");
        await navigate("subscription", { ...current, preserveScroll: true }); return;
      }
      const url = safeTelegramActionUrl(offer.checkout.url);
      if (!url || url !== `https://t.me/RE_Program_Bot?start=subscribe_${planCode}`) throw { code: "invalid_response" };
      const outcome = native.openTelegramLink(url);
      if (outcome.status === "opened") {
        beginReceiptWait(planCode, fresh);
        setNotice("В боте откроются условия выбранного тарифа. Оплата и подтверждение выполняются отдельно.");
      } else {
        // A regular Telegram link is a real fallback on clients without the SDK method.
        const fallback = card("Продолжить в Telegram", p("Откройте условия выбранного тарифа. Счёт появится после отдельного подтверждения в боте."),
          link("Открыть выбранный тариф", url));
        screen.querySelector("[data-checkout-fallback]")?.remove();
        fallback.setAttribute("data-checkout-fallback", planCode); pageForCheckout()?.append(fallback);
        fallback.querySelector('a')?.addEventListener('click', () => beginReceiptWait(planCode, fresh));
        setNotice("Перейдите в Telegram по кнопке ниже.");
      }
    } catch (error) { if (!disposed && generation === lifecycle && navigation === navigationEpoch) setNotice(errorMessage(error), "error"); }
    finally {
      checkoutPending = false;
      if (!disposed && generation === lifecycle && navigation === navigationEpoch)
        for (const [node, disabled] of purchaseButtons) if (node.isConnected) node.disabled = disabled;
    }
  }
  const pageForCheckout = () => screen.querySelector("[data-subscription-screen]");
  const subscriptionActionNodes = () => [...screen.querySelectorAll("[data-purchase-plan], [data-recurring-plan], [data-renewal-action], [data-subscription-confirm], [data-package-purchase], [data-package-schedule], [data-transition-cancel], [data-transition-monthly], [data-recover-pending-subscription], [data-reconfirm-pending-cancellation]")];
  const currentSubscription = (generation, navigation) => !disposed && generation === lifecycle && navigation === navigationEpoch &&
    current.section === "subscription" && client.authenticated;
  async function subscriptionFreshCheck(check, { readOnly = false } = {}) {
    if (disposed || submitting || checkoutPending || current.section !== "subscription" || !client.authenticated ||
        (!readOnly && (client.subscriptionOutcomePending || client.packageOutcomePending || typeof client.subscriptionAction !== "function"))) return null;
    const generation = lifecycle, navigation = navigationEpoch;
    const pendingNotice = readOnly && (client.subscriptionOutcomePending || client.packageOutcomePending)
      ? { text: notice.textContent, status: notice.getAttribute("data-status") ?? "info", action: noticeAction } : null;
    checkoutPending = true;
    const nodes = subscriptionActionNodes().map(node => [node, node.disabled]);
    for (const [node] of nodes) node.disabled = true;
    setNotice("Проверяем актуальные условия…");
    try {
      const fresh = await client.read("subscription");
      if (!currentSubscription(generation, navigation)) return null;
      if (!check(fresh)) {
        setNotice("Условия или состояние изменились. Проверьте обновлённые данные.");
        await navigate("subscription", { ...current, preserveScroll: true }); return null;
      }
      if (pendingNotice && (client.subscriptionOutcomePending || client.packageOutcomePending))
        setNotice(pendingNotice.text, pendingNotice.status, pendingNotice.action);
      else setNotice("");
      return fresh;
    } catch (error) { if (currentSubscription(generation, navigation)) setNotice(errorMessage(error), "error"); return null; }
    finally {
      checkoutPending = false;
      if (currentSubscription(generation, navigation)) for (const [node, disabled] of nodes) if (node.isConnected) node.disabled = disabled;
    }
  }
  const sameRecurringQuote = (a, b) => a && b && ["planCode", "amountStars", "currency", "priceVersion", "termsRevision", "accessSeconds", "billingMode"]
    .every(key => a[key] === b[key]);
  const packageOffer = (data, planCode, packageCode) => data?.packages?.offers?.find(item => item.planCode === planCode && item.packageCode === packageCode);
  const samePackageOffer = (a, b, oldObservedAt, newObservedAt) => a && b &&
    ['planCode', 'packageCode', 'durationDays', 'periodSeconds', 'amountStars', 'currency', 'priceVersion', 'offerVersion', 'campaignCode', 'termsRevision', 'billingMode']
      .every(key => a[key] === b[key]) && a.terms?.text === b.terms?.text && a.terms?.available === b.terms?.available &&
    !!a.preview && !!b.preview && (a.preview.startsAt > oldObservedAt) === (b.preview.startsAt > newObservedAt) &&
    (a.preview.startsAt <= oldObservedAt || a.preview.startsAt === b.preview.startsAt && a.preview.endsAt === b.preview.endsAt);
  const packageDate = value => Number.isSafeInteger(value) ? `${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value * 1000))} МСК` : 'Дата уточняется';
  function showSubscriptionConfirmation(title, children, submitLabel, onSubmit, consentText = null, focusOrigin = null) {
    screen.querySelector('.subscription-dialog')?.remove();
    const returnFocus = focusOrigin ?? document.activeElement;
    const panel = card(title, ...children); panel.classList.add('subscription-confirmation');
    panel.setAttribute('data-subscription-confirmation', 'true'); panel.setAttribute('tabindex', '-1');
    panel.querySelector('h3').id = 'subscription-confirmation-title';
    const dialog = add(e('dialog', null, 'subscription-dialog'), panel);
    dialog.setAttribute('aria-labelledby', 'subscription-confirmation-title');
    dialog.setAttribute('aria-modal', 'true');
    let checkbox = null;
    const close = () => {
      if (submitting || checkoutPending) return;
      dialog.close?.(); dialog.remove();
      if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
    };
    const submit = typeof onSubmit === 'function'
      ? button(submitLabel, () => { if (!submit.disabled && (!checkbox || checkbox.checked)) void onSubmit(panel); }, 'button primary', !!consentText) : null;
    submit?.setAttribute('data-subscription-confirm', 'true');
    if (submit && consentText) {
      checkbox = e('input'); checkbox.type = 'checkbox'; checkbox.checked = false;
      const consent = add(e('label', null, 'subscription-consent'), checkbox, e('span', consentText));
      checkbox.addEventListener('change', () => { submit.disabled = checkoutPending || !checkbox.checked; }); panel.append(consent);
    }
    add(panel, add(e('div', null, 'subscription-confirmation-actions'), submit, button('Назад', close)));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    // Native dialog keeps the background inert and traps keyboard focus. The
    // fallback serves DOM tests and older clients without changing any action.
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const nodes = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), summary, a[href]')];
      const first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); panel.focus?.(); }
      else if (event.shiftKey && [first, panel].includes(document.activeElement)) { event.preventDefault(); last.focus?.(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus?.(); }
    });
    pageForCheckout()?.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    panel.focus({ preventScroll: true });
  }
  function previousActionNotice() {
    const recovery = client.subscriptionRecoveryState;
    const suffix = ' Условия можно прочитать; новый счёт пока недоступен.';
    if (client.packageOutcomePending) return 'В браузере сохранён запрос пакета без подтверждённого результата.' + suffix;
    if (recovery?.state === 'unrecoverable') return 'В браузере осталась блокировка предыдущего действия, но данных для его проверки недостаточно.' + suffix;
    if (recovery?.state === 'principal_mismatch') return 'Сохранённый запрос относится к другому аккаунту или боту. Откройте исходный аккаунт либо передайте диагностику в поддержку.' + suffix;
    if (recovery?.state === 'missing') return 'Сервер пока не нашёл сохранённый запрос. Его результат не подтверждён.' + suffix;
    if (recovery?.state === 'lookup_failed') return 'Не удалось проверить сохранённый запрос на сервере.' + suffix;
    if (recovery?.state === 'checking') return 'Проверяем результат сохранённого запроса.' + suffix;
    if (['admitted', 'pending', 'unknown'].includes(recovery?.state)) return 'Сервер ещё не подтвердил результат предыдущего действия.' + suffix;
    return 'В браузере сохранено предыдущее действие; его результат ещё не проверен.' + suffix;
  }
  async function openPackageConfirmation(kind, planCode, packageCode, shown) {
    if (!['invoice', 'schedule'].includes(kind)) return;
    const focusOrigin = screen.querySelector(`[data-package-${kind === 'invoice' ? 'purchase' : 'schedule'}="${planCode}:${packageCode}"]`) ?? document.activeElement;
    const displayed = packageOffer(shown, planCode, packageCode);
    const fresh = await subscriptionFreshCheck(data => {
      const offer = packageOffer(data, planCode, packageCode);
      return samePackageOffer(displayed, offer, shown.observedAt, data.observedAt) && offer.terms.available === true &&
        (kind === 'invoice' || offer[kind].available === true);
    }, { readOnly: kind === 'invoice' });
    if (!fresh) return;
    const offer = packageOffer(fresh, planCode, packageCode), name = planCode === 'dragon' ? 'Dragon' : 'Professional';
    const recurring = offer.billingMode === 'recurring';
    const invoiceAvailable = typeof client.packageAction === 'function' && offer[kind].available === true
      && !client.subscriptionOutcomePending && !client.packageOutcomePending;
    const pending = client.subscriptionOutcomePending || client.packageOutcomePending;
    const terms = add(e('details', null, 'subscription-terms'), e('summary', 'Условия пакета и возврата'),
      p(offer.terms.text, 'subscription-terms-text'), p(`Редакция: ${offer.termsRevision}`, 'subscription-version'));
    if (!invoiceAvailable) terms.setAttribute('open', '');
    showSubscriptionConfirmation(kind === 'schedule' ? `Запланировать ${name}` : `${name} · ${offer.durationDays} дней`, [
      p(recurring ? `${offer.amountStars} Stars за новый месяц · каждые 30 дней` : `${offer.amountStars} Stars · полная разовая стоимость`, 'subscription-current-time'),
      p(`Начало: ${packageDate(offer.preview.startsAt)}. Окончание: ${packageDate(offer.preview.endsAt)}.`),
      p(kind === 'schedule' ? 'Это только намерение: Stars сейчас не списываются, текущий оплаченный срок сохраняется. Новый период нужно оплатить отдельно.'
        : 'Без автосписаний. Даты предварительные; точный оплаченный период появится в квитанции Telegram.'),
      terms, !invoiceAvailable ? p(pending ? previousActionNotice()
        : subscriptionAvailabilityReason(offer[kind].reasonCode ?? 'purchase_unavailable'), 'subscription-lock') : null,
      recurring ? p('На дату перехода потребуется новый месячный счёт и отдельное согласие на автопродление.') : null],
    kind === 'schedule' ? 'Подтвердить планирование' : 'Подтвердить и получить счёт', invoiceAvailable ? async panel => {
      const checked = await subscriptionFreshCheck(data => {
        const candidate = packageOffer(data, planCode, packageCode);
        return samePackageOffer(offer, candidate, fresh.observedAt, data.observedAt) && candidate[kind].available === true;
      });
      if (checked && panel.isConnected) await sendPackageAction(kind, { requestedPlanCode: planCode, packageCode,
        confirmation: { acceptedTerms: true, amountStars: offer.amountStars, currency: offer.currency, priceVersion: offer.priceVersion,
          offerVersion: offer.offerVersion, campaignCode: offer.campaignCode, termsRevision: offer.termsRevision } }, panel);
    } : null, invoiceAvailable ? kind === 'schedule' ? `Принимаю условия и планирую ${name} на следующий период. Покупку подтвержу отдельно.`
      : `Принимаю условия разовой оплаты ${offer.amountStars} Stars за ${offer.durationDays} дней без автосписаний.` : null, focusOrigin);
  }
  async function openTransitionCancellation(shown) {
    const focusOrigin = screen.querySelector(`[data-transition-cancel="${shown.transitionId}"]`) ?? document.activeElement;
    const fresh = await subscriptionFreshCheck(data => data.packages?.transitions.some(item => item.transitionId === shown.transitionId &&
      item.revision === shown.revision && item.cancel.available === true));
    if (!fresh) return;
    showSubscriptionConfirmation('Отменить изменение?', [p('Отменяется только запланированное изменение. Текущий оплаченный срок сохраняется.'),
      p('Это действие не возвращает Stars и не отменяет автопродление другого договора. Возврат и состояние продления проверяются отдельно.')],
    'Отменить изменение', async panel => {
      const checked = await subscriptionFreshCheck(data => data.packages?.transitions.some(item => item.transitionId === shown.transitionId &&
        item.revision === shown.revision && item.cancel.available === true));
      if (checked && panel.isConnected) await sendPackageAction('cancel', { transitionId: shown.transitionId, expectedRevision: shown.revision }, panel);
    }, null, focusOrigin);
  }
  async function openMonthlyTransitionConfirmation(shown) {
    const focusOrigin = screen.querySelector(`[data-transition-monthly="${shown.transitionId}"]`) ?? document.activeElement;
    const same = data => data.packages?.transitions.find(item => item.transitionId === shown.transitionId && item.revision === shown.revision &&
      item.monthlyCheckout.available === true && ['amountStars', 'currency', 'termsRevision', 'priceVersion'].every(field => item.monthlyCheckout[field] === shown.monthlyCheckout[field]));
    const fresh = await subscriptionFreshCheck(data => !!same(data)); if (!fresh) return;
    const transition = same(fresh), offer = transition.monthlyCheckout, name = transition.toPlan === 'dragon' ? 'Dragon' : 'Professional';
    showSubscriptionConfirmation(`Новый месяц ${name}`, [p(`${offer.amountStars} Stars каждые 30 дней`, 'subscription-current-time'),
      p('Это новый месячный договор. Прежнее согласие не переносится; новый тариф начнёт действовать после подтверждённой оплаты.'),
      add(e('details', null, 'subscription-terms'), e('summary', 'Условия подписки и возврата'),
        p(fresh.catalog.recurring?.terms?.text ?? 'Автопродление каждые 30 дней. Отмена сохраняет уже оплаченный срок.', 'subscription-terms-text'),
        p(`Редакция: ${offer.termsRevision}`, 'subscription-version'))], 'Подтвердить и получить счёт', async panel => {
      const checked = await subscriptionFreshCheck(data => !!same(data));
      if (checked && panel.isConnected) await sendPackageAction('monthly-invoice', { transitionId: transition.transitionId, expectedRevision: transition.revision,
        recurringConsent: true, termsRevision: offer.termsRevision, priceVersion: offer.priceVersion }, panel);
    }, `Согласен на ${offer.amountStars} Stars каждые 30 дней и принимаю условия. Продление можно отменить.`, focusOrigin);
  }
  async function sendPackageAction(kind, payload, panel) {
    if (disposed || submitting || checkoutPending || client.subscriptionOutcomePending || client.packageOutcomePending || !client.authenticated || !panel.isConnected) return;
    const generation = lifecycle, navigation = navigationEpoch; submitting = true;
    let invoiceReady = false;
    screen.setAttribute('aria-busy', 'true');
    for (const node of subscriptionActionNodes()) node.disabled = true;
    for (const node of panel.querySelectorAll('button, input')) node.disabled = true;
    setNotice('Отправляем подтверждённое действие…');
    try {
      const result = await client.packageAction(kind, payload);
      if (!currentSubscription(generation, navigation)) return;
      if (['invoice', 'monthly-invoice'].includes(kind)) {
        const invoice = safeStarsInvoiceUrl(kind === 'invoice' ? result.invoiceURL : result.invoiceUrl);
        if (invoice) { invoiceReady = kind === 'invoice'; beginReceiptWait(payload.requestedPlanCode ?? null, lastSubscriptionData); setNotice('Счёт готов. Оплата подтверждается отдельно в Telegram; текущий доступ пока сохраняется.'); }
        else setNotice('Результат выдачи счёта требует проверки. Новый счёт не отправляем; проверьте тот же запрос или обратитесь в помощь с оплатой.');
      } else setNotice(kind === 'cancel' ? 'Запланированное изменение отменено. Оплаченный срок сохранён; Stars не возвращались.'
        : 'Изменение запланировано. Текущий тариф и оплаченный срок сохранены; новый период ещё нужно оплатить.');
    } catch (error) { if (currentSubscription(generation, navigation)) setNotice(errorMessage(error), 'error'); }
    finally {
      submitting = false;
      if (currentSubscription(generation, navigation)) {
        const refreshed = navigationEpoch + 1;
        await navigate('subscription', { ...current, preserveScroll: true, closeDialog: true });
        if (invoiceReady && currentSubscription(generation, refreshed))
          screen.querySelector('[data-package-invoice]')?.scrollIntoView?.({ behavior: 'auto', block: 'start' });
      }
    }
  }
  async function recoverPackageAction() {
    if (disposed || submitting || checkoutPending || !client.authenticated || typeof client.recoverPackageAction !== 'function') return;
    const generation = lifecycle, navigation = navigationEpoch; submitting = true; setNotice('Проверяем тот же сохранённый запрос…');
    try {
      const result = await client.recoverPackageAction();
      if (currentSubscription(generation, navigation)) setNotice(result && !client.packageOutcomePending
        ? 'Результат сохранённого запроса подтверждён. Доступ и квитанция проверяются отдельно.'
        : 'Результат ещё уточняется. Помощь с оплатой проверит этот запрос; новый счёт не создаём.');
    } catch (error) { if (currentSubscription(generation, navigation)) setNotice(errorMessage(error), 'error'); }
    finally { submitting = false; if (currentSubscription(generation, navigation)) await navigate('subscription', { ...current, preserveScroll: true, closeDialog: true }); }
  }
  async function recoverMissingSubscriptionAction() {
    if (disposed) return;
    if (!client.authenticated) {
      showPendingRecoveryFeedback('Сессия завершилась. Закройте кабинет и откройте его снова из Telegram.', 'error'); return;
    }
    if (submitting || checkoutPending) {
      showPendingRecoveryFeedback('Дождитесь завершения текущей проверки, затем проверьте доступные действия.'); return;
    }
    if (client.pendingSubscriptionRecoveryAvailable !== true || typeof client.recoverMissingSubscriptionAction !== 'function') {
      showPendingRecoveryFeedback('Состояние сохранённого запроса изменилось. Нажмите «Обновить», затем проверьте доступные действия.', 'error'); return;
    }
    const generation = lifecycle, navigation = navigationEpoch; submitting = true;
    let recoverySucceeded = false;
    screen.setAttribute('aria-busy', 'true');
    for (const node of subscriptionActionNodes()) node.disabled = true;
    showPendingRecoveryFeedback('Проверяем сохранённое действие… Это может занять до 45 секунд.', 'info', true);
    try {
      await client.recoverMissingSubscriptionAction();
      recoverySucceeded = true;
      if (currentSubscription(generation, navigation)) showPendingRecoveryFeedback(client.subscriptionOutcomePending
        ? 'Результат ещё уточняется. Новый запрос пока недоступен.'
        : 'Сохранённое действие проверено. Доступные действия обновлены.', client.subscriptionOutcomePending ? 'info' : 'success');
    } catch (error) {
      if (!disposed && generation === lifecycle && navigation === navigationEpoch && current.section === 'subscription')
        showPendingRecoveryFeedback(errorMessage(error) + ' Обновите данные. Если блокировка остаётся, скопируйте диагностику и передайте в поддержку.', 'error');
    }
    finally {
      submitting = false;
      if (!disposed && generation === lifecycle && navigation === navigationEpoch && current.section === 'subscription') {
        screen.setAttribute('aria-busy', 'false');
        const recoveryButton = screen.querySelector('[data-recover-pending-subscription]');
        if (recoveryButton) {
          recoveryButton.setAttribute('aria-busy', 'false');
          recoveryButton.disabled = checkoutPending || !client.authenticated || client.pendingSubscriptionRecoveryAvailable !== true;
        }
        if (recoverySucceeded && client.authenticated)
          await navigate('subscription', { ...current, preserveScroll: true, closeDialog: true });
      }
    }
  }
  function showPendingRecoveryFeedback(text, status = 'info', busy = false) {
    const operation = client.pendingSubscriptionDiagnostics?.subscription;
    pendingRecoveryFeedback = { text, status, busy, operationKey: operation?.key, operationKind: operation?.kind }; setNotice(text, status);
    const feedback = screen.querySelector('[data-pending-recovery-status]');
    if (feedback) {
      feedback.textContent = text; feedback.hidden = false; feedback.setAttribute('data-status', status);
      feedback.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    }
    const recoveryButton = screen.querySelector('[data-recover-pending-subscription]');
    if (recoveryButton) {
      recoveryButton.textContent = busy ? 'Восстанавливаем…' : 'Восстановить действие';
      recoveryButton.disabled = busy || submitting || checkoutPending || !client.authenticated;
      recoveryButton.setAttribute('aria-busy', String(busy));
    }
  }
  async function openRecurringConfirmation(planCode, shown, requestedFocusOrigin = null) {
    const focusOrigin = requestedFocusOrigin ?? screen.querySelector(`[data-recurring-plan="${planCode}"]`) ?? document.activeElement;
    const displayed = shown.catalog.recurring?.offers.find(row => row.planCode === planCode);
    const fresh = await subscriptionFreshCheck(data => {
      const offer = data.catalog.recurring?.offers.find(row => row.planCode === planCode);
      return sameRecurringQuote(displayed, offer) && data.catalog.recurring.terms.available === true;
    }, { readOnly: true });
    if (!fresh) return;
    const offer = fresh.catalog.recurring.offers.find(row => row.planCode === planCode), name = planCode === "dragon" ? "Dragon" : "Professional";
    const canInvoice = data => data.access?.current?.status === 'verified' && data.catalog.recurring?.ready === true &&
      data.lifecycle?.pendingOperations === 0 && data.catalog.recurring.terms.available === true && data.catalog.recurring.offers.some(row => row.planCode === planCode &&
        row.purchaseEligibility?.eligible === true && row.checkout?.available === true);
    const invoiceAvailable = canInvoice(fresh) && !client.subscriptionOutcomePending && !client.packageOutcomePending &&
      typeof client.subscriptionAction === 'function';
    const terms = add(e('details', null, 'subscription-terms'), e('summary', 'Условия подписки и возврата'),
      p(fresh.catalog.recurring.terms.text, 'subscription-terms-text'), p(`Редакция: ${offer.termsRevision}`, 'subscription-version'));
    if (!invoiceAvailable) terms.setAttribute('open', '');
    showSubscriptionConfirmation(`Месячная подписка ${name}`, [p(`${offer.amountStars} Stars каждые 30 дней`, "subscription-current-time"), terms,
      p(invoiceAvailable ? 'После подтверждения откроется счёт Telegram.'
        : client.subscriptionOutcomePending || client.packageOutcomePending ? previousActionNotice()
          : 'Новый счёт сейчас недоступен. Состояние текущей подписки показано выше. Просмотр условий ничего не покупает.')],
    "Подтвердить и открыть счёт", invoiceAvailable ? async panel => {
      const checked = await subscriptionFreshCheck(data => sameRecurringQuote(offer, data.catalog.recurring?.offers.find(row => row.planCode === planCode)) && canInvoice(data) &&
        data.catalog.recurring.terms.text === fresh.catalog.recurring.terms.text);
      if (checked && panel.isConnected) await sendSubscriptionAction("invoice", { planCode, recurringConsent: true, termsRevision: offer.termsRevision, priceVersion: offer.priceVersion }, panel);
    } : null, invoiceAvailable ? `Согласен на ${offer.amountStars} Stars каждые 30 дней и принимаю условия. Продление можно отменить.` : null, focusOrigin);
  }
  async function openRenewalConfirmation(action, shown) {
    if (!["cancel", "enable"].includes(action)) return;
    const focusOrigin = screen.querySelector(`[data-renewal-action="${action}"]`) ?? document.activeElement;
    const fresh = await subscriptionFreshCheck(data => data.renewalActions?.[action]?.available === true &&
      data.renewalActions.contractId === shown.renewalActions?.contractId && data.renewalActions.expectedRevision === shown.renewalActions?.expectedRevision &&
      (data.lifecycle?.pendingOperations === 0 || action === "cancel" && isNativeRenewalPermissionPending(data)));
    if (!fresh) return;
    const target = { contractId: fresh.renewalActions.contractId, expectedRevision: fresh.renewalActions.expectedRevision };
    showSubscriptionConfirmation(action === "cancel" ? "Отменить продление?" : "Разрешить включение?", [
      p(action === "cancel" ? "Будущие списания прекратятся. Оплаченный срок сохранится. Возврат оформляется отдельно."
        : "После разрешения включите подписку самостоятельно: Telegram → Звёзды → Мои подписки. Это не новая оплата; оплаченный срок сохранится.")],
    action === "cancel" ? "Отменить продление" : "Разрешить включение", async panel => {
      const checked = await subscriptionFreshCheck(data => data.renewalActions?.[action]?.available === true &&
        data.renewalActions.contractId === target.contractId && data.renewalActions.expectedRevision === target.expectedRevision &&
        (data.lifecycle?.pendingOperations === 0 || action === "cancel" && isNativeRenewalPermissionPending(data)));
      if (checked && panel.isConnected) await sendSubscriptionAction(action, target, panel);
    }, null, focusOrigin);
  }
  async function openCancellationReconfirmation() {
    if (disposed || submitting || checkoutPending) return;
    if (!client.authenticated) {
      showPendingRecoveryFeedback('Сессия завершилась. Закройте кабинет и откройте его снова из Telegram.', 'error'); return;
    }
    const generation = lifecycle, navigation = navigationEpoch;
    const focusOrigin = screen.querySelector('[data-reconfirm-pending-cancellation]');
    checkoutPending = true; if (focusOrigin) focusOrigin.disabled = true;
    try {
      await client.recoverSubscriptionAction(); // Read the own original/link status before showing consent.
      if (!currentSubscription(generation, navigation)) return;
      if (!client.pendingCancellationReconfirmationMode) {
        showPendingRecoveryFeedback('Состояние отмены изменилось. Нажмите «Обновить», затем проверьте доступные действия.', 'error'); return;
      }
      showSubscriptionConfirmation('Подтвердить отмену заново?', [
        p('Результат прежней отмены не подтверждён. Сервер проверит сохранённое действие и свяжет с ним новое подтверждение отмены. Оплаченный срок сохранится. Возврат оформляется отдельно.')
      ], 'Подтвердить отмену', panel => sendCancellationReconfirmation(panel), null, focusOrigin);
    } catch (error) {
      if (!disposed && generation === lifecycle && navigation === navigationEpoch && current.section === 'subscription')
        showPendingRecoveryFeedback(errorMessage(error) + ' Обновите данные или скопируйте диагностику.', 'error');
    } finally {
      checkoutPending = false;
      if (focusOrigin?.isConnected) focusOrigin.disabled = !client.authenticated || !client.pendingCancellationReconfirmationMode;
    }
  }
  async function sendCancellationReconfirmation(panel) {
    if (disposed || submitting || checkoutPending || !panel.isConnected) return;
    if (!client.authenticated || !client.pendingCancellationReconfirmationMode) {
      showPendingCancellationFailure('Состояние отмены или сессии изменилось. Нажмите «Обновить» либо откройте кабинет снова из Telegram.', panel); return;
    }
    const generation = lifecycle, navigation = navigationEpoch; submitting = true;
    screen.setAttribute('aria-busy', 'true');
    for (const node of subscriptionActionNodes()) node.disabled = true;
    for (const node of panel.querySelectorAll('button, input')) node.disabled = true;
    setNotice('Проверяем прежнее действие и отправляем новую подтверждённую отмену… Это может занять до 45 секунд.');
    let terminal = false;
    try {
      const result = await client.reconfirmSubscriptionCancellation();
      terminal = !client.subscriptionOutcomePending && ['confirmed', 'rejected'].includes(result.status ?? result.state);
      if (!disposed && generation === lifecycle && navigation === navigationEpoch && current.section === 'subscription')
        showPendingCancellationFailure(terminal ? (result.status ?? result.state) === 'confirmed'
          ? 'Команда отмены подтверждена. Проверяем состояние продления; уже оплаченный срок сохранён.'
          : 'Действие отклонено. Проверьте обновлённое состояние подписки.'
          : 'Сервер ещё не подтвердил результат отмены. Обновите данные или скопируйте диагностику.', panel);
    } catch (error) {
      if (!disposed && generation === lifecycle && navigation === navigationEpoch && current.section === 'subscription')
        showPendingCancellationFailure((error.code === 'subscription_outcome_unknown'
          ? 'Ответ не подтверждён. Действие могло выполниться; повторно его не отправляем.' : errorMessage(error)) +
          ' Обновите данные или скопируйте диагностику.', panel);
    } finally {
      submitting = false;
      if (!disposed && generation === lifecycle && navigation === navigationEpoch && current.section === 'subscription') {
        screen.setAttribute('aria-busy', 'false');
        const action = screen.querySelector('[data-reconfirm-pending-cancellation]');
        if (action) action.disabled = !client.authenticated || !client.pendingCancellationReconfirmationMode;
        if (terminal && client.authenticated) await navigate('subscription', { ...current, preserveScroll: true, closeDialog: true });
      }
    }
  }
  async function sendSubscriptionAction(kind, payload, panel) {
    if (disposed || submitting || checkoutPending || client.subscriptionOutcomePending || !client.authenticated || !panel.isConnected) return;
    const generation = lifecycle, navigation = navigationEpoch;
    submitting = true;
    screen.setAttribute("aria-busy", "true");
    for (const node of subscriptionActionNodes()) node.disabled = true;
    for (const node of panel.querySelectorAll("button, input")) node.disabled = true;
    setNotice(kind === 'cancel' ? 'Отправляем подтверждённую отмену… Это может занять до 45 секунд.' : "Отправляем подтверждённое действие…");
    let invoice = null;
    let retainCancellationCard = false;
    try {
      const result = await client.subscriptionAction(kind, payload);
      if (!currentSubscription(generation, navigation)) return;
      if (kind === "invoice" && result.status === "confirmed") {
        invoice = safeStarsInvoiceUrl(result.invoiceUrl);
        if (!invoice) throw { code: "invalid_response" };
        issuedSubscriptionInvoice = { url: invoice, planCode: payload.planCode };
        beginReceiptWait(payload.planCode, lastSubscriptionData);
        setNotice("Счёт готов. Откройте его в Telegram и отдельно подтвердите оплату. Доступ пока не изменён.");
      } else setNotice(result.status === "confirmed" && kind === "cancel"
        ? "Команда отмены подтверждена. Проверяем состояние продления; уже оплаченный срок сохранён."
        : result.status === "confirmed" && kind === "enable" && result.reenableAllowed === true
          ? "Разрешение получено. В разделе Stars в Telegram включите продление. Статус включения ещё не подтверждён; оплаченный срок сохранён."
          : result.status === "rejected" ? "Telegram не подтвердил действие. Проверьте состояние подписки или обратитесь в поддержку."
            : "Результат ещё уточняется. Повторная отправка недоступна; проверьте данные или обратитесь в поддержку.");
    } catch (error) {
      const message = error.code === "subscription_outcome_unknown"
        ? "Ответ не подтверждён. Действие могло выполниться; повторно его не отправляем. Обновите данные или обратитесь в поддержку."
        : errorMessage(error);
      retainCancellationCard = kind === 'cancel' && client.subscriptionOutcomePending;
      if (!disposed && generation === lifecycle && navigation === navigationEpoch && current.section === 'subscription') {
        if (retainCancellationCard) showPendingCancellationFailure(message, panel);
        else if (client.authenticated) setNotice(message, "error", ["invoice", "enable"].includes(kind) && error.code === "subscription_outcome_unknown" ? `subscription.${kind}_outcome_unknown` : null);
      }
    } finally {
      submitting = false;
      if (retainCancellationCard && !disposed && generation === lifecycle && navigation === navigationEpoch && current.section === 'subscription') {
        screen.setAttribute('aria-busy', 'false'); return;
      }
      if (currentSubscription(generation, navigation)) {
        const refreshed = navigationEpoch + 1;
        await navigate("subscription", { ...current, preserveScroll: true, closeDialog: true });
        if (invoice && currentSubscription(generation, refreshed) && !screen.querySelector('[data-subscription-invoice]')) {
          appendInvoiceCard(invoice, payload.planCode, lastSubscriptionData);
        }
      }
    }
  }
  function showPendingCancellationFailure(text, panel) {
    const dialog = panel?.closest('.subscription-dialog'); dialog?.close?.(); dialog?.remove();
    const currentCard = screen.querySelector('[data-current-plan]');
    if (currentCard) {
      if (!currentCard.querySelector('[data-copy-pending-diagnostics]')) {
        const copy = button('Копировать диагностику', () => copyPendingSubscriptionDiagnostics({ document, client, container: currentCard,
          onStatus: message => setNotice(message) }), 'button small');
        copy.setAttribute('data-copy-pending-diagnostics', 'true'); currentCard.append(copy);
      }
      if (!currentCard.querySelector('[data-pending-recovery-status]')) {
        const feedback = p('', 'subscription-state-note'); feedback.setAttribute('data-pending-recovery-status', 'true');
        feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); currentCard.append(feedback);
      }
    }
    showPendingRecoveryFeedback(text, 'error');
  }
  const showBack = visible => { if (visible) telegram?.BackButton?.show?.(); else telegram?.BackButton?.hide?.(); };
  const navigator = new CabinetNavigator(client, state => {
    if (disposed) return;
    detachNativeView();
    screen.replaceChildren(); screen.setAttribute("aria-busy", String(state.status === "loading"));
    showBack(false);
    if (state.status === "loading") {
      const loading = add(e("div", null, "loading"),
        p(renderedSection === state.section ? "Обновляем данные…" : `Открываем раздел «${LABELS[state.section]}»…`),
        e("div", null, "loading-line"));
      loading.setAttribute("role", "status");
      add(screen, head(LABELS[state.section], false), loading); return;
    }
    if (state.status === "error") {
      finishLaunch("error");
      add(screen, card("Не удалось загрузить раздел", p(errorMessage(state.error)),
        button("Повторить загрузку", () => navigate(state.section, { ...state, cursor: undefined })))); return;
    }
    try {
      let data = state.data;
      if (["offers", "applications"].includes(state.section) && !state.leadId) {
        const key = `${state.section}:${data.view}`;
        const previous = state.cursor ? pages.get(key)?.items ?? [] : [];
        const ids = new Set(previous.map(item => state.section === "offers" ? item.code ?? item.offer?.code : item.leadId));
        const items = [...previous, ...data.items.filter(item => !ids.has(state.section === "offers" ? item.code ?? item.offer?.code : item.leadId))];
        data = { ...data, items }; pages.set(key, data);
      }
      const render = { profile: profileScreen, offers: offersScreen, applications: applicationsScreen,
        analytics: analyticsScreen, subscription: subscriptionScreen }[state.section];
      render(data); renderedSection = state.section;
    } catch {
      screen.replaceChildren(card("Не удалось прочитать данные", p(errorMessage({ code: "invalid_response" })),
        button("Обновить раздел", () => navigate(state.section))));
    }
    if (!preservingVisualState) screen.focus({ preventScroll: true });
    finishLaunch("ready");
  });
  async function navigate(section, options = {}) {
    if (disposed || submitting) return;
    // A passive in-place refresh must not remove a focused consent dialog.
    // Submission always re-reads its quote; an altered quote closes the dialog
    // through the existing checkoutPending refresh path before any POST.
    if (section === 'subscription' && current.section === section && options.preserveScroll &&
        screen.querySelector('.subscription-dialog') && !checkoutPending && !options.closeDialog) return;
    navigationEpoch++;
    revealReceipt = false;
    const navigation = navigationEpoch;
    const visualState = options.preserveScroll && renderedSection === section && current.section === section
      ? captureVisualState() : null;
    preservingVisualState = visualState !== null;
    const scrollTop = options.preserveScroll
      ? Number.isFinite(options.scrollTop) && options.scrollTop >= 0
        ? options.scrollTop : document.defaultView?.scrollY ?? 0
      : null;
    current = { section, view: options.view ?? (section === "offers" ? "catalog" : "mine"),
      period: options.period ?? "7d", ...(options.leadId ? { leadId: options.leadId } : {}) };
    redrawNavigation();
    const availability = bootstrap?.navigation.find(item => item.section === section);
    if (availability?.enabled === false) {
      detachNativeView();
      navigator.cancel(); screen.setAttribute("aria-busy", "false");
      screen.replaceChildren(head(LABELS[section], false), empty("Раздел пока недоступен",
        "Аналитика доступна после активации партнёрского профиля."));
      preservingVisualState = false; screen.focus(); return;
    }
    await navigator.load(section, { ...current, cursor: options.cursor });
    if (navigation === navigationEpoch && !disposed && client.authenticated) {
      preservingVisualState = false;
      if (visualState && !revealReceipt) restoreVisualState(visualState);
      if (revealReceipt) {
        const featured = screen.querySelector('[data-featured-receipt]');
        featured?.focus?.({ preventScroll: true }); featured?.scrollIntoView?.({ behavior: 'auto', block: 'start' });
        revealReceipt = false;
      } else if (scrollTop !== null) document.defaultView?.scrollTo?.({ top: scrollTop, behavior: "auto" });
    }
  }
  const back = () => navigate(current.section === "applications" ? "applications" : "offers",
    { view: current.view, period: current.period });
  const checkExpiry = () => { if (bootstrap && !client.authenticated) expire(); };
  const visibility = () => {
    if (disposed || document.hidden) return;
    checkExpiry();
    if (receiptPresenter.pending) receiptRefreshBudget = 4;
    if (bootstrap && client.authenticated && current.section === "subscription" && !submitting && !invoiceDialogPending)
      void navigate("subscription", { ...current, cursor: undefined, preserveScroll: true });
  };
  function expire() {
    lifecycle++;
    navigator.cancel(); pages.clear(); drafts.clear(); savedResults.clear(); savedInputs.clear(); bootstrap = null; renderedSection = null;
    clearTimeout(expiryTimer); client.clearSession();
    detachNativeView(); native.clearPrivate(); syncFullscreen();
    receiptPresenter.clear(); receiptRefreshBudget = 0; lastFeaturedReceipt = null; lastSubscriptionData = null;
    issuedSubscriptionInvoice = null; invoiceDialogPending = false;
    nav.replaceChildren(); nav.hidden = true;
    screen.setAttribute("aria-busy", "false");
    screen.replaceChildren(card("Сессия завершилась", p(errorMessage({ code: "session_expired" })),
      client.uncertain ? p("Последнее действие могло сохраниться. Откройте кабинет заново и проверьте данные перед повторной отправкой.", "form-message") : null,
      support()));
    setNotice(""); showBack(false); finishLaunch("error");
  }
  telegram?.BackButton?.onClick?.(back);
  document.addEventListener("visibilitychange", visibility);
  document.defaultView?.addEventListener?.('focus', visibility);
  let activationListener = false;
  try {
    if (typeof telegram?.version === "string" && /^\d+\.\d+(?:\.\d+)?$/.test(telegram.version)
      && Number(telegram.version.split(".")[0]) >= 8
      && (typeof telegram.isVersionAtLeast !== "function" || telegram.isVersionAtLeast("8.0") === true)
      && typeof telegram.onEvent === "function" && typeof telegram.offEvent === "function") {
      telegram.onEvent("activated", visibility); activationListener = true;
    }
  } catch {}
  return {
    async start() {
      try {
        clearTimeout(expiryTimer);
        if (!await refreshBootstrap() || disposed) return;
        const milliseconds = Math.max(0, client.expiresAt * 1000 - Date.now());
        expiryTimer = setTimeout(expire, milliseconds);
        await navigate(document.defaultView?.location?.hash === "#subscription" ? "subscription" : "profile");
        if (!disposed && client.authenticated && native.capabilities().homeScreen) void native.checkHomeScreenStatus();
      } catch (error) {
        if (disposed) return;
        if (!client.authenticated) { expire(); return; }
        finishLaunch("error"); screen.setAttribute("aria-busy", "false");
        screen.replaceChildren(card("Кабинет недоступен", p(errorMessage(error)),
          client.authenticated ? button("Повторить загрузку", () => this.start()) : null, support()));
      }
    },
    navigate,
    expire,
    showError(error) {
      lifecycle++; navigator.cancel(); pages.clear(); drafts.clear(); savedResults.clear(); savedInputs.clear(); bootstrap = null; renderedSection = null;
      client.clearSession(); nav.replaceChildren(); nav.hidden = true;
      detachNativeView(); native.clearPrivate(); syncFullscreen();
      receiptPresenter.clear(); receiptRefreshBudget = 0; lastFeaturedReceipt = null; lastSubscriptionData = null;
      issuedSubscriptionInvoice = null; invoiceDialogPending = false;
      finishLaunch("error"); screen.setAttribute("aria-busy", "false");
      screen.replaceChildren(card("Кабинет недоступен", p(errorMessage(error)), support()));
    },
    destroy() {
      disposed = true; lifecycle++; navigator.cancel(); pages.clear(); drafts.clear(); savedResults.clear(); savedInputs.clear(); bootstrap = null; renderedSection = null; clearTimeout(expiryTimer);
      client.clearSession(); nav.replaceChildren(); nav.hidden = true; screen.replaceChildren(); setNotice("");
      detachNativeView(); unsubscribeNative(); fullscreenButton?.removeEventListener("click", fullscreenClick); native.destroy(); syncFullscreen();
      receiptPresenter.clear(); receiptRefreshBudget = 0; lastFeaturedReceipt = null; lastSubscriptionData = null;
      issuedSubscriptionInvoice = null; invoiceDialogPending = false;
      telegram?.BackButton?.offClick?.(back); showBack(false);
      document.removeEventListener("visibilitychange", visibility);
      document.defaultView?.removeEventListener?.('focus', visibility);
      if (activationListener) { telegram.offEvent("activated", visibility); activationListener = false; }
      root.setAttribute("aria-busy", "false");
    },
  };
}
