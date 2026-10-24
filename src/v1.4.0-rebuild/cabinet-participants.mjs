import { loadCabinetActor, hasRole, authorityError } from './cabinet-authority.mjs';

const safeId = value => /^[1-9][0-9]*$/u.test(String(value)) &&
  Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function canonicalCabinetOwnerId(env) {
  const admin = safeId(env?.ADMIN_ID);
  if (!admin) return null;
  // ADMIN_ID is the accepted bot's canonical authority. Some inherited
  // environments omit OWNER_TELEGRAM_ID; an explicit conflicting value fails closed.
  return env?.OWNER_TELEGRAM_ID === undefined || safeId(env.OWNER_TELEGRAM_ID) === admin ? admin : null;
}

export function readCabinetAdminGate(env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const ownerTelegramId = canonicalCabinetOwnerId(env), botId = safeId(env?.REBUILD_V140_BOT_ID);
  const revision = Number(env?.REBUILD_V140_RELEASE_REVISION);
  let origin;
  try { origin = new URL(env?.MINI_APP_ORIGIN); } catch { return null; }
  if (env?.REBUILD_V140_ADMIN_ACCESS_ENABLED !== 'true' || env?.REBUILD_V140_RELEASE_LEASE_REQUIRED !== 'true' ||
      env?.REBUILD_V140_STORAGE_ENABLED !== 'true' || !ownerTelegramId || !botId ||
      !/^[0-9a-f]{40}$/u.test(env?.REBUILD_V140_RC_SHA ?? '') || !Number.isSafeInteger(revision) || revision < 1 ||
      origin.protocol !== 'https:' || origin.origin !== env.MINI_APP_ORIGIN || !Number.isSafeInteger(nowSeconds)) return null;
  return Object.freeze({ accessScope: 'admin', candidateSha: env.REBUILD_V140_RC_SHA, revision,
    ownerTelegramId, canonicalAdminId:ownerTelegramId, botId, origin: origin.origin, issuedAt: nowSeconds, expiresAt: nowSeconds + 300 });
}

// The selected participant remains the sole D1 lease owner. The inherited
// canonical owner can use that same finite lease with their own identity;
// another admin, request field or additional environment flag cannot join it.
export function isCabinetWindowParticipant(env, gate, telegramId) {
  if (!Number.isSafeInteger(telegramId) || telegramId < 1 || !gate) return false;
  if (gate.accessScope === 'admin') return env?.REBUILD_V140_ADMIN_ACCESS_ENABLED === 'true' &&
    telegramId === canonicalCabinetOwnerId(env) && gate.ownerTelegramId === telegramId &&
    gate.candidateSha === env.REBUILD_V140_RC_SHA && gate.revision === Number(env.REBUILD_V140_RELEASE_REVISION);
  return telegramId === gate.ownerTelegramId ||
    (env?.REBUILD_V140_RELEASE_LEASE_REQUIRED === 'true' &&
      telegramId === canonicalCabinetOwnerId(env));
}

export async function loadCabinetWindowActor({ repo, env, gate, telegramId, nowSeconds }) {
  if (!gate || !Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(gate.issuedAt) ||
      !Number.isSafeInteger(gate.expiresAt) || gate.expiresAt - gate.issuedAt > 1200 || gate.issuedAt > nowSeconds ||
      gate.expiresAt <= nowSeconds || !isCabinetWindowParticipant(env, gate, telegramId)) {
    authorityError('identity_mismatch', 401);
  }
  const actor = await loadCabinetActor(repo, telegramId);
  if (telegramId !== gate.ownerTelegramId || telegramId === canonicalCabinetOwnerId(env)) {
    if (!hasRole(actor, 'admin')) authorityError('admin_required');
    if (actor.user.acceptedTerms !== 1 && actor.user.acceptedTerms !== true) authorityError('terms_required');
    const deleting = await repo.select('privacy_deletion_requests',
      "telegram_id=? AND status='pending' AND unixepoch(expires_at)>?", [telegramId, nowSeconds], 'request_id', 1);
    if (deleting.length) authorityError('actor_deleting');
  }
  return actor;
}
