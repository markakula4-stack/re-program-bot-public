// Retain bounded, redacted provider diagnostics only in the private audit log.
// Numeric API errors do not establish provider state or an actual HTTP status.
const codes = new Set(['charge_id_invalid', 'user_id_invalid']);
const numeric = value => typeof value === 'string' && /^telegram_[1-5][0-9]{2}$/u.test(value)
  && !value.includes('\n') && !value.includes('\r');

function safeDescription(value, redactions = []) {
  if (typeof value !== 'string' || !value.length || value.length > 4096) return null;
  let text = value;
  for (const secret of [...new Set(redactions.filter(v => typeof v === 'string' && v.length >= 3))].sort((a,b) => b.length-a.length))
    text = text.split(secret).join('[redacted]');
  const opaque = part => part.length<=96 && /^[A-Z]{2,}(?:_[A-Z]{2,})+$/u.test(part) ? part : '[redacted]';
  return text.replace(/(?:https?:\/\/|tg:\/\/|t\.me\/)[^\s]+/gi,'[redacted]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{16,}\b/g,'[redacted]')
    .replace(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi,'[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g,opaque)
    .replace(/\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){2,}\b/g,opaque)
    .replace(/\b\d{5,}\b/g,'[redacted]')
    .replace(/\b(?:token|password|secret|charge(?:_id)?)\s*[:=]\s*\S+/gi,'[redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,512);
}

export async function describeTelegramCommandError(method, data, httpStatus, {redactions=[]}={}) {
  if (method !== 'editUserStarSubscription') return null;
  const description = data?.description;
  const validDescription = typeof description === 'string' && description.length > 0 && description.length <= 4096;
  const match = validDescription ? /^(?:Bad Request: )?(CHARGE_ID_INVALID|USER_ID_INVALID)$/i.exec(description) : null;
  const code = match && match[0] === description ? match[1].toLowerCase() : 'unclassified';
  const digest = validDescription ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(description)) : null;
  return Object.freeze({
    telegramApiErrorCode: Number.isSafeInteger(data?.error_code) && data.error_code >= 100 && data.error_code <= 599 ? data.error_code : null,
    telegramHttpStatus: Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    telegramDescriptionCode: code,
    telegramDescriptionSha256: digest ? [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('') : null,
    telegramDescriptionSafe: code !== 'unclassified' ? 'Bad Request: '+match[1].toUpperCase() : safeDescription(description,redactions),
    telegramDescriptionTruncated: validDescription && description.length > 512,
    telegramDescriptionRecorded: false,
  });
}

export function telegramCommandDiagnosticStatement(db, row, error, actorId=row.telegram_id) {
  if(error?.method !== 'editUserStarSubscription') return null;
  const number=v=>Number.isSafeInteger(v)&&v>=100&&v<=599?v:null;
  const details={version:1,method:error.method,code:telegramCommandReason(error),
    apiErrorCode:number(error.telegramApiErrorCode),httpStatus:number(error.telegramHttpStatus),
    descriptionCode:codes.has(error.telegramDescriptionCode)?error.telegramDescriptionCode:'unclassified',
    descriptionSafe:codes.has(error.telegramDescriptionCode)?'Bad Request: '+error.telegramDescriptionCode.toUpperCase():safeDescription(error.telegramDescriptionSafe),
    descriptionSha256:typeof error.telegramDescriptionSha256==='string'&&/^[a-f0-9]{64}$/.test(error.telegramDescriptionSha256)?error.telegramDescriptionSha256:null,
    descriptionTruncated:error.telegramDescriptionTruncated===true};
  return db.prepare(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,details)
    VALUES(?,'subscription_provider_diagnostic','subscription_provider_command',?,?)`)
    .bind(actorId,row.command_id,JSON.stringify(details));
}

export function telegramCommandReason(error) {
  const base = String(error?.code || 'telegram_provider_outcome_unknown').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 64);
  if (error?.method !== 'editUserStarSubscription' || !numeric(base)) return base;
  if (codes.has(error.telegramDescriptionCode)) return `${base}_${error.telegramDescriptionCode}`;
  if (typeof error.telegramDescriptionSha256 === 'string' && /^[a-f0-9]{64}$/u.test(error.telegramDescriptionSha256)
      && error.telegramDescriptionSha256.length === 64)
    return `${base}_detail_${error.telegramDescriptionSha256.slice(0, 16)}`;
  return base;
}
