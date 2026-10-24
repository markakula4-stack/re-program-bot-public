import { isTrustedContext, readTrustedContext, restrictTrustedContextForWrapper } from './trusted-context.mjs';
import { assertP04SchemaReady } from './privacy-schema.mjs';

const requestContexts = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code, status: 503 }); };
export const runtimeBindingEnabled = env => env?.V141_AUTHORIZATION_ENABLED === 'true';

// An opt-in server switch is necessary but never proves schema readiness.
// Every effect request verifies the exact reviewed object manifest and ledger
// marker on the primary; similarly named unconstrained tables are insufficient.
export async function assertRuntimeBindingReady({ binding, env } = {}) {
  if (!runtimeBindingEnabled(env)) fail('v141_runtime_disabled');
  if (!binding?.withSession || !binding?.prepare || !binding?.batch) fail('untrusted_database');
  await assertP04SchemaReady({binding});
  return true;
}

// Private request-local propagation across the existing immutable env wrappers.
// A serialized field on env cannot supply identity or replace this WeakMap.
export function bindRuntimeContext(env, context) {
  if (!env || typeof env !== 'object' || !isTrustedContext(context)) fail('untrusted_context');
  if (!runtimeBindingEnabled(env)) fail('v141_runtime_disabled');
  requestContexts.set(env, context);
  return env;
}
export function inheritRuntimeContext(source, target) {
  const context = requestContexts.get(source);
  if (context) requestContexts.set(target, restrictTrustedContextForWrapper(context,target));
  return target;
}
export function runtimeContext(env) {
  const context = requestContexts.get(env);
  if (!context) fail('runtime_context_unavailable');
  const facts = readTrustedContext(context);
  for (const [key, value] of Object.entries(facts.env)) {
    if (env[key] !== value) fail('runtime_binding_changed');
  }
  return context;
}
