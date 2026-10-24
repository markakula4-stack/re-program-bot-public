import {
  AI_PARTNER_MODEL_ALIASES,
  AI_PARTNER_POLICY_VERSION,
  AI_PARTNER_PROMPT_VERSION,
  normalizeAiPartnerDraftType,
} from "./ai-partner-foundation.mjs";
import {
  loadApprovedAiPartnerFactBundle,
  validateAiPartnerModelOutput,
} from "./ai-partner-draft-runtime.mjs";
import { assertOwnerDraftClaims } from "./ai-partner-owner-factuality-part4.mjs";

// The model may propose a draft; only the owner can consume a confirmation.
// No production Worker imports this module during Part 2.
export const AI_PARTNER_OWNER_WRITE_TOOLS = Object.freeze([
  "save_own_draft",
  "save_own_draft_version",
]);

const ACTIONS = new Set(AI_PARTNER_OWNER_WRITE_TOOLS);
const TOKEN = /^w38_[A-Za-z0-9_-]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEY = /^[A-Za-z0-9:_-]{16,160}$/;
const HASH = /^[0-9a-f]{64}$/;
const CONFIRMATION_SECONDS = 600;
const encoder = new TextEncoder();

function writeError(code, cause) {
  const error = new Error("AI Partner confirmed owner write rejected");
  error.name = "AiPartnerOwnerWriteError";
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function exactInput(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw writeError("write_input_invalid");
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw writeError("write_input_field_denied");
  }
  return input;
}

function ownerContext(env, actorTelegramId) {
  const actor = Number(actorTelegramId);
  const owner = Number(env?.ADMIN_ID);
  if (!Number.isSafeInteger(actor) || actor <= 0 ||
    !Number.isSafeInteger(owner) || owner <= 0 || actor !== owner) {
    throw writeError("write_owner_only");
  }
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw writeError("write_database_not_ready");
  }
  if (env.AI_PARTNER_OWNER_WRITE_TOOLS_ENABLED !== "true" ||
    env.AI_PARTNER_ENABLED !== "true" ||
    env.AI_PARTNER_ROLLOUT_MODE !== "admin") {
    throw writeError("write_feature_disabled");
  }
  return { owner, db: env.DB };
}

function timestamp(value) {
  const at = value === undefined ? Math.floor(Date.now() / 1_000) : value;
  if (!Number.isSafeInteger(at) || at < 1_600_000_000 || at > 9_999_999_999) {
    throw writeError("write_clock_invalid");
  }
  return at;
}

function id(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw writeError("write_draft_id_invalid");
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw writeError("write_payload_invalid");
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

async function sha256(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomId() {
  if (!globalThis.crypto?.randomUUID) throw writeError("write_crypto_not_ready");
  return globalThis.crypto.randomUUID();
}

function randomToken() {
  if (!globalThis.crypto?.getRandomValues) throw writeError("write_crypto_not_ready");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  const base64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `w38_${base64}`;
}

function title(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw writeError("write_title_invalid");
  }
  return value;
}

async function ownDraft(db, owner, draftId, draftType) {
  const draft = await db.prepare(
    `SELECT draft_id, owner_telegram_id, draft_type, draft_state,
            current_version_no
     FROM ai_drafts WHERE draft_id = ? AND owner_telegram_id = ?`,
  ).bind(draftId, owner).first();
  if (!draft || draft.draft_state !== "draft" ||
    draft.draft_type !== draftType) {
    throw writeError("write_own_draft_required");
  }
  return draft;
}

async function validatedPreview(env, owner, payload, at) {
  if (env.AI_PARTNER_OWNER_CONFIRMATION_UX_ENABLED === "true") {
    assertOwnerDraftClaims(payload.output);
  }
  const bundle = await loadApprovedAiPartnerFactBundle(env, {
    actorTelegramId: owner,
    ownerTelegramId: owner,
    factSourceIds: payload.factSourceIds,
    generatedAt: at,
  });
  const result = validateAiPartnerModelOutput({
    draftType: payload.draftType,
    output: payload.output,
    factBundle: bundle,
  });
  return Object.freeze({
    ...result,
    contentHash: await sha256(result.content),
  });
}

function requestId(intentId, versionOrigin = "ai") {
  return `${versionOrigin === "user" ? "a138we" : "a138wr"}:${intentId}`;
}

function publicVersion(row, replayed) {
  return Object.freeze({
    draftId: String(row.draft_id),
    versionId: String(row.version_id),
    versionNo: Number(row.version_no),
    content: String(row.content),
    contentHash: String(row.content_hash),
    replayed,
    autoPublished: false,
  });
}

async function storedVersion(db, owner, intentId) {
  return db.prepare(
    `SELECT version.version_id, version.draft_id, version.version_no,
            version.content, version.content_hash
     FROM ai_draft_versions version
     JOIN ai_drafts draft ON draft.draft_id = version.draft_id
     WHERE version.request_id IN (?, ?)
       AND draft.owner_telegram_id = ?`,
  ).bind(requestId(intentId), requestId(intentId, "user"), owner).first();
}

export async function prepareOwnerConfirmedDraftWrite(env, input) {
  exactInput(input, [
    "actorTelegramId", "actionType", "draftId", "requestKey", "draftType",
    "title", "output", "factSourceIds", "at", "intentId", "versionOrigin",
    "modelAlias",
  ]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  const at = timestamp(input.at);
  const action = input.actionType;
  if (!ACTIONS.has(action)) throw writeError("write_action_denied");
  if (typeof input.requestKey !== "string" || !REQUEST_KEY.test(input.requestKey)) {
    throw writeError("write_request_key_invalid");
  }
  const draftType = normalizeAiPartnerDraftType(input.draftType);
  const cleanTitle = title(input.title);
  const draft = action === "save_own_draft_version"
    ? await ownDraft(db, owner, id(input.draftId), draftType)
    : null;
  if (action === "save_own_draft" && input.draftId != null) {
    throw writeError("write_new_draft_target_denied");
  }
  const versionOrigin = input.versionOrigin ?? "ai";
  const modelAlias = input.modelAlias ?? AI_PARTNER_MODEL_ALIASES.safe;
  if (!(
    (versionOrigin === "ai" && modelAlias === AI_PARTNER_MODEL_ALIASES.safe) ||
    (versionOrigin === "user" &&
      modelAlias === AI_PARTNER_MODEL_ALIASES.humanEdit && draft)
  )) throw writeError("write_version_mode_denied");
  const intentId = input.intentId === undefined ? randomId() : id(input.intentId);
  const plannedDraftId = draft ? String(draft.draft_id) : randomId();
  const expectedCurrentVersionNo = draft ? Number(draft.current_version_no) : 0;
  const payload = {
    draftType,
    title: cleanTitle,
    output: input.output,
    factSourceIds: input.factSourceIds,
    plannedDraftId,
    expectedCurrentVersionNo,
    versionOrigin,
    modelAlias,
  };
  const preview = await validatedPreview(env, owner, payload, at);
  const payloadJson = canonicalJson(payload);
  if (payloadJson.length > 12_000) throw writeError("write_payload_too_large");
  const payloadHash = await sha256(payloadJson);
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = at + CONFIRMATION_SECONDS;
  await expireOwnerPreparedDraftWrites(env, { actorTelegramId: owner, at });
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO ai_partner_write_intents (
           intent_id, owner_telegram_id, action_type, target_draft_id,
           request_key, payload_hash, confirmation_token_hash, issued_at,
           expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(intentId, owner, action, draft ? plannedDraftId : null,
        input.requestKey, payloadHash, tokenHash, at, expiresAt),
      db.prepare(
        `INSERT INTO ai_partner_write_payloads (
           intent_id, owner_telegram_id, planned_draft_id,
           expected_current_version_no, draft_type, title,
           fact_source_ids_json, template_json, preview_hash, prepared_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(intentId, owner, plannedDraftId, expectedCurrentVersionNo,
        draftType, cleanTitle, JSON.stringify(preview.factSourceIds), payloadJson,
        preview.contentHash, at),
      db.prepare(
        `INSERT INTO ai_partner_write_events (
           event_id, event_key, intent_id, owner_telegram_id,
           event_type, occurred_at
         ) VALUES (?, ?, ?, ?, 'prepared', ?)`,
      ).bind(randomId(), `write:prepared:${intentId}`, intentId, owner, at),
    ]);
  } catch (cause) {
    const existing = await db.prepare(
      `SELECT intent_id FROM ai_partner_write_intents
       WHERE owner_telegram_id = ? AND action_type = ? AND request_key = ?`,
    ).bind(owner, action, input.requestKey).first();
    if (existing) throw writeError("write_request_replay_conflict", cause);
    throw writeError("write_prepare_failed", cause);
  }
  return Object.freeze({
    intentId,
    actionType: action,
    draftId: plannedDraftId,
    expectedCurrentVersionNo,
    preview: preview.content,
    previewHash: preview.contentHash,
    confirmationToken: token,
    expiresAt,
    autoPublished: false,
  });
}

async function readIntent(db, owner, tokenHash) {
  return db.prepare(
    `SELECT intent.intent_id, intent.owner_telegram_id, intent.action_type,
            intent.target_draft_id, intent.payload_hash, intent.intent_state,
            intent.issued_at, intent.expires_at, intent.resolved_at,
            payload.planned_draft_id, payload.expected_current_version_no,
            payload.draft_type, payload.title, payload.fact_source_ids_json,
            payload.template_json, payload.preview_hash
     FROM ai_partner_write_intents intent
     LEFT JOIN ai_partner_write_payloads payload
       ON payload.intent_id = intent.intent_id
     WHERE intent.confirmation_token_hash = ? AND intent.owner_telegram_id = ?`,
  ).bind(tokenHash, owner).first();
}

export async function consumeOwnerConfirmedDraftWrite(env, input) {
  exactInput(input, ["actorTelegramId", "confirmationToken", "at"]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  const at = timestamp(input.at);
  const token = input.confirmationToken;
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw writeError("write_confirmation_invalid");
  }
  const tokenHash = await sha256(token);
  const intent = await readIntent(db, owner, tokenHash);
  if (!intent) throw writeError("write_confirmation_denied");
  if (intent.intent_state === "consumed") {
    const version = await storedVersion(db, owner, intent.intent_id);
    if (!version) throw writeError("write_receipt_missing");
    return publicVersion(version, true);
  }
  if (intent.intent_state !== "pending") throw writeError("write_confirmation_used");
  if (at < Number(intent.issued_at) || at >= Number(intent.expires_at)) {
    throw writeError("write_confirmation_expired");
  }
  if (!intent.template_json || !HASH.test(String(intent.payload_hash))) {
    throw writeError("write_prepared_payload_missing");
  }
  if (await sha256(String(intent.template_json)) !== intent.payload_hash) {
    throw writeError("write_prepared_payload_mismatch");
  }
  const payload = JSON.parse(String(intent.template_json));
  const versionOrigin = payload.versionOrigin ?? "ai";
  const modelAlias = payload.modelAlias ?? AI_PARTNER_MODEL_ALIASES.safe;
  if (payload.plannedDraftId !== intent.planned_draft_id ||
    payload.expectedCurrentVersionNo !== Number(intent.expected_current_version_no) ||
    payload.draftType !== intent.draft_type || payload.title !== intent.title ||
    !(
      (versionOrigin === "ai" &&
        modelAlias === AI_PARTNER_MODEL_ALIASES.safe) ||
      (versionOrigin === "user" &&
        modelAlias === AI_PARTNER_MODEL_ALIASES.humanEdit &&
        intent.action_type === "save_own_draft_version")
    ) ||
    JSON.stringify([...payload.factSourceIds].sort()) !==
      JSON.stringify(JSON.parse(String(intent.fact_source_ids_json)).sort())) {
    throw writeError("write_prepared_payload_mismatch");
  }
  const preview = await validatedPreview(env, owner, payload, at);
  if (preview.contentHash !== intent.preview_hash) {
    throw writeError("write_preview_changed");
  }
  const existing = intent.action_type === "save_own_draft_version";
  if (existing) {
    const draft = await ownDraft(db, owner, intent.planned_draft_id, payload.draftType);
    if (Number(draft.current_version_no) !== payload.expectedCurrentVersionNo ||
      draft.draft_id !== intent.target_draft_id) {
      throw writeError("write_stale_draft_version");
    }
  } else if (intent.target_draft_id !== null) {
    throw writeError("write_prepared_payload_mismatch");
  }
  const draftId = String(intent.planned_draft_id);
  const versionId = randomId();
  const versionNo = Number(intent.expected_current_version_no) + 1;
  const statements = [
    db.prepare(
      `UPDATE ai_partner_write_intents
       SET intent_state = 'consumed', resolved_at = ?, revision = revision + 1
       WHERE intent_id = ? AND owner_telegram_id = ?
         AND confirmation_token_hash = ? AND intent_state = 'pending'
         AND issued_at <= ? AND expires_at > ?`,
    ).bind(at, intent.intent_id, owner, tokenHash, at, at),
    db.prepare(
      `INSERT INTO ai_partner_write_events (
         event_id, event_key, intent_id, owner_telegram_id,
         event_type, occurred_at
       ) VALUES (?, ?, ?, ?, 'confirmed', ?)`,
    ).bind(randomId(), `write:confirmed:${intent.intent_id}`, intent.intent_id, owner, at),
  ];
  if (!existing) {
    statements.push(db.prepare(
      `INSERT INTO ai_drafts (
         draft_id, request_key, owner_telegram_id, draft_type, draft_state,
         title, current_version_no, policy_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'draft', ?, 0, ?, ?, ?)`,
    ).bind(draftId, `write-draft:${intent.intent_id}`, owner, payload.draftType,
      payload.title, AI_PARTNER_POLICY_VERSION, at, at));
  }
  statements.push(db.prepare(
    `INSERT INTO ai_draft_versions (
       version_id, version_key, request_id, draft_id, version_no,
       version_origin, generation_state, content, structured_payload_json,
       fact_source_ids_json, warnings_json, content_hash, model_alias,
       prompt_version, schema_version, policy_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, '[]', ?, ?, ?, 1, ?, ?)`,
  ).bind(versionId, `draft-version:${draftId}:${versionNo}`,
    requestId(intent.intent_id, versionOrigin), draftId, versionNo, versionOrigin,
    preview.content,
    canonicalJson({ ...preview.structuredPayload, requestFingerprint: intent.payload_hash }),
    JSON.stringify(preview.factSourceIds), preview.contentHash,
    modelAlias, AI_PARTNER_PROMPT_VERSION,
    AI_PARTNER_POLICY_VERSION, at));
  statements.push(db.prepare(
    `DELETE FROM ai_partner_write_payloads
     WHERE intent_id = ? AND owner_telegram_id = ?`,
  ).bind(intent.intent_id, owner));
  try {
    await db.batch(statements);
  } catch (cause) {
    const after = await readIntent(db, owner, tokenHash);
    if (after?.intent_state === "consumed") {
      const replay = await storedVersion(db, owner, intent.intent_id);
      if (replay) return publicVersion(replay, true);
    }
    throw writeError("write_commit_failed", cause);
  }
  const result = await storedVersion(db, owner, intent.intent_id);
  if (!result || result.content_hash !== preview.contentHash) {
    throw writeError("write_receipt_missing");
  }
  return publicVersion(result, false);
}

export async function cancelOwnerConfirmedDraftWrite(env, input) {
  exactInput(input, ["actorTelegramId", "confirmationToken", "at"]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  const at = timestamp(input.at);
  if (typeof input.confirmationToken !== "string" ||
    !TOKEN.test(input.confirmationToken)) {
    throw writeError("write_confirmation_invalid");
  }
  const intent = await readIntent(db, owner, await sha256(input.confirmationToken));
  if (!intent || intent.intent_state !== "pending") {
    throw writeError("write_confirmation_used");
  }
  if (at < Number(intent.issued_at) || at >= Number(intent.expires_at)) {
    throw writeError("write_confirmation_expired");
  }
  try {
    await db.batch([
      db.prepare(
        `UPDATE ai_partner_write_intents
         SET intent_state = 'cancelled', resolved_at = ?, revision = revision + 1
         WHERE intent_id = ? AND owner_telegram_id = ? AND intent_state = 'pending'
           AND issued_at <= ? AND expires_at > ?`,
      ).bind(at, intent.intent_id, owner, at, at),
      db.prepare(
        `INSERT INTO ai_partner_write_events (
           event_id, event_key, intent_id, owner_telegram_id,
           event_type, occurred_at
         ) VALUES (?, ?, ?, ?, 'cancelled', ?)`,
      ).bind(randomId(), `write:cancelled:${intent.intent_id}`, intent.intent_id, owner, at),
      db.prepare(
        `DELETE FROM ai_partner_write_payloads
         WHERE intent_id = ? AND owner_telegram_id = ?`,
      ).bind(intent.intent_id, owner),
    ]);
  } catch (cause) {
    throw writeError("write_cancel_failed", cause);
  }
  return Object.freeze({ cancelled: true, autoPublished: false });
}

// Call on owner activity; a future Worker scheduler may call this periodically.
export async function expireOwnerPreparedDraftWrites(env, input) {
  exactInput(input, ["actorTelegramId", "at"]);
  const { owner, db } = ownerContext(env, input.actorTelegramId);
  const at = timestamp(input.at);
  const rows = await db.prepare(
    `SELECT intent_id FROM ai_partner_write_intents
     WHERE owner_telegram_id = ? AND intent_state = 'pending'
       AND expires_at <= ?
     ORDER BY expires_at, intent_id LIMIT 20`,
  ).bind(owner, at).all();
  let expired = 0;
  for (const row of rows.results) {
    const intentId = String(row.intent_id);
    try {
      await db.batch([
        db.prepare(
          `UPDATE ai_partner_write_intents
           SET intent_state = 'expired', resolved_at = ?, revision = revision + 1
           WHERE intent_id = ? AND owner_telegram_id = ?
             AND intent_state = 'pending' AND expires_at <= ?`,
        ).bind(at, intentId, owner, at),
        db.prepare(
          `INSERT INTO ai_partner_write_events (
             event_id, event_key, intent_id, owner_telegram_id,
             event_type, occurred_at
           ) VALUES (?, ?, ?, ?, 'expired', ?)`,
        ).bind(randomId(), `write:expired:${intentId}`, intentId, owner, at),
        db.prepare(
          `DELETE FROM ai_partner_write_payloads
           WHERE intent_id = ? AND owner_telegram_id = ?`,
        ).bind(intentId, owner),
      ]);
      expired += 1;
    } catch (cause) {
      const current = await db.prepare(
        `SELECT intent_state FROM ai_partner_write_intents
         WHERE intent_id = ? AND owner_telegram_id = ?`,
      ).bind(intentId, owner).first();
      if (current?.intent_state === "pending") {
        throw writeError("write_expiry_cleanup_failed", cause);
      }
    }
  }
  return Object.freeze({ expired });
}
