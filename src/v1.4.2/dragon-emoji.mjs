import { readRuntimeAuthorization, requireRuntimeAuthorization } from '../v1.4.1/runtime-authorizer.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { projectSubscriptionAccess } from './subscription-access.mjs';
import { REGISTERED_DRAGON_EMOJI } from './dragon-emoji-asset.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const assetVerified = asset => asset && Object.isFrozen(asset) && asset.setName === 'RE_Dragon'
  && typeof asset.customEmojiId === 'string' && /^[1-9][0-9]{0,19}$/u.test(asset.customEmojiId)
  && typeof asset.fileUniqueId === 'string' && /^[\x21-\x7e]{1,256}$/u.test(asset.fileUniqueId)
  && asset.width === 100 && asset.height === 100 && asset.isAnimated === false && asset.isVideo === false
  && asset.needsRepainting === false && positive(asset.verifiedAt);

// GET remains a bounded, read-only own projection. Asset verification happens
// once before release; no Telegram call, status write or grant occurs here.
// The surrounding subscription reader retains its final canonical source fence.
export function readOwnDragonEmojiDescriptor(authorization) {
  requireRuntimeAuthorization(authorization);
  const access = projectSubscriptionAccess(authorization);
  const { context } = readRuntimeAuthorization(authorization), identity = readTrustedContext(context);
  const current = access.current;
  const active = current.status === 'verified' && current.planCode === 'dragon'
    && current.activeDragon === true && current.previewActive === false && current.accessOverlay === 'none'
    && ['active', 'cancel_at_period_end', 'payment_failed'].includes(current.accessState) && current.durationKind === 'finite'
    && ['stars', 'package_payment', 'referral_bonus'].includes(current.sourceKind)
    && positive(current.expiresAt) && current.expiresAt > identity.nowSeconds
    && positive(current.remainingSeconds) && access.sessionExpiresAt > identity.nowSeconds;
  // Owner exception is deliberately absent from the eligibility predicate.
  // An owner with genuine paid Dragon follows exactly the customer timeline.
  const reasonCode = !assetVerified(REGISTERED_DRAGON_EMOJI) ? 'dragon_custom_emoji_not_configured'
    : identity.env.V142_DRAGON_EMOJI_ENABLED !== 'true' ? 'dragon_emoji_disabled'
      : !active ? 'active_dragon_required' : 'eligible';
  const available = reasonCode === 'eligible';
  return Object.freeze({ available, reasonCode,
    customEmojiId: available ? REGISTERED_DRAGON_EMOJI.customEmojiId : null });
}
