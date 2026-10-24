// Telegram commands have platform provenance, not a fabricated Mini App
// session. These brands live only inside this Worker and cannot survive JSON.
const updates = new WeakSet();
const callbacks = new WeakSet();
const contexts = new WeakSet();
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};
const encoder = new TextEncoder();
const integer = n => Number.isSafeInteger(n) && n > 0;
const fail = () => { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request', status: 400 }); };
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
};
const epoch = gate => gate?.accessScope === 'admin'
  ? `${gate.candidateSha}:${gate.revision}:admin`
  : `${gate?.candidateSha??'legacy'}:${gate?.revision??0}:participant:${gate?.issuedAt}`;
async function signature(secret, payload) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512) fail();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))).slice(0, 12);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
export async function cabinetCallback({ op, target, version = 0, actor, gate, expiresAt, secret,
  nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!/^(pa|pr|bg|oa|op|om|or|ov)$/u.test(op) || !/^([1-9][0-9]*|[a-z0-9_-]{3,24})$/u.test(String(target)) ||
      !integer(actor) || !Number.isSafeInteger(version) || version < 0 || !integer(expiresAt) ||
      expiresAt <= nowSeconds || expiresAt > Math.min(gate.expiresAt, nowSeconds + 300)) fail();
  const body = `r14:${op}:${target}:${version.toString(36)}:${expiresAt.toString(36)}`;
  const value = body + ':' + await signature(secret, `${actor}:${gate.botId}:${epoch(gate)}:${body}`);
  if (encoder.encode(value).length > 64) fail();
  return value;
}
export async function parseCabinetCallback(value, { actor, gate, secret, nowSeconds }) {
  const match = /^(r14:(pa|pr|bg|oa|op|om|or|ov):([a-z0-9_-]{1,24}):([0-9a-z]{1,8}):([0-9a-z]{1,8})):([A-Za-z0-9_-]{16})$/u.exec(value ?? '');
  if (!match||!integer(nowSeconds)) fail();
  const [, body, op, target, v, e, actual] = match, version = parseInt(v, 36), expiresAt = parseInt(e, 36);
  if (!Number.isSafeInteger(version) || version < 0 || !integer(expiresAt) || expiresAt <= nowSeconds ||
      expiresAt > Math.min(gate.expiresAt, nowSeconds + 300) ||
      !equal(actual, await signature(secret, `${actor}:${gate.botId}:${epoch(gate)}:${body}`))) fail();
  const result = Object.freeze({ op, target, version, expiresAt, actor, botId: gate.botId, epoch: epoch(gate), value });
  callbacks.add(result);
  return result;
}
export async function readVerifiedCabinetUpdate(request, { env, gate, nowSeconds }) {
  const url = new URL(request.url);
  if (!integer(nowSeconds)||request.method !== 'POST' || url.pathname !== '/webhook' || url.origin !== gate.origin || url.search ||
      typeof env.WEBHOOK_SECRET !== 'string' || env.WEBHOOK_SECRET.length < 16 ||
      !equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET) ||
      !/^application\/json(?:\s*;|$)/iu.test(request.headers.get('Content-Type') ?? '')) return null;
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^[0-9]{1,6}$/u.test(declared) || Number(declared) > 65536)) return null;
  const reader = request.clone().body?.getReader(); if (!reader) return null;
  const chunks = []; let size = 0, timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('body_timeout')), 5000); });
    for (;;) { const next = await Promise.race([reader.read(), deadline]); if (next.done) break;
      size += next.value.length; if (size > 65536) return null; chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const update = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!update || typeof update !== 'object' || Array.isArray(update) ||
        !Number.isSafeInteger(update.update_id) || update.update_id < 0) return null;
    const callback = update.callback_query, message = callback?.message ?? update.message, from = callback?.from ?? message?.from;
    if (!integer(from?.id) || from.is_bot === true || message?.chat?.type !== 'private' || message.chat.id !== from.id ||
        message.forward_origin || message.sender_chat || message.business_connection_id) return null;
    if (callback && (message.from?.id !== gate.botId || message.from?.is_bot !== true || typeof callback.id !== 'string')) return null;
    const date = Number(update.message?.date);
    const freshMessage = integer(date) && date <= nowSeconds + 30 && nowSeconds - date <= 300 &&
      (gate.accessScope === 'admin' || date >= gate.issuedAt);
    if (!callback && !freshMessage) return null;
    const authenticated = Object.freeze({ update: deepFreeze(update), actor: from.id, botId: gate.botId, freshMessage,
      nowSeconds, epoch: epoch(gate) });
    updates.add(authenticated); return authenticated;
  } catch { return null; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
export function createVerifiedTelegramCommandContext({ authentication, gate, callback = null,
  claimToken, receiptExpiresAt, nowSeconds }) {
  if (!updates.has(authentication) || authentication.botId !== gate.botId || authentication.epoch !== epoch(gate) ||
      authentication.actor!==gate.canonicalAdminId||!integer(nowSeconds)||
      !/^[0-9a-f]{40}$/u.test(gate.candidateSha??'')||!integer(gate.revision)||
      nowSeconds !== authentication.nowSeconds || typeof claimToken !== 'string' || claimToken.length < 16 ||
      !integer(receiptExpiresAt) || receiptExpiresAt <= nowSeconds) fail();
  let expiresAt = Math.min(nowSeconds + 300, gate.expiresAt, receiptExpiresAt);
  if (authentication.update.callback_query) {
    if (!callbacks.has(callback) || callback.actor !== authentication.actor || callback.botId !== gate.botId ||
        callback.epoch !== epoch(gate) || callback.value !== authentication.update.callback_query.data) fail();
    expiresAt = Math.min(expiresAt, callback.expiresAt);
  } else if (!authentication.freshMessage) fail();
  if (!integer(expiresAt) || expiresAt <= nowSeconds) fail();
  const context = Object.freeze({ contextVersion: 1, authoritySource: 'verified_telegram_update',
    telegramId: authentication.actor, botId: gate.botId, updateId: authentication.update.update_id,
    claimToken, issuedAt: nowSeconds, expiresAt, candidateSha: gate.candidateSha, revision: gate.revision });
  contexts.add(context); return context;
}
export const isVerifiedTelegramCommandContext = value => contexts.has(value);
