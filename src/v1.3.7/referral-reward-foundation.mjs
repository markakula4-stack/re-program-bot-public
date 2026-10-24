export const REFERRAL_REWARD_PROGRAM_CODE = "first_paid_friend_v1";

export const REFERRAL_REWARD_SECONDS = Object.freeze({
  paymentEligibility: 30 * 24 * 60 * 60,
  protectionHold: 21 * 24 * 60 * 60,
  bonusAccess: 3 * 24 * 60 * 60,
  manualClaimWindow: 30 * 24 * 60 * 60,
});

export const REFERRAL_REWARD_STATES = Object.freeze([
  "pending",
  "confirmed",
  "cancelled",
]);

export const BONUS_GRANT_STATES = Object.freeze([
  "pending",
  "claimable",
  "applied",
  "expired",
  "revoked",
  "manual_review",
]);

const PAID_PLAN_CODES = new Set(["professional", "dragon"]);
const ROLLOUT_MODES = new Set(["off", "admin", "allowlist", "public"]);
const MAX_REASONABLE_UNIX_SECONDS = 4_102_444_800;

function strictFlag(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function rolloutMode(value) {
  const normalized = String(value || "off").trim().toLowerCase();
  return ROLLOUT_MODES.has(normalized) ? normalized : "off";
}

function configuredUnixSeconds(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const timestamp = Number(normalized);
  return Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    timestamp <= MAX_REASONABLE_UNIX_SECONDS
    ? timestamp
    : null;
}

export function requireUnixSeconds(value, fieldName = "timestamp") {
  const normalized =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;

  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    normalized > MAX_REASONABLE_UNIX_SECONDS
  ) {
    throw new TypeError(`${fieldName} must be positive integer Unix seconds`);
  }
  return normalized;
}

function addSeconds(timestamp, seconds, fieldName) {
  const value = requireUnixSeconds(timestamp, fieldName);
  const result = value + seconds;
  if (
    !Number.isSafeInteger(result) ||
    result > MAX_REASONABLE_UNIX_SECONDS
  ) {
    throw new RangeError(`${fieldName} exceeds safe integer range`);
  }
  return result;
}

export function paymentEligibilityDeadline(firstStartedAt) {
  return addSeconds(
    firstStartedAt,
    REFERRAL_REWARD_SECONDS.paymentEligibility,
    "firstStartedAt",
  );
}

export function rewardConfirmationTime(paidAt) {
  return addSeconds(
    paidAt,
    REFERRAL_REWARD_SECONDS.protectionHold,
    "paidAt",
  );
}

export function manualClaimExpiry(confirmedAt) {
  return addSeconds(
    confirmedAt,
    REFERRAL_REWARD_SECONDS.manualClaimWindow,
    "confirmedAt",
  );
}

export function isPaymentInsideEligibilityWindow({ firstStartedAt, paidAt }) {
  const firstStart = requireUnixSeconds(firstStartedAt, "firstStartedAt");
  const payment = requireUnixSeconds(paidAt, "paidAt");
  return payment >= firstStart && payment <= paymentEligibilityDeadline(firstStart);
}

export function resolveBonusDelivery({ currentPlanCode, accessState } = {}) {
  if (
    typeof currentPlanCode !== "string" ||
    currentPlanCode.trim() === "" ||
    typeof accessState !== "string" ||
    accessState.trim() === ""
  ) {
    throw new TypeError("currentPlanCode and accessState are required");
  }

  const planCode = currentPlanCode.trim().toLowerCase();
  const state = accessState.trim().toLowerCase();

  if (state === "suspended") {
    throw new Error("suspended access cannot receive a bonus grant");
  }

  if (
    PAID_PLAN_CODES.has(planCode) &&
    (state === "active" || state === "cancel_at_period_end")
  ) {
    return Object.freeze({
      deliveryMode: "extend_active_plan",
      planCode,
      requiresManualClaim: false,
      bonusSeconds: REFERRAL_REWARD_SECONDS.bonusAccess,
      claimWindowSeconds: null,
    });
  }

  const receivesManualProfessionalBonus =
    (planCode === "free" &&
      ["none", "trial", "expired", "refunded"].includes(state));

  if (receivesManualProfessionalBonus) {
    return Object.freeze({
      deliveryMode: "manual_claim",
      planCode: "professional",
      requiresManualClaim: true,
      bonusSeconds: REFERRAL_REWARD_SECONDS.bonusAccess,
      claimWindowSeconds: REFERRAL_REWARD_SECONDS.manualClaimWindow,
    });
  }

  throw new Error(
    `unsupported bonus delivery state: ${planCode}/${state}`,
  );
}

export function readReferralRewardConfig(env = {}) {
  const mode = rolloutMode(env.REFERRAL_REWARD_ROLLOUT_MODE);
  const masterEnabled = strictFlag(env.REFERRAL_REWARDS_ENABLED);
  const candidateWritesRequested =
    masterEnabled &&
    mode !== "off" &&
    strictFlag(env.REFERRAL_REWARD_CANDIDATES_ENABLED);
  const programStartedAt = configuredUnixSeconds(
    env.REFERRAL_REWARD_PROGRAM_STARTED_AT,
  );
  const configurationProblems = [];
  if (candidateWritesRequested && programStartedAt === null) {
    configurationProblems.push("referral_program_start_missing");
  }
  const candidateWritesEnabled =
    candidateWritesRequested && configurationProblems.length === 0;
  const confirmationsEnabled =
    candidateWritesEnabled &&
    strictFlag(env.REFERRAL_REWARD_CONFIRMATIONS_ENABLED);
  const bonusGrantsEnabled =
    confirmationsEnabled && strictFlag(env.REFERRAL_BONUS_GRANTS_ENABLED);

  return Object.freeze({
    programCode: REFERRAL_REWARD_PROGRAM_CODE,
    rolloutMode: masterEnabled ? mode : "off",
    masterEnabled,
    programStartedAt,
    configurationProblems: Object.freeze(configurationProblems),
    candidateWritesEnabled,
    confirmationsEnabled,
    bonusGrantsEnabled,
    fullyEnabled: bonusGrantsEnabled,
  });
}
