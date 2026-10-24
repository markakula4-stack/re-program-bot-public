import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { AdminClient, buildAdminReadPath, buildAdminOfferReadPath, buildAdminActionRequest } from "../src/v1.4.0-rebuild/mini-app/admin-client.mjs";
import { mountAdminCabinet } from "../src/v1.4.0-rebuild/mini-app/admin-view.mjs";
const requireDom = createRequire(process.env.CABINET_UI_DOM_ROOT
  ? `${process.env.CABINET_UI_DOM_ROOT}/package.json` : new URL("./p08-ui/package.json", import.meta.url));
const { parseHTML } = requireDom("linkedom");
const html = await readFile(new URL("../src/v1.4.0-rebuild/mini-app/admin-cabinet.html", import.meta.url), "utf8");
const now = Math.floor(Date.now() / 1000), origin = "https://cabinet.example.test";
const decision = (capability = "admin.cabinet.open", allowed = true) => ({ version: 1, capability, allowed,
  reasonCode: allowed ? "allowed" : "role_required", policyVersion: "2026-10-02.v1.4.1.policy-proposal.1",
  effectivePlan: "free", accessState: "none", validUntil: now + 300, quota: null, actionPolicy: allowed ? "allow" : "deny" });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tokenResponse = () => ({ sessionToken: `rpms1_${"A".repeat(43)}`, tokenType: "Bearer", expiresAt: now + 300,
  features: { version: 1, mutationsEnabled: true, offerActionsEnabled: false }, authorizationVersion: 1 });
const tick = () => new Promise(resolve => setImmediate(resolve));
const offerConditions = { buttonText: "Посмотреть", description: "Полное описание\nВторая строка", category: "bank",
  payoutText: "1500 ₽ за подтверждённую заявку", requiredAction: "Оформить карту и выполнить покупку", minAge: 18, maxAge: 65,
  geo: "Россия", holdDays: 14, trafficSources: "Органический трафик; без спама", sourceName: "Официальная программа",
  startsAt: "2026-10-02 10:00:00", expiresAt: "2026-11-01 18:00:00", allowedDecisions: ["approved", "changes_requested", "rejected"] };

function fixture(t, { mutate, read, readOffer, telegram } = {}) {
  const { document, window } = parseHTML(html);
  window.HTMLElement.prototype.focus = function () {};
  window.HTMLElement.prototype.reportValidity = function () { return true; };
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", { configurable: true,
    get() { return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value ?? ""; },
    set(value) { for (const option of this.querySelectorAll("option")) {
      if (option.value === String(value)) option.setAttribute("selected", ""); else option.removeAttribute("selected");
    } },
  });
  const partner = { applicationId: 7, displayName: "Партнёр", contact: "@contact", ageConfirmed: true,
    status: "pending", createdAt: "2026-10-02 18:00:00", updatedAt: null, partnerProfileId: null, profileStatus: null, canReview: true };
  const offer = { code: "offer_one", title: "Условия оффера", provider: "Банк", businessStatus: "active",
    moderationStatus: "pending", visibility: "private", version: 3, expectedVersionId: 15, ownerProfileId: 8, ownerName: "Партнёр", updatedAt: null,
    canModerate: true, canChangeVisibility: false, publicVisibilityEnabled: false };
  const user = { telegramId: 303, username: "someone", joinedAt: "2026-10-01 09:00:00", isBlocked: false,
    acceptedTerms: true, roles: ["user"], partnerStatus: null, planCode: "free", moderation: null, canModerate: true, deliveryUnavailable: false };
  const ticket = { ticketId: 12, userLabel: "Тестовый пользователь", username: "someone", status: "open", createdAt: now,
    updatedAt: now, lastMessageId: 15, pendingMessages: 1, canReply: true, canClose: true };
  let aiMode = "off";
  const client = { authenticated: true, canMutate: true, uncertain: false, expiresAt: now + 300, reads: [], writes: [],
    clearSession() { this.authenticated = false; this.canMutate = false; },
    async read(section, params = {}) {
      this.reads.push({ section, params });
      if (read) return read({ section, params, client: this });
      const base = { readModelVersion: 1, section, generatedAt: now, authorization: decision(), features: { mutationsEnabled: true } };
      if (section === "overview") return { ...base, counts: { users: 4, blockedUsers: 0, pendingPartners: 1, activePartners: 1,
        pendingOffers: 1, approvedOffers: 0, pendingLeads: 2, confirmedLeads: 3 }, release: { version: "1.4.1.1", revision: 31, mode: "owner_only", partnerBetaEnabled: false } };
      if (section === "settings") return { ...base, items: [{ key: "ai_rollout_mode", label: "Доступ к RE AI", value: aiMode, allowedValues: ["off", "admin", "all"], editable: true },
        { key: "official_web_enabled", value: false, allowedValues: [false, true], editable: true },
        { key: "official_web_stale_enabled", value: false, allowedValues: [false, true], editable: true }],
        publicEnablement: { providerConnected: false, activePrograms: 1, approvedPrograms: 1, ready: false, reasonCode: "provider_unavailable" },
        effective: { releaseMode: "owner_only", partnerBetaEnabled: false, officialWebAdminOnly: true, authorizationEnabled: true } };
      return { ...base, items: section === "partners" ? [partner] : section === "offers" ? [offer] : section === "users" ? [user] : section === "support" ? [ticket] : [],
        total: 1, limit: params.limit ?? 20, offset: params.offset ?? 0, hasMore: false };
    },
    async readTicket(ticketId, params) {
      this.reads.push({ section: "support-ticket", params: { ticketId, ...params } });
      return { readModelVersion: 1, section: "support", generatedAt: now, authorization: decision(), features: { mutationsEnabled: true },
        ticket, messages: [{ messageId: 15, direction: "user", text: "Помогите разобраться", hasPhoto: false, createdAt: now, deliveryState: null }], hasMore: false, before: 15 };
    },
    async readOffer(code, expectedVersionId) {
      this.reads.push({ section: "offer-detail", params: { code, expectedVersionId } });
      if (readOffer) return readOffer({ code, expectedVersionId, client: this });
      return { readModelVersion: 1, section: "offers", generatedAt: now, authorization: decision(), features: { mutationsEnabled: true },
        offer: { ...offer, ...offerConditions } };
    },
    async mutate(action, payload, target) {
      this.writes.push({ action, payload, target });
      if (mutate) return mutate({ action, payload, target, client: this });
      if (action === "setting.update" && payload.key === "ai_rollout_mode") aiMode = payload.value;
      return { commitStatus: "committed" };
    },
  };
  const app = mountAdminCabinet({ document, client, telegram }); t.after(() => app.destroy());
  const click = text => [...document.querySelectorAll("button")].find(node => node.textContent === text)?.click();
  return { app, document, window, client, click };
}

test("admin routes fix all seven sections, bounded paging and operation-specific revisions", () => {
  for (const section of ["overview", "partners", "offers", "users", "settings", "support", "journal"]) {
    assert.match(buildAdminReadPath(section), new RegExp(`/admin/${section}(?:\\?|$)`));
  }
  assert.match(buildAdminReadPath("users", { status: "blocked", query: "@someone" }), /query=%40someone/u);
  assert.throws(() => buildAdminReadPath("journal", { status: "all" }));
  assert.throws(() => buildAdminReadPath("partners", { limit: 100 }));
  assert.equal(buildAdminOfferReadPath("offer_one", 15), "/api/v1.4.0/cabinet/admin/offers/offer_one?expectedVersionId=15");
  assert.throws(() => buildAdminOfferReadPath("../users", 15)); assert.throws(() => buildAdminOfferReadPath("offer_one", 0));
  assert.throws(() => buildAdminActionRequest("offer.moderation", { expectedVersionId: 15, decision: "rejected" }, { code: "offer_one" }));
  const operation = buildAdminActionRequest("user.moderation", { action: "block", targetTelegramId: 303,
    expectedRevision: 0, reason: "Спам", confirmed: true }, { telegramId: 303 });
  assert.equal(operation.path, "/api/v1.4.0/cabinet/admin/users/303/moderation");
  assert.throws(() => buildAdminActionRequest("user.moderation", { action: "block", targetTelegramId: 404,
    expectedRevision: 0, reason: "Спам", confirmed: true }, { telegramId: 303 }));
  assert.deepEqual(JSON.parse(buildAdminActionRequest("setting.update", { action: "update_setting", key: "ai_rollout_mode",
    value: "all", expectedValue: "off", confirmed: true }, {}).body), { action: "update_setting", key: "ai_rollout_mode",
    value: "all", expectedValue: "off", confirmed: true });
});
test("admin transport keeps Bearer in memory, binds read authorization and never widens a closed write feature", async () => {
  const requests = [];
  const client = new AdminClient({ origin, cryptoImpl: webcrypto, now: () => now * 1000, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/session")) return response(tokenResponse());
    return response({ readModelVersion: 1, section: "overview", generatedAt: now,
      authorization: decision(), features: { mutationsEnabled: false }, counts: {}, release: {} });
  } });
  await client.authenticate("RAW_SIGNED_INITDATA"); await client.read("overview");
  assert.equal(requests[1].options.headers.Authorization, `Bearer rpms1_${"A".repeat(43)}`);
  assert.equal(requests[1].options.credentials, "omit"); assert.equal(requests[1].options.cache, "no-store");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(client.canMutate, false);
  await assert.rejects(client.mutate("partner.review", { decision: "approve" }, { applicationId: 7 }), { code: "writes_unavailable" });
  assert.equal(requests.length, 2); client.clearSession(); assert.equal(client.authenticated, false);
});
test("offer detail transport rejects foreign versions, incomplete content and unbound authorization", async () => {
  const offer = { code: "offer_one", expectedVersionId: 15, version: 3, businessStatus: "active", moderationStatus: "pending",
    visibility: "private", title: "Условия", provider: "Банк", canModerate: true, canChangeVisibility: false,
    publicVisibilityEnabled: false, ...offerConditions };
  const base = { readModelVersion: 1, section: "offers", generatedAt: now, authorization: decision(), offer };
  let data = base, status = 200; const paths = [];
  const client = new AdminClient({ origin, cryptoImpl: webcrypto, now: () => now * 1000, fetchImpl: async url => {
    if (url.endsWith("/session")) return response(tokenResponse()); paths.push(url); return response(data, status);
  } });
  await client.authenticate("SIGNED_INITDATA");
  assert.equal((await client.readOffer("offer_one", 15)).offer.requiredAction, offerConditions.requiredAction);
  assert.equal(paths[0], `${origin}/api/v1.4.0/cabinet/admin/offers/offer_one?expectedVersionId=15`);
  for (const patch of [{ code: "foreign_offer" }, { expectedVersionId: 16 }, { description: null }, { geo: undefined }, { allowedDecisions: ["other"] }]) {
    data = { ...base, offer: { ...offer, ...patch } }; await assert.rejects(client.readOffer("offer_one", 15), { code: "invalid_response" });
  }
  data = { ...base, authorization: decision("offer.read_own") }; await assert.rejects(client.readOffer("offer_one", 15), { code: "invalid_response" });
  data = { ...base, authorization: decision("admin.cabinet.open", false) }; await assert.rejects(client.readOffer("offer_one", 15), { code: "access_required" });
  data = { error: "state_conflict" }; status = 409; await assert.rejects(client.readOffer("offer_one", 15), { code: "state_conflict", status: 409 });
  assert.equal(client.uncertain, false); client.clearSession();
});
test("an unknown admin write is sent once and GET refresh cannot release its fence", async () => {
  let writes = 0;
  const client = new AdminClient({ origin, cryptoImpl: webcrypto, now: () => now * 1000, fetchImpl: async (url, options) => {
    if (url.endsWith("/session")) return response(tokenResponse());
    if (options.method === "POST") { writes++; throw new Error("network_lost"); }
    return response({ readModelVersion: 1, section: "overview", generatedAt: now, authorization: decision(), features: { mutationsEnabled: true }, counts: {}, release: {} });
  } });
  await client.authenticate("RAW_SIGNED_INITDATA");
  await assert.rejects(client.mutate("partner.review", { decision: "approve" }, { applicationId: 7 }), { code: "outcome_unknown" });
  await client.read("overview"); assert.equal(client.uncertain, true);
  await assert.rejects(client.mutate("partner.review", { decision: "approve" }, { applicationId: 7 }), { code: "outcome_unknown" });
  assert.equal(writes, 1); client.clearSession();
});
test("support sends one UUID in the header and a queued receipt never claims delivery", async () => {
  const requests = [];
  const client = new AdminClient({ origin, cryptoImpl: webcrypto, now: () => now * 1000, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/session")) return response(tokenResponse());
    return response({ commitStatus: "committed", authorization: decision(), receiptStatus: "completed", ticketId: 12,
      commandId: 1, messageId: 16, duplicate: false, reasonCode: null, deliveryState: "queued" });
  } });
  await client.authenticate("RAW_SIGNED_INITDATA");
  const result = await client.mutate("support.reply", { text: "Проверяем ваш вопрос", expectedLastMessageId: 15 }, { ticketId: 12 });
  assert.equal(result.deliveryState, "queued");
  assert.match(requests[1].options.headers["Idempotency-Key"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(JSON.parse(requests[1].options.body), { text: "Проверяем ваш вопрос", expectedLastMessageId: 15 });
  assert.equal(client.uncertain, false); client.clearSession();
});
test("a verified old receipt remains a commit when a current decision is denied, and unknown delivery blocks resending", async () => {
  const client = new AdminClient({ origin, cryptoImpl: webcrypto, now: () => now * 1000, fetchImpl: async url => {
    if (url.endsWith("/session")) return response(tokenResponse());
    return response({ commitStatus: "unchanged", authorization: decision("admin.cabinet.open", false), receiptStatus: "completed",
      ticketId: 12, commandId: 1, messageId: 16, duplicate: true, reasonCode: null, deliveryState: "unknown" });
  } });
  await client.authenticate("RAW_SIGNED_INITDATA");
  const result = await client.mutate("support.reply", { text: "Ответ", expectedLastMessageId: null }, { ticketId: 12 });
  assert.equal(result.commitStatus, "unchanged"); assert.equal(client.uncertainReason, "delivery_unknown");
  await assert.rejects(client.mutate("support.reply", { text: "Ответ", expectedLastMessageId: null }, { ticketId: 12 }), { code: "outcome_unknown" });
  client.clearSession();
});
test("simultaneous identical admin writes share one request while another intent is rejected", async () => {
  let resolve, writes = 0; const pending = new Promise(yes => { resolve = yes; });
  const client = new AdminClient({ origin, cryptoImpl: webcrypto, now: () => now * 1000, fetchImpl: async (url, options) => {
    if (url.endsWith("/session")) return response(tokenResponse());
    if (options.method === "POST") { writes++; return pending; }
    throw new Error("unexpected_get");
  } });
  await client.authenticate("RAW_SIGNED_INITDATA");
  const first = client.mutate("partner.review", { decision: "approve" }, { applicationId: 7 });
  const duplicate = client.mutate("partner.review", { decision: "approve" }, { applicationId: 7 });
  assert.equal(first, duplicate);
  await assert.rejects(client.mutate("partner.review", { decision: "reject", reason: "Уточнить" }, { applicationId: 7 }), { code: "request_in_progress" });
  resolve(response({ commitStatus: "committed", authorization: decision("admin.partner.review") }));
  await first; assert.equal(writes, 1); client.clearSession();
});
test("owner remote shows three tabs while compatible admin APIs keep confirmed writes", async t => {
  const { app, document, window, client, click } = fixture(t); await app.start();
  const navigation = [...document.querySelectorAll("#admin-navigation button")];
  assert.deepEqual([...document.querySelectorAll("#admin-navigation button")].map(node => node.textContent), ["Пульт", "Поддержка", "Платежи"]);
  assert.equal(client.reads[0].section, "overview"); assert.equal(client.reads[1].section, "settings");
  assert.match(document.querySelector(".admin-remote-footer").textContent, /1\.4\.1\.1.*Beta выключена.*Только владелец/u);
  for (const section of ["partners", "offers", "users", "settings", "support", "journal"]) {
    await app.navigate(section); assert.equal(client.reads.at(-1).section, section);
    assert.equal(document.getElementById("admin-screen").getAttribute("aria-busy"), "false");
    assert.deepEqual([...document.querySelectorAll("#admin-navigation button")], navigation);
  }
  await app.navigate("partners"); click("Одобрить");
  const form = document.querySelector(".admin-confirm"), submit = form.querySelector('button[type="submit"]');
  assert.equal(submit.disabled, true);
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); assert.equal(client.writes.length, 0);
  form.querySelector('input[type="checkbox"]').checked = true;
  form.querySelector('input[type="checkbox"]').dispatchEvent(new window.Event("change"));
  assert.equal(submit.disabled, false);
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.equal(client.writes.length, 1); assert.deepEqual(client.writes[0], { action: "partner.review", payload: { decision: "approve" }, target: { applicationId: 7 } });
  assert.match(document.getElementById("admin-notice").textContent, /Изменение сохранено/u);
});
test("rapid owner navigation clicks keep each control and ignore a late previous response", async t => {
  const { app, document, client } = fixture(t); await app.start();
  const navigation = [...document.querySelectorAll("#admin-navigation button")];
  const support = document.querySelector('#admin-navigation [data-section="support"]');
  const settings = document.querySelector('#admin-navigation [data-section="settings"]');
  const read = client.read.bind(client);
  let release;
  const late = new Promise(resolve => { release = resolve; });
  client.read = async (section, ...args) => { if (section === "support") await late; return read(section, ...args); };
  support.click(); settings.click();
  for (let i = 0; i < 8; i++) await tick();
  release(); for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual([...document.querySelectorAll("#admin-navigation button")], navigation);
  assert.equal(document.querySelectorAll('#admin-navigation [aria-current="page"]').length, 1);
  assert.equal(settings.getAttribute("aria-current"), "page");
  assert.equal(document.querySelector("#admin-screen h2").textContent, "Пульт");
  assert.deepEqual(client.writes, []);
  app.expire(); assert.equal(document.querySelectorAll("#admin-navigation button").length, 0);
});
test("rejecting an offer requires a reason and sends the exact displayed version", async t => {
  const { app, document, window, client, click } = fixture(t); await app.start(); await app.navigate("offers");
  assert.equal(document.querySelector('[data-admin-write="true"]'), null); click("Просмотреть условия"); await tick(); click("Вернуть на доработку");
  const form = document.querySelector(".admin-confirm"), consent = form.querySelector('input[type="checkbox"]');
  consent.checked = true; consent.dispatchEvent(new window.Event("change"));
  assert.equal(form.querySelector('button[type="submit"]').disabled, true);
  form.querySelector("textarea").value = "Уточните условия"; form.querySelector("textarea").dispatchEvent(new window.Event("input"));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.deepEqual(client.writes[0], { action: "offer.moderation", target: { code: "offer_one" },
    payload: { expectedVersionId: 15, decision: "changes_requested", reason: "Уточните условия" } });
});
test("offer decisions exist only after full conditions load and cancelling creates no write", async t => {
  const { app, document, window, client, click } = fixture(t); await app.start(); await app.navigate("offers");
  assert.equal(document.querySelector('[data-admin-write="true"]'), null); click("Просмотреть условия"); await tick();
  assert.deepEqual(client.reads.at(-1), { section: "offer-detail", params: { code: "offer_one", expectedVersionId: 15 } });
  const text = document.getElementById("admin-screen").textContent;
  for (const value of [offerConditions.description, offerConditions.payoutText, offerConditions.requiredAction, offerConditions.geo,
    offerConditions.trafficSources, offerConditions.sourceName, "18 лет", "65 лет", "14 дн.", "13:00:00", "21:00:00", "МСК"]) assert.ok(text.includes(value), value);
  click("Одобрить"); const cancelled = document.querySelector(".admin-confirm");
  cancelled.querySelector('input[type="checkbox"]').checked = true; click("Отмена");
  cancelled.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.equal(document.querySelector(".admin-confirm"), null); assert.equal(client.writes.length, 0);
});
test("a detail read conflict requires a fresh queue selection without silently changing the captured version", async t => {
  const { app, document, client, click } = fixture(t); const read = client.read.bind(client);
  let version = 15; client.read = async (section, params) => {
    const data = await read(section, params); if (section === "offers") data.items[0].expectedVersionId = version; return data;
  };
  client.readOffer = async (code, expectedVersionId) => {
    client.reads.push({ section: "offer-detail", params: { code, expectedVersionId } }); throw { code: "state_conflict" };
  };
  await app.start(); await app.navigate("offers"); version = 16; click("Просмотреть условия"); await tick();
  assert.equal(client.reads.at(-1).params.expectedVersionId, 15);
  assert.match(document.getElementById("admin-screen").textContent, /Версия оффера изменилась/u);
  assert.equal(document.querySelector('[data-admin-write="true"]'), null); assert.equal(client.reads.filter(row => row.section === "offer-detail").length, 1);
  click("Обновить очередь"); await tick(); assert.equal(client.reads.at(-1).section, "offers"); click("Просмотреть условия"); await tick();
  assert.equal(client.reads.at(-1).params.expectedVersionId, 16); assert.equal(client.writes.length, 0);
});
test("an offer POST conflict invalidates the old form including a later Enter event", async t => {
  const { app, document, window, client, click } = fixture(t, { mutate: () => { throw { code: "state_conflict" }; } });
  await app.start(); await app.navigate("offers"); click("Просмотреть условия"); await tick(); click("Одобрить");
  const form = document.querySelector(".admin-confirm"), consent = form.querySelector('input[type="checkbox"]');
  consent.checked = true; consent.dispatchEvent(new window.Event("change"));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.equal(client.writes.length, 1); assert.equal(client.writes[0].payload.expectedVersionId, 15);
  assert.equal(document.querySelector('[data-admin-write="true"]'), null);
  assert.match(document.getElementById("admin-screen").textContent, /Нужен новый|Версия оффера изменилась/u);
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick(); assert.equal(client.writes.length, 1);
  click("Обновить очередь"); await tick(); assert.equal(client.reads.at(-1).section, "offers");
  assert.equal(document.querySelector('[data-admin-write="true"]'), null);
});
test("the actual stale POST 403 prerequisite_required contract also invalidates the captured form", async t => {
  let posts = 0;
  const authorization = { ...decision("admin.offer.moderate", false), reasonCode: "prerequisite_required" };
  const transport = new AdminClient({ origin, cryptoImpl: webcrypto, now: () => now * 1000, fetchImpl: async (url, options) => {
    if (url.endsWith("/session")) return response(tokenResponse());
    assert.equal(options.method, "POST"); posts++; return response({ error: "prerequisite_required", authorization }, 403);
  } });
  await transport.authenticate("SIGNED_INITDATA"); t.after(() => transport.clearSession());
  const { app, document, window, client, click } = fixture(t, { mutate: async ({ action, payload, target }) => {
    try { return await transport.mutate(action, payload, target); }
    catch (error) { assert.equal(error.status, 403); assert.equal(error.code, "prerequisite_required"); assert.equal(error.authorization.reasonCode, "prerequisite_required"); throw error; }
  } });
  await app.start(); await app.navigate("offers"); click("Просмотреть условия"); await tick(); click("Одобрить");
  const form = document.querySelector(".admin-confirm"), consent = form.querySelector('input[type="checkbox"]');
  consent.checked = true; consent.dispatchEvent(new window.Event("change"));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.match(document.getElementById("admin-screen").textContent, /Версия оффера изменилась/u);
  assert.equal(document.querySelector('[data-admin-write="true"]'), null); assert.equal(posts, 1); assert.equal(client.uncertain, false);
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick(); assert.equal(posts, 1);
  click("Обновить очередь"); await tick(); assert.equal(client.reads.at(-1).section, "offers");
});
test("visibility also requires full captured conditions and uses the displayed version", async t => {
  const { app, document, window, client, click } = fixture(t); const readOffer = client.readOffer.bind(client);
  client.readOffer = async (...args) => { const data = await readOffer(...args); Object.assign(data.offer,
    { moderationStatus: "approved", canModerate: false, canChangeVisibility: true, publicVisibilityEnabled: true }); return data; };
  await app.start(); await app.navigate("offers"); assert.equal(document.querySelector('[data-admin-write="true"]'), null);
  click("Просмотреть условия"); await tick(); click("Опубликовать");
  const form = document.querySelector(".admin-confirm"), consent = form.querySelector('input[type="checkbox"]');
  consent.checked = true; consent.dispatchEvent(new window.Event("change")); form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.deepEqual(client.writes[0], { action: "offer.visibility", target: { code: "offer_one" }, payload: { expectedVersionId: 15, visibility: "public" } });
});
test("loading, failure, navigation and expiry never expose a late offer's private content or actions", async t => {
  for (const next of ["navigate", "expire", "error"]) await t.test(next, async t => {
    let resolve, reject; const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const { app, document, client, click } = fixture(t); const readOffer = client.readOffer.bind(client);
    client.readOffer = async (...args) => { const data = await readOffer(...args); await pending; return data; };
    await app.start(); await app.navigate("offers"); click("Просмотреть условия");
    assert.equal(document.getElementById("admin-screen").getAttribute("aria-busy"), "true");
    assert.equal(document.querySelector('[data-admin-write="true"]'), null);
    if (next === "navigate") await app.navigate("journal"); else if (next === "expire") app.expire();
    if (next === "error") reject({ code: "network_error" }); else resolve(); await tick();
    assert.doesNotMatch(document.getElementById("admin-screen").textContent, /Полное описание|1500 ₽/u);
    assert.equal(document.querySelector('[data-admin-write="true"]'), null);
    if (next === "error") assert.match(document.getElementById("admin-screen").textContent, /Не удалось открыть условия/u);
    if (next === "expire") assert.equal(document.getElementById("admin-navigation").hidden, true);
  });
});
test("full offer fields are rendered as text, including empty conditions and disabled-action explanations", async t => {
  const { app, document, client, click } = fixture(t); const readOffer = client.readOffer.bind(client);
  client.readOffer = async (...args) => { const data = await readOffer(...args); Object.assign(data.offer, {
    description: '<img src=x onerror="throw 1">', geo: "", minAge: null, maxAge: null, holdDays: null, startsAt: null, expiresAt: null,
    moderationStatus: "approved", canModerate: false, canChangeVisibility: true, publicVisibilityEnabled: false }); return data; };
  await app.start(); await app.navigate("offers"); click("Просмотреть условия"); await tick();
  assert.match(document.getElementById("admin-screen").textContent, /<img src=x.*Публикация в общий каталог отключена/u);
  assert.equal(document.querySelector("#admin-screen img"), null); assert.equal(document.querySelector(".admin-offer-detail").querySelector(".fact dd").textContent, "offer_one");
  assert.equal([...document.querySelectorAll("button")].some(node => node.textContent === "Опубликовать"), false);
});
test("remote AI confirms captured old and new values, cancel is inert and saved state comes from a fresh read", async t => {
  const { app, document, window, client, click } = fixture(t); await app.start();
  assert.equal(document.querySelector('[data-ai-mode="off"]').getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelector(".admin-ai-explanation").textContent, "RE AI выключен для всех аккаунтов.");
  assert.equal(document.querySelector('[data-ai-mode="all"]').disabled, true);
  assert.match(document.getElementById("admin-screen").textContent, /подключите провайдера/u);
  click("Только мне"); let form = document.querySelector(".admin-confirm");
  assert.match(form.textContent, /Выключен → Только мне/u); assert.equal(form.querySelector('input[type="checkbox"]'), null);
  click("Отмена"); assert.equal(client.writes.length, 0); assert.equal(document.querySelector(".admin-confirm"), null);
  assert.equal(document.querySelector('[data-ai-mode="off"]').getAttribute("aria-pressed"), "true");
  click("Только мне"); form = document.querySelector(".admin-confirm");
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.deepEqual(client.writes, [{ action: "setting.update", target: {},
    payload: { action: "update_setting", key: "ai_rollout_mode", value: "admin", expectedValue: "off", confirmed: true } }]);
  assert.equal(document.querySelector('[data-ai-mode="admin"]').getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelector(".admin-ai-explanation").textContent, "RE AI доступен только вашему аккаунту администратора.");
  assert.match(document.getElementById("admin-notice").textContent, /Настройка сохранена/u);
});
test("public AI readiness controls all, preserves current all and never widens access locally", async t => {
  for (const state of ["not_ready", "ready", "already_all"]) await t.test(state, async t => {
    const { app, document, window, client, click } = fixture(t);
    const read = client.read.bind(client); client.read = async (...args) => {
      const data = await read(...args);
      if (data.section === "settings") {
        if (state === "ready") data.publicEnablement = { providerConnected: true, activePrograms: 2, approvedPrograms: 2, ready: true, reasonCode: "ready" };
        if (state === "already_all") data.items[0].value = "all";
      }
      return data;
    };
    await app.start(); const all = document.querySelector('[data-ai-mode="all"]');
    assert.equal(all.disabled, state !== "ready"); assert.equal(all.getAttribute("aria-pressed"), String(state === "already_all"));
    if (state === "already_all") {
      assert.equal(document.querySelector(".admin-ai-explanation").textContent, "RE AI доступен пользователям с учётом их прав и лимитов.");
      assert.doesNotMatch(document.querySelector(".admin-ai-explanation").textContent, /только вашему/u);
    }
    if (state === "ready") {
      click("Всем"); const form = document.querySelector(".admin-confirm");
      assert.match(form.textContent, /Выключен → Всем/u); assert.equal(client.writes.length, 0);
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
      assert.equal(client.writes[0].payload.value, "all"); assert.equal(client.writes[0].payload.expectedValue, "off");
    } else { await tick(); assert.equal(client.writes.length, 0); }
  });
});
test("web switches show actual state until confirmed and keep stale search collapsed", async t => {
  const { app, document, window, client, click } = fixture(t); await app.start();
  const stale = document.querySelector(".admin-extra-settings"); assert.equal(stale.hasAttribute("open"), false);
  const toggle = document.querySelector('[name="official_web_enabled"]'); assert.equal(toggle.checked, false);
  toggle.checked = true; toggle.dispatchEvent(new window.Event("change")); assert.equal(toggle.checked, false);
  const form = document.querySelector(".admin-confirm"); assert.match(form.textContent, /Выключено → Включено/u);
  click("Отмена"); assert.equal(client.writes.length, 0); assert.equal(toggle.checked, false);
  toggle.checked = true; toggle.dispatchEvent(new window.Event("change"));
  document.querySelector(".admin-confirm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.deepEqual(client.writes[0].payload, { action: "update_setting", key: "official_web_enabled", value: true, expectedValue: false, confirmed: true });
});
test("a setting CAS rejection keeps displayed state and blocks the stale confirmation", async t => {
  const { app, document, window, client, click } = fixture(t, { mutate: () => { throw { code: "state_conflict" }; } });
  await app.start(); click("Только мне"); const form = document.querySelector(".admin-confirm");
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.match(form.textContent, /Данные изменились/u); assert.equal(form.querySelector('button[type="submit"]').disabled, true);
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.equal(client.writes.length, 1); assert.equal(document.querySelector('[data-ai-mode="off"]').getAttribute("aria-pressed"), "true");
});
test("server-disabled own targets and closed public rollout expose no dead admin action buttons", async t => {
  const { app, document, client } = fixture(t);
  const read = client.read.bind(client);
  client.read = async (section, params) => {
    const data = await read(section, params);
    if (section === "partners") data.items[0].canReview = false;
    if (section === "offers") Object.assign(data.items[0], { moderationStatus: "approved", canModerate: false,
      canChangeVisibility: true, publicVisibilityEnabled: false });
    if (section === "users") data.items[0].canModerate = false;
    return data;
  };
  await app.start(); await app.navigate("partners");
  assert.equal(document.querySelector('[data-admin-write="true"]'), null);
  await app.navigate("offers");
  assert.doesNotMatch(document.getElementById("admin-screen").textContent, /Опубликовать/u);
  await app.navigate("users"); assert.equal(document.querySelector('[data-admin-write="true"]'), null);
  assert.equal(client.writes.length, 0);
});
test("unknown outcomes preserve reading while every later admin write stays disabled", async t => {
  const { app, document, window, client, click } = fixture(t, { mutate: ({ client }) => { client.uncertain = true; throw { code: "outcome_unknown" }; } });
  await app.start(); await app.navigate("partners"); click("Одобрить");
  const form = document.querySelector(".admin-confirm"), consent = form.querySelector('input[type="checkbox"]');
  consent.checked = true; consent.dispatchEvent(new window.Event("change"));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.match(document.getElementById("admin-notice").textContent, /могло выполниться/u);
  assert.ok([...document.querySelectorAll('[data-admin-write="true"]')].every(node => node.disabled));
  await app.navigate("users"); assert.equal(client.reads.at(-1).section, "users");
  assert.ok([...document.querySelectorAll('[data-admin-write="true"]')].every(node => node.disabled));
  assert.equal(client.writes.length, 1); assert.equal(client.uncertain, true);
});
const openFirstTicket = async ({ app, document }) => {
  await app.navigate("support"); document.querySelector('[data-ticket-id="12"]').click(); await tick();
};
const composeReply = ({ document, window }, text) => {
  const input = document.querySelector(".admin-reply-composer textarea"); input.value = text;
  input.dispatchEvent(new window.Event("input")); return input;
};
test("support queue uses status chips and inline composer confirms one exact reply without claiming delivery", async t => {
  let resolve; const pending = new Promise(yes => { resolve = yes; });
  const f = fixture(t, { mutate: () => pending }); const { app, document, window, client, click } = f;
  await app.start(); await app.navigate("support");
  assert.equal(document.querySelectorAll(".admin-support-filters button").length, 3); assert.equal(client.reads.at(-1).params.limit, 25);
  document.querySelector('[data-ticket-id="12"]').click(); await tick();
  assert.equal(client.reads.at(-1).section, "support-ticket"); assert.equal(client.reads.at(-1).params.limit, 25);
  assert.match(document.querySelector(".admin-ticket-thread").textContent, /Помогите разобраться/u);
  assert.equal(document.querySelector(".screen-head"), null);
  assert.equal(document.querySelectorAll(".admin-ticket-toolbar button").length, 2);
  assert.match(document.querySelector(".admin-ticket-header").textContent, /№12/u);
  assert.equal([...document.querySelectorAll("button")].some(button => button.textContent === "Ответить"), false);
  const input = composeReply(f, "Проверяем ваш вопрос"); assert.equal(input.maxLength, 2000); click("Отправить");
  let form = document.querySelector(".admin-confirm"); assert.equal(form.querySelector('input[type="checkbox"]'), null);
  assert.equal(document.querySelector(".admin-send-preview").textContent, "Проверяем ваш вопрос");
  click("Изменить"); assert.equal(input.value, "Проверяем ваш вопрос"); assert.equal(input.disabled, false); assert.equal(client.writes.length, 0);
  click("Отправить"); form = document.querySelector(".admin-confirm");
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(client.writes.length, 1); assert.ok([...document.querySelectorAll("button")].every(button => button.disabled));
  resolve({ commitStatus: "committed", deliveryState: "queued" }); await tick();
  assert.deepEqual(client.writes[0], { action: "support.reply", target: { ticketId: 12 }, payload: { text: "Проверяем ваш вопрос", expectedLastMessageId: 15 } });
  assert.match(document.getElementById("admin-notice").textContent, /Ответ принят в очередь.*Доставка ещё не подтверждена/u);
  assert.doesNotMatch(document.getElementById("admin-notice").textContent, /доставлен/u);
  assert.equal(document.querySelector(".admin-reply-composer textarea").value, "");
});
test("nonempty inline replies guard tab, refresh and Telegram back with the original queue retained", async t => {
  let back; const telegram = { BackButton: { onClick(fn) { back = fn; }, offClick() {}, show() {}, hide() {} } };
  const f = fixture(t, { telegram }); const { app, document, client, click } = f; await app.start();
  await app.navigate("support", { status: "waiting", offset: 25 }); document.querySelector('[data-ticket-id="12"]').click(); await tick();
  composeReply(f, "Несохранённый ответ"); let reads = client.reads.length;
  click("Пульт"); assert.equal(client.reads.length, reads); click("Продолжить редактирование");
  click("Обновить"); assert.equal(client.reads.length, reads); click("Продолжить редактирование");
  back(); assert.equal(client.reads.length, reads); assert.match(document.getElementById("admin-screen").textContent, /Ответ ещё не отправлен/u);
  click("Продолжить редактирование"); assert.equal(document.querySelector("textarea").value, "Несохранённый ответ");
  back(); click("Удалить текст и перейти"); await tick();
  assert.equal(client.reads.at(-1).section, "support"); assert.equal(client.reads.at(-1).params.status, "waiting"); assert.equal(client.reads.at(-1).params.offset, 25);
  assert.equal(document.querySelector("textarea"), null); assert.equal(client.writes.length, 0);
});
test("closed tickets and unresolved delivery keep honest state and never offer another reply", async t => {
  const f = fixture(t); const { app, document, client } = f;
  const readTicket = client.readTicket.bind(client); client.readTicket = async (...args) => {
    const data = await readTicket(...args); data.ticket.canReply = false; data.ticket.canClose = false;
    data.messages.push({ messageId: 16, direction: "staff", text: "Ответ", hasPhoto: false, createdAt: now, deliveryState: "queued" }); return data;
  };
  await app.start(); await openFirstTicket(f);
  assert.match(document.querySelector(".admin-ticket-thread").textContent, /В очереди на отправку/u);
  assert.equal(document.querySelector(".admin-reply-composer"), null); assert.equal(document.querySelector('[data-admin-write="true"]'), null);
  assert.doesNotMatch(document.getElementById("admin-screen").textContent, /Ответ доставлен/u);
});
test("support photo links and unknown delivery retain the no-resend fence", async t => {
  const f = fixture(t, { mutate: ({ client }) => {
    client.uncertain = true; client.uncertainReason = "delivery_unknown"; return { commitStatus: "committed", deliveryState: "unknown" };
  } }); const { app, document, window, client, click } = f;
  const readTicket = client.readTicket.bind(client); client.readTicket = async (...args) => {
    const data = await readTicket(...args); data.messages[0].hasPhoto = true; return data;
  };
  await app.start(); await openFirstTicket(f);
  assert.equal(document.querySelector(".admin-message a").href, "https://t.me/RE_Program_Support_Bot");
  composeReply(f, "Ответ"); click("Отправить"); const form = document.querySelector(".admin-confirm");
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.match(document.getElementById("admin-notice").textContent, /исход доставки неизвестен.*боте поддержки/u);
  assert.doesNotMatch(document.getElementById("admin-notice").textContent, /✅ Ответ доставлен/u);
  assert.ok([...document.querySelectorAll('[data-admin-write="true"]')].every(node => node.disabled));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick(); assert.equal(client.writes.length, 1);
});
test("close requires separate confirmation, preserves history and includes the captured last message", async t => {
  const f = fixture(t); const { app, document, window, client, click } = f; await app.start(); await openFirstTicket(f);
  click("Закрыть обращение"); let form = document.querySelector(".admin-confirm");
  assert.match(form.textContent, /История сохранится/u); assert.equal(form.querySelector('input[type="checkbox"]'), null);
  click("Отмена"); assert.equal(client.writes.length, 0);
  click("Закрыть обращение"); form = document.querySelector(".admin-confirm");
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick();
  assert.deepEqual(client.writes[0], { action: "support.close", target: { ticketId: 12 }, payload: { expectedLastMessageId: 15 } });
});
test("support inline private draft and late reply acknowledgement disappear after session expiry", async t => {
  let resolve; const pending = new Promise(yes => { resolve = yes; });
  const f = fixture(t, { mutate: () => pending }); const { app, document, window, client, click } = f;
  await app.start(); await openFirstTicket(f); composeReply(f, "Личный черновик"); click("Отправить");
  document.querySelector(".admin-confirm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  client.uncertain = true; app.expire(); resolve({ commitStatus: "committed", deliveryState: "sent" }); await tick();
  assert.equal(document.querySelector("textarea"), null); assert.equal(document.querySelector(".admin-confirm"), null);
  assert.equal(document.getElementById("admin-navigation").hidden, true);
  assert.doesNotMatch(document.getElementById("admin-screen").textContent, /Личный черновик|Помогите разобраться|Ответ доставлен/u);
});
test("private admin data and confirmation forms disappear on expiry and a late ACK cannot restore them", async t => {
  let resolve; const pending = new Promise(yes => { resolve = yes; });
  const { app, document, window, client, click } = fixture(t, { mutate: () => pending });
  await app.start(); await app.navigate("partners"); click("Одобрить");
  const form = document.querySelector(".admin-confirm"), consent = form.querySelector('input[type="checkbox"]');
  consent.checked = true; consent.dispatchEvent(new window.Event("change"));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); client.uncertain = true; app.expire();
  resolve({ commitStatus: "committed" }); await tick();
  assert.equal(document.querySelector(".admin-confirm"), null); assert.equal(document.getElementById("admin-navigation").hidden, true);
  assert.doesNotMatch(document.getElementById("admin-screen").textContent, /@contact|Изменение сохранено/u);
  assert.match(document.getElementById("admin-screen").textContent, /Сессия завершилась.*могло выполниться/u);
});
test("admin browser sources have no HTML sinks or persistent identity storage", async () => {
  for (const name of ["admin-client.mjs", "admin-view.mjs", "admin-cabinet.mjs"]) {
    const source = await readFile(new URL(`../src/v1.4.0-rebuild/mini-app/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB|innerHTML|outerHTML|insertAdjacentHTML|eval\(/u);
  }
});
