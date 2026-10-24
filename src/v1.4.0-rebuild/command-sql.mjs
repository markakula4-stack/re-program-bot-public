// Fixed compiler for server-created P04–P06 plans. Client JSON never supplies
// a table, SQL fragment, column, command plan or reference.
export class CabinetStorageError extends Error {
  constructor(code, status = 503) {
    super(code); this.name = "CabinetStorageError"; this.code = code; this.status = status;
  }
}
const fail = () => { throw new CabinetStorageError("invalid_server_command"); };
const snake = value => value.replace(/[A-Z]/gu, x => `_${x.toLowerCase()}`);
const fields = (text) => new Set(text.split(" "));
const TABLES = Object.freeze({
  partner_applications: fields("telegramId displayName contact ageConfirmed status rejectionReason reviewedBy reviewedAt submittedAt updatedAt"),
  partner_application_decisions: fields("applicationId decision actorId actorRole reason eventKey createdAt"),
  partner_profiles: fields("telegramId applicationId displayName contact status approvedBy approvedAt updatedAt"),
  user_roles: fields("telegramId role status assignedBy assignedAt updatedAt"),
  partner_public_settings: fields("telegramId publicUsernameEnabled updatedAt"),
  partner_legal_profiles: fields("partnerProfileId profileKind verificationState revision declaredBy declaredAt verifiedBy verifiedAt updatedAt"),
  partner_legal_profile_events: fields("partnerProfileId fromKind toKind fromRevision toRevision actorId actorRole eventKey createdAt"),
  offers: fields("code buttonText title description provider category url urlEnvKey payoutText requiredAction minAge maxAge geo holdDays trafficSources sourceName startsAt expiresAt status sortOrder createdAt updatedAt"),
  offer_owners: fields("offerCode ownerKind partnerProfileId createdBy createdAt updatedBy updatedAt"),
  offer_versions: fields("offerCode versionNumber snapshotSchemaVersion snapshotJson businessStatus contentHash createdBy createdAt"),
  offer_visibility_rules: fields("offerCode moderationStatus visibility currentVersionId submittedVersionId approvedVersionId publishedAt updatedBy updatedAt"),
  partner_offer_links: fields("offerCode partnerLinkId selectedBy selectedAt updatedAt"),
  offer_moderation_decisions: fields("offerCode offerVersionId decision fromStatus toStatus actorId actorRole reason eventKey createdAt"),
  offer_visibility_assignments: fields("offerCode telegramId assignmentStatus assignedBy assignedAt revokedBy revokedAt updatedAt"),
  offer_visibility_assignment_events: fields("offerCode offerVersionId telegramId action actorId actorRole reason eventKey createdAt"),
  lead_requests: fields("id telegramId inviterId offerCode status rewardKopecks rejectionReason reviewedBy reviewedAt createdAt updatedAt"),
  lead_partner_attribution: fields("leadId partnerLinkId partnerProfileId programCode attributedAt"),
  lead_request_events: fields("eventKey requestHash leadId operation eventKind statusFrom statusTo actorTelegramId actorRole offerCode rewardKopecks reason occurredAt"),
  conversions: fields("telegramId inviterId offerCode status rewardKopecks updatedAt"),
  admin_audit_log: fields("actorId action entityType entityId details createdAt"),
});
const ACTIONS = Object.freeze({
  partner_applications: { insert_unique_telegram_id: "insert", compare_and_swap: "update" },
  partner_application_decisions: { append_unique_event: "insert" },
  partner_profiles: { insert_if_absent_same_application: "ignore" },
  user_roles: { upsert_exact_role: "upsert" },
  partner_public_settings: { insert_default_if_absent: "ignore", insert_unique_telegram_id: "insert", compare_and_swap: "update" },
  partner_legal_profiles: { insert_unique_profile: "insert", compare_and_swap: "update" },
  partner_legal_profile_events: { append_unique_event: "insert" },
  offers: { insert_unique_code_if_limit: "insert", compare_and_swap_current_version: "update" },
  offer_owners: { insert_partner_owner: "insert", touch_owned_partner_offer: "update" },
  offer_versions: { append_version_with_inserted_id: "insert", append_next_version: "insert" },
  offer_visibility_rules: { insert_private_rule: "insert", compare_and_swap_reset_private: "update",
    compare_and_swap_submission: "update", compare_and_swap_moderation_after_event: "update",
    compare_and_swap_visibility_after_event: "update" },
  partner_offer_links: { upsert_owned_approved_route: "upsert", delete_owned_route: "delete" },
  offer_moderation_decisions: { append_unique_event: "insert" },
  offer_visibility_assignments: { upsert_active: "upsert", compare_and_swap_revoke: "update" },
  offer_visibility_assignment_events: { append_unique_event: "insert" },
  lead_requests: { insert_unique_subject_offer: "insert", compare_and_swap_rejected_to_pending: "update", compare_and_swap_result: "update" },
  lead_partner_attribution: { insert_once_for_inserted_lead: "insert", backfill_once_if_absent_and_inviter_matches: "insert" },
  lead_request_events: { append_unique_event: "insert" },
  conversions: { upsert_compatibility_after_canonical_cas: "upsert" },
  admin_audit_log: { append_if_offer_created: "insert", append_if_version_created: "insert", append_after_canonical_cas: "insert" },
});
const KEYS = Object.freeze({
  partner_applications: ["telegramId"], partner_profiles: ["telegramId"],
  user_roles: ["telegramId", "role"], partner_public_settings: ["telegramId"],
  partner_legal_profiles: ["partnerProfileId"], offers: ["code"],
  offer_owners: ["offerCode"], offer_visibility_rules: ["offerCode"],
  partner_offer_links: ["offerCode"], offer_visibility_assignments: ["offerCode", "telegramId"],
  lead_requests: ["id"], conversions: ["telegramId", "offerCode"],
});
const OPERATIONS = /^(?:partner_application\.(?:submit|resubmit|approve|reject)|partner_profile\.repair|partner_legal_profile\.declare|partner_public_username\.set|partner_offer\.(?:create_draft|create_version|submit|approved|changes_requested|rejected|set_visibility|assignment)|lead\.(?:submit|resubmit|confirm|reject|mark_paid))$/u;
const textTime = value => typeof value === "number"
  ? new Date(value * 1000).toISOString().slice(0, 19).replace("T", " ") : value;

export function compileCabinetCommand(command) {
  if (command?.commandVersion !== 1 || !OPERATIONS.test(command.operation) ||
      !Array.isArray(command.writes) || command.writes.length > 12 ||
      (command.writes.length && command.transactionRequired !== true)) fail();
  const version = command.writes.find(w => w.table === "offer_versions")?.values;
  const lead = command.writes.find(w => w.table === "lead_requests")?.values;
  const application = command.writes.find(w => w.table === "partner_applications")?.values;
  const valueSql = (value, name, params) => {
    if (value === "inserted_version_id") {
      if (!version) fail();
      params.push(version.offerCode, version.versionNumber);
      return "(SELECT id FROM offer_versions WHERE offer_code = ? AND version_number = ?)";
    }
    if (value === "inserted_lead_id") {
      if (!lead) fail();
      params.push(lead.telegramId, lead.offerCode);
      return "(SELECT id FROM lead_requests WHERE telegram_id = ? AND offer_code = ?)";
    }
    if (value === "inserted_application_id") {
      if (!application) fail();
      params.push(application.telegramId);
      return "(SELECT id FROM partner_applications WHERE telegram_id = ?)";
    }
    if (value === undefined || (value !== null && !["string", "number", "boolean"].includes(typeof value))) fail();
    params.push(typeof value === "boolean" ? Number(value) : /At$/u.test(name) ? textTime(value) : value);
    return "?";
  };
  return command.writes.map(write => {
    const { table, action, values } = write;
    const kind = ACTIONS[table]?.[action];
    if (!kind || !values || Object.keys(values).some(k => !TABLES[table].has(k))) fail();
    const params = [];
    const names = Object.keys(values);
    const keys = [...(KEYS[table] ?? [])];
    const addKey = (key, value) => {
      params.push(value); return `${snake(key)} = ?`;
    };
    let sql;
    if (["insert", "ignore", "upsert"].includes(kind)) {
      const expressions = names.map(k => valueSql(values[k], k, params));
      sql = `INSERT INTO ${table} (${names.map(snake).join(", ")}) VALUES (${expressions.join(", ")})`;
      // Ignore only the expected canonical key. A different UNIQUE/CHECK/FK
      // failure must roll back approval instead of silently skipping a profile.
      if (kind === "ignore") sql += ` ON CONFLICT (${keys.map(snake).join(", ")}) DO NOTHING`;
      if (kind === "upsert") {
        const changes = names.filter(k => !keys.includes(k));
        sql += ` ON CONFLICT (${keys.map(snake).join(", ")}) DO UPDATE SET ${changes.map(k => `${snake(k)} = excluded.${snake(k)}`).join(", ")}`;
      }
    } else {
      // Canonical row keys are fixed by the server plan, never arbitrary WHERE.
      if (table === "partner_applications" && write.key) keys.splice(0, keys.length, "id");
      const getKey = k => values[k] ?? (k === "id" ? write.key : k === "code" || k === "offerCode" ? write.key ?? command.offerCode : undefined);
      if (keys.length === 0 || keys.some(k => getKey(k) === undefined)) fail();
      const updates = names.filter(k => !keys.includes(k));
      if (kind === "update") {
        if (!updates.length) fail();
        sql = `UPDATE ${table} SET ${updates.map(k => `${snake(k)} = ${valueSql(values[k], k, params)}`).join(", ")}`;
      } else sql = `DELETE FROM ${table}`;
      const where = keys.map(k => addKey(k, getKey(k)));
      if (write.expectedStatus && write.expectedStatus !== "missing") where.push(addKey("status", write.expectedStatus));
      if (table === "lead_requests") where.push(addKey("status", command.compareAndSwap.fromStatus));
      if (table === "partner_legal_profiles") where.push(addKey("revision", command.compareAndSwap.fromRevision));
      if (table === "offer_visibility_rules" && write.expectedCurrentVersionId) where.push(addKey("currentVersionId", write.expectedCurrentVersionId));
      if (table === "offers" && write.expectedVersionId) {
        params.push(write.expectedVersionId);
        where.push("EXISTS (SELECT 1 FROM offer_visibility_rules WHERE offer_code = offers.code AND current_version_id = ?)");
      }
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    return Object.freeze({ sql, params, minChanges: kind === "ignore" ? 0 : 1, maxChanges: 1 });
  });
}
