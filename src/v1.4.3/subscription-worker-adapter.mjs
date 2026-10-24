import {createServiceExecutor} from '../v1.4.1/trusted-context.mjs';
import {assertRuntimeBindingReady} from '../v1.4.1/runtime-binding.mjs';
import {handleVerifiedTelegramSubscriptionUpdate} from './provider-subscription-events.mjs';
import {runPaidSubscriptionNotifications} from './subscription-notifications.mjs';

// Fixed authenticated webhook adapter. No request chooses a service purpose,
// subject, provider transport or entitlement; the event reader verifies the
// original Request and durable receipt again before its D1-only transaction.
export async function handleMainSubscriptionWebhook(env,webhookRequest,receiptClaimToken) {
  await assertRuntimeBindingReady({binding:env?.DB,env});
  const serviceContext=createServiceExecutor({binding:env.DB,env,purpose:'stars_process_event'})
    .createContext({requestPayload:{}});
  return handleVerifiedTelegramSubscriptionUpdate({webhookRequest,serviceContext,receiptClaimToken});
}

// A fixed cron task, closed by default. Only the private historical-notification
// service can select real recipients from verified paid evidence.
export async function runMainPaidSubscriptionNotifications(env) {
  if (env?.STARS_PAID_NOTIFICATIONS_ENABLED !== 'true') return {enabled:false};
  await assertRuntimeBindingReady({binding:env?.DB,env});
  const context = createServiceExecutor({binding:env.DB,env,purpose:'notification_deliver_historical'})
    .createContext({requestPayload:{}});
  return runPaidSubscriptionNotifications(context,{limit:20});
}
