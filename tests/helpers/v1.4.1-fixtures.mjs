import fs from 'node:fs';
import { fixture, signedInitData, BOT_TOKEN } from './v1.4.0-rebuild-sqlite.mjs';
import { CAPABILITY_CATALOG, PLAN_CAPABILITIES } from '../../src/v1.4.1/capability-policy.mjs';
import { createCustomerContext } from '../../src/v1.4.1/trusted-context.mjs';

export { signedInitData, BOT_TOKEN };
export function foundationFixture(t) {
  const f = fixture({ exactSchema: true });
  t?.after(() => f.close());
  for (const name of ['0062-v1.4.1-capability-policy.sql', '0063-v1.4.1-grants-overrides.sql',
    '0064-v1.4.1-audit-rollout.sql']) f.sqlite.exec(fs.readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  for (const [table, rows] of [['capability_catalog', CAPABILITY_CATALOG], ['plan_capabilities', PLAN_CAPABILITIES]]) {
    for (const row of rows) {
      const keys = Object.keys(row);
      f.sqlite.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`)
        .run(...keys.map(key => row[key]));
    }
  }
  f.serverEnv = { ...f.baseEnv, ADMIN_ID: '900', OWNER_TELEGRAM_ID: '900' };
  f.context = (id = 101, operation = 'application.create', channel = 'mini_app', patch = {}) =>
    createCustomerContext({ binding: f.binding, env: f.serverEnv, initData: signedInitData(id, f.now),
      nowSeconds: f.now, operation, channel, ...patch });
  return f;
}
