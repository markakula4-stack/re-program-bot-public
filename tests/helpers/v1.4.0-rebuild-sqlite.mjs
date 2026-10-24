import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { reviewedRepositoryFactory } from '../../src/v1.4.0-rebuild/storage-factory.mjs';
import { createD1CabinetRepository } from "../../src/v1.4.0-rebuild/d1-cabinet-repository.mjs";
import { createCabinetHttp, withCabinetTrustedService } from "../../src/v1.4.0-rebuild/cabinet-http.mjs";

export const ORIGIN = "https://cabinet.example";
export const BOT_TOKEN = "123456789:synthetic-token-for-offline-tests-only";
let sequence = 0;
const read = file => fs.readFileSync(new URL("../../" + file, import.meta.url), "utf8");
const baseSource = read("re-program-bot-worker.js");
const baseTables = ["re_schema_migrations", "users", "user_access", "user_roles",
  "partner_applications", "partner_profiles", "partner_public_settings", "offers",
  "partner_programs", "program_offers", "partner_links", "partner_link_clicks",
  "lead_partner_attribution", "lead_requests", "conversions", "admin_audit_log",'notifications','notification_settings','privacy_deletion_requests'];

class Statement {
  constructor(binding, sql, params = []) { this.binding = binding; this.sql = sql; this.params = params; }
  bind(...params) {
    if (params.length > 100) throw new Error("D1 bound parameter limit");
    return new Statement(this.binding, this.sql, params);
  }
  async first(column) {
    const row = this.binding.sqlite.prepare(this.sql).get(...this.params) ?? null;
    this.binding.audit.push({ sql: this.sql, params: this.params, mode: "read" });
    return column ? row?.[column] ?? null : row;
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  execute() {
    const prepared = this.binding.sqlite.prepare(this.sql);
    const isRead = prepared.columns().length > 0;
    this.binding.audit.push({ sql: this.sql, params: this.params, mode: isRead ? "read" : "write" });
    if (isRead) return { success: true, results: prepared.all(...this.params), meta: { changes: 0 } };
    const result = prepared.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}
export class SqliteD1 {
  constructor(sqlite) { this.sqlite = sqlite; this.audit = []; this.sessions = []; }
  prepare(sql) {
    if (/\b(?:FROM|JOIN)\s+pragma_[a-z_]+\s*\(/iu.test(sql)) throw new Error("D1 has no table-valued PRAGMA functions");
    if (new TextEncoder().encode(sql).length > 100000) throw new Error("D1 SQL length limit");
    for (const match of sql.matchAll(/\b(json_object|json_set|json_patch)\s*\(/gu)) {
      let depth = 1, args = 1, quoted = false;
      for (let i = match.index + match[0].length; i < sql.length && depth; i++) {
        const character = sql[i];
        if (character === "'") {
          if (quoted && sql[i + 1] === "'") { i++; continue; }
          quoted = !quoted; continue;
        }
        if (quoted) continue;
        if (character === "(") depth++;
        else if (character === ")") depth--;
        else if (character === "," && depth === 1) args++;
      }
      if (args > 32) throw new Error("D1 SQL function argument limit");
    }
    return new Statement(this, sql);
  }
  withSession(mode) { this.sessions.push(mode); return this; }
  async batch(statements) {
    const isCommand = statements[0]?.sql.startsWith("INSERT INTO mini_app_command_receipts");
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook({ statements, isCommand, sqlite: this.sqlite });
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    const result = [];
    try {
      for (let index = 0; index < statements.length; index++) {
        if (this.failStatement?.(statements[index].sql, index)) {
          this.failStatement = null;
          throw new Error("injected SQL failure");
        }
        result.push(statements[index].execute());
      }
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    if (isCommand && this.loseCommandResponse) {
      this.loseCommandResponse = false;
      throw new Error("connection lost after COMMIT");
    }
    return result;
  }
}
export function signedInitData(id, now, fields = {}) {
  const data = { auth_date: String(now), query_id: "offline_" + ++sequence,
    user: JSON.stringify({ id, first_name: "Offline test" }), ...fields };
  const check = Object.entries(data).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + "=" + value).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...data, hash }).toString();
}
export function fixture({ adapters = {}, exactSchema = false, expand = true } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const sqlite = new DatabaseSync(":memory:");
  if (exactSchema) {
    const objects=JSON.parse(fs.readFileSync(new URL('../fixtures/base-schema.json',import.meta.url),'utf8')).objects;
    if (!objects) throw new Error('exact schema missing');
    for (const kind of ['table','index','view','trigger']) for (const row of objects) {
      if (row.type===kind&&row.sql&&!row.name.startsWith('_cf_')) sqlite.exec(row.sql);
    }
    sqlite.exec('INSERT INTO partner_beta_settings(id) VALUES(1)');
  }
  for (const table of exactSchema?[]:baseTables) {
    const start = baseSource.indexOf("CREATE TABLE IF NOT EXISTS " + table + " (");
    const end = baseSource.indexOf("`", start);
    if (start < 0 || end < start) throw new Error("accepted base DDL missing: " + table);
    sqlite.exec(baseSource.slice(start, end));
  }
  if(!exactSchema)sqlite.exec(read('migrations/0024-v1.3.5-final-security.sql').split('CREATE TABLE IF NOT EXISTS telegram_ingress_rate_limits')[0]);
  for (const name of ["0017-v1.3.4-partner-beta-foundation.sql",
    "0018-v1.3.4-partner-offer-drafts.sql", "0019-v1.3.4-partner-offer-moderation.sql"]) {
    sqlite.exec(read("migrations/" + name));
  }
  sqlite.exec(read("migrations/0021-v1.3.5-plan-foundation.sql"));
  for (const [file, table] of [["0025-v1.3.5-dragon-preview-hotfix.sql", "trial_grants"],
    ["0039-v1.3.9-ambassador-attribution.sql", "ambassador_profiles_v2"]]) {
    const source = read("migrations/" + file);
    const start = source.indexOf("CREATE TABLE IF NOT EXISTS " + table + " (");
    const end = source.indexOf("\n);", start);
    sqlite.exec(source.slice(start, end + 3));
  }
  for (const file of expand?["0057-v1.4.0-rebuild-mini-app-storage.sql",
    "0058-v1.4.0-rebuild-legal-history.sql", "0059-v1.4.0-rebuild-lead-history.sql",'0060-v1.4.0-rebuild-effect-privacy.sql','0061-v1.4.0-rebuild-release-lease.sql']:[]) {
    sqlite.exec(read("migrations/" + file));
  }
  for (const id of [101, 202, 303, 404, 900]) {
    sqlite.prepare("INSERT INTO users (telegram_id, referral_code, accepted_terms) VALUES (?, ?, 1)").run(id, "synthetic_" + id);
    sqlite.prepare("INSERT INTO user_roles (telegram_id, role, status) VALUES (?, 'user', 'active')").run(id);
    sqlite.prepare("INSERT INTO user_access (telegram_id, access_tier) VALUES (?, 'free')").run(id);
  }
  sqlite.exec("INSERT INTO user_roles (telegram_id, role, status) VALUES (900, 'admin', 'active')");
  const binding = new SqliteD1(sqlite);
  const repositoryFactory = exactSchema?reviewedRepositoryFactory:(env, options) => createD1CabinetRepository(env.DB, options);
  const baseEnv = { DB: binding, BOT_TOKEN, REBUILD_V140_BOT_ID: "123456789",
    MINI_APP_ORIGIN: ORIGIN, REBUILD_V140_OWNER_WINDOW: `true:${now - 1}:${now + 600}`,
    MINI_APP_CURSOR_SECRET: "offline-cursor-secret-at-least-thirty-two-bytes",
    MINI_APP_IDEMPOTENCY_SECRET: "offline-idempotency-secret-at-least-thirty-two-bytes",
    REBUILD_V140_STORAGE_ENABLED:'true',REBUILD_V140_WRITES_ENABLED: "true", REBUILD_V140_OFFER_ACTIONS_ENABLED: "true",
    PARTNER_BETA_ENABLED: "true", PARTNER_PRIVATE_OFFERS_ENABLED: "true",
    PARTNER_OFFER_SUBMISSIONS_ENABLED: "true", PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED: "true",
    PLAN_COMPATIBILITY_DUAL_READ_ENABLED: "false", PLAN_CANONICAL_READ_ENABLED: "false",
    DRAGON_PREVIEW_ENABLED: "true" };
  const env = id => ({ ...baseEnv, OWNER_TELEGRAM_ID: String(id) });
  const http = createCabinetHttp({ repositoryFactory, clock: () => now, adapters });
  const tokens = new Map();
  const call = async (id, path, { method = "GET", payload, key = "offline_request_" + ++sequence,
    headers = {}, token = tokens.get(id), rawBody, customEnv } = {}) => {
    const requestHeaders = { ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(method === "POST" ? { Origin: ORIGIN, "Content-Type": "application/json",
        "Idempotency-Key": key, "Sec-Fetch-Site": "same-origin" } : {}), ...headers };
    const request = new Request(ORIGIN + "/api/v1.4.0/cabinet/" + path, {
      method, headers: requestHeaders,
      ...(method === "POST" ? { body: rawBody ?? JSON.stringify(payload) } : {}),
    });
    const response = await http(request, customEnv ?? env(id));
    return { response, status: response.status, data: await response.json() };
  };
  const session = async (id, initData = signedInitData(id, now)) => {
    const result = await call(id, "session", { method: "POST", payload: { initData }, token: null });
    if (result.status !== 200) throw new Error("session failed: " + JSON.stringify(result.data));
    tokens.set(id, result.data.sessionToken);
    return { ...result, initData };
  };
  const trusted = (id, action, payload, target, key = "offline_trusted_" + ++sequence) =>
    withCabinetTrustedService({ env: env(id), sessionToken: tokens.get(id), repositoryFactory,
      clock: () => now, adapters, run: service => service.trusted(action, payload, target, key) });
  const grantBeta = profileId => {
    sqlite.prepare("INSERT INTO partner_beta_access (partner_profile_id, granted_by) VALUES (?, 900)").run(profileId);
    sqlite.exec("UPDATE partner_beta_settings SET enabled = 1, private_offers_enabled = 1, submissions_enabled = 1, public_visibility_enabled = 1");
  };
  const seedRoute = profileId => {
    sqlite.exec("INSERT OR IGNORE INTO offers (code, button_text, title, status) VALUES ('bank_catalog', 'Открыть', 'Каталог', 'active')");
    sqlite.exec("INSERT OR IGNORE INTO partner_programs (code, name, allowed_domains, status) VALUES ('bank_program', 'Тест Банк', 'bank.example', 'active')");
    sqlite.exec("INSERT OR IGNORE INTO program_offers (id, program_code, offer_code, status) VALUES (17, 'bank_program', 'bank_catalog', 'active')");
    const id = 70 + profileId;
    sqlite.prepare(`INSERT INTO partner_links
      (id, partner_profile_id, catalog_offer_id, url, tracking_key, ownership_confirmed, traffic_confirmed, status)
      VALUES (?, ?, 17, 'https://go.bank.example/path?ref=approved', ?, 1, 1, 'approved')`)
      .run(id, profileId, "offline_route_" + profileId);
    return id;
  };
  return { sqlite, binding, now, env, baseEnv, tokens, repositoryFactory, http, call, session, trusted, grantBeta, seedRoute,
    close: () => sqlite.close() };
}
export async function approvedPartner(f, id = 202) {
  if (!f.tokens.has(id)) await f.session(id);
  if (!f.tokens.has(900)) await f.session(900);
  const submitted = await f.call(id, "partner/application", { method: "POST",
    payload: { displayName: "Партнёр Тест", contact: "@synthetic", ageConfirmed: true } });
  if (submitted.status !== 200) throw new Error("partner apply: " + JSON.stringify(submitted));
  const applicationId = f.sqlite.prepare("SELECT id FROM partner_applications WHERE telegram_id = ?").get(id).id;
  await f.trusted(900, "admin.partner.review", { decision: "approve" }, { applicationId });
  const profileId = f.sqlite.prepare("SELECT id FROM partner_profiles WHERE telegram_id = ?").get(id).id;
  f.grantBeta(profileId); // Fixture represents an explicit existing admin Beta grant.
  return { profileId, applicationId, linkId: f.seedRoute(profileId) };
}
export async function publishedOffer(f, id = 202, partner = null) {
  const authority = partner ?? await approvedPartner(f, id);
  const created = await f.call(id, "offers", { method: "POST", payload: {} });
  if (created.status !== 200) throw new Error("offer create: " + JSON.stringify(created));
  const code = created.data.offerCode;
  const patch = { buttonText: "Открыть оффер", title: "Проверенный оффер",
    description: "Подробные условия партнёрского оффера", provider: "Тест Банк", category: "debit",
    payoutText: "До 1000 рублей", requiredAction: "Выполнить условия банка", minAge: 18, maxAge: 70,
    geo: "Россия", holdDays: 30, trafficSources: "Telegram", sourceName: "Официальная программа",
    startsAt: "2026-01-01", expiresAt: "2027-09-01", partnerLinkId: authority.linkId };
  const edited = await f.call(id, "offers/" + code + "/version", { method: "POST", payload: { version: 1, patch } });
  if (edited.status !== 200) throw new Error("offer edit: " + JSON.stringify(edited));
  await f.trusted(id, "offer.business", { version: 2, desiredBusinessStatus: "active" }, { code });
  const submitted = await f.call(id, "offers/" + code + "/submit", { method: "POST", payload: { version: 3 } });
  if (submitted.status !== 200) throw new Error("offer submit: " + JSON.stringify(submitted));
  await f.trusted(900, "admin.offer.moderate", { version: 3, decision: "approved" }, { code });
  await f.trusted(900, "admin.offer.visibility", { version: 3, visibility: "public" }, { code });
  return { ...authority, code };
}
