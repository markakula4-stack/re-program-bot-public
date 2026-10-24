import {
  MINI_APP_SECURITY_HEADERS, MAX_JSON_BODY_BYTES, assertMiniAppRequest,
  verifyTelegramInitData, establishMiniAppSession, extractBearerSessionToken,
  verifyMiniAppSession, sha256Hex,
} from "./mini-app-security.mjs";
import { resolveCabinetReadRoute } from "./cabinet-read-model.mjs";
import { createCabinetService, resolveCabinetWriteRoute, exactPayload } from "./cabinet-service.mjs";
import { authorityError } from "./cabinet-authority.mjs";
import { loadCabinetWindowActor, readCabinetAdminGate, canonicalCabinetOwnerId } from './cabinet-participants.mjs';
import { CABINET_ASSETS } from "./cabinet-assets.mjs";
import {renderCabinetReleaseVersion} from './release-presentation.mjs';
import { makeQueryBudget, budgetBinding } from './storage-factory.mjs';
import { createCabinetHttpRuntime, isCabinetAuthorizationEnabled, cabinetErrorAuthorization,
  CABINET_AUTHORIZATION_VERSION } from '../v1.4.1/http-runtime.mjs';
import { scopeV141ReleaseActor } from '../v1.4.1/release-scope.mjs';
import {createAdminCabinetService,resolveAdminCabinetRoute} from '../v1.4.1/admin-cabinet-service.mjs';
import {createAdminCabinetHttpRuntime,adminCabinetErrorAuthorization} from '../v1.4.1/admin-http-runtime.mjs';
import {isV143NativeReadinessEnvelope,isV143NativeOwnerCheckoutEnvelope} from '../v1.4.3/native-readiness-config.mjs';

export const CABINET_API_PREFIX = "/api/v1.4.0/cabinet/";
export const CABINET_APP_PREFIX = "/v1.4.0/cabinet/";
export const P09_LIVE_STORAGE_STATE = "blocked_until_fresh_live_inventory";
export const OWNER_WINDOW_MAX_SECONDS = 1200;
const windowPattern = /^true:([0-9]{10}):([0-9]{10})$/u;
const safeId = value => /^[1-9][0-9]*$/u.test(String(value)) &&
  Number.isSafeInteger(Number(value)) ? Number(value) : null;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status,
  headers: { ...MINI_APP_SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
const publicError = error => {
  // Only these fixed, sanitized provider outcomes are public. Preserve an
  // unknown preparation so the client does not suggest a blind retry.
  const providerCode = ['prepared_message_effect_unknown', 'prepared_message_rejected',
    'prepared_message_provider_unavailable'].includes(error?.code) ? error.code : null;
  const status = providerCode ? providerCode === 'prepared_message_provider_unavailable' ? 503 : 502
    : Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 503;
  const code = providerCode ?? (status < 500 && /^[a-z][a-z0-9_]{1,63}$/u.test(error?.code) ? error.code : "unavailable");
  const authorization=cabinetErrorAuthorization(error)??adminCabinetErrorAuthorization(error);
  return json({ error: code, ...(authorization ? {authorization}: {}) }, status);
};

export function readCabinetOwnerGate(env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const window = windowPattern.exec(String(env?.REBUILD_V140_OWNER_WINDOW ?? ""));
  const ownerTelegramId = safeId(env?.REBUILD_V140_OWNER_TELEGRAM_ID ?? env?.OWNER_TELEGRAM_ID);
  const botId = safeId(env?.REBUILD_V140_BOT_ID);
  let origin;
  try { origin = new URL(env?.MINI_APP_ORIGIN); } catch { return null; }
  if (!window || !ownerTelegramId || !botId || origin.protocol !== "https:" ||
      origin.origin !== env.MINI_APP_ORIGIN || !Number.isSafeInteger(nowSeconds)) return null;
  const issuedAt = Number(window[1]), expiresAt = Number(window[2]);
  if (issuedAt > nowSeconds || expiresAt <= nowSeconds || expiresAt <= issuedAt ||
      expiresAt - issuedAt > OWNER_WINDOW_MAX_SECONDS) return null;
  return Object.freeze({ issuedAt, expiresAt, ownerTelegramId, canonicalAdminId:canonicalCabinetOwnerId(env), botId, origin: origin.origin,
    ...(/^[0-9a-f]{40}$/u.test(env.REBUILD_V140_RC_SHA ?? '') && Number(env.REBUILD_V140_RELEASE_REVISION) > 0
      ? { candidateSha: env.REBUILD_V140_RC_SHA, revision: Number(env.REBUILD_V140_RELEASE_REVISION) } : {}) });
}

const gateForActor = (env, telegramId, now) => telegramId === canonicalCabinetOwnerId(env)
  ? readCabinetAdminGate(env, now) ?? readCabinetOwnerGate(env, now) : readCabinetOwnerGate(env, now);
const sessionScopeFor = (env, gate) => env.REBUILD_V140_ADMIN_ACCESS_ENABLED === 'true'
  ? { candidateSha: gate.candidateSha, revision: gate.revision } : undefined;
const bearerActor = async (env, token, budget) => {
  if(env.REBUILD_V140_STORAGE_ENABLED!=='true')authorityError('storage_unavailable',503);
  // Only trusted D1 metadata chooses an actor scope. The authenticated repo
  // subsequently re-reads the full session and captures it in its own fence.
  const row = await budgetBinding(env.DB, budget).withSession('first-primary')
    .prepare('SELECT telegram_id FROM mini_app_sessions WHERE session_token_hash=?')
    .bind(await sha256Hex(token)).first();
  if (!Number.isSafeInteger(row?.telegram_id) || row.telegram_id < 1) authorityError('invalid_session', 401);
  return row.telegram_id;
};

async function boundedJson(request) {
  if (!request.body) authorityError("invalid_request", 400);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("body_timeout"),
        { code: "invalid_request", status: 400 })), 5000);
    });
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) authorityError("payload_too_large", 413);
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { authorityError("invalid_request", 400); }
    exactPayload(data, Object.keys(data ?? {}));
    return { data, size };
  } finally {
    clearTimeout(timer);
    // An untrusted stream's cancellation promise may never settle. Cleanup
    // must not extend the bounded body read or delay its rejection.
    void reader.cancel().catch(() => {});
  }
}
const requestGuard = (request, gate, contentLength) => assertMiniAppRequest({
  method: request.method, url: request.url, expectedOrigin: gate.origin,
  origin: request.headers.get("Origin"),
  contentType: request.headers.get("Content-Type") ?? undefined,
  contentLength, idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
  secFetchSite: request.headers.get("Sec-Fetch-Site") ?? undefined,
});
const contextFor = async (repo, sessionToken, env, gate, now) => {
  const tokenHash = await sha256Hex(sessionToken);
  const sessionRecord = await repo.one("mini_app_sessions", "session_token_hash = ?", [tokenHash]);
  const context = await verifyMiniAppSession({ sessionRecord, sessionToken,
    expectedTelegramId: sessionRecord?.telegramId, expectedBotId: gate.botId, nowSeconds: now,
    sessionScope: sessionScopeFor(env, gate) });
  await loadCabinetWindowActor({ repo, env, gate, telegramId: context.telegramId, nowSeconds: now });
  return context;
};
const openRepo = async (factory, env, readOnly, budget, gate) => {
  if (typeof factory !== "function") authorityError("storage_unavailable", 503);
  const repo = await factory(env, { readOnly, budget, ...(gate?.accessScope === 'admin' ? { accessScope: 'admin' } : {}) });
  if (!repo?.assertCandidateSchema || !repo?.commit) authorityError("storage_unavailable", 503);
  await repo.assertCandidateSchema();
  return repo;
};
const serviceFor = async ({ env, token, repositoryFactory, clock, adapters, readOnly, budget }) => {
  const nowSeconds = clock(), gate = gateForActor(env, await bearerActor(env, token, budget), nowSeconds);
  if (!gate) authorityError("writes_unavailable");
  let repo = await openRepo(repositoryFactory, env, readOnly, budget, gate);
  let context = await contextFor(repo, token, env, gate, nowSeconds);
  const scopedEnv=scopeV141ReleaseActor(env,context);
  // The initial repository only authenticates. Effect and service construction
  // must use the verified actor's scope, not the pre-authentication env.
  if(scopedEnv!==env) {
    repo=await openRepo(repositoryFactory,scopedEnv,readOnly,budget,gate);
    context=await contextFor(repo,token,scopedEnv,gate,nowSeconds);
  }
  env=scopedEnv;
  const runtime = isCabinetAuthorizationEnabled(env) ? createCabinetHttpRuntime({env,sessionToken:token,
    sessionScope:sessionScopeFor(env,gate),context,nowSeconds}) : null;
  return createCabinetService({ repo, env, context, gate, nowSeconds, ...adapters,
    ...(runtime ? {runtime,readAccessAuthority:runtime.readAccessAuthority}: {}),
    reconcileReceipt: async command => {
      if (env.REBUILD_V140_WRITES_ENABLED !== "true") authorityError("writes_unavailable");
      const fresh = await serviceFor({ env, token, repositoryFactory, clock, adapters, readOnly: false, budget });
      return fresh.reconcile(command);
    },
  });
};

export function createCabinetHttp({ repositoryFactory = null,
  clock = () => Math.floor(Date.now() / 1000), adapters = {},
  nativeProviderFetch = globalThis.fetch } = {}) {
  return async (request, env, executionContext) => {
    const budget = makeQueryBudget();
    const parsed = new URL(request.url);
    if (!parsed.pathname.startsWith(CABINET_API_PREFIX) &&
        !parsed.pathname.startsWith(CABINET_APP_PREFIX)) return null;
    const nowSeconds = clock();
    let gate = readCabinetOwnerGate(env, nowSeconds) ?? readCabinetAdminGate(env, nowSeconds);
    // Expired/absent windows touch neither D1 nor the accepted bot runtime.
    if (!gate || parsed.origin !== gate.origin || parsed.hash || parsed.username || parsed.password) return json({ error: "not_found" }, 404);
    try {
      if(typeof repositoryFactory!=='function')authorityError('storage_unavailable',503);
      if (parsed.pathname.startsWith(CABINET_APP_PREFIX)) {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        if (parsed.search) return json({ error: "invalid_request" }, 400);
        const name = parsed.pathname.slice(CABINET_APP_PREFIX.length) || "partner-cabinet.html";
        const asset = Object.hasOwn(CABINET_ASSETS, name) ? CABINET_ASSETS[name] : null;
        if (!asset) return json({ error: "not_found" }, 404);
        // A shell is not a working cabinet: without released storage it also
        // fails closed. In tests the factory binds the local candidate schema.
        await openRepo(repositoryFactory, env, true, budget, gate);
        return new Response(name.endsWith('.html')?renderCabinetReleaseVersion(asset.content):asset.content, { headers: { ...MINI_APP_SECURITY_HEADERS,
          "Content-Type": asset.contentType } });
      }
      if (!["GET", "POST"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
      const declared = request.headers.get("Content-Length");
      if (declared !== null && !/^(?:0|[1-9][0-9]{0,8})$/u.test(declared)) authorityError("invalid_request", 400);
      const declaredSize = declared === null ? 0 : Number(declared);
      requestGuard(request, gate, declaredSize);
      if (request.method === "GET" && request.body) authorityError("invalid_request", 400);
      let body = null;
      if (request.method === "POST") {
        const parsedBody = await boundedJson(request);
        requestGuard(request, gate, parsedBody.size);
        if (declared !== null && declaredSize !== parsedBody.size) authorityError("invalid_request", 400);
        body = parsedBody.data;
      }
      if (request.method === "POST" && parsed.pathname === CABINET_API_PREFIX + "session") {
        if (parsed.search || request.headers.has("Authorization")) authorityError("invalid_request", 400);
        exactPayload(body, ["initData"]);
        const authentication = await verifyTelegramInitData({ initData: body.initData,
          botToken: env.BOT_TOKEN, expectedBotId: gate.botId,
          nowSeconds });
        gate = gateForActor(env, authentication.telegramId, nowSeconds);
        if (!gate) authorityError('identity_mismatch', 401);
        env=scopeV141ReleaseActor(env,authentication);
        const repo = await openRepo(repositoryFactory, env, false, budget, gate);
        await loadCabinetWindowActor({ repo, env, gate, telegramId: authentication.telegramId, nowSeconds });
        const mutationsReady = !isCabinetAuthorizationEnabled(env) ||
          await createCabinetHttpRuntime({env,nowSeconds}).ready().then(()=>true,()=>false);
        const ttlSeconds = Math.min(300, gate.expiresAt - nowSeconds);
        if (ttlSeconds < 60) authorityError("writes_unavailable", 403);
        const session = await establishMiniAppSession({ authentication, nowSeconds,
          ttlSeconds,
          sessionScope: sessionScopeFor(env, gate),
          persistAtomically: envelope => repo.establishSession({
            receipt: envelope.receipt, session: { ...envelope.session, gateExpiresAt: gate.expiresAt },
          }) });
        return json({ ...session, principal:{telegramId:authentication.telegramId,botId:gate.botId}, ...(isCabinetAuthorizationEnabled(env)
          ? {authorizationVersion:CABINET_AUTHORIZATION_VERSION}: {}), features: { version: 1,
          mutationsEnabled: env.REBUILD_V140_WRITES_ENABLED === "true" && mutationsReady,
          offerActionsEnabled: env.REBUILD_V140_OFFER_ACTIONS_ENABLED === "true",
          ...(isV143NativeReadinessEnvelope(env)&&authentication.telegramId===canonicalCabinetOwnerId(env)
            ?{existingRenewalCancellationEnabled:mutationsReady}:{}),
          ...(isV143NativeOwnerCheckoutEnvelope(env)&&authentication.telegramId===canonicalCabinetOwnerId(env)
            ?{nativeOwnerInvoiceOnly:mutationsReady}:{}) } });
      }
      const token = extractBearerSessionToken(request.headers.get("Authorization"));
      gate = gateForActor(env, await bearerActor(env, token, budget), nowSeconds);
      if (!gate) authorityError('identity_mismatch', 401);
      // Preparing a Telegram share message is an external effect. Its own
      // authority still uses a SELECT-only repository, never a business write.
      const preparingReferral = request.method === 'POST'
        && parsed.pathname === CABINET_API_PREFIX + 'referral/prepared';
      if (preparingReferral && (parsed.search || parsed.hash)) authorityError('invalid_request', 400);
      const readingSubscriptionOperation = request.method === 'POST'
        && [CABINET_API_PREFIX+'subscription/operation-status',CABINET_API_PREFIX+'subscription/renewal/reconfirm-cancel-status'].includes(parsed.pathname);
      const readOnly = request.method === 'GET' || preparingReferral || readingSubscriptionOperation;
      let repo = await openRepo(repositoryFactory, env, readOnly, budget, gate);
      let context = await contextFor(repo, token, env, gate, nowSeconds);
      const scopedEnv=scopeV141ReleaseActor(env,context);
      if(scopedEnv!==env) {
        repo=await openRepo(repositoryFactory,scopedEnv,readOnly,budget,gate);
        context=await contextFor(repo,token,scopedEnv,gate,nowSeconds);
      }
      env=scopedEnv;
      if(parsed.pathname.startsWith(CABINET_API_PREFIX+'admin/')) {
        if(env.V141_ADMIN_MINI_APP_ENABLED!=='true' || context.telegramId!==canonicalCabinetOwnerId(env) || gate.accessScope!=='admin') authorityError('not_found',404);
        const adminRuntime=createAdminCabinetHttpRuntime({env,sessionToken:token,
          sessionScope:sessionScopeFor(env,gate),context,nowSeconds});
        if(parsed.pathname===CABINET_API_PREFIX+'admin/refund-renewal/complete') {
          if(parsed.search||parsed.hash)authorityError('invalid_request',400);
          if(request.method!=='POST')authorityError('method_not_allowed',405);
          if(env.REBUILD_V140_WRITES_ENABLED!=='true'&&!isV143NativeReadinessEnvelope(env))authorityError('writes_unavailable',403);
          const result=await adminRuntime.completeRefundRenewal(body,request.headers.get('Idempotency-Key'),
            {fetchImpl:nativeProviderFetch});
          return json(result,['unknown','pending','attempted','admitted'].includes(result?.status)?202:200);
        }
        const reviewPath=CABINET_API_PREFIX+'admin/subscription-review';
        if (parsed.pathname===reviewPath || parsed.pathname===reviewPath+'/apply' ||
            parsed.pathname===reviewPath+'/refund') {
          if (parsed.search || parsed.hash) authorityError('invalid_request',400);
          if (request.method==='GET' && parsed.pathname===reviewPath)
            return json(await adminRuntime.subscriptionReviewList({}));
          if (request.method!=='POST' || parsed.pathname===reviewPath) authorityError('method_not_allowed',405);
          if (env.REBUILD_V140_WRITES_ENABLED!=='true') authorityError('writes_unavailable',403);
          const action=parsed.pathname.endsWith('/apply')?'apply':'refund';
          const result=await adminRuntime.subscriptionReviewMutate(action,body,
            request.headers.get('Idempotency-Key'),{fetchImpl:nativeProviderFetch});
          return json(result,['unknown','pending','attempted','admitted'].includes(result?.status)?202:200);
        }
        const route=resolveAdminCabinetRoute({method:request.method,url:request.url});
        const adminService=createAdminCabinetService({repo,env,context,gate,nowSeconds,runtime:adminRuntime});
        const result=route.kind==='read'?await adminService.read(route):
          await adminService.mutate(route.action,body,route.target,request.headers.get('Idempotency-Key'));
        return json(result,result.receiptStatus==='rejected'?409:200);
      }
      const runtime = isCabinetAuthorizationEnabled(env) ? createCabinetHttpRuntime({env,sessionToken:token,
        sessionScope:sessionScopeFor(env,gate),context,nowSeconds}) : null;
      if (parsed.pathname === CABINET_API_PREFIX+'subscription/operation-status') {
        if (parsed.search || parsed.hash) authorityError('invalid_request',400);
        if (request.method !== 'POST') authorityError('method_not_allowed',405);
        if (!runtime) authorityError('reads_unavailable',503);
        return json(await runtime.readSubscriptionOperationStatus(body,request.headers.get('Idempotency-Key')));
      }
      if(parsed.pathname===CABINET_API_PREFIX+'subscription/recover'){
        if(parsed.search||parsed.hash)authorityError('invalid_request',400);
        if(request.method!=='POST')authorityError('method_not_allowed',405);
        if(!runtime||(env.REBUILD_V140_WRITES_ENABLED!=='true'&&
          !(body?.kind==='cancel'&&isV143NativeReadinessEnvelope(env))&&
          !(body?.kind==='enable'&&isV143NativeOwnerCheckoutEnvelope(env)&&context.telegramId===canonicalCabinetOwnerId(env))))
          authorityError('writes_unavailable',403);
        return json(await runtime.recoverSubscriptionCommand(body,request.headers.get('Idempotency-Key')));
      }
      if([CABINET_API_PREFIX+'subscription/renewal/reconfirm-cancel',CABINET_API_PREFIX+'subscription/renewal/reconfirm-cancel-status'].includes(parsed.pathname)){
        if(parsed.search||parsed.hash)authorityError('invalid_request',400);
        if(request.method!=='POST')authorityError('method_not_allowed',405);
        const readOnly=parsed.pathname.endsWith('-status');
        if(!runtime)authorityError('reads_unavailable',503);
        if(!readOnly&&(context.telegramId!==canonicalCabinetOwnerId(env)||
          env.REBUILD_V140_WRITES_ENABLED!=='true'&&!isV143NativeReadinessEnvelope(env)))authorityError('writes_unavailable',403);
        return json(await runtime.reconfirmSubscriptionCancellation(body,request.headers.get('Idempotency-Key'),{readOnly}));
      }
      const invoicePath=CABINET_API_PREFIX+'subscription/recurring-invoice';
      const cancelPath=CABINET_API_PREFIX+'subscription/renewal/cancel';
      const enablePath=CABINET_API_PREFIX+'subscription/renewal/enable';
      if ([invoicePath,cancelPath,enablePath].includes(parsed.pathname)) {
        if (parsed.search || parsed.hash) authorityError('invalid_request',400);
        if (request.method!=='POST') authorityError('method_not_allowed',405);
        if (!runtime || (env.REBUILD_V140_WRITES_ENABLED!=='true'&&
            !(parsed.pathname===cancelPath&&isV143NativeReadinessEnvelope(env))&&
            !(parsed.pathname===enablePath&&isV143NativeOwnerCheckoutEnvelope(env)&&context.telegramId===canonicalCabinetOwnerId(env))&&
            !(parsed.pathname===invoicePath&&isV143NativeOwnerCheckoutEnvelope(env)&&context.telegramId===canonicalCabinetOwnerId(env)))) authorityError('writes_unavailable',403);
        const clientKey=request.headers.get('Idempotency-Key');
        const options={fetchImpl:nativeProviderFetch};
        const work=parsed.pathname===invoicePath
          ? runtime.issueRecurringInvoice(body,clientKey,options)
          : runtime.controlSubscriptionRenewal(parsed.pathname===cancelPath?'cancel':'enable',body,clientKey,options);
        // Keep this one authenticated cancellation alive after a client
        // disconnect. Registration neither retries nor starts another effect.
        if(parsed.pathname===cancelPath&&typeof executionContext?.waitUntil==='function')
          executionContext.waitUntil(work.then(()=>undefined,()=>undefined));
        const result=await work;
        return json(result,['unknown','pending','attempted','admitted'].includes(result?.status)?202:200);
      }
      const service = createCabinetService({ repo, env, context, gate, nowSeconds, ...adapters,
        ...(runtime ? {runtime,readAccessAuthority:runtime.readAccessAuthority}: {}),
        reconcileReceipt: async command => {
          if (env.REBUILD_V140_WRITES_ENABLED !== "true") authorityError("writes_unavailable");
          const fresh = await serviceFor({ env, token, repositoryFactory, clock, adapters, readOnly: false, budget });
          return fresh.reconcile(command);
        },
      });
      if (request.method === "GET") {
        const action = /^\/api\/v1\.4\.0\/cabinet\/offers\/([a-z0-9_-]{3,24})\/action$/u.exec(parsed.pathname);
        if (action) {
          if (parsed.search) authorityError("invalid_request", 400);
          if (env.REBUILD_V140_OFFER_ACTIONS_ENABLED !== "true") authorityError("writes_unavailable", 403);
          return json(await service.read({ routeCode: "cabinet.offer_action", params: { code: action[1] } }));
        }
        const result=await service.read(resolveCabinetReadRoute({ method: "GET", url: request.url }));
        return json(isV143NativeReadinessEnvelope(env)&&context.telegramId===canonicalCabinetOwnerId(env)
          ?{...result,features:{version:1,mutationsEnabled:false,offerActionsEnabled:false,
            existingRenewalCancellationEnabled:true,
            ...(isV143NativeOwnerCheckoutEnvelope(env)?{nativeOwnerInvoiceOnly:true}:{})}}:result);
      }
      if (preparingReferral) {
        const assertFence = async () => {
          const freshGate = gateForActor(env, context.telegramId, clock());
          if (!freshGate || freshGate.botId !== gate.botId
            || freshGate.candidateSha !== gate.candidateSha || freshGate.revision !== gate.revision
            || freshGate.accessScope !== gate.accessScope) authorityError('expired_authentication', 401);
          await repo.assertReadFence({ context, gate: freshGate });
        };
        return json(await service.prepareReferral(body, request.headers.get('Idempotency-Key'),
          { assertFence, nowSeconds: clock, fetchImpl: nativeProviderFetch }));
      }
      if (env.REBUILD_V140_WRITES_ENABLED !== "true") authorityError("writes_unavailable", 403);
      const { action, target } = resolveCabinetWriteRoute(request.url);
      return json(await service.mutate(action, body, target, request.headers.get("Idempotency-Key")));
    } catch (error) {
      // Never log raw initData, bearer, URL query, request body or D1 errors.
      if(isCabinetAuthorizationEnabled(env) &&
          /^\/api\/v1\.4\.0\/cabinet\/offers\/[a-z0-9_-]{3,24}\/action$/u.test(parsed.pathname) &&
          ['offer_not_public','offer_not_available','invalid_route'].includes(error?.code)) {
        return json({error:'not_found'},404);
      }
      return publicError(error);
    }
  };
}

// Internal integration seam for existing verified bot/server workflows.
// No HTTP route resolves here; authentication and finite owner window are
// revalidated from the hashed session, never a caller-provided context object.
export async function withCabinetTrustedService({ env, sessionToken, repositoryFactory,
  clock = () => Math.floor(Date.now() / 1000), adapters = {}, run }) {
  const nowSeconds = clock(), gate = readCabinetOwnerGate(env, nowSeconds) ?? readCabinetAdminGate(env, nowSeconds);
  if (!gate || env.REBUILD_V140_WRITES_ENABLED !== "true") authorityError("writes_unavailable");
  if (typeof run !== "function") authorityError("invalid_request", 400);
  const service = await serviceFor({ env, token: extractBearerSessionToken("Bearer " + sessionToken),
    repositoryFactory, clock, adapters, readOnly: false, budget:makeQueryBudget() });
  return run(service);
}
