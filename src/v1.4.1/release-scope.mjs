import { canonicalCabinetOwnerId } from '../v1.4.0-rebuild/cabinet-participants.mjs';

// This helper only narrows already compiled server switches. It authenticates
// nobody and grants no role: callers must verify the actual transport/session
// and account first, never pass an actor selected from a request body.
export function scopeV141ReleaseActor(env, verifiedActor) {
  const mode=env?.V141_RELEASE_MODE;
  if(mode===undefined || mode==='enabled') return env;
  if(!['default_off','owner_only','recovery'].includes(mode)) {
    throw Object.assign(new Error('v141_release_scope_invalid'),{code:'v141_release_scope_invalid',status:503});
  }
  const telegramId=typeof verifiedActor==='number' ? verifiedActor : verifiedActor?.telegramId;
  if(mode==='owner_only' && Number.isSafeInteger(telegramId) && telegramId>0 &&
      telegramId===canonicalCabinetOwnerId(env)) return env;
  if(env.V141_AUTHORIZATION_ENABLED==='false' && env.V141_LEGACY_COMPATIBILITY_ENABLED==='false') return env;
  return {...env,V141_AUTHORIZATION_ENABLED:'false',V141_LEGACY_COMPATIBILITY_ENABLED:'false'};
}
