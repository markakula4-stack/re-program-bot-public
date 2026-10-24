import { errorMessage, formatDate } from "./cabinet-client.mjs";

const SECTIONS = Object.freeze({ overview: "Обзор", partners: "Партнёры", offers: "Офферы",
  users: "Пользователи", settings: "Пульт", support: "Поддержка", journal: "Журнал", payments: "Платежи" });
const REMOTE_SECTIONS = Object.freeze({ settings: "Пульт", support: "Поддержка", payments: "Платежи" });
const PAYMENT_STATUS = { pending_review: "Требует проверки", applied: "Доступ выдан", refunded: "Возвращено",
  chargeback: "Спор по оплате", pending: "Ожидаем подтверждение", unknown: "Результат неясен" };
const PAYMENT_REASON = { recovery_order_in_progress: "Во время оплаты уже был открыт другой счёт",
  recurring_first_charge_conflict: "Нужно проверить первую оплату подписки",
  paid_access_suspended: "На момент оплаты доступ был приостановлен" };
const STATUS = { pending: "На рассмотрении", approved: "Одобрено", rejected: "Отклонено",
  changes_requested: "Нужны изменения", not_submitted: "Не отправлено", active: "Активен",
  paused: "Приостановлен", draft: "Черновик", archived: "В архиве", public: "Публичный",
  private: "Приватный", assigned: "По назначению", open: "Ждёт специалиста", waiting: "Ждём пользователя", closed: "Закрыто" };
const FILTERS = { partners: { pending: "На рассмотрении", approved: "Одобренные", rejected: "Отклонённые", all: "Все заявки" },
  offers: { pending: "На модерации", approved: "Одобренные", changes_requested: "Нужны изменения", rejected: "Отклонённые", not_submitted: "Не отправленные", all: "Все офферы" },
  users: { all: "Все пользователи", blocked: "Заблокированные" }, support: { open: "Ждут ответа", waiting: "Ждём пользователя", closed: "Закрытые" } };
const SETTING_LABELS = { ai_rollout_mode: "Доступ к RE AI", official_web_enabled: "Официальный веб-поиск",
  official_web_stale_enabled: "Использование устаревших результатов веб-поиска" };
const settingValue = value => typeof value === "boolean" ? value ? "Включено" : "Выключено"
  : value === "off" ? "Выключен" : value === "admin" ? "Только мне" : value === "all" ? "Всем" : String(value ?? "Не задано");
const aiModeDescription = value => ({
  off: "RE AI выключен для всех аккаунтов.",
  admin: "RE AI доступен только вашему аккаунту администратора.",
  all: "RE AI доступен пользователям с учётом их прав и лимитов.",
})[value] ?? "Не удалось определить текущий режим RE AI. Обновите данные.";
const offerNeedsNewRead = error => ["state_conflict", "version_conflict", "prerequisite_required"].includes(error?.code)
  || ["state_conflict", "version_conflict", "prerequisite_required"].includes(error?.authorization?.reasonCode);
const DEFAULT_STATUS = { partners: "pending", offers: "pending", users: "all", support: "open" };
const number = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("ru-RU") : "Недоступно";
const date = value => value === null || value === undefined ? "Не указана"
  : formatDate(typeof value === "number" ? new Date(value * 1000).toISOString() : value);
const offerDate = value => value === null ? "Не указана" : `${new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium", timeStyle: "medium", timeZone: "Europe/Moscow",
}).format(new Date(value.replace(" ", "T") + "Z"))} МСК`;
const label = value => STATUS[value] ?? (typeof value === "string" && value ? value : "Не указано");

export function mountAdminCabinet({ document, client, telegram = null }) {
  const root = document.getElementById("admin-cabinet"), screen = document.getElementById("admin-screen");
  const nav = document.getElementById("admin-navigation"), notice = document.getElementById("admin-notice");
  const sessionStatus = document.getElementById("admin-session-status");
  let current = { section: "settings", params: {} }, disposed = false, admitted = false, releaseInfo = null;
  let generation = 0, controller = null, submitting = false, expiryTimer = null;
  const e = (tag, text, className) => {
    const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className; return node;
  };
  const add = (node, ...children) => { node.append(...children.filter(Boolean)); return node; };
  const p = (text, className = "muted") => e("p", text, className);
  const card = (title, ...children) => add(e("section", null, "card"), e("h3", title), ...children);
  const button = (text, action, { primary = false, disabled = false, write = false, small = false } = {}) => {
    const node = e("button", text, `button${primary ? " primary" : ""}${small ? " small" : ""}`);
    node.type = "button"; node.disabled = disabled || submitting || write && (!client.canMutate || client.uncertain);
    if (write) node.setAttribute("data-admin-write", "true"); node.addEventListener("click", action); return node;
  };
  const badge = (text, kind = "") => e("span", text, `badge ${kind}`);
  const navigationIcon = section => {
    const icon = e("span", null, "nav-icon"), svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", section === "settings" ? "M4 7h6m4 0h6M4 17h10m4 0h2M10 4v6m4 4v6"
      : section === 'payments' ? "M4 5h16v14H4zM4 9h16M8 14h3"
        : "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2ZM8 9h8M8 13h5");
    svg.append(path); icon.append(svg); return icon;
  };
  const facts = rows => {
    const list = e("dl", null, "facts");
    for (const [name, value] of rows) add(list, add(e("div", null, "fact"), e("dt", name), e("dd", value ?? "Не указано")));
    return list;
  };
  const field = (text, { name, value = "", options, textarea = false, required = false } = {}) => {
    const node = e("label", null, "field"), input = e(options ? "select" : textarea ? "textarea" : "input");
    input.name = name ?? ""; input.required = required;
    if (options) for (const [key, title] of Object.entries(options)) {
      const option = e("option", title); option.value = key; option.selected = key === String(value); input.append(option);
    } else { input.value = value ?? ""; if (!textarea) input.type = "text"; }
    add(node, e("span", text), input); return { node, input };
  };
  const setNotice = (text, status = "info") => { notice.textContent = text; notice.setAttribute("data-status", status); };
  const leaveReply = (continueAction, discardReply = false) => {
    const form = screen.querySelector('.admin-reply-composer') ?? screen.querySelector('.admin-confirm[data-action="support.reply"]');
    if (discardReply || !form?.querySelector("textarea")?.value.trim()) return false;
    screen.querySelector(".admin-draft-warning")?.remove();
    const warning = card("Ответ ещё не отправлен", p("При переходе набранный текст будет удалён. Продолжить без отправки?"));
    warning.classList.add("admin-draft-warning"); warning.setAttribute("role", "alert");
    add(warning, add(e("div", null, "actions"),
      button("Продолжить редактирование", () => { warning.remove(); form.querySelector("textarea")?.focus?.(); }, { primary: true }),
      button("Удалить текст и перейти", () => { warning.remove(); continueAction(); })));
    form.after(warning); warning.scrollIntoView?.({ block: "nearest" }); return true;
  };
  const finishLaunch = state => {
    document.documentElement.setAttribute("data-launch-state", state);
    document.getElementById("launch-screen")?.setAttribute("aria-hidden", "true");
  };
  const writeBanner = () => client.uncertain
    ? card(client.uncertainReason === "delivery_unknown" ? "Проверьте доставку ответа"
      : client.uncertainReason === 'payment_review_unknown' ? 'Платёж требует проверки' : "Проверьте последнее действие",
      p(client.uncertainReason === "delivery_unknown"
        ? "Ответ сохранён, но исход доставки неизвестен. Обновите историю и проверьте доставку в существующем боте поддержки. Не отправляйте тот же ответ повторно."
        : client.uncertainReason === 'payment_review_unknown'
          ? 'Результат по оплате пока не подтверждён. Обновите список и проверьте состояние. Повторная отправка отключена.'
        : "Ответ не получен. Действие могло выполниться. Обновите данные и проверьте результат. Для следующего изменения закройте кабинет и откройте его новой кнопкой в боте."),
      button("Обновить данные", () => refresh()))
    : !client.canMutate ? card("Просмотр данных", p("Изменения сейчас отключены. Все доступные списки можно просматривать и обновлять.")) : null;
  const drawNavigation = () => {
    nav.hidden = !admitted;
    if (!admitted || current.section === "settings") telegram?.BackButton?.hide?.();
    else telegram?.BackButton?.show?.();
    if (!admitted) { nav.replaceChildren(); return; }
    // Reuse controls so selection can crossfade inside each button instead of
    // remounting the whole row on every navigation or in-place refresh.
    const mounted = new Map([...nav.children].map(node => [node.getAttribute("data-section"), node]));
    for (const [section, text] of Object.entries(REMOTE_SECTIONS)) {
      let node = mounted.get(section);
      if (!node) {
        node = button(null, () => navigate(section)); add(node, navigationIcon(section), e("span", text)); node.setAttribute("data-section", section);
        nav.append(node);
      }
      node.disabled = submitting;
      if (section === current.section) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    }
  };
  const headline = section => add(e("div", null, "screen-head"), e("h2", SECTIONS[section]),
    button("Обновить", () => refresh(), { small: true }));
  const showFilters = data => {
    if (!FILTERS[data.section]) return;
    if (data.section === "support") {
      const filters = e("div", null, "admin-support-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Статус обращений");
      for (const [status, text] of Object.entries(FILTERS.support)) {
        const choice = button(text, () => navigate("support", { status, offset: 0 }), { small: true });
        choice.setAttribute("aria-pressed", String(status === (current.params.status ?? "open"))); filters.append(choice);
      }
      screen.append(filters); return;
    }
    const filter = field("Показать", { name: "status", options: FILTERS[data.section], value: current.params.status ?? DEFAULT_STATUS[data.section] });
    const query = data.section === "users" ? field("Telegram ID или username партнёра", { name: "query", value: current.params.query ?? "" }) : null;
    if (query) query.input.maxLength = 64;
    const form = add(e("form", null, "admin-filters"), filter.node, query?.node);
    const apply = e("button", "Показать", "button"); apply.type = "submit"; add(form, apply);
    form.addEventListener("submit", event => {
      event.preventDefault(); if (submitting) return;
      navigate(data.section, { status: filter.input.value, ...(query ? { query: query.input.value.trim() } : {}), offset: 0 });
    }); screen.append(form);
  };
  const paginate = data => {
    if (!data.total && !data.offset) return;
    add(screen, add(e("div", null, "admin-pagination"),
      button("Назад", () => navigate(data.section, { ...current.params, offset: Math.max(0, data.offset - data.limit) }), { small: true, disabled: data.offset === 0 }),
      p(data.items.length ? `${data.offset + 1}–${data.offset + data.items.length} из ${number(data.total)}` : `Всего ${number(data.total)}`),
      button("Далее", () => navigate(data.section, { ...current.params, offset: data.offset + data.limit }),
        { small: true, disabled: !data.hasMore || data.section === "support" && data.offset + data.limit > 1000 })));
  };
  const command = (row, options, { discardReply = false } = {}) => {
    const { title, description, submitText, action, target, payload, requireReason = false,
      reasonLabel = "Комментарий (необязательно)", includeReason = true, maxReasonLength = 500, minReasonLength = 0, successMessage = null,
      reasonOptions = null,
      simple = false, previewText = null, cancelText = "Отмена", onCancel = null, onCommitted = null } = options;
    if (submitting || !client.canMutate || client.uncertain) return;
    if (leaveReply(() => command(row, options, { discardReply: true }), discardReply)) return;
    row.querySelector(".admin-confirm")?.remove();
    const form = add(e("form", null, "admin-confirm"), e("h4", title), p(description)); form.setAttribute("data-action", action);
    const reason = field(reasonLabel, { name: "reason", textarea: !reasonOptions, options: reasonOptions ?? undefined, required: requireReason });
    reason.input.maxLength = maxReasonLength; reason.input.minLength = minReasonLength;
    const check = add(e("label", null, "check"), e("input"), e("span", "Подтверждаю это действие"));
    const consent = check.querySelector("input"); consent.type = "checkbox"; consent.required = !simple;
    const msg = p("", "form-message"); msg.setAttribute("role", "status");
    const submit = e("button", submitText, "button primary"); submit.type = "submit"; submit.setAttribute("data-admin-write", "true");
    let committed = false, invalidated = false;
    const sync = () => { submit.disabled = committed || invalidated || submitting || !client.canMutate || client.uncertain || !simple && !consent.checked
      || requireReason && Array.from(reason.input.value.trim()).length < Math.max(1, minReasonLength); };
    consent.addEventListener("change", sync); reason.input.addEventListener("input", sync); reason.input.addEventListener('change', sync);
    add(form, previewText === null ? null : p(previewText, "admin-send-preview"), includeReason ? reason.node : null, simple ? null : check, msg, add(e("div", null, "actions"), submit,
      button(cancelText, () => {
        if (submitting) return;
        if (simple) { form.remove(); onCancel?.(); return; }
        if (!leaveReply(() => form.remove(), action !== "support.reply")) form.remove();
      })));
    row.append(form); if (includeReason) reason.input.focus?.({ preventScroll: true });
    sync();
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (committed || invalidated || !form.isConnected || submitting || !client.canMutate || client.uncertain || !simple && !consent.checked
        || requireReason && Array.from(reason.input.value.trim()).length < Math.max(1, minReasonLength) || !form.reportValidity()) return;
      const localGeneration = generation;
      const controls = [...root.querySelectorAll("button,input,select,textarea")].map(node => [node, node.disabled]);
      submitting = true; for (const [node] of controls) node.disabled = true;
      submit.classList.add("is-loading"); submit.setAttribute("aria-busy", "true");
      msg.textContent = "Сохраняем…"; msg.setAttribute("data-status", "loading");
      try {
        const result = await client.mutate(action, payload(reason.input.value.trim()), target);
        if (disposed || generation !== localGeneration || !client.authenticated) return;
        committed = true; onCommitted?.(); setNotice(successMessage ? successMessage(result)
          : result.commitStatus === "unchanged" ? "✅ Данные уже сохранены." : "✅ Изменение сохранено.",
        client.uncertain || ['manual_review', 'unknown'].includes(result.status) || ["unknown", "failed"].includes(result.deliveryState)
          ? "error" : ["queued", "sending"].includes(result.deliveryState) ? "info" : "success");
        submitting = false;
        await refresh({ preserveNotice: true, discardReply: true });
      } catch (error) {
        if (disposed || generation !== localGeneration) return;
        msg.textContent = errorMessage(error); msg.setAttribute("data-status", "error");
        if (action.startsWith("offer.") && offerNeedsNewRead(error)) {
          invalidated = true; generation++; controller?.abort(); showOfferConflict();
        } else if (["setting.update", "support.reply", "support.close"].includes(action) && offerNeedsNewRead(error)) {
          invalidated = true; msg.textContent = "Данные изменились. Обновите экран и проверьте новое состояние перед действием.";
        } else if (client.uncertain || error.code === "outcome_unknown") {
          setNotice("Последнее действие могло выполниться. Обновите данные и проверьте результат; не отправляйте его повторно.", "error");
          screen.prepend(writeBanner());
        }
      } finally {
        submitting = false;
        for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled;
        submit.classList.remove("is-loading"); submit.setAttribute("aria-busy", "false"); sync();
        if (committed && form.isConnected) for (const node of form.querySelectorAll("button,input,textarea")) node.disabled = true;
        if (client.uncertain) for (const node of root.querySelectorAll('[data-admin-write="true"]')) node.disabled = true;
        drawNavigation();
      }
    });
  };
  const overview = data => {
    add(screen, add(e("div", null, "admin-intro"), p("Работа бота", "eyebrow"),
      p("Актуальные данные и очереди, которые требуют вашего решения.")));
    const stats = e("div", null, "admin-stats");
    for (const [key, text] of Object.entries({ users: "Пользователи", blockedUsers: "Заблокированы",
      pendingPartners: "Заявки партнёров", activePartners: "Активные партнёры", pendingOffers: "На модерации",
      approvedOffers: "Одобренные офферы", pendingLeads: "Ожидают результата", confirmedLeads: "Подтверждённые заявки" })) {
      add(stats, add(e("div", null, "stat"), e("span", number(data.counts?.[key]), "stat-value"), e("span", text, "stat-label")));
    }
    add(screen, stats, card("Очереди", p("Проверяйте заявки и условия офферов перед одобрением."),
      add(e("div", null, "actions"), button("Партнёрские заявки", () => navigate("partners")), button("Модерация офферов", () => navigate("offers")))));
    add(screen, card("Рабочий режим", facts([["Версия", data.release?.version ?? "Недоступно"],
      ["Режим", data.release?.mode === "owner_only" ? "Доступ только владельцу" : label(data.release?.mode)],
      ["Partner Beta", data.release?.partnerBetaEnabled === true ? "Включена" : data.release?.partnerBetaEnabled === false ? "Выключена" : "Недоступно"]]),
      p("Права администратора сохраняются за вашим аккаунтом. Если сессия завершится, откройте кабинет новой кнопкой в боте.")));
  };
  const partnerRow = item => {
    const row = card(item.displayName || `Заявка №${item.applicationId}`); row.classList.add("admin-row");
    add(row, add(e("div", null, "admin-row-meta"), badge(label(item.status), item.status === "pending" ? "warning" : item.status === "approved" ? "success" : ""),
      badge(`№${item.applicationId}`)), facts([["Контакт", item.contact || "Не указан"], ["18+", item.ageConfirmed === true ? "Подтверждено заявителем" : "Нет подтверждения"],
      ["Отправлена", date(item.createdAt)], ["Профиль", item.profileStatus ? label(item.profileStatus) : "Не создан"]]));
    if (item.status === "pending" && item.canReview === true) {
      const target = { applicationId: item.applicationId };
      add(row, add(e("div", null, "actions"),
        button("Одобрить", () => command(row, { title: "Одобрить заявку", description: `Партнёр: ${item.displayName || `заявка №${item.applicationId}`}. Одобрение создаёт партнёрский профиль; оно не заменяет проверку возраста или документов.`,
          submitText: "Подтвердить одобрение", action: "partner.review", target, payload: reason => ({ decision: "approve", ...(reason ? { reason } : {}) }) }), { primary: true, write: true, disabled: item.ageConfirmed !== true }),
        button("Отклонить", () => command(row, { title: "Отклонить заявку", description: `Укажите понятную причину для ${item.displayName || `заявки №${item.applicationId}`}.`,
          submitText: "Отклонить заявку", action: "partner.review", target, requireReason: true, reasonLabel: "Причина отклонения", payload: reason => ({ decision: "reject", reason }) }), { write: true })));
      if (item.ageConfirmed !== true) add(row, p("Одобрение недоступно: заявитель ещё не подтвердил возраст 18+."));
    } else if (item.status === "pending") {
      add(row, p("Рассмотрение этой заявки сейчас недоступно. Обновите данные или проверьте доступ; собственные защищённые заявки не рассматриваются через кабинет."));
    }
    return row;
  };
  const offerRow = item => {
    const row = card(item.title || `Оффер ${item.code}`); row.classList.add("admin-row");
    add(row, add(e("div", null, "admin-row-meta"), badge(label(item.moderationStatus), item.moderationStatus === "approved" ? "success" : item.moderationStatus === "pending" ? "warning" : ""), badge(label(item.visibility))),
      facts([["Партнёр", item.ownerName || "Системный оффер"], ["Источник", item.provider || "Не указан"],
        ["Код", item.code], ["Версия", number(item.version)], ["Состояние", label(item.businessStatus)], ["Обновлён", date(item.updatedAt)]]));
    add(row, button("Просмотреть условия", () => openOffer(item.code, item.expectedVersionId), { primary: true }),
      p("Решение доступно после просмотра полной выбранной версии."));
    return row;
  };
  const offerDetail = data => {
    const item = data.offer, target = { code: item.code }, expectedVersionId = item.expectedVersionId;
    add(screen, button("К офферам", () => navigate("offers", current.params), { small: true }));
    const row = card(item.title || `Оффер ${item.code}`); row.classList.add("admin-row", "admin-offer-detail");
    add(row, add(e("div", null, "admin-row-meta"), badge(label(item.moderationStatus), item.moderationStatus === "pending" ? "warning" : ""), badge(label(item.visibility))),
      facts([["Код", item.code], ["Версия", number(item.version)], ["Партнёр", item.ownerName || "Системный оффер"],
        ["Источник", item.provider || "Не указан"], ["Категория", item.category || "Не указана"], ["Состояние", label(item.businessStatus)]]));
    const textBlock = (title, value) => add(e("section", null, "admin-offer-text"), e("h4", title), p(value || "Не указано"));
    add(row, textBlock("Описание", item.description), textBlock("Вознаграждение", item.payoutText), textBlock("Необходимое действие", item.requiredAction),
      facts([["Минимальный возраст", item.minAge === null ? "Не указан" : `${item.minAge} лет`],
        ["Максимальный возраст", item.maxAge === null ? "Не указан" : `${item.maxAge} лет`], ["География", item.geo || "Не указана"],
        ["Холд", item.holdDays === null ? "Не указан" : `${item.holdDays} дн.`], ["Источники трафика", item.trafficSources || "Не указаны"],
        ["Название источника", item.sourceName || "Не указано"], ["Начало действия", offerDate(item.startsAt)], ["Окончание действия", offerDate(item.expiresAt)],
        ["Текст кнопки", item.buttonText || "Не указан"]]), p("Решение относится только к показанной версии. Если условия изменятся, потребуется заново открыть оффер."));
    const controls = e("div", null, "actions");
    if (item.moderationStatus === "pending" && item.canModerate === true) for (const [decision, text] of Object.entries({ approved: "Одобрить", changes_requested: "Вернуть на доработку", rejected: "Отклонить" })) {
      if (!item.allowedDecisions.includes(decision)) continue;
      add(controls, button(text, () => command(row, { title: text, description: `${item.title || item.code}, версия ${item.version}. Решение относится к этой версии оффера.`,
        submitText: decision === "approved" ? "Подтвердить одобрение" : text, action: "offer.moderation", target,
        requireReason: decision !== "approved", reasonLabel: decision === "approved" ? "Комментарий (необязательно)" : "Причина решения",
        payload: reason => ({ expectedVersionId, decision, ...(reason ? { reason } : {}) }) }), { write: true, primary: decision === "approved" }));
    }
    if (item.moderationStatus === "approved" && item.canChangeVisibility === true) for (const [visibility, text] of Object.entries({ public: "Опубликовать", private: "Скрыть из каталога" })) {
      if (item.visibility === visibility || visibility === "public" && item.publicVisibilityEnabled !== true) continue;
      add(controls, button(text, () => command(row, { title: text, description: visibility === "public"
        ? "Оффер станет доступен в общем каталоге при соблюдении его текущих условий и доступа." : "Оффер исчезнет из общего каталога. Сохранённые данные и история останутся.",
        submitText: "Подтвердить изменение", action: "offer.visibility", target,
        payload: reason => ({ expectedVersionId, visibility, ...(reason ? { reason } : {}) }) }), { write: true }));
    }
    if (controls.childNodes.length) row.append(controls);
    if (item.moderationStatus === "pending" && item.canModerate !== true) add(row,
      p("Решение по этой версии сейчас недоступно. Обновите очередь и проверьте доступ; собственные защищённые офферы не модерируются через кабинет."));
    if (item.moderationStatus === "approved" && item.canChangeVisibility !== true) add(row, p("Изменение видимости этой версии сейчас недоступно."));
    if (item.moderationStatus === "approved" && item.publicVisibilityEnabled !== true) add(row,
      p("Публикация в общий каталог отключена текущим режимом доступа. Условия и история доступны для просмотра."));
    if (!["pending", "approved"].includes(item.moderationStatus)) add(row, p(`Действия по этой версии сейчас недоступны: ${label(item.moderationStatus).toLowerCase()}.`));
    screen.append(row);
  };
  const userRow = item => {
    const row = card(item.username ? `@${item.username.replace(/^@/u, "")}` : `Пользователь ${item.telegramId}`); row.classList.add("admin-row");
    add(row, add(e("div", null, "admin-row-meta"), badge(item.isBlocked ? "Заблокирован" : "Доступ открыт", item.isBlocked ? "red" : "success"),
      Array.isArray(item.roles) && item.roles.includes("admin") ? badge("Администратор", "blue") : null), facts([["Telegram ID", item.telegramId], ["Дата регистрации", date(item.joinedAt)],
      ["Роли", Array.isArray(item.roles) ? item.roles.map(value => ({ user: "Пользователь", partner: "Партнёр", admin: "Администратор" })[value] ?? value).join(", ") : "Не указаны"],
      ["Тариф", ({ free: "Free", professional: "Professional", dragon: "Dragon" })[item.planCode] ?? "Требуется проверка"],
      ["Партнёрский профиль", label(item.partnerStatus)], ["Доставка сообщений", item.deliveryUnavailable ? "Недоступна" : "Доступна"]]),
      item.moderation?.reason ? p(`Причина ограничения: ${item.moderation.reason}`) : null);
    if (item.canModerate === true) {
      const action = item.isBlocked ? "unblock" : "block";
      add(row, button(item.isBlocked ? "Снять блокировку" : "Заблокировать", () => command(row, {
        title: item.isBlocked ? "Снять блокировку" : "Ограничить пользователя", description: `Telegram ID ${item.telegramId}. Решение будет сохранено в журнале модерации.`,
        submitText: item.isBlocked ? "Снять блокировку" : "Подтвердить блокировку", action: "user.moderation", target: { telegramId: item.telegramId },
        requireReason: true, reasonLabel: "Причина решения", minReasonLength: 3, maxReasonLength: 300,
        payload: reason => ({ action, reason, targetTelegramId: item.telegramId,
          expectedRevision: item.moderation?.revision ?? 0, confirmed: true }) }), { write: true }));
    } else add(row, p("Этот аккаунт защищён от изменения через кабинет или действие сейчас недоступно."));
    return row;
  };
  const journalRow = item => {
    const actions = { user_moderation_blocked: "Пользователь заблокирован", user_moderation_unblocked: "Блокировка снята",
      admin_runtime_setting_updated: "Настройка бота изменена", partner_beta_granted: "Выдан Partner Beta",
      partner_offer_created: "Создан партнёрский оффер", partner_offer_version_created: "Сохранена версия оффера" };
    const entities = { telegram_user: "Пользователь", runtime_setting: "Настройка", partner_application: "Заявка партнёра",
      partner_beta_access: "Partner Beta", offer: "Оффер" };
    const row = card(actions[item.action] ?? item.action ?? "Действие администратора"); row.classList.add("admin-row");
    add(row, facts([["Объект", [entities[item.entityType] ?? item.entityType, item.entityId].filter(value => value !== null && value !== undefined && value !== "").join(" · ") || "Не указан"],
      ["Кто", item.actorLabel || "Администратор"], ["Дата", date(item.createdAt)]])); return row;
  };
  const settingConfirmation = (row, item, value) => {
    if (value === item.value || !item.editable || !(item.allowedValues ?? []).includes(value)) return;
    command(row, { title: "Применить изменение?", description: `${SETTING_LABELS[item.key] ?? item.label ?? item.key}: ${settingValue(item.value)} → ${settingValue(value)}.`,
      submitText: "Применить", action: "setting.update", target: {}, includeReason: false, simple: true,
      payload: () => ({ action: "update_setting", key: item.key, value, expectedValue: item.value, confirmed: true }),
      successMessage: () => "✅ Настройка сохранена." });
  };
  const publicGateMessage = readiness => ({
    provider_unavailable: "Для режима «Всем» подключите провайдера RE AI.",
    no_active_programs: "Для режима «Всем» нужна активная программа.",
    sources_not_approved: "Для режима «Всем» подтвердите официальные источники активных программ.",
  })[readiness?.reasonCode] ?? "Готовность режима «Всем» пока не подтверждена.";
  const settings = data => {
    const mode = data.items?.find(item => item.key === "ai_rollout_mode");
    if (mode) {
      const row = card("RE AI", p(`Сейчас: ${settingValue(mode.value)}`, "admin-setting-description"));
      row.classList.add("admin-control-card", "admin-setting");
      const choices = e("div", null, "admin-ai-modes"); choices.setAttribute("role", "group"); choices.setAttribute("aria-label", "Доступ к RE AI");
      for (const value of ["off", "admin", "all"]) {
        const choice = button(settingValue(value), () => {
          if (value === "all" && data.publicEnablement?.ready !== true && value !== mode.value) return;
          settingConfirmation(row, mode, value);
        }, { write: true, disabled: !mode.editable || !(mode.allowedValues ?? []).includes(value)
          || value === mode.value || value === "all" && data.publicEnablement?.ready !== true && value !== mode.value });
        choice.setAttribute("aria-pressed", String(value === mode.value)); choice.setAttribute("data-ai-mode", value); choices.append(choice);
      }
      add(row, choices, p(aiModeDescription(mode.value), "admin-setting-description admin-ai-explanation"));
      if (data.publicEnablement?.ready !== true) add(row, p(publicGateMessage(data.publicEnablement), "admin-setting-description"));
      if (!mode.editable) add(row, p("Изменения сейчас недоступны."));
      screen.append(row);
    } else add(screen, card("RE AI", p("Не удалось получить текущее значение. Обновите данные.")));
    const switchRow = item => {
      const row = e("section", null, "card admin-control-card admin-setting"), line = e("label", null, "admin-switch-row");
      const copy = add(e("span"), e("strong", SETTING_LABELS[item.key] ?? item.label ?? item.key),
        p(settingValue(item.value), "admin-setting-description"));
      const input = e("input", null, "admin-switch"); input.type = "checkbox"; input.checked = item.value === true;
      input.name = item.key; input.setAttribute("data-admin-write", "true");
      input.disabled = submitting || !item.editable || !client.canMutate || client.uncertain;
      input.addEventListener("change", () => {
        const value = input.checked; input.checked = item.value === true;
        if (!input.disabled) settingConfirmation(row, item, value);
      });
      add(line, copy, input); add(row, line); return row;
    };
    const web = data.items?.find(item => item.key === "official_web_enabled");
    if (web) screen.append(switchRow(web));
    const stale = data.items?.find(item => item.key === "official_web_stale_enabled");
    if (stale) {
      const extra = add(e("details", null, "admin-extra-settings"), e("summary", "Дополнительно"));
      add(extra, switchRow(stale), p("Разрешает использовать сохранённые результаты, если источник временно недоступен.", "admin-setting-description")); screen.append(extra);
    }
    const version = releaseInfo?.version ?? "Версия недоступна";
    const beta = releaseInfo?.partnerBetaEnabled === true ? "Beta включена" : releaseInfo?.partnerBetaEnabled === false ? "Beta выключена" : "Статус Beta недоступен";
    add(screen, p(`${version} · ${beta} · ${releaseInfo?.mode === "owner_only" ? "Только владелец" : "Доступ владельца"}`, "admin-remote-footer"));
  };
  const support = data => {
    if (data.available === false) {
      add(screen, card("Поддержка недоступна", p(data.message || "Не удалось получить обращения. Обновите данные позже."))); return;
    }
    renderList(data, item => {
      const row = button(null, () => openTicket(item.ticketId)); row.classList.add("admin-ticket-card"); row.setAttribute("data-ticket-id", String(item.ticketId));
      row.setAttribute("aria-label", `Открыть обращение №${item.ticketId} от ${item.userLabel || "пользователя"}`);
      add(row, add(e("span", null, "admin-ticket-card-main"), e("strong", item.userLabel || "Пользователь"),
        e("span", `${item.username ? `@${item.username} · ` : ""}№${item.ticketId} · ${date(item.updatedAt)}`, "admin-message-meta")),
        badge(item.pendingMessages > 0 ? `${number(item.pendingMessages)} без ответа` : label(item.status), item.pendingMessages > 0 ? "warning" : ""));
      return row;
    });
  };
  const replyReceiptMessage = result => result.deliveryState === "sent" ? "✅ Ответ доставлен."
    : result.deliveryState === "failed" ? "Ответ сохранён, но не доставлен. Проверьте статус в боте поддержки."
      : result.deliveryState === "unknown" ? "Ответ сохранён; исход доставки неизвестен. Не повторяйте ответ — проверьте доставку в боте поддержки."
        : result.deliveryState === "sending" ? "Ответ принят. Отправляется; доставка ещё не подтверждена."
          : "Ответ принят в очередь. Доставка ещё не подтверждена.";
  const supportDetail = data => {
    const ticket = data.ticket;
    const toolbar = add(e("div", null, "admin-ticket-toolbar"), button("К обращениям", () => navigate("support", current.params), { small: true }),
      button("Обновить", () => refresh(), { small: true }));
    const header = add(e("div", null, "admin-ticket-header"),
      e("h3", `${ticket.userLabel || "Пользователь"} · №${ticket.ticketId}`),
      badge(label(ticket.status), ticket.status === "open" ? "warning" : ""));
    add(screen, toolbar, header);
    const thread = e("div", null, "admin-ticket-thread"); thread.setAttribute("aria-label", "История обращения");
    for (const message of [...data.messages].sort((a, b) => a.messageId - b.messageId)) {
      const outgoing = message.direction === "staff";
      const row = e("article", null, "admin-message"); row.setAttribute("data-author", outgoing ? "admin" : "user");
      add(row, e("span", `${outgoing ? "Вы" : ticket.userLabel || "Пользователь"} · ${date(message.createdAt)}`, "admin-message-meta"),
        p(message.text || (message.hasPhoto ? "Фотография" : "Сообщение без текста")), message.hasPhoto ? badge("Есть фото") : null);
      if (message.hasPhoto) {
        const link = e("a", "Перейти в бот поддержки"); link.href = "https://t.me/RE_Program_Support_Bot";
        link.target = "_blank"; link.rel = "noopener noreferrer"; add(row, link);
      }
      if (outgoing && message.deliveryState) add(row, badge(({ queued: "В очереди на отправку", sending: "Отправляется",
        sent: "Доставлено", failed: "Не доставлено", unknown: "Доставка не подтверждена" })[message.deliveryState] ?? "Статус доставки неизвестен",
      message.deliveryState === "sent" ? "success" : message.deliveryState === "failed" ? "red" : "warning"));
      thread.append(row);
    }
    add(screen, thread.childNodes.length ? thread : card("История пуста", p("Сообщений в этой части обращения нет.")));
    const history = e("div", null, "actions");
    if (data.hasMore && Number.isSafeInteger(data.before) && data.before > 0) add(history,
      button("Предыдущие сообщения", () => openTicket(ticket.ticketId, data.before), { small: true }));
    if (current.ticket?.beforeMessageId) add(history, button("К последним сообщениям", () => openTicket(ticket.ticketId), { small: true }));
    if (history.childNodes.length) screen.append(history);
    const target = { ticketId: ticket.ticketId }, expectedLastMessageId = ticket.lastMessageId ?? null;
    const canReply = ticket.canReply === true, canClose = ticket.canClose === true;
    if (canReply) {
      const composer = e("section", null, "card admin-reply-composer");
      const draft = field("Ваш ответ", { name: "support_reply", textarea: true, required: true }); draft.input.maxLength = 2000;
      draft.input.placeholder = "Напишите ответ пользователю…";
      draft.input.disabled = submitting || !client.canMutate || client.uncertain;
      const count = p("0 / 2000", "admin-reply-meta"), send = button("Отправить", () => {
        const text = draft.input.value.trim();
        if (!text || text.length > 2000 || send.disabled) return;
        draft.input.disabled = true; send.disabled = true;
        command(composer, { title: "Отправить ответ?", description: `${ticket.userLabel || "Пользователь"} · обращение №${ticket.ticketId}`,
          submitText: "Отправить пользователю", action: "support.reply", target, includeReason: false, simple: true, previewText: text,
          cancelText: "Изменить", onCancel: () => { draft.input.disabled = !client.canMutate || client.uncertain; sync(); draft.input.focus?.(); },
          onCommitted: () => { draft.input.value = ""; }, payload: () => ({ text, expectedLastMessageId }), successMessage: replyReceiptMessage }, { discardReply: true });
      }, { primary: true, write: true, disabled: true });
      const sync = () => {
        count.textContent = `${draft.input.value.length} / 2000`;
        send.disabled = submitting || !client.canMutate || client.uncertain || !draft.input.value.trim() || draft.input.value.trim().length > 2000
          || Boolean(composer.querySelector(".admin-confirm"));
      };
      draft.input.addEventListener("input", sync);
      add(composer, draft.node, add(e("div", null, "admin-reply-actions"), count, send)); screen.append(composer);
    }
    const controls = e("section", null, "admin-ticket-actions");
    if (canClose) add(controls, button("Закрыть обращение", () => command(controls, { title: "Закрыть обращение?",
      description: `Обращение №${ticket.ticketId} будет закрыто. История сохранится.`, submitText: "Закрыть", simple: true,
      action: "support.close", target, includeReason: false, payload: () => ({ expectedLastMessageId }), successMessage: () => "✅ Обращение закрыто." }), { write: true }));
    if (!canReply) add(controls, p(ticket.status === "closed" ? "Обращение закрыто. История доступна для просмотра."
      : "Ответ сейчас недоступен. Обновите историю и проверьте доставку предыдущего ответа в боте поддержки."));
    if (controls.childNodes.length) screen.append(controls);
  };
  const renderList = (data, makeRow) => {
    showFilters(data);
    const list = e("div", null, "admin-list");
    if (!data.items.length) add(list, card("Список пуст", p("В выбранном разделе сейчас нет записей. Можно изменить фильтр или обновить данные.")));
    else for (const item of data.items) list.append(makeRow(item));
    add(screen, list); paginate(data);
  };
  const paymentRow = item => {
    const plan = item.planCode === 'dragon' ? 'Dragon' : 'Professional';
    const row = card(`${plan} · ${number(item.amountStars)} Stars`);
    row.classList.add('admin-payment-card'); row.setAttribute('data-payment-id', item.ledgerEntryId);
    add(row, add(e('div', null, 'admin-row-meta'), badge(PAYMENT_STATUS[item.status],
      item.status === 'applied' ? 'success' : ['pending_review', 'pending', 'unknown'].includes(item.status) ? 'warning' : ''),
      p(`Пользователь ${item.telegramId}`, 'admin-payment-user')));
    const detail = e('details', null, 'admin-payment-detail');
    add(detail, e('summary', 'Детали оплаты'), facts([
      ['Получено', date(item.recordedAt)], ['Тип оплаты', item.startsAt === null ? 'Разовая' : 'Ежемесячная'],
      ...(item.startsAt === null ? [] : [['Начало периода', date(item.startsAt)], ['Окончание периода', date(item.endsAt)]]),
      ['Причина проверки', PAYMENT_REASON[item.reasonCode] ?? 'Нужно проверить результат оплаты'],
      ['Номер записи', item.ledgerEntryId],
    ]));
    const uncertain = ['pending', 'unknown'].includes(item.status);
    if (uncertain) add(detail, p('Результат пока не подтверждён. Повторная отправка отключена; обновите список и проверьте оплату.'));
    else if (['refunded', 'chargeback'].includes(item.status)) add(detail, p(item.status === 'refunded'
      ? 'Возврат сохранён. История оплаты остаётся доступной.' : 'По оплате зафиксирован спор. История сохранена; выдача доступа здесь недоступна.'));
    else {
      const controls = e('div', null, 'actions');
      for (const action of item.status === 'pending_review' ? ['apply', 'refund'] : ['refund']) {
        const apply = action === 'apply';
        add(controls, button(apply ? 'Выдать доступ' : 'Вернуть Stars', () => command(row, {
          title: apply ? 'Выдать доступ по оплате?' : 'Вернуть эту оплату?',
          description: `${plan} · ${number(item.amountStars)} Stars · пользователь ${item.telegramId}. ` + (apply
            ? 'Будет использована сохранённая оплата и её срок. Проверьте детали перед подтверждением.'
            : 'Возврат относится только к этой оплате. Её оплаченный доступ завершится; другие оплаты сохраняются.'),
          submitText: apply ? 'Выдать доступ' : 'Вернуть Stars',
          action: `subscription.review.${action}`, target: { ledgerEntryId: item.ledgerEntryId }, requireReason: true,
          reasonLabel: 'Причина решения', reasonOptions: { '': 'Выберите причину', ...(apply
            ? { owner_payment_confirmed: 'Оплата подтверждена', owner_access_recovered: 'Восстановление доступа после проверки' }
            : { owner_refund_requested: 'Возврат по обращению пользователя', owner_duplicate_payment: 'Повторная оплата' }),
            owner_support_resolution: 'Решение по обращению' },
          payload: reasonCode => ({ reasonCode }), successMessage: result =>
            ['manual_review', 'unknown', 'pending', 'attempted', 'admitted'].includes(result.status)
              ? 'Результат пока не подтверждён. Проверьте состояние оплаты; повторная отправка отключена.'
              : apply ? result.accessApplied ? '✅ Доступ выдан по сохранённой оплате.' : 'Оплата уже обработана. Проверьте её состояние.'
                : result.refunded ? '✅ Возврат подтверждён.' : 'Результат возврата пока не подтверждён.',
        }), { primary: apply, write: true }));
      }
      add(detail, controls);
    }
    row.append(detail); return row;
  };
  const payments = data => {
    add(screen, p('Сохранённые оплаты, которым потребовалась проверка. Сумма, пользователь и срок берутся из оплаты.'),
      p(`Показано записей: ${number(data.items.length)}${data.hasMore ? '. Есть более ранние записи; их история сохранена.' : '.'}`, 'admin-payment-count'));
    const list = e('div', null, 'admin-list');
    if (!data.items.length) add(list, card('Оплат на проверке нет', p('Новые записи появятся здесь, если оплату не удалось безопасно применить.')));
    else for (const item of data.items) list.append(paymentRow(item));
    screen.append(list);
  };
  const render = data => {
    const isSupportDetail = data.section === "support" && Boolean(data.ticket);
    screen.classList.toggle("admin-support-detail", isSupportDetail);
    screen.replaceChildren(...[isSupportDetail ? null : headline(data.section), writeBanner()].filter(Boolean));
    if (data.section === "overview") overview(data);
    else if (data.section === "settings") settings(data);
    else if (data.section === "offers" && data.offer) offerDetail(data);
    else if (data.section === "support") data.ticket ? supportDetail(data) : support(data);
    else if (data.section === 'payments') payments(data);
    else renderList(data, { partners: partnerRow, offers: offerRow, users: userRow, journal: journalRow }[data.section]);
    screen.setAttribute("aria-busy", "false"); screen.focus?.({ preventScroll: true });
  };
  async function navigate(section, params = {}, { preserveNotice = false, discardReply = false } = {}) {
    if (disposed || submitting || !Object.hasOwn(SECTIONS, section)) return;
    if (leaveReply(() => navigate(section, params, { preserveNotice, discardReply: true }), discardReply)) return;
    const localGeneration = ++generation; controller?.abort(); controller = new AbortController();
    current = { section, params: ["overview", "settings", 'payments'].includes(section) ? {} : { limit: section === "support" ? 25 : 20, offset: 0,
      ...(DEFAULT_STATUS[section] ? { status: DEFAULT_STATUS[section] } : {}), ...params } };
    if (!preserveNotice && !client.uncertain) setNotice(""); drawNavigation();
    screen.setAttribute("aria-busy", "true");
    screen.replaceChildren(add(e("div", null, "loading"), p(`Открываем раздел «${SECTIONS[section]}»…`), e("div", null, "loading-line")));
    try {
      const data = section === "settings"
        ? await Promise.all([client.read("overview", {}, { signal: controller.signal }), client.read(section, current.params, { signal: controller.signal })])
          .then(([overview, settings]) => { if (!disposed && generation === localGeneration && client.authenticated) releaseInfo = overview.release ?? null; return settings; })
        : section === 'payments' ? { ...await client.readSubscriptionReview({}, { signal: controller.signal }), section: 'payments' }
          : await client.read(section, current.params, { signal: controller.signal });
      if (disposed || generation !== localGeneration || !client.authenticated) return;
      if (!admitted) { admitted = true; drawNavigation(); }
      render(data); finishLaunch("ready");
    } catch (error) {
      if (disposed || generation !== localGeneration) return;
      if (!client.authenticated) { expire(); return; }
      screen.setAttribute("aria-busy", "false");
      screen.replaceChildren(card("Не удалось загрузить раздел", p(errorMessage(error)),
        button("Повторить загрузку", () => navigate(section, current.params, { preserveNotice: true }))));
      finishLaunch("error");
    }
  }
  async function openTicket(ticketId, beforeMessageId, { preserveNotice = false, discardReply = false } = {}) {
    if (disposed || submitting) return;
    if (leaveReply(() => openTicket(ticketId, beforeMessageId, { preserveNotice, discardReply: true }), discardReply)) return;
    const localGeneration = ++generation; controller?.abort(); controller = new AbortController();
    const params = current.section === "support" ? current.params : { limit: 25, offset: 0, status: "open" };
    current = { section: "support", params, ticket: { ticketId, beforeMessageId } };
    if (!preserveNotice && !client.uncertain) setNotice(""); drawNavigation();
    screen.setAttribute("aria-busy", "true"); screen.replaceChildren(add(e("div", null, "loading"), p("Открываем историю обращения…")));
    try {
      const data = await client.readTicket(ticketId, { limit: 25, ...(beforeMessageId ? { beforeMessageId } : {}) }, { signal: controller.signal });
      if (disposed || generation !== localGeneration || !client.authenticated) return;
      render(data); finishLaunch("ready");
    } catch (error) {
      if (disposed || generation !== localGeneration) return;
      if (!client.authenticated) { expire(); return; }
      screen.setAttribute("aria-busy", "false"); screen.replaceChildren(card("Не удалось открыть обращение", p(errorMessage(error)),
        button("Обновить историю", () => openTicket(ticketId, beforeMessageId, { preserveNotice: true })),
        button("К обращениям", () => navigate("support", params)))); finishLaunch("error");
    }
  }
  function showOfferConflict() {
    if (current.offer) current.offer.invalidated = true;
    screen.setAttribute("aria-busy", "false"); screen.replaceChildren(card("Версия оффера изменилась",
      p("Условия или доступ изменились. Старое решение не отправляется повторно. Обновите очередь и заново откройте выбранную версию перед решением."),
      button("Обновить очередь", () => navigate("offers", current.params), { primary: true })));
    setNotice("Нужен новый просмотр актуальной версии оффера.", "error"); finishLaunch("error");
  }
  async function openOffer(code, expectedVersionId, { preserveNotice = false, discardReply = false } = {}) {
    if (disposed || submitting) return;
    if (leaveReply(() => openOffer(code, expectedVersionId, { preserveNotice, discardReply: true }), discardReply)) return;
    const localGeneration = ++generation; controller?.abort(); controller = new AbortController();
    const params = current.section === "offers" ? current.params : { limit: 20, offset: 0, status: "pending" };
    current = { section: "offers", params, offer: { code, expectedVersionId } };
    if (!preserveNotice && !client.uncertain) setNotice(""); drawNavigation();
    screen.setAttribute("aria-busy", "true"); screen.replaceChildren(
      button("К офферам", () => navigate("offers", params), { small: true }),
      add(e("div", null, "loading"), p("Открываем полные условия выбранной версии…")));
    try {
      const data = await client.readOffer(code, expectedVersionId, { signal: controller.signal });
      if (disposed || generation !== localGeneration || !client.authenticated) return;
      render(data); finishLaunch("ready");
    } catch (error) {
      if (disposed || generation !== localGeneration) return;
      if (!client.authenticated) { expire(); return; }
      if (offerNeedsNewRead(error)) { showOfferConflict(); return; }
      screen.setAttribute("aria-busy", "false"); screen.replaceChildren(card("Не удалось открыть условия оффера", p(errorMessage(error)),
        button("Повторить загрузку условий", () => openOffer(code, expectedVersionId, { preserveNotice: true })),
        button("К офферам", () => navigate("offers", params)))); finishLaunch("error");
    }
  }
  const refresh = options => current.ticket
    ? openTicket(current.ticket.ticketId, current.ticket.beforeMessageId, options)
    : current.offer && !current.offer.invalidated ? openOffer(current.offer.code, current.offer.expectedVersionId, options)
      : navigate(current.section, current.params, options);
  function expire() {
    if (disposed) return;
    generation++; controller?.abort(); clearTimeout(expiryTimer); admitted = false; current = { section: "settings", params: {} }; releaseInfo = null;
    client.clearSession(); drawNavigation(); setNotice(""); sessionStatus.textContent = "Сессия завершилась";
    screen.setAttribute("aria-busy", "false"); screen.replaceChildren(card("Сессия завершилась",
      p("Закройте кабинет и откройте его новой кнопкой в админском меню Telegram-бота. Ваши права администратора сохраняются."),
      client.uncertain ? p("Последнее действие могло выполниться. После открытия проверьте результат перед повторной отправкой.") : null));
    finishLaunch("error");
  }
  const visibility = () => { if (!document.hidden && admitted && !client.authenticated) expire(); };
  document.addEventListener("visibilitychange", visibility);
  const back = () => { if (!submitting) navigate(current.ticket ? "support" : current.offer ? "offers" : "settings",
    current.ticket || current.offer ? current.params : {}); };
  telegram?.BackButton?.onClick?.(back);
  return {
    async start() {
      await navigate("settings");
      if (!disposed && admitted && client.authenticated) {
        sessionStatus.textContent = "Защищённая сессия активна";
        clearTimeout(expiryTimer); expiryTimer = setTimeout(expire, Math.max(0, client.expiresAt * 1000 - Date.now()));
      }
    }, navigate, expire,
    showError(error) {
      if (disposed) return;
      generation++; controller?.abort(); clearTimeout(expiryTimer); admitted = false; current = { section: "settings", params: {} }; releaseInfo = null; client.clearSession(); drawNavigation(); setNotice("");
      screen.setAttribute("aria-busy", "false"); screen.replaceChildren(card("Кабинет недоступен", p(errorMessage(error)))); finishLaunch("error");
    },
    destroy() {
      disposed = true; generation++; controller?.abort(); clearTimeout(expiryTimer); admitted = false; current = { section: "settings", params: {} }; releaseInfo = null; client.clearSession();
      nav.replaceChildren(); nav.hidden = true; screen.replaceChildren(); setNotice("");
      document.removeEventListener("visibilitychange", visibility); telegram?.BackButton?.offClick?.(back); telegram?.BackButton?.hide?.();
    },
  };
}
