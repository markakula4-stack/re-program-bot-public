import {
  getReferralRewardRolloutDecision,
} from "./referral-reward-candidate-runtime.mjs";
import {
  REFERRAL_REWARD_CALLBACKS,
  claimReferralRewardForUser as claimLegacyReferralRewardForUser,
  getReferralRewardMenuButton as getLegacyReferralRewardMenuButton,
  getReferralRewardUserScreen as getLegacyReferralRewardUserScreen,
} from "./referral-reward-ux-admin-runtime.mjs";

function closedScreen() {
  return Object.freeze({
    state: "closed",
    text:
      "<b>🎁 +3 дня за друга</b>\n\n" +
      "Функция пока недоступна для этого аккаунта.",
    keyboard: [[{ text: "⬅️ В меню", callback_data: "menu" }]],
  });
}

function emptyStateButton() {
  return Object.freeze({
    text: "🎁 +3 дня за друга",
    callback_data: REFERRAL_REWARD_CALLBACKS.status,
  });
}

function rolloutEligible(env, telegramId) {
  return getReferralRewardRolloutDecision(env, telegramId).eligible;
}

export async function getReferralRewardMenuButton(env, options = {}) {
  const existing = await getLegacyReferralRewardMenuButton(env, options);
  if (existing) return existing;
  return rolloutEligible(env, options.telegramId)
    ? emptyStateButton()
    : null;
}

export async function getReferralRewardUserScreen(env, options = {}) {
  const screen = await getLegacyReferralRewardUserScreen(env, options);
  if (screen?.state !== "none") return screen;
  return rolloutEligible(env, options.telegramId) ? screen : closedScreen();
}

export async function claimReferralRewardForUser(env, options = {}) {
  const screen = await claimLegacyReferralRewardForUser(env, options);
  if (screen?.state !== "none") return screen;
  return rolloutEligible(env, options.telegramId) ? screen : closedScreen();
}
