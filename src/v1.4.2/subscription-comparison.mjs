import { FOUNDATION_POLICY_VERSION, QUOTA_DEFINITIONS } from '../v1.4.1/capability-policy.mjs';
import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readActorFacts, readActorContext } from '../v1.4.1/authority-resolver.mjs';
import { readRuntimeAuthorization, requireRuntimeAuthorization, RuntimeAuthorizationError } from '../v1.4.1/runtime-authorizer.mjs';

const rows = Object.freeze([
  { key:'active_applications', label:'Активные заявки', unit:'active_application', roleRequirement:'user',
    additionalRestrictions:['actual_action_authorization_required'] },
  { key:'own_working_offers', label:'Собственные рабочие офферы', unit:'working_offer', roleRequirement:'active_partner',
    additionalRestrictions:['age_confirmation_required','legal_declaration_required','partner_beta_access_required',
      'partner_beta_cap_preserved','actual_action_authorization_required'] },
  { key:'active_campaigns', label:'Активные кампании', unit:'active_campaign', roleRequirement:'active_partner',
    additionalRestrictions:['approved_campaign_issuer_required','campaign_rollout_required','actual_action_authorization_required'] },
]);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const fail = code => { throw new RuntimeAuthorizationError(code); };

// Published plan capacities are reference data. They remain visible if a
// customer's financial authority is under review, and never grant an action,
// a role, Partner Beta access, or an exception to a smaller effective limit.
export function projectSubscriptionComparison(authorization) {
  const { context, actor } = readRuntimeAuthorization(requireRuntimeAuthorization(authorization));
  const identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.actorKind !== 'customer' || identity.operation !== 'access.read_own' ||
    facts.actorKind !== 'customer' || readActorContext(actor) !== context ||
    facts.telegramId !== identity.telegramId || facts.botId !== identity.botId)
    fail('subscription_comparison_scope_mismatch');
  return freeze({ version:1, authority:'worker', policyVersion:FOUNDATION_POLICY_VERSION,
    publishedPolicyOnly:true, grantsRoles:false,
    rows:rows.map(row => ({ ...row, additionalRestrictions:[...row.additionalRestrictions],
      limits:Object.fromEntries(['free','professional','dragon'].map(plan => [plan,QUOTA_DEFINITIONS[row.key].limits[plan]])) })),
    previewLimits:Object.fromEntries(rows.map(row => [row.key,QUOTA_DEFINITIONS[row.key].limits.preview])),
    baseline:['own_profile','own_history','basic_support','payment_help'],
    support:{ basic:'included', paymentHelp:'included', priority:'not_released', founderLine:'not_released' },
  });
}
