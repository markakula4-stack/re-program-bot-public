import fs from 'node:fs';
import { foundationFixture } from './v1.4.1-fixtures.mjs';
import { createRuntimeAuthorizer, runtimeAuthorizationDTO } from '../../src/v1.4.1/runtime-authorizer.mjs';
import { readSubscriptionData } from '../../src/v1.4.2/subscription-read-model.mjs';

const authorizer = createRuntimeAuthorizer();
export function subscriptionFixture(t, { envPatch = {} } = {}) {
  const f = foundationFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../../migrations/0026-v1.3.6-stars-core-foundation.sql', import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid', STARS_PRICE_VERSION: '1',
    STARS_TERMS_REVISION: '2026-09-10.stars-v1', STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '101',
    STARS_INVOICE_SECRET: 'offline-v142-browser-stars-secret-more-than-thirty-two-characters', ...envPatch };
  return f;
}

// Render/client fixtures use the actual server projection and genuine brands.
// No external API is called; caller changes canonical fixture rows when needed.
export async function subscriptionServerDTO(f, id = 101) {
  const authorization = await authorizer.authorize(await f.context(id, 'access.read_own'));
  return { ...await readSubscriptionData({ authorization }), authorization: runtimeAuthorizationDTO(authorization) };
}
