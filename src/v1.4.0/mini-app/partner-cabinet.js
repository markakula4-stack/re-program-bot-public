(function () {
  "use strict";

  var ROUTES = {
    home: "/api/v1.4.0/cabinet/bootstrap",
    profile: "/api/v1.4.0/cabinet/profile",
    offers: "/api/v1.4.0/cabinet/offers",
    applications: "/api/v1.4.0/cabinet/applications",
    results: "/api/v1.4.0/cabinet/results"
  };
  var RECOVERY_KEY = "re-program-cabinet-v1-recovery";
  var webApp = window.Telegram && window.Telegram.WebApp;
  var screen = document.getElementById("screen");
  var status = document.getElementById("status");
  var recoveryBanner = document.getElementById("recovery-banner");
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-screen]"));
  var sessionToken = null;
  var ownerBindingHash = null;
  var currentScreen = "home";

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setStatus(message) {
    status.textContent = message || "";
  }

  function setBusy(busy) {
    screen.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function setActiveTab(name) {
    tabs.forEach(function (button) {
      if (button.dataset.screen === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  function row(label, value) {
    var line = element("div", "row");
    line.append(element("span", "", label), element("strong", "", value));
    return line;
  }

  function card(title, subtitle) {
    var wrapper = element("article", "card");
    var head = element("div", "card-head");
    var copy = element("div");
    copy.append(element("h2", "", title));
    if (subtitle) copy.append(element("p", "muted", subtitle));
    head.append(copy);
    wrapper.append(head);
    return wrapper;
  }

  function badge(text) {
    return element("span", "badge", text);
  }

  function titleCase(value) {
    return String(value || "—").replace(/_/g, " ");
  }

  function formatTime(value) {
    if (!Number.isSafeInteger(value) || value <= 0) return "—";
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value * 1000));
  }

  function renderProfile(profile, heading) {
    var wrapper = card(heading || "Профиль", profile.dragonPreview ? "Dragon Preview" : titleCase(profile.planCode));
    var head = wrapper.querySelector(".card-head");
    head.append(badge(String(profile.capacityPercent) + "%"));
    var rows = element("div", "rows");
    rows.append(
      row("Специализация", titleCase(profile.specialization)),
      row("Юридический профиль", titleCase(profile.legalProfile)),
      row("Доступ", titleCase(profile.accessState)),
      row("Активных заявок до", profile.activeApplicationsLimit),
      row("Действует до", formatTime(profile.accessExpiresAt))
    );
    wrapper.append(rows);
    return wrapper;
  }

  function renderHome(data) {
    var fragment = document.createDocumentFragment();
    fragment.append(renderProfile(data.profile, "Ваш доступ"));
    var metrics = element("section", "metrics");
    [[data.counts.offers, "офферов"], [data.counts.activeApplications, "активных заявок"], [data.counts.results, "результатов"]].forEach(function (entry) {
      var metric = element("div", "metric");
      metric.append(element("strong", "", entry[0]), element("span", "", entry[1]));
      metrics.append(metric);
    });
    fragment.append(metrics);
    return fragment;
  }

  function renderOffers(data) {
    var fragment = document.createDocumentFragment();
    data.items.forEach(function (item) {
      var wrapper = card(item.title || item.offerCode, item.provider || item.offerCode);
      wrapper.querySelector(".card-head").append(badge(titleCase(item.moderationStatus)));
      if (item.description) wrapper.append(element("p", "description", item.description));
      var rows = element("div", "rows");
      rows.append(
        row("Категория", item.category || "—"),
        row("Видимость", titleCase(item.visibility)),
        row("Выплата", item.payoutText || "—"),
        row("Медиа", item.mediaCount)
      );
      wrapper.append(rows);
      fragment.append(wrapper);
    });
    return fragment;
  }

  function renderApplications(data, resultsOnly) {
    var fragment = document.createDocumentFragment();
    data.items.forEach(function (item) {
      var resultText = item.result ? titleCase(item.result.resultCode) : "Без результата";
      var wrapper = card(item.offerCode, resultsOnly ? resultText : titleCase(item.currentStatus));
      wrapper.querySelector(".card-head").append(badge(item.active ? "active" : "closed"));
      var rows = element("div", "rows");
      rows.append(
        row("Статус", titleCase(item.currentStatus)),
        row("Результат", resultText),
        row("Создана", formatTime(item.createdAt))
      );
      wrapper.append(rows);
      var open = element("button", "application-link", "Открыть заявку");
      open.type = "button";
      open.addEventListener("click", function () { loadDetail(item.applicationId); });
      wrapper.append(open);
      fragment.append(wrapper);
    });
    return fragment;
  }

  function renderDetail(data) {
    var detail = data.detail;
    var fragment = document.createDocumentFragment();
    var wrapper = card("Заявка", titleCase(detail.application.currentStatus));
    var rows = element("div", "rows");
    rows.append(
      row("ID", detail.application.applicationId),
      row("Статус", titleCase(detail.application.currentStatus)),
      row("Ревизия", detail.application.revision),
      row("Контакт", detail.contact ? detail.contact.value : "—"),
      row("Результат", detail.result ? titleCase(detail.result.resultCode) : "—")
    );
    wrapper.append(rows);
    fragment.append(wrapper);
    if (detail.notes.length) {
      var notes = card("Заметки");
      detail.notes.forEach(function (note) {
        notes.append(element("p", "description", note.note));
      });
      fragment.append(notes);
    }
    return fragment;
  }

  function render(data, append) {
    if (!data || data.contractVersion !== 1 || data.actionsEnabled !== false) throw new Error("invalid_response");
    var content;
    if (data.screen === "home") content = renderHome(data);
    else if (data.screen === "profile") content = renderProfile(data.profile);
    else if (data.screen === "offers") content = renderOffers(data);
    else if (data.screen === "applications") content = renderApplications(data, false);
    else if (data.screen === "results") content = renderApplications(data, true);
    else if (data.screen === "application_detail") content = renderDetail(data);
    else throw new Error("invalid_response");
    if (!append) screen.replaceChildren();
    if (data.items && data.items.length === 0 && !append) {
      screen.append(element("div", "empty", "Здесь пока ничего нет"));
    } else {
      screen.append(content);
    }
    if (data.nextCursor && data.mode === "live") {
      var more = element("button", "more", "Показать ещё");
      more.type = "button";
      more.addEventListener("click", function () {
        more.remove();
        load(data.screen, data.nextCursor, true);
      });
      screen.append(more);
    }
    recoveryBanner.hidden = data.mode !== "read_only_recovery";
    setBusy(false);
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      var output = {};
      Object.keys(value).sort().forEach(function (key) { output[key] = canonical(value[key]); });
      return output;
    }
    return value;
  }

  async function sha256(value) {
    var bytes = new TextEncoder().encode(value);
    var digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function saveRecovery(snapshot) {
    if (!snapshot || snapshot.snapshotVersion !== 1 || snapshot.screen === "application_detail") return;
    try {
      var cache = JSON.parse(sessionStorage.getItem(RECOVERY_KEY) || "{}");
      cache[snapshot.screen] = snapshot;
      sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(cache));
    } catch (_) {}
  }

  async function restoreRecovery(name) {
    try {
      var cache = JSON.parse(sessionStorage.getItem(RECOVERY_KEY) || "{}");
      var snapshot = cache[name];
      var now = Math.floor(Date.now() / 1000);
      if (!snapshot || snapshot.snapshotVersion !== 1 || !ownerBindingHash ||
          snapshot.ownerBindingHash !== ownerBindingHash || snapshot.screen !== name ||
          !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt > now ||
          snapshot.expiresAt !== snapshot.createdAt + 900 || snapshot.expiresAt <= now ||
          snapshot.payload.screen !== name || snapshot.payload.actionsEnabled !== false ||
          snapshot.payloadHash !== await sha256(JSON.stringify(canonical(snapshot.payload)))) return null;
      var recovered = Object.assign({}, snapshot.payload, {
        mode: "read_only_recovery",
        actionsEnabled: false,
        stale: true,
        nextCursor: null
      });
      return recovered;
    } catch (_) {
      return null;
    }
  }

  async function request(path, options) {
    var init = options || {};
    init.headers = Object.assign({ "Accept": "application/json" }, init.headers || {});
    if (sessionToken) init.headers.Authorization = "Bearer " + sessionToken;
    var response = await fetch(path, init);
    var payload = await response.json().catch(function () { return null; });
    if (!response.ok || !payload || payload.ok !== true) throw new Error("request_failed");
    return payload;
  }

  async function establishSession() {
    if (!webApp || typeof webApp.initData !== "string" || webApp.initData.length < 16) {
      throw new Error("telegram_required");
    }
    var payload = await request("/api/v1.4.0/cabinet/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: webApp.initData })
    });
    if (typeof payload.sessionToken !== "string" || payload.sessionToken.indexOf("cbs1_") !== 0 ||
        typeof payload.ownerBindingHash !== "string") throw new Error("invalid_session");
    sessionToken = payload.sessionToken;
    ownerBindingHash = payload.ownerBindingHash;
  }

  async function load(name, cursor, append) {
    if (!ROUTES[name]) return;
    currentScreen = name;
    setActiveTab(name);
    setBusy(true);
    setStatus("Загружаем только ваши данные…");
    var path = ROUTES[name] + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "");
    try {
      var payload = await request(path);
      render(payload.data, Boolean(append));
      saveRecovery(payload.recoverySnapshot);
      setStatus("Данные проверены сервером");
    } catch (_) {
      var recovered = append ? null : await restoreRecovery(name);
      if (recovered) {
        render(recovered, false);
        setStatus("Сеть недоступна · показана read-only копия");
      } else {
        setBusy(false);
        screen.replaceChildren(element("div", "empty", "Не удалось загрузить данные. Откройте кабинет заново из бота."));
        setStatus("Доступ закрыт безопасно");
      }
    }
  }

  async function loadDetail(applicationId) {
    if (!/^app_[0-9a-f]{64}$/.test(applicationId)) return;
    currentScreen = "application_detail";
    setActiveTab("");
    setBusy(true);
    setStatus("Открываем заявку…");
    try {
      var payload = await request("/api/v1.4.0/cabinet/applications/" + applicationId);
      render(payload.data, false);
      setStatus("Приватные поля не сохраняются для recovery");
    } catch (_) {
      setBusy(false);
      screen.replaceChildren(element("div", "empty", "Заявка недоступна"));
      setStatus("Доступ закрыт безопасно");
    }
  }

  tabs.forEach(function (button) {
    button.addEventListener("click", function () { load(button.dataset.screen); });
  });

  if (webApp) {
    try {
      webApp.ready();
      webApp.expand();
      webApp.setHeaderColor("secondary_bg_color");
      webApp.setBackgroundColor("bg_color");
      if (webApp.BackButton) {
        webApp.BackButton.onClick(function () {
          if (currentScreen === "home") webApp.close();
          else load("home");
        });
      }
    } catch (_) {}
  }

  establishSession().then(function () {
    return load("home");
  }).catch(function () {
    setBusy(false);
    screen.replaceChildren(element("div", "empty", "Откройте кабинет кнопкой внутри @RE_Program_Bot"));
    setStatus("Telegram-сессия не подтверждена");
  });
})();
