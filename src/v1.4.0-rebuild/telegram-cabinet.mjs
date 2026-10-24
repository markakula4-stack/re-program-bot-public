import { readCabinetOwnerGate, CABINET_APP_PREFIX } from './cabinet-http.mjs';
import { createCabinetService } from './cabinet-service.mjs';
import { hasRole, authorityError } from './cabinet-authority.mjs';
import { isCabinetWindowParticipant, loadCabinetWindowActor, readCabinetAdminGate, canonicalCabinetOwnerId } from './cabinet-participants.mjs';
import { cabinetCallback, parseCabinetCallback, readVerifiedCabinetUpdate, createVerifiedTelegramCommandContext } from './telegram-command-authority.mjs';
export { cabinetCallback, parseCabinetCallback } from './telegram-command-authority.mjs';
import { reviewedRepositoryFactory, makeQueryBudget } from './storage-factory.mjs';
import {releaseLeaseFence,releaseAdminFence,assertReleaseLease} from './release-lease.mjs';
import {grantTelegramPartnerBeta} from './telegram-beta.mjs';
import {databaseSeconds} from './d1-cabinet-repository.mjs';
import {createCabinetCustomerContext,deriveTrustedOperationContext} from '../v1.4.1/trusted-context.mjs';
import {assertRuntimeBindingReady,runtimeBindingEnabled,bindRuntimeContext} from '../v1.4.1/runtime-binding.mjs';
import {authorizeTelegramHandler,executeTelegramMutation,assertTelegramPresentationFresh} from '../v1.4.1/telegram-runtime.mjs';
import {createRuntimeAuthorizer,requireRuntimeAuthorization} from '../v1.4.1/runtime-authorizer.mjs';
import {scopeV141ReleaseActor} from '../v1.4.1/release-scope.mjs';

const integer = n => Number.isSafeInteger(n) && n > 0;
const equal = (a,b) => {
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;
};
export function scopedCabinetBetaEnv(env) {
  return env.REBUILD_V140_BETA_ENABLED==='true' && env.REBUILD_V140_RELEASE_LEASE_REQUIRED==='true' && readCabinetOwnerGate(env)
    ? {...env,PARTNER_BETA_ENABLED:'true',PARTNER_PRIVATE_OFFERS_ENABLED:'true',
      PARTNER_OFFER_SUBMISSIONS_ENABLED:'true',PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED:'true'} : env;
}
const target = update => {
  if(typeof update?.callback_query?.data==='string'&&update.callback_query.data.startsWith('r14:'))return {kind:'callback',value:update.callback_query.data};
  const text=String(update?.message?.text??'').trim();
  if(/^\/cabinet(?:@RE_Program_Bot)?$/iu.test(text))return {kind:'open'};
  if(/^\/(?:cabinet_admin|cabine_admin)(?:@RE_Program_Bot)?$/iu.test(text))return {kind:'admin'};
  if(/^\/cabinet_offers(?:@RE_Program_Bot)?$/iu.test(text))return {kind:'offers'};
  const result=/^\/cabinet_result(?:@RE_Program_Bot)? ([1-9][0-9]*) (confirm ([0-9]+)|mark_paid|reject (.{1,300}))$/iu.exec(text);
  if(result)return {kind:'result',leadId:Number(result[1]),decision:result[2].split(' ')[0].toLowerCase(),
    rewardKopecks:result[3]===undefined?undefined:Number(result[3]),reason:result[4]};
  return /^\/cabinet(?:_|\b)/iu.test(text)?{kind:'invalid'}:null;
};
async function telegramSession(repo,actor,gate,now) {
  // This is an existing, real initData session. A Telegram webhook provides
  // fresh platform authentication for its same actor; no initData is forged,
  // bearer token retrieved, role granted or session invented by this bridge.
  const sessions=await repo.select('mini_app_sessions',
    "telegram_id=? AND bot_id=? AND status='active' AND revoked_at IS NULL AND token_version=1 AND issued_at<=? AND expires_at>?",
    [actor,gate.botId,now,now],'expires_at DESC, session_id',1);
  const s=sessions[0];if(!s||!/^mss_[0-9a-f]{64}$/u.test(s.sessionId))authorityError('session_required',401);
  return Object.freeze({contextVersion:1,authoritySource:'database_session',sessionId:s.sessionId,
    telegramId:actor,botId:gate.botId,expiresAt:Math.min(s.expiresAt,gate.expiresAt)});
}
function callbackAction({op,target,version}) {
  if(op==='bg')return {action:'admin.partner.beta',target:{profileId:Number(target)},payload:{}};
  if(op==='pa'||op==='pr')return {action:'admin.partner.review',target:{applicationId:Number(target)},
    payload:{decision:op==='pa'?'approve':'reject',...(op==='pr'?{reason:'Заявка требует уточнения условий.'}:{})}};
  if(op==='oa'||op==='op')return {action:'offer.business',target:{code:target},payload:{version,desiredBusinessStatus:op==='oa'?'active':'paused'}};
  if(op==='om'||op==='or')return {action:'admin.offer.moderate',target:{code:target},
    payload:{version,decision:op==='om'?'approved':'changes_requested',...(op==='or'?{reason:'Уточните условия оффера перед публикацией.'}:{})}};
  return {action:'admin.offer.visibility',target:{code:target},payload:{version,visibility:'public'}};
}
async function menu(repo,kind,actor,gate,context,secret,env,now) {
  if(kind==='admin'&&env.V141_ADMIN_MINI_APP_ENABLED==='true'&&actor===canonicalCabinetOwnerId(env)) {
    return {text:'🎛 Пульт владельца\nНастройки RE AI и ответы поддержки в одном месте.',
      keyboard:[[{text:'🎛 Открыть пульт',web_app:{url:gate.origin+CABINET_APP_PREFIX+'admin-cabinet.html'}}]]};
  }
  const keyboard=[],lines=[kind==='admin'?'Кабинет · модерация':'Кабинет · мои офферы'];
  let betaButtons=0;
  const add=async(text,op,key,version=0)=>keyboard.push([{text,callback_data:await cabinetCallback({op,target:key,version,actor,gate,
    expiresAt:Math.min(context.expiresAt,gate.expiresAt,now+300),secret,nowSeconds:now})}]);
  if(kind==='admin') {
    keyboard.push([{text:'🧩 Открыть кабинет',web_app:{url:gate.origin+CABINET_APP_PREFIX}}],
      [{text:'🛡 Панель администратора',callback_data:'admin_dashboard'}]);
    lines.push('Доступ администратора не зависит от Partner Beta.');
    const applications=await repo.select('partner_applications',"status='pending' AND telegram_id<>?",[actor],'id DESC',3);
    if(!applications.length)lines.push('Заявок на партнёрство для проверки пока нет.');
    for(const a of applications){lines.push(`Заявка #${a.id}: ${a.displayName}; 18+ ${a.ageConfirmed===1?'подтверждено':'не подтверждено'}`);
      if(a.ageConfirmed===1)await add(`Одобрить заявку #${a.id}`,'pa',String(a.id));await add(`Отклонить заявку #${a.id}`,'pr',String(a.id));}
    const profiles=await repo.readQuery(`SELECT p.id FROM partner_profiles p JOIN partner_applications a ON a.id=p.application_id
      JOIN users u ON u.telegram_id=p.telegram_id
      WHERE p.status='active' AND a.telegram_id=p.telegram_id AND a.status='approved' AND a.age_confirmed=1
      AND u.is_blocked=0 AND EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=p.telegram_id AND role='partner' AND status='active')
      AND NOT EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=p.telegram_id AND role='admin' AND status='active')
      AND NOT EXISTS(SELECT 1 FROM privacy_deletion_requests WHERE telegram_id=p.telegram_id AND status='pending' AND unixepoch(expires_at)>unixepoch())
      AND NOT EXISTS
      (SELECT 1 FROM partner_beta_access b WHERE b.partner_profile_id=p.id AND
        (b.access_status<>'active' OR b.expires_at IS NULL OR unixepoch(b.expires_at) IS NULL OR unixepoch(b.expires_at)>unixepoch())) ORDER BY p.id DESC LIMIT 5`,[],['id']);
    if(env.REBUILD_V140_BETA_ENABLED==='true'||env.REBUILD_V140_ADMIN_BETA_GRANTS_ENABLED==='true'){
      for(const p of profiles){await add(`Выдать Beta на 60 мин · #${p.id}`,'bg',String(p.id));betaButtons++;}
      if(!betaButtons)lines.push('Нет партнёров, которым сейчас можно выдать Partner Beta.');
    }else lines.push('Выдача Partner Beta в этой панели сейчас недоступна.');
    const grants=await repo.readQuery(`SELECT b.partner_profile_id,b.access_status,b.expires_at FROM partner_beta_access b
      JOIN partner_profiles p ON p.id=b.partner_profile_id
      WHERE NOT EXISTS(SELECT 1 FROM user_roles WHERE telegram_id=p.telegram_id AND role='admin' AND status='active')
      ORDER BY b.partner_profile_id LIMIT 5`,[],['partner_profile_id','access_status','expires_at']);
    if(!grants.length)lines.push('Доступов Partner Beta для отображения пока нет.');
    for(const b of grants){
      const prefix=`Partner Beta профиля #${b.partnerProfileId}: `;
      if(b.accessStatus==='revoked')lines.push(prefix+'доступ отозван. Повторная выдача в этой панели недоступна.');
      else if(b.accessStatus==='paused')lines.push(prefix+'доступ приостановлен. Повторная выдача в этой панели недоступна.');
      else {
        const expiry=databaseSeconds(b.expiresAt);
        if(b.expiresAt==null)lines.push(prefix+'доступ активен; срок окончания не указан.');
        else if(expiry===null)lines.push(prefix+'срок доступа некорректен. Повторная выдача в этой панели недоступна.');
        else lines.push(prefix+(expiry>now?'доступ активен':'срок доступа истёк')+'; до '+
          new Date(expiry*1000).toISOString().replace('T',' ').replace('.000Z',' UTC')+'.');
      }
    }
  }
  const rows=await repo.readQuery(`SELECT o.code,o.title,o.status,r.moderation_status,r.visibility,v.version_number
    FROM offers o JOIN offer_owners own ON own.offer_code=o.code AND own.owner_kind='partner'
    JOIN offer_visibility_rules r ON r.offer_code=o.code JOIN offer_versions v ON v.id=r.current_version_id
    JOIN partner_profiles p ON p.id=own.partner_profile_id
    WHERE ${kind==='offers'?'p.telegram_id=?':"r.moderation_status IN ('pending','approved') AND p.telegram_id<>?"}
    ORDER BY o.updated_at DESC,o.code LIMIT 5`,[actor],
    ['code','title','status','moderation_status','visibility','version_number']);
  for(const o of rows){lines.push(`${o.code} · ${String(o.title).slice(0,80)} · v${o.versionNumber} · ${o.status} · ${o.moderationStatus}`);
    if(kind==='offers')await add(`${o.status==='active'?'Приостановить':'Активировать'} ${o.code}`,o.status==='active'?'op':'oa',o.code,o.versionNumber);
    else if(o.moderationStatus==='pending'){await add(`Одобрить ${o.code}`,'om',o.code,o.versionNumber);await add(`На доработку ${o.code}`,'or',o.code,o.versionNumber);}
    else if(o.visibility!=='public')await add(`Опубликовать ${o.code}`,'ov',o.code,o.versionNumber);}
  if(kind==='admin'){
    const leads=await repo.select('lead_requests',"status IN ('pending','confirmed')",[],'id DESC',5);
    if(!leads.length)lines.push('Заявок на офферы для обработки пока нет.');
    for(const l of leads)lines.push(`Заявка на оффер #${l.id}: ${l.offerCode}, ${l.status}, ${l.rewardKopecks} коп.`);
    if(env.REBUILD_V140_RESULT_ACTIONS_ENABLED==='true')lines.push('Результат: /cabinet_result ID confirm СУММА_В_КОПЕЙКАХ; mark_paid — после реальной выплаты; reject ПРИЧИНА.');
    else lines.push('Финансовые действия пока недоступны.');
    if(betaButtons)lines.push('Partner Beta выдаётся выбранному партнёру кнопкой на 60 минут. Одобрение заявки само по себе Beta не выдаёт.');
  }
  if(!rows.length)lines.push(kind==='admin'?'Офферов для модерации пока нет.':'Офферов для этого раздела пока нет.');
  return {text:lines.join('\n'),keyboard};
}
export function createTelegramCabinet({repositoryFactory=reviewedRepositoryFactory,
  clock=()=>Math.floor(Date.now()/1000),fetchImpl=fetch}={}) {
  return async(request,env)=>{
    const now=clock();let gate=readCabinetAdminGate(env,now)??readCabinetOwnerGate(env,now);
    const url=new URL(request.url);
    const unchanged={response:null,legacyEnv:env};
    if(env.REBUILD_V140_TELEGRAM_ENABLED!=='true'||!gate||request.method!=='POST'||url.pathname!=='/webhook'||
      url.origin!==gate.origin||url.search||typeof env.WEBHOOK_SECRET!=='string'||env.WEBHOOK_SECRET.length<16||
      !equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.WEBHOOK_SECRET))return unchanged;
    const authentication=await readVerifiedCabinetUpdate(request,{env,gate,nowSeconds:now});
    const update=authentication?.update,requested=target(update),actor=authentication?.actor;
    gate=actor===canonicalCabinetOwnerId(env)?readCabinetAdminGate(env,now)??readCabinetOwnerGate(env,now):readCabinetOwnerGate(env,now);
    if(!gate||!isCabinetWindowParticipant(env,gate,actor)||(!update?.callback_query&&
      (gate.accessScope!=='admin'&&Number(update?.message?.date)<gate.issuedAt)))return requested?{response:new Response('OK'),legacyEnv:env}:unchanged;
    let scoped=scopedCabinetBetaEnv(env);
    if(!requested)return unchanged;
    if(env.REBUILD_V140_WRITES_ENABLED!=='true')return {response:new Response('OK'),legacyEnv:env};
    const budget=makeQueryBudget();let repo,claimToken,deliveryStarted=false,claimed=false,authorized=false,readContext=null,
      runtimeBase=null,runtimeAuthorization=null;
    const acknowledge=async text=>{
      if(!update?.callback_query)return;
      if(clock()>=gate.expiresAt)authorityError('release_lease_unavailable',503);
      if(repo)await assertReleaseLease(repo.db,gate.accessScope==='admin'?releaseAdminFence(scoped):releaseLeaseFence(scoped));
      if(runtimeAuthorization)await assertTelegramPresentationFresh(runtimeAuthorization);
      deliveryStarted=true;
      const response=await fetchImpl(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callback_query_id:update.callback_query.id,text}),
        signal:AbortSignal.timeout(10000)});
      if(!response.ok||(await response.json()).ok!==true)throw new Error('delivery_unknown');
    };
    const send=async(text,keyboard=[])=>{
      if(clock()>=gate.expiresAt)authorityError('release_lease_unavailable',503);
      if(repo)await assertReleaseLease(repo.db,gate.accessScope==='admin'?releaseAdminFence(scoped):releaseLeaseFence(scoped));
      // Menus and Web App buttons recheck captured actor/session authority
      // before delivery. A committed mutation has changed its own snapshots.
      if(readContext)await repo.assertReadFence({context:readContext,gate});
      if(runtimeAuthorization)await assertTelegramPresentationFresh(runtimeAuthorization);
      deliveryStarted=true;
      const response=await fetchImpl(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:actor,text,
          reply_markup:{inline_keyboard:keyboard}}),signal:AbortSignal.timeout(10000)});
      if(!response.ok||(await response.json()).ok!==true)throw new Error('delivery_unknown');
    };
    try {
      repo=await repositoryFactory(scoped,{readOnly:false,budget,...(gate.accessScope==='admin'?{accessScope:'admin'}:{})});await repo.assertCandidateSchema();
      const account=await loadCabinetWindowActor({repo,env:scoped,gate,telegramId:actor,nowSeconds:now});
      authorized=true;
      if((requested.kind==='admin'||requested.kind==='result')&&!hasRole(account,'admin'))authorityError('admin_required');
      if(requested.kind==='offers'&&!hasRole(account,'partner'))authorityError('partner_required');
      let command,context,parsedCallback;
      const platformAdmin=actor===canonicalCabinetOwnerId(env)&&hasRole(account,'admin');
      if(!platformAdmin&&requested.kind!=='open')context=await telegramSession(repo,actor,gate,now);
      if(platformAdmin)context={expiresAt:Math.min(now+300,gate.expiresAt)};
      if(requested.kind==='callback'){
        parsedCallback=await parseCabinetCallback(requested.value,{actor,gate,secret:env.MINI_APP_IDEMPOTENCY_SECRET,nowSeconds:now});
        command=callbackAction(parsedCallback);
      }
      if(requested.kind==='result') {
        if(env.REBUILD_V140_RESULT_ACTIONS_ENABLED!=='true')authorityError('writes_unavailable');
        command={action:'admin.lead.result',target:{leadId:requested.leadId},payload:{decision:requested.decision,
          ...(requested.rewardKopecks===undefined?{}:{rewardKopecks:requested.rewardKopecks}),...(requested.reason?{reason:requested.reason}:{})}};
      }
      if(command?.action.startsWith('admin.')&&!hasRole(account,'admin'))authorityError('admin_required');
      if(command?.action==='offer.business'&&(!hasRole(account,'partner')||hasRole(account,'admin')))authorityError('partner_required');
      if(!command)readContext=context??{expiresAt:gate.expiresAt};
      claimToken=crypto.randomUUID();
      const claim=await repo.db.prepare(`INSERT INTO telegram_update_receipts
        (update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at)
        VALUES(?,?,?,'processing',?,1,?,?) ON CONFLICT(update_id) DO NOTHING RETURNING update_id`)
        .bind(update.update_id,update.callback_query?'callback_query':'message',actor,claimToken,now,Math.min(now+300,gate.expiresAt)).first();
      if(claim?.update_id!==update.update_id)return {response:new Response('OK'),legacyEnv:env};
      claimed=true;
      // Scope only after the actual verified webhook, current account and
      // processing claim. A body-selected ID cannot choose this release mode.
      const releaseScoped=scopeV141ReleaseActor(scoped,actor);
      if(releaseScoped!==scoped) {
        scoped=releaseScoped;
        repo=await repositoryFactory(scoped,{readOnly:false,budget,...(gate.accessScope==='admin'?{accessScope:'admin'}:{})});
        await repo.assertCandidateSchema();
      }
      if(runtimeBindingEnabled(scoped)) {
        await assertRuntimeBindingReady({binding:scoped.DB,env:scoped});
        runtimeBase=await createCabinetCustomerContext({binding:scoped.DB,env:scoped,webhookRequest:request,
          receiptClaimToken:claimToken,channel:update.callback_query?'telegram_callback':'telegram_command',
          operation:'account.menu.read',nowSeconds:now});
        bindRuntimeContext(scoped,runtimeBase);
        const selected=await authorizeTelegramHandler(runtimeBase,update);
        if(!selected)authorityError('unknown_telegram_handler',403);
        runtimeAuthorization=selected.authorization;
      }
      if(command&&platformAdmin){
        const receipt=await repo.one('telegram_update_receipts','update_id=?',[update.update_id]);
        if(receipt?.actorId!==actor||receipt.status!=='processing'||receipt.claimToken!==claimToken||receipt.leaseExpiresAt<=now)authorityError('invalid_request',400);
        context=createVerifiedTelegramCommandContext({authentication,gate,callback:parsedCallback,claimToken,
          receiptExpiresAt:receipt.leaseExpiresAt,nowSeconds:now});
      }
      if(command){
        let message='Изменение сохранено. Обновите кабинет, чтобы увидеть актуальное состояние.';
        if(command.action==='admin.partner.beta'){
          const beta=await grantTelegramPartnerBeta({repo,env:scoped,context,gate,profileId:command.target.profileId,updateId:update.update_id,nowSeconds:now,
            ...(runtimeAuthorization?{authorization:runtimeAuthorization}:{})});
          message=beta.alreadyGranted?'Beta уже активна. Откройте свежую панель, чтобы проверить срок.'
            :'Partner Beta сохранена на 60 минут. Откройте свежую панель, чтобы проверить срок.';
        }
        else if(runtimeAuthorization)await executeTelegramMutation(runtimeAuthorization);
        else {const service=createCabinetService({repo,env:scoped,context,gate,nowSeconds:now});
          await service.trusted(command.action,command.payload,command.target,`telegram_update_${update.update_id}`);}
        if(runtimeBase) {
          const presentation=await deriveTrustedOperationContext(runtimeBase,{operation:platformAdmin?'admin.cabinet.open':'profile.read_own',requestPayload:{}});
          runtimeAuthorization=await createRuntimeAuthorizer().authorize(presentation,platformAdmin?{kind:'admin_surface',key:'cabinet'}:null);
          requireRuntimeAuthorization(runtimeAuthorization);
        }
        await acknowledge('Сохранено.');await send(message);
      }else if(requested.kind==='open')await send('Ваш кабинет',[ [{text:'Открыть кабинет',web_app:{url:gate.origin+CABINET_APP_PREFIX}}] ]);
      else if(requested.kind==='admin'||requested.kind==='offers'){
        const view=await menu(repo,requested.kind,actor,gate,context,env.MINI_APP_IDEMPOTENCY_SECRET,env,now);await send(view.text,view.keyboard);
      }else await send('Команда не распознана. Откройте кабинет командой /cabinet.');
      await repo.db.prepare("UPDATE telegram_update_receipts SET status='completed',lease_expires_at=0,completed_at=unixepoch() WHERE update_id=? AND claim_token=? AND status='processing'")
        .bind(update.update_id,claimToken).run();
    }catch(error){
      if(claimed&&repo)try{await repo.db.prepare("UPDATE telegram_update_receipts SET status='failed',lease_expires_at=0,completed_at=unixepoch(),last_error_code='rebuild_telegram_outcome_unverified' WHERE update_id=? AND claim_token=? AND status='processing'")
        .bind(update.update_id,claimToken).run();}catch{}
      // Once an outbound request starts, never send a second message or retry
      // it after a lost response. Commands also never retry unknown D1 writes.
      if(authorized&&!deliveryStarted&&!['release_lease_unavailable','storage_unavailable','query_budget_unavailable'].includes(error?.code))try{
        if(update?.callback_query)await acknowledge('Откройте свежую панель и проверьте состояние перед повторным действием.');
        else await send(error?.code==='session_required'
          ?'Сначала откройте /cabinet и войдите в мини-приложение. Затем вернитесь к действию.'
          :'Не удалось подтвердить действие. Откройте свежую панель и проверьте состояние перед повторным действием.');
      }catch{}
    }
    return {response:new Response('OK'),legacyEnv:env};
  };
}
