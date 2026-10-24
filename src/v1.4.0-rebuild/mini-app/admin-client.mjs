import { CabinetClientError, readAuthorizationDTO } from "./cabinet-client.mjs";

const API = "/api/v1.4.0/cabinet/";
const SECTIONS = new Set(["overview", "partners", "offers", "users", "settings", "support", "journal"]);
const READ_CAPABILITY = () => "admin.cabinet.open";
const TOKEN = /^rpms1_[A-Za-z0-9_-]{43}$/u;
const CODE = /^[a-z0-9_-]{3,24}$/u;
const REVIEW_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const REVIEW_REASONS = new Set(['owner_payment_confirmed', 'owner_access_recovered',
  'owner_refund_requested', 'owner_duplicate_payment', 'owner_support_resolution']);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const fail = (code, status = 0, authorization = null) => { throw new CabinetClientError(code, status, authorization); };
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("invalid_request");
  return value;
};
const exact = (value, fields) => {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) fail("invalid_request");
  return structuredClone(value);
};
const reason = value => {
  if (typeof value !== "string" || value.trim().length > 500) fail("invalid_request");
  return value.trim();
};

export function buildAdminReadPath(section, params = {}) {
  if (!SECTIONS.has(section)) fail("invalid_request");
  exact(params, ["limit", "offset", "status", "query"]);
  if (["overview", "settings"].includes(section)) {
    if (Object.keys(params).length) fail("invalid_request");
    return `${API}admin/${section}`;
  }
  const query = new URLSearchParams({ limit: String(integer(params.limit ?? 20, 1, 25)),
    offset: String(integer(params.offset ?? 0, 0, section === "support" ? 1000 : 100_000)) });
  const statuses = { partners: ["pending", "approved", "rejected", "all"],
    offers: ["pending", "approved", "changes_requested", "rejected", "not_submitted", "all"],
    users: ["all", "blocked"], support: ["open", "waiting", "closed"] };
  if (params.status !== undefined) {
    if (!statuses[section]?.includes(params.status)) fail("invalid_request");
    query.set("status", params.status);
  }
  if (params.query !== undefined) {
    if (section !== "users" || typeof params.query !== "string" || params.query.length > 64) fail("invalid_request");
    const value = params.query.trim();
    if (value) query.set("query", value);
  }
  return `${API}admin/${section}?${query}`;
}
export function buildAdminTicketReadPath(ticketId, params = {}) {
  integer(ticketId, 1); exact(params, ["limit", "beforeMessageId"]);
  const query = new URLSearchParams({ limit: String(integer(params.limit ?? 20, 1, 25)) });
  if (params.beforeMessageId !== undefined) query.set("beforeMessageId", String(integer(params.beforeMessageId, 1)));
  return `${API}admin/support/tickets/${ticketId}?${query}`;
}
export function buildAdminOfferReadPath(code, expectedVersionId) {
  if (typeof code !== "string" || !CODE.test(code)) fail("invalid_request");
  const query = new URLSearchParams({ expectedVersionId: String(integer(expectedVersionId, 1)) });
  return `${API}admin/offers/${code}?${query}`;
}

export function readAdminSubscriptionReviewDTO(data) {
  const fields = ['authority', 'observedAt', 'items', 'hasMore', 'actionAdmissionRequired', 'authorization'];
  if (!object(data) || Object.keys(data).length !== fields.length || fields.some(key => !Object.hasOwn(data, key))
    || data.authority !== 'worker' || !Number.isSafeInteger(data.observedAt) || data.observedAt <= 0
    || data.actionAdmissionRequired !== true || typeof data.hasMore !== 'boolean'
    || !Array.isArray(data.items) || data.items.length > 50) fail('invalid_response');
  const itemFields = ['ledgerEntryId', 'telegramId', 'planCode', 'currency', 'amountStars',
    'startsAt', 'endsAt', 'reasonCode', 'recordedAt', 'status'];
  const seen = new Set();
  for (const item of data.items) {
    if (!object(item) || Object.keys(item).length !== itemFields.length || itemFields.some(key => !Object.hasOwn(item, key))
      || typeof item.ledgerEntryId !== 'string' || !REVIEW_ID.test(item.ledgerEntryId) || seen.has(item.ledgerEntryId)
      || !Number.isSafeInteger(item.telegramId) || item.telegramId <= 0
      || !['professional', 'dragon'].includes(item.planCode) || item.currency !== 'XTR'
      || !Number.isSafeInteger(item.amountStars) || item.amountStars <= 0
      || !Number.isSafeInteger(item.recordedAt) || item.recordedAt <= 0
      || typeof item.reasonCode !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(item.reasonCode)
      || !['pending_review', 'applied', 'refunded', 'chargeback', 'pending', 'unknown'].includes(item.status)
      || !(item.startsAt === null && item.endsAt === null || Number.isSafeInteger(item.startsAt) && item.startsAt > 0
        && Number.isSafeInteger(item.endsAt) && item.endsAt > item.startsAt)) fail('invalid_response');
    seen.add(item.ledgerEntryId);
  }
  const authorization = readAuthorizationDTO(data.authorization, 'admin.cabinet.open');
  if (!authorization.allowed) fail('access_required', 403, authorization);
  return Object.freeze({ ...structuredClone(data), authorization });
}

// This produces a request, never an authority claim. Actor and current target
// ownership, revisions and role are resolved again by the server.
export function buildAdminActionRequest(action, payload = {}, target = {}) {
  let path, capability, body;
  if (action === "partner.review") {
    exact(target, ["applicationId"]); const id = integer(target.applicationId, 1);
    body = exact(payload, ["decision", "reason"]);
    if (!["approve", "reject"].includes(body.decision)) fail("invalid_request");
    if (body.reason !== undefined) body.reason = reason(body.reason);
    if (body.decision === "reject" && !body.reason) fail("invalid_request");
    path = `partners/${id}/review`; capability = "admin.partner.review";
  } else if (["offer.moderation", "offer.visibility"].includes(action)) {
    exact(target, ["code"]); if (!CODE.test(target.code)) fail("invalid_request");
    const moderation = action === "offer.moderation";
    body = exact(payload, ["expectedVersionId", moderation ? "decision" : "visibility", "reason"]);
    integer(body.expectedVersionId, 1);
    if (!(moderation ? ["approved", "changes_requested", "rejected"] : ["private", "assigned", "public"])
      .includes(body[moderation ? "decision" : "visibility"])) fail("invalid_request");
    if (body.reason !== undefined) body.reason = reason(body.reason);
    if (moderation && body.decision !== "approved" && !body.reason) fail("invalid_request");
    path = `offers/${target.code}/${moderation ? "moderation" : "visibility"}`;
    capability = moderation ? "admin.offer.moderate" : "admin.offer.visibility";
  } else if (action === "user.moderation") {
    exact(target, ["telegramId"]); integer(target.telegramId, 1);
    body = exact(payload, ["action", "targetTelegramId", "expectedRevision", "reason", "confirmed"]);
    if (!["block", "unblock"].includes(body.action) || body.confirmed !== true || body.targetTelegramId !== target.telegramId) fail("invalid_request");
    integer(body.expectedRevision); body.reason = reason(body.reason);
    if (Array.from(body.reason).length < 3 || Array.from(body.reason).length > 300) fail("invalid_request");
    path = `users/${target.telegramId}/moderation`; capability = "admin.user.moderation";
  } else if (action === "setting.update") {
    exact(target, []); body = exact(payload, ["action", "key", "value", "expectedValue", "confirmed"]);
    if (body.action !== "update_setting" || body.confirmed !== true ||
      !["ai_rollout_mode", "official_web_enabled", "official_web_stale_enabled"].includes(body.key)) fail("invalid_request");
    if (body.key === "ai_rollout_mode" ? !["off", "admin", "all"].includes(body.value) || !["off", "admin", "all"].includes(body.expectedValue)
      : typeof body.value !== "boolean" || typeof body.expectedValue !== "boolean") fail("invalid_request");
    path = "settings"; capability = "admin.settings.manage";
  } else if (["support.reply", "support.close"].includes(action)) {
    exact(target, ["ticketId"]); integer(target.ticketId, 1);
    const reply = action === "support.reply";
    body = exact(payload, ["expectedLastMessageId", ...(reply ? ["text"] : [])]);
    if (body.expectedLastMessageId !== null) integer(body.expectedLastMessageId, 1);
    if (reply && (typeof body.text !== "string" || !body.text.trim() || body.text.length > 2000)) fail("invalid_request");
    path = `support/tickets/${target.ticketId}/${reply ? "reply" : "close"}`;
    capability = "admin.cabinet.open";
  } else if (['subscription.review.apply', 'subscription.review.refund'].includes(action)) {
    exact(target, ['ledgerEntryId']);
    if (typeof target.ledgerEntryId !== 'string' || !REVIEW_ID.test(target.ledgerEntryId)) fail('invalid_request');
    body = exact(payload, ['reasonCode']);
    if (!REVIEW_REASONS.has(body.reasonCode)) fail('invalid_request');
    body.ledgerEntryId = target.ledgerEntryId;
    path = 'subscription-review/' + (action.endsWith('.apply') ? 'apply' : 'refund');
    capability = 'admin.cabinet.open';
  } else fail("invalid_request");
  return Object.freeze({ path: `${API}admin/${path}`, capability, body: JSON.stringify(body) });
}

export class AdminClient {
  #fetch; #crypto; #now; #origin; #token = null; #expires = 0; #epoch = 0;
  #authAttempted = false; #requests = new Set(); #pending = null; #uncertain = false; #uncertainReason = null; #onExpired;
  canMutate = false;
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), cryptoImpl = globalThis.crypto,
    now = () => Date.now(), origin = globalThis.location?.origin, onExpired = () => {} } = {}) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) fail("invalid_origin");
    if (typeof fetchImpl !== "function" || !cryptoImpl?.getRandomValues) fail("unavailable");
    this.#fetch = fetchImpl; this.#crypto = cryptoImpl; this.#now = now;
    this.#origin = origin; this.#onExpired = onExpired;
  }
  get authenticated() { return this.#token !== null && this.#expires * 1000 > this.#now(); }
  get expiresAt() { return this.#expires; }
  get uncertain() { return this.#uncertain; }
  get uncertainReason() { return this.#uncertainReason; }
  #key() { return [...this.#crypto.getRandomValues(new Uint8Array(24))]
    .map(value => value.toString(16).padStart(2, "0")).join(""); }
  #uuid() {
    const values = this.#crypto.getRandomValues(new Uint8Array(16));
    values[6] = (values[6] & 15) | 64; values[8] = (values[8] & 63) | 128;
    const hex = [...values].map(value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  clearSession() {
    const hadSession = this.#token !== null;
    if (this.#pending) { this.#uncertain = true; this.#uncertainReason = "outcome_unknown"; }
    this.#token = null; this.#expires = 0; this.#epoch++; this.canMutate = false;
    for (const controller of this.#requests) controller.abort(); this.#requests.clear();
    if (hadSession) this.#onExpired();
  }
  #checkSession() {
    if (!this.authenticated) { this.clearSession(); fail("session_expired", 401); }
  }
  async #request(path, { method = "GET", body, key, signal, auth = true } = {}) {
    if (auth) this.#checkSession();
    if (body !== undefined && new TextEncoder().encode(body).length > 32_768) fail("invalid_request");
    const epoch = this.#epoch, controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) controller.abort();
    this.#requests.add(controller);
    const headers = { Accept: "application/json" };
    if (auth) headers.Authorization = `Bearer ${this.#token}`;
    if (method === "POST") { headers["Content-Type"] = "application/json"; headers["Idempotency-Key"] = key; }
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.#fetch(new URL(path, this.#origin).href, { method, headers, body,
        signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      if (epoch !== this.#epoch || auth && !this.authenticated) { this.clearSession(); fail("session_expired", 401); }
      if (auth && response.status === 401) { this.clearSession(); fail("session_expired", 401); }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        fail(method === "POST" ? "outcome_unknown" : "invalid_response");
      }
      let data; try { data = await response.json(); } catch { fail(method === "POST" ? "outcome_unknown" : "invalid_response"); }
      if (epoch !== this.#epoch || auth && !this.authenticated) { this.clearSession(); fail("session_expired", 401); }
      if (!response.ok) {
        if (method === "POST" && response.status >= 500) fail("outcome_unknown", response.status);
        const authorization = data?.authorization === undefined ? null : readAuthorizationDTO(data.authorization);
        fail(typeof data?.error === "string" ? data.error : "unavailable", response.status, authorization);
      }
      if (!object(data)) fail(method === "POST" ? "outcome_unknown" : "invalid_response");
      return data;
    } catch (error) {
      if (error instanceof CabinetClientError) throw error;
      if (epoch !== this.#epoch) fail("session_expired", 401);
      if (signal?.aborted) throw error;
      fail(method === "POST" ? "outcome_unknown" : "network_error");
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#requests.delete(controller);
    }
  }
  async authenticate(initData) {
    if (this.#authAttempted) fail("replayed_init_data", 409);
    if (typeof initData !== "string" || !initData || new TextEncoder().encode(initData).length > 8192) fail("telegram_required");
    this.#authAttempted = true;
    const data = await this.#request(`${API}session`, { method: "POST", auth: false,
      body: JSON.stringify({ initData }), key: this.#key() });
    const now = Math.floor(this.#now() / 1000);
    if (!TOKEN.test(data.sessionToken) || data.tokenType !== "Bearer" || !Number.isSafeInteger(data.expiresAt)
      || data.expiresAt <= now || data.expiresAt > now + 300) fail("invalid_response");
    if (!object(data.features) || data.features.version !== 1 || typeof data.features.mutationsEnabled !== "boolean") fail("invalid_response");
    this.#token = data.sessionToken; this.#expires = data.expiresAt;
    this.canMutate = data.features.mutationsEnabled;
  }
  #readEnvelope(data, section) {
    if (data.readModelVersion !== 1 || data.section !== section || !Number.isSafeInteger(data.generatedAt)) fail("invalid_response");
    data.authorization = readAuthorizationDTO(data.authorization, READ_CAPABILITY(section));
    if (!data.authorization.allowed) fail("access_required", 403, data.authorization);
    if (data.features !== undefined) {
      if (!object(data.features) || Object.keys(data.features).some(key => key !== "mutationsEnabled")
        || typeof data.features.mutationsEnabled !== "boolean") fail("invalid_response");
      if (!data.features.mutationsEnabled) this.canMutate = false;
    }
    return data;
  }
  async read(section, params = {}, { signal } = {}) {
    const data = this.#readEnvelope(await this.#request(buildAdminReadPath(section, params), { signal }), section);
    if (section === "settings" && (!Array.isArray(data.items) || data.items.some(item => !object(item)
      || typeof item.key !== "string" || typeof item.editable !== "boolean" || !Array.isArray(item.allowedValues)))) fail("invalid_response");
    if (section === "settings" && data.items.some(item => item.key === "ai_rollout_mode" && item.allowedValues.includes("all"))) {
      const readiness = data.publicEnablement;
      const fields = ["providerConnected", "activePrograms", "approvedPrograms", "ready", "reasonCode"];
      if (!object(readiness) || Object.keys(readiness).length !== fields.length || fields.some(key => !Object.hasOwn(readiness, key))
        || typeof readiness.providerConnected !== "boolean" || typeof readiness.ready !== "boolean"
        || !Number.isSafeInteger(readiness.activePrograms) || readiness.activePrograms < 0
        || !Number.isSafeInteger(readiness.approvedPrograms) || readiness.approvedPrograms < 0 || readiness.approvedPrograms > readiness.activePrograms
        || readiness.reasonCode !== (!readiness.providerConnected ? "provider_unavailable" : readiness.activePrograms === 0 ? "no_active_programs"
          : readiness.approvedPrograms !== readiness.activePrograms ? "sources_not_approved" : "ready")
        || readiness.ready !== (readiness.reasonCode === "ready")) fail("invalid_response");
    }
    if (!["overview", "settings"].includes(section) && (!Array.isArray(data.items)
      || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.offset)
      || data.offset < 0 || !Number.isSafeInteger(data.limit) || data.limit < 1 || data.limit > 25
      || typeof data.hasMore !== "boolean" || data.items.some(item => !object(item)))) fail("invalid_response");
    return data;
  }
  async readTicket(ticketId, params = {}, { signal } = {}) {
    const data = this.#readEnvelope(await this.#request(buildAdminTicketReadPath(ticketId, params), { signal }), "support");
    if (!object(data.ticket) || data.ticket.ticketId !== ticketId || !Array.isArray(data.messages)
      || data.messages.some(item => !object(item) || !Number.isSafeInteger(item.messageId)
        || typeof item.text !== "string") || typeof data.hasMore !== "boolean") fail("invalid_response");
    return data;
  }
  async readOffer(code, expectedVersionId, { signal } = {}) {
    const data = this.#readEnvelope(await this.#request(buildAdminOfferReadPath(code, expectedVersionId), { signal }), "offers");
    const offer = data.offer;
    if (!object(offer) || offer.code !== code || offer.expectedVersionId !== expectedVersionId
      || !Number.isSafeInteger(offer.version) || offer.version < 1
      || ["businessStatus", "moderationStatus", "visibility", "buttonText", "title", "description", "provider", "category",
        "payoutText", "requiredAction", "geo", "trafficSources", "sourceName"].some(key => typeof offer[key] !== "string")
      || ["minAge", "maxAge", "holdDays"].some(key => offer[key] !== null && (!Number.isSafeInteger(offer[key]) || offer[key] < 0))
      || ["startsAt", "expiresAt"].some(key => offer[key] !== null && (typeof offer[key] !== "string"
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(offer[key])))
      || !Array.isArray(offer.allowedDecisions) || offer.allowedDecisions.some(value => !["approved", "changes_requested", "rejected"].includes(value))
      || ["canModerate", "canChangeVisibility", "publicVisibilityEnabled"].some(key => typeof offer[key] !== "boolean")) fail("invalid_response");
    return data;
  }
  async readSubscriptionReview(params = {}, { signal } = {}) {
    exact(params, []);
    return readAdminSubscriptionReviewDTO(await this.#request(`${API}admin/subscription-review`, { signal }));
  }
  mutate(action, payload, target) {
    if (!this.canMutate) return Promise.reject(new CabinetClientError("writes_unavailable"));
    if (this.#uncertain) return Promise.reject(new CabinetClientError("outcome_unknown"));
    const signature = `${action}\n${JSON.stringify(payload)}\n${JSON.stringify(target)}`;
    if (this.#pending) return this.#pending.signature === signature ? this.#pending.promise
      : Promise.reject(new CabinetClientError("request_in_progress"));
    const support = action === "support.reply" || action === "support.close", key = support ? this.#uuid() : this.#key();
    const request = buildAdminActionRequest(action, payload, target);
    const promise = this.#request(request.path, { method: "POST", body: request.body, key })
      .then(data => {
        if (action.startsWith('subscription.review.')) {
          const fields = ['status', 'decision', 'ledgerEntryId', 'accessApplied', 'refunded', 'accessChanged', 'reason', 'authorization'];
          const apply = action.endsWith('.apply');
          if (Object.keys(data).some(field => !fields.includes(field)) || data.decision !== (apply ? 'apply' : 'refund')
            || !['applied', 'duplicate', 'manual_review', 'unknown', 'pending', 'attempted', 'admitted'].includes(data.status)
            || apply && (data.ledgerEntryId !== target.ledgerEntryId || typeof data.accessApplied !== 'boolean')
            || apply && data.status === 'applied' && data.accessApplied !== true
            || !apply && (typeof data.refunded !== 'boolean'
              || ['applied', 'duplicate'].includes(data.status) && data.refunded !== true)) fail('outcome_unknown');
          try { data.authorization = readAuthorizationDTO(data.authorization, request.capability); }
          catch { fail('outcome_unknown'); }
          if (['manual_review', 'unknown', 'pending', 'attempted', 'admitted'].includes(data.status)) {
            this.#uncertain = true; this.#uncertainReason = 'payment_review_unknown';
          }
          return data;
        }
        if (!["committed", "unchanged"].includes(data.commitStatus)) fail("outcome_unknown");
        try { data.authorization = readAuthorizationDTO(data.authorization, request.capability); }
        catch { fail("outcome_unknown"); }
        // A durable receipt can acknowledge an earlier commit even when a
        // later policy decision is denied. The next action reauthorizes.
        if (support && data.deliveryState === "unknown") {
          this.#uncertain = true; this.#uncertainReason = "delivery_unknown";
        }
        return data;
      }).catch(error => { if (error.code === "outcome_unknown") { this.#uncertain = true; this.#uncertainReason = "outcome_unknown"; } throw error; })
      .finally(() => { this.#pending = null; });
    this.#pending = { signature, promise }; return promise;
  }
}
