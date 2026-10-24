import { CabinetStorageError, compileCabinetCommand } from "./command-sql.mjs";
import {isVerifiedTelegramCommandContext} from './telegram-command-authority.mjs';

const TABLES = new Set([
  "users", "user_roles", "user_access", "user_plans", "user_access_states", "trial_grants",
  "partner_applications", "partner_profiles", "partner_public_settings", "partner_beta_access",
  "partner_beta_settings", "partner_legal_profiles", "partner_legal_profile_events",
  "partner_application_decisions", "offers", "offer_owners", "offer_versions",
  "offer_visibility_rules", "offer_visibility_assignments", "partner_offer_links",
  "partner_links", "partner_programs", "program_offers", "partner_link_clicks",
  "lead_requests", "lead_partner_attribution", "lead_request_events", "conversions",
  "ambassador_profiles_v2", "mini_app_init_data_receipts", "mini_app_sessions",
  "mini_app_command_receipts", "mini_app_atomic_guards", "mini_app_effect_outbox",
  "mini_app_effect_claims", "mini_app_privacy_guard", "mini_app_privacy_denials",
  "notifications", "notification_settings", "privacy_deletion_requests",
  "mini_app_release_control", "telegram_update_receipts",
  "partner_beta_access_events", "admin_audit_log",
]);
const REQUIRED = Object.freeze({
  mini_app_init_data_receipts: ["init_data_fingerprint", "receipt_id", "bot_id", "telegram_id", "auth_date", "received_at", "expires_at", "query_id_hash"],
  mini_app_sessions: ["session_id", "session_token_hash", "init_data_fingerprint", "bot_id", "telegram_id", "token_version", "status", "issued_at", "expires_at", "revoked_at"],
  mini_app_command_receipts: ["idempotency_key", "request_hash", "actor_telegram_id", "bot_id", "operation", "response_json", "commit_status", "committed_at", "precondition_ok"],
  mini_app_atomic_guards: ["guard_key", "precondition_ok"],
  mini_app_effect_outbox: ["dedupe_key", "command_key", "effect_kind", "payload_json", "status", "created_at", "delivered_at"],
  partner_legal_profiles: ["partner_profile_id", "profile_kind", "verification_state", "revision", "declared_by", "declared_at", "verified_by", "verified_at", "updated_at"],
  partner_legal_profile_events: ["event_key", "partner_profile_id", "from_kind", "to_kind", "from_revision", "to_revision", "actor_id", "actor_role", "created_at"],
  lead_request_events: ["event_key", "request_hash", "lead_id", "operation", "event_kind", "status_from", "status_to", "actor_telegram_id", "actor_role", "offer_code", "reward_kopecks", "reason", "occurred_at"],
});
const camel = key => key.replace(/_([a-z])/gu, (_, x) => x.toUpperCase());
export const databaseRow = row => row == null ? null : Object.freeze({
  authoritySource: "database", ...Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])),
});
export const databaseSeconds = value => {
  if (Number.isSafeInteger(value)) return value;
  if (value == null || value === "") return null;
  const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
};
const unavailable = () => { throw new CabinetStorageError("storage_unavailable"); };
const asStatement = (db, sql, params = []) => {
  if (params.length > 100 || new TextEncoder().encode(sql).length > 100000) unavailable();
  return db.prepare(sql).bind(...params);
};
const schemaCache = new WeakMap(); // Schema metadata only; never user/session rows.
const UNIQUE_KEYS = Object.freeze({
  users: [["telegram_id"]], user_roles: [["telegram_id", "role"]],
  partner_applications: [["telegram_id"]], partner_profiles: [["telegram_id"], ["application_id"]],
  offers: [["code"]], offer_owners: [["offer_code"]], offer_versions: [["offer_code", "version_number"]],
  offer_visibility_rules: [["offer_code"]], offer_visibility_assignments: [["offer_code", "telegram_id"]],
  lead_requests: [["telegram_id", "offer_code"]], conversions: [["telegram_id", "offer_code"]],
  lead_partner_attribution: [["lead_id"]],
  mini_app_init_data_receipts: [["init_data_fingerprint"], ["receipt_id"]],
  mini_app_sessions: [["session_id"], ["session_token_hash"], ["init_data_fingerprint"]],
  mini_app_command_receipts: [["idempotency_key"]], mini_app_atomic_guards: [["guard_key"]],
  mini_app_effect_outbox: [["dedupe_key"]], partner_legal_profiles: [["partner_profile_id"]],
  partner_legal_profile_events: [["event_key"]], lead_request_events: [["event_key"]],
});
const rows = result => {
  if (result?.success === false || !Array.isArray(result?.results)) unavailable();
  return result.results;
};

// Construct one repository per HTTP request. Authentication starts on primary;
// a captured SELECT is replayed in the same atomic batch as its command.
// This adapter targets the UNRELEASED local fixture. The default Worker does
// not instantiate it until live inventory and the final schema are approved.
export function createD1CabinetRepository(binding, { trackReads = true, readOnly = false, schemaManifest = null } = {}) {
  if (!binding?.prepare || !binding?.batch || !binding?.withSession) unavailable();
  const db = binding.withSession("first-primary");
  const snapshots = new Map();
  const columns = new Map();
  const deadlines = new Set();
  const aggregates = new Map(); // Request-local; never shared between actors.
  const stmt = (sql, params) => asStatement(db, sql, params);
  const readColumns = async table => {
    if (!TABLES.has(table)) unavailable();
    if (!columns.has(table)) {
      const result = rows(await stmt(`PRAGMA table_info("${table}")`).all());
      const names = result.map(x => x.name);
      if (!names.length || names.some(x => !/^[a-z][a-z0-9_]*$/u.test(x))) unavailable();
      columns.set(table, names);
    }
    return columns.get(table);
  };
  const readQuery = async (query, bound, names) => {
    if (!/^SELECT /u.test(query) || query.includes(";") ||
        names.some(k => !/^[a-z][a-z0-9_]*$/u.test(k))) unavailable();
    // D1 limits a function to 32 arguments. Preserve SQL NULLs as JSON null;
    // json_patch would delete null keys. json_set takes <=15 pairs per chunk.
    let objectSql = `json_object(${names.slice(0, 16).map(k => `'${k}', q.${k}`).join(", ")})`;
    for (let i = 16; i < names.length; i += 15) {
      objectSql = `json_set(${objectSql}, ${names.slice(i, i + 15).map(k => `'$.${k}', q.${k}`).join(", ")})`;
    }
    const sql = `SELECT json_group_array(${objectSql}) AS snapshot FROM (${query}) q`;
    const key = `${sql}\n${JSON.stringify(bound)}`;
    const saved = snapshots.get(key);
    if (saved) return JSON.parse(saved.snapshot).map(databaseRow);
    const result = await stmt(sql, bound).first();
    if (typeof result?.snapshot !== "string") unavailable();
    if (trackReads) {
      const prior = snapshots.get(key);
      if (prior && prior.snapshot !== result.snapshot) {
        throw new CabinetStorageError("state_conflict", 409);
      }
      snapshots.set(key, { sql, params: bound, snapshot: result.snapshot });
      if (snapshots.size > (readOnly ? 512 : 40) ||
          [...snapshots.values()].reduce((n, v) => n + v.snapshot.length, 0) > (readOnly ? 2097152 : 131072)) unavailable();
    }
    let parsed;
    try { parsed = JSON.parse(result.snapshot); } catch { unavailable(); }
    if (!Array.isArray(parsed)) unavailable();
    return parsed.map(databaseRow);
  };
  const select = async (table, where = "1", params = [], order = "", limit = null) => {
    const names = await readColumns(table);
    const query = `SELECT ${names.join(", ")} FROM ${table} WHERE ${where}${order ? ` ORDER BY ${order}` : ""}${limit === null ? "" : " LIMIT ?"}`;
    return readQuery(query, limit === null ? params : [...params, limit], names);
  };
  const one = async (...args) => {
    const result = await select(...args);
    if (result.length > 1) unavailable();
    return result[0] ?? null;
  };
  const guard = ({ context, gate }) => {
    if (!context || !gate || !Number.isSafeInteger(gate.expiresAt)) unavailable();
    const conditions = ["unixepoch() < ?", "unixepoch() < ?"];
    const params = [context.expiresAt, gate.expiresAt];
    if(isVerifiedTelegramCommandContext(context)){
      if(context.telegramId!==gate.canonicalAdminId||context.botId!==gate.botId||context.candidateSha!==gate.candidateSha||context.revision!==gate.revision)unavailable();
      conditions.push(`EXISTS(SELECT 1 FROM telegram_update_receipts WHERE update_id=? AND actor_id=?
        AND status='processing' AND claim_token=? AND lease_expires_at>unixepoch())`,
      'EXISTS(SELECT 1 FROM mini_app_release_control WHERE id=1 AND candidate_sha=? AND revision=?)',
      "EXISTS(SELECT 1 FROM users WHERE telegram_id=? AND accepted_terms=1 AND is_blocked=0)",
      "EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=? AND role='admin' AND status='active')",
      "NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())");
      params.push(context.updateId,context.telegramId,context.claimToken,context.candidateSha,context.revision,
        context.telegramId,context.telegramId,context.telegramId);
    }
    for (const deadline of deadlines) { conditions.push("unixepoch() < ?"); params.push(deadline); }
    for (const snapshot of snapshots.values()) {
      conditions.push(`(${snapshot.sql}) = ?`);
      params.push(...snapshot.params, snapshot.snapshot);
    }
    return { sql: conditions.join(" AND "), params };
  };
  const assertChanged = (key, min, max) => [
    stmt("INSERT INTO mini_app_atomic_guards (guard_key, precondition_ok) VALUES (?, CASE WHEN changes() BETWEEN ? AND ? THEN 1 ELSE 0 END)", [key, min, max]),
  ];
  const receiptFrom = (value, expected) => {
    if (!value || value.requestHash !== expected.requestHash ||
        value.actorTelegramId !== expected.context.telegramId ||
        value.botId !== expected.context.botId || value.operation !== expected.operation) {
      throw new CabinetStorageError("idempotency_conflict", 409);
    }
    let ack;
    try { ack = JSON.parse(value.responseJson); } catch { unavailable(); }
    if (!["committed", "unchanged"].includes(ack?.commitStatus)) unavailable();
    return { ...ack, commitStatus: "unchanged" };
  };
  return Object.freeze({
    db, select, one, readQuery,
    async commitTrustedBatch({statements,context,gate}){
      if(readOnly||!Array.isArray(statements)||statements.length<1||statements.length>12)unavailable();
      const check=guard({context,gate}),key='trusted_'+crypto.randomUUID();
      await db.batch([stmt(`INSERT INTO mini_app_atomic_guards(guard_key,precondition_ok) VALUES(?,CASE WHEN ${check.sql} THEN 1 ELSE 0 END)`,[key,...check.params]),
        ...statements,stmt('DELETE FROM mini_app_atomic_guards WHERE guard_key=?',[key])]);
    },
    async loadOfferAggregates(codes, telegramId = 0) {
      const missing = [...new Set(codes)].filter(code => !aggregates.has(`${telegramId}:${code}`));
      if (missing.length) {
        const jsonRow = (table, alias, key) => {
          const names = columns.get(table);
          if (!names?.length) unavailable();
          let sql = `json_object(${names.slice(0,16).map(k => `'${k}', ${alias}.${k}`).join(',')})`;
          for (let i=16;i<names.length;i+=15) sql = `json_set(${sql},${names.slice(i,i+15).map(k => `'$.${k}',${alias}.${k}`).join(',')})`;
          return `CASE WHEN ${alias}.${key} IS NULL THEN NULL ELSE ${sql} END`;
        };
        for (const table of ['offers','offer_owners','offer_visibility_rules','offer_versions','partner_offer_links',
          'partner_links','program_offers','partner_profiles','partner_programs','offer_visibility_assignments']) await readColumns(table);
        const specs = [['offer_json','offers','o','code'],['owner_json','offer_owners','own','offer_code'],
          ['rule_json','offer_visibility_rules','r','offer_code'],['version_json','offer_versions','v','id'],
          ['link_json','partner_links','link','id'],['catalog_json','program_offers','catalog','id'],
          ['profile_json','partner_profiles','p','id'],['program_json','partner_programs','program','code'],
          ['destination_json','offers','destination','code'],['assignment_json','offer_visibility_assignments','a','offer_code']];
        const found = await readQuery(`SELECT o.code, ${specs.map(([name,table,alias,key]) => `${jsonRow(table,alias,key)} AS ${name}`).join(',')}
          FROM offers o LEFT JOIN offer_owners own ON own.offer_code=o.code
          LEFT JOIN offer_visibility_rules r ON r.offer_code=o.code
          LEFT JOIN offer_versions v ON v.id=r.current_version_id AND v.offer_code=o.code
          LEFT JOIN partner_offer_links selected ON selected.offer_code=o.code
          LEFT JOIN partner_links link ON link.id=selected.partner_link_id
          LEFT JOIN program_offers catalog ON catalog.id=link.catalog_offer_id
          LEFT JOIN partner_profiles p ON p.id=link.partner_profile_id
          LEFT JOIN partner_programs program ON program.code=catalog.program_code
          LEFT JOIN offers destination ON destination.code=catalog.offer_code
          LEFT JOIN offer_visibility_assignments a ON a.offer_code=o.code AND a.telegram_id=?
          WHERE o.code IN (SELECT value FROM json_each(?)) ORDER BY o.code`,
          [telegramId,JSON.stringify(missing)],['code',...specs.map(s=>s[0])]);
        for (const code of missing) aggregates.set(`${telegramId}:${code}`,null);
        for (const row of found) {
          const decoded = Object.fromEntries(specs.map(([name]) => {
            const k=camel(name);return [k,row[k]===null?null:databaseRow(JSON.parse(row[k]))];
          }));
          const {linkJson:link,catalogJson:catalog,profileJson:profile,programJson:program,destinationJson:destination}=decoded;
          const route = link&&catalog&&profile&&program&&destination ? Object.freeze({ authoritySource:'database',
            partnerLinkId:link.id,partnerProfileId:link.partnerProfileId,ownerProfileStatus:profile.status,
            partnerLinkStatus:link.status,ownershipConfirmed:link.ownershipConfirmed,trafficConfirmed:link.trafficConfirmed,
            catalogOfferId:catalog.id,catalogOfferCode:catalog.offerCode,catalogOfferStatus:catalog.status,
            programCode:program.code,programStatus:program.status,catalogBusinessStatus:destination.status,
            url:link.url,trackingKey:link.trackingKey,allowedDomains:program.allowedDomains,updatedAt:link.updatedAt }) : null;
          aggregates.set(`${telegramId}:${row.code}`,Object.freeze({offer:decoded.offerJson,owner:decoded.ownerJson,
            visibilityRule:decoded.ruleJson,currentVersion:decoded.versionJson,currentRoute:route,assignment:decoded.assignmentJson}));
        }
      }
      return new Map(codes.map(code => [code,aggregates.get(`${telegramId}:${code}`)]));
    },
    deadline: value => { if (Number.isSafeInteger(value)) deadlines.add(value); },
    async assertReadFence({ context, gate }) {
      const check = guard({ context, gate });
      const statements = [stmt(`SELECT ${check.sql} AS valid`,check.params)];
      // SELECT-only transaction: P07 reads create no audit/guard rows.
      const result = await db.batch(statements);
      if (result.some(x => rows(x)[0]?.valid !== 1)) {
        throw new CabinetStorageError("state_conflict", 409);
      }
    },
    async assertCandidateSchema() {
      const metadataSql = `SELECT json_group_array(json_object('name', name, 'type', type,
        'table_name', tbl_name, 'sql', sql)) AS snapshot FROM
        (SELECT name, type, tbl_name, sql FROM sqlite_schema
         WHERE tbl_name IN (${[...TABLES].map(name => `'${name}'`).join(", ")}) AND sql IS NOT NULL
         ORDER BY type, name) s`;
      const snapshot = (await stmt(metadataSql).first())?.snapshot;
      if (typeof snapshot !== "string") unavailable();
      if (trackReads) snapshots.set(metadataSql, { sql: metadataSql, params: [], snapshot });
      if (schemaManifest) {
        if (schemaManifest.version!==1 || snapshot!==JSON.stringify(schemaManifest.objects)) unavailable();
        for (const [table,names] of Object.entries(schemaManifest.columns)) columns.set(table,names);
        return true;
      }
      const cached = schemaCache.get(binding);
      if (cached?.snapshot === snapshot) {
        for (const [table, names] of cached.columns) columns.set(table, names);
        return true;
      }
      // Actual key/CHECK/history constraints are necessary, while this local
      // schema proof still does NOT constitute fresh LIVE inventory or release.
      const metadata = JSON.parse(snapshot);
      for (const table of metadata.filter(row => row.type === "table")) {
        // D1 rejects table-valued pragma_* functions. Its documented standalone
        // read PRAGMAs are used on schema-cache misses only; hot requests still
        // fence the exact DDL/index/trigger snapshot with one SELECT.
        table.columns = rows(await stmt(`PRAGMA table_info("${table.name}")`).all());
        table.unique_keys = [];
        const indexes = rows(await stmt(`PRAGMA index_list("${table.name}")`).all());
        for (const index of indexes.filter(x => x.unique === 1 && x.partial === 0)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(index.name)) unavailable();
          table.unique_keys.push(rows(await stmt(`PRAGMA index_info("${index.name}")`).all()).map(x => x.name));
        }
        const names = table.columns.map(row => row.name);
        if (names.some(name => !/^[a-z][a-z0-9_]*$/u.test(name))) unavailable();
        columns.set(table.name, names);
      }
      for (const [table, required] of Object.entries(REQUIRED)) {
        const names = columns.get(table) ?? [];
        if (required.some(name => !names.includes(name))) unavailable();
      }
      const normalizeSql = sql => String(sql ?? "").toLowerCase().replace(/[\s"`]/gu, "");
      for (const table of ["mini_app_command_receipts", "mini_app_atomic_guards"]) {
        if (!normalizeSql(metadata.find(r => r.type === "table" && r.name === table)?.sql)
          .includes("check(precondition_ok=1)")) unavailable();
      }
      for (const [table, keys] of Object.entries(UNIQUE_KEYS)) {
        const definition = metadata.find(row => row.name === table && row.type === "table");
        const info = definition?.columns ?? [];
        if (!info.length) unavailable();
        const unique = [info.filter(row => row.pk > 0).sort((a,b) => a.pk - b.pk).map(row => row.name),
          ...(definition.unique_keys ?? [])];
        if (keys.some(key => !unique.some(candidate => candidate.length === key.length &&
          candidate.every((name, i) => name === key[i])))) unavailable();
      }
      for (const table of ["partner_legal_profile_events", "lead_request_events"]) {
        for (const operation of ["update", "delete"]) {
          if (!metadata.some(row => row.type === "trigger" && row.table_name === table &&
              normalizeSql(row.sql).includes("before" + operation) &&
              normalizeSql(row.sql).includes("raise(abort,"))) unavailable();
        }
      }
      schemaCache.set(binding, { snapshot, columns: new Map(columns) });
      return true;
    },
    async establishSession({ receipt, session }) {
      const receiptFields = ["initDataFingerprint", "receiptId", "botId", "telegramId", "queryIdHash", "authDate", "receivedAt", "expiresAt"];
      const sessionFields = ["sessionId", "sessionTokenHash", "initDataFingerprint", "botId", "telegramId", "tokenVersion", "status", "issuedAt", "expiresAt", "revokedAt"];
      const insert = (table, fields, value) => stmt(
        `INSERT INTO ${table} (${fields.map(k => k.replace(/[A-Z]/gu, x => `_${x.toLowerCase()}`)).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
        fields.map(k => value[k]),
      );
      // Recheck the account and all captured authority reads atomically.
      const securityGuard = guard({ context: { expiresAt: session.expiresAt },
        gate: { expiresAt: session.gateExpiresAt } });
      try {
        const result = await db.batch([
          stmt(`INSERT INTO mini_app_atomic_guards VALUES (?, CASE WHEN ${securityGuard.sql}
            AND NOT EXISTS (SELECT 1 FROM mini_app_privacy_denials WHERE init_data_fingerprint=? AND expires_at>unixepoch())
            THEN 1 ELSE 0 END)`, [session.sessionId, ...securityGuard.params,receipt.initDataFingerprint]),
          insert("mini_app_init_data_receipts", receiptFields, receipt),
          ...assertChanged(session.sessionId + ":receipt", 1, 1),
          insert("mini_app_sessions", sessionFields, session),
          ...assertChanged(session.sessionId + ":session", 1, 1),
          stmt("DELETE FROM mini_app_atomic_guards WHERE guard_key IN (?,?,?)", [session.sessionId,session.sessionId+':receipt',session.sessionId+':session']),
          stmt("SELECT session_id FROM mini_app_sessions WHERE session_id = ?", [session.sessionId]),
        ]);
        if (rows(result.at(-1)).length !== 1) unavailable();
        return { accepted: true };
      } catch (error) {
        if (/UNIQUE constraint failed: mini_app_init_data_receipts\.(?:init_data_fingerprint|receipt_id)/u.test(String(error?.message))) {
          return { accepted: false, reason: "replay" };
        }
        unavailable();
      }
    },
    async findReceipt(key) {
      // Receipts are not part of the canonical read set; they arbitrate the
      // unique request key rather than the business transition.
      const row = await stmt("SELECT * FROM mini_app_command_receipts WHERE idempotency_key = ?", [key]).first();
      return databaseRow(row);
    },
    async replayReceipt({ receipt, ...expected }) {
      const ack = receiptFrom(receipt, expected);
      const check = guard(expected);
      const key = "replay_" + crypto.randomUUID();
      const result = await db.batch([
        stmt(`INSERT INTO mini_app_atomic_guards VALUES (?, CASE WHEN ${check.sql} THEN 1 ELSE 0 END)`, [key, ...check.params]),
        stmt("DELETE FROM mini_app_atomic_guards WHERE guard_key = ?", [key]),
      ]);
      if (result.some(x => x.success === false)) unavailable();
      return ack;
    },
    async commit({ command, idempotencyKey, requestHash, operation, context, gate }) {
      const writes = compileCabinetCommand(command);
      const ack = { commitStatus: writes.length ? "committed" : "unchanged",
        ...(command.offerCode ? { offerCode: command.offerCode } : {}) };
      const check = guard({ context, gate });
      const statements = [stmt(
        `INSERT INTO mini_app_command_receipts
          (idempotency_key, request_hash, bot_id, actor_telegram_id, operation,
           commit_status, response_json, committed_at, precondition_ok)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), CASE WHEN ${check.sql} THEN 1 ELSE 0 END)`,
        [idempotencyKey, requestHash, context.botId, context.telegramId, operation,
          ack.commitStatus, JSON.stringify(ack), ...check.params],
      )];
      writes.forEach((write, index) => {
        statements.push(stmt(write.sql, write.params),
          ...assertChanged(`${idempotencyKey}:${index}`, write.minChanges, write.maxChanges));
      });
      for (const effect of command.postCommitEffects ?? []) {
        if (!["notification", "analytics_adapter"].includes(effect.kind) ||
            typeof effect.dedupeKey !== "string") unavailable();
        const leadWrite = command.writes.find(w => w.table === "lead_requests")?.values;
        const payload = { ...effect, recipientTelegramId: effect.recipient === "subject" ? context.telegramId : effect.recipientTelegramId };
        delete payload.recipient;
        const leadSql = effect.leadId === "inserted_lead_id"
          ? "(SELECT id FROM lead_requests WHERE telegram_id = ? AND offer_code = ?)" : "?";
        const leadParams = effect.leadId === "inserted_lead_id"
          ? [leadWrite.telegramId, leadWrite.offerCode] : [effect.leadId];
        statements.push(stmt(
          `INSERT INTO mini_app_effect_outbox
           (dedupe_key, command_key, effect_kind, payload_json, created_at)
           VALUES (?, ?, ?, json_set(?, '$.leadId', ${leadSql}), unixepoch())`,
          [effect.dedupeKey, idempotencyKey, effect.kind, JSON.stringify(payload), ...leadParams],
        ));
      }
      if (writes.length) statements.push(stmt(`DELETE FROM mini_app_atomic_guards WHERE guard_key IN (${writes.map(()=>'?').join(',')})`,writes.map((_,i)=>`${idempotencyKey}:${i}`)));
      statements.push(stmt("SELECT response_json FROM mini_app_command_receipts WHERE idempotency_key = ?", [idempotencyKey]));
      let result;
      try { result = await db.batch(statements); }
      catch (error) {
        // A unique race may have committed in another request. Reconcile only
        // its matching receipt, under this request's fresh authority guard.
        if (/UNIQUE constraint failed: mini_app_command_receipts.idempotency_key|CHECK constraint failed: precondition_ok/u.test(String(error?.message))) {
          const receipt = databaseRow(await asStatement(binding.withSession("first-primary"),
            "SELECT * FROM mini_app_command_receipts WHERE idempotency_key = ?", [idempotencyKey]).first());
          if (receipt) {
            receiptFrom(receipt, { requestHash, operation, context });
            // Our earlier read set changed when the winning command committed.
            // Reconciliation must reload current session/roles/Beta on primary.
            throw new CabinetStorageError("receipt_race", 409);
          }
        }
        if (/CHECK constraint failed: precondition_ok/u.test(String(error?.message))) {
          throw new CabinetStorageError("state_conflict", 409);
        }
        // Connection loss cannot prove rollback. The browser latches unknown
        // outcome and does not repeat a POST automatically.
        unavailable();
      }
      const last = rows(result.at(-1));
      if (result.some(x => x.success === false) || last.length !== 1 ||
          last[0].response_json !== JSON.stringify(ack)) unavailable();
      return ack;
    },
  });
}
