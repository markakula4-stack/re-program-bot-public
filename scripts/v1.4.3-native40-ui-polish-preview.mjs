// Offline visual review of the actual loader, partner cabinet and owner remote.
// helper exercises real local modules with a synthetic Professional receipt;
// no account, production credential, real payment or provider call is used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {createOfflineSubscriptionVisual} from './v1.4.3-native40-ui-preview.mjs';
import {handleStarsRefundedPaymentUpdate} from '../src/v1.3.6/stars-access-runtime.mjs';
import {runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {MiniAppClient, mountThemeSelector} from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import {mountCabinet} from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import {AdminClient} from '../src/v1.4.0-rebuild/mini-app/admin-client.mjs';
import {mountAdminCabinet} from '../src/v1.4.0-rebuild/mini-app/admin-view.mjs';

const requireDom=createRequire(process.env.CABINET_UI_DOM_ROOT
  ? `${process.env.CABINET_UI_DOM_ROOT}/package.json`
  : new URL('../tests/p08-ui/package.json',import.meta.url));
const {parseHTML}=requireDom('linkedom');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const POLISH_VISUAL_CASES=Object.freeze([
  {state:'partner-launch',fixture:'launch',target:'#launch-screen'},
  {state:'profile-top',fixture:'profile',target:'#theme-bar'},
  {state:'profile-legal',fixture:'profile',target:'.legal-saved'},
  {state:'free-current',fixture:'free',target:'.subscription-current'},
  {state:'refunded-current',fixture:'refunded',target:'.subscription-current'},
  {state:'professional-current',fixture:'current',target:'.subscription-current'},
  {state:'catalog',fixture:'current',target:'.subscription-plans'},
  {state:'dragon-catalog',fixture:'current',target:'.subscription-plans .subscription-plan-dragon'},
  {state:'monthly',fixture:'current',target:'.subscription-monthly'},
  {state:'admin-pult',fixture:'admin',target:'.admin-hero'}
].map(value=>Object.freeze(value)));
const WIDTHS=Object.freeze([320,360,390,430]);
const THEMES=Object.freeze(['light','dark']);
const POLISHED_SECTIONS=Object.freeze([
  '.subscription-current','.subscription-plans','.subscription-monthly',
  '.subscription-history','.subscription-capacity','.subscription-preview',
  '.subscription-payment-help','.subscription-telegram-details'
]);
const expectedFrames=POLISH_VISUAL_CASES.length*WIDTHS.length*THEMES.length;
const expectedFiles=()=>POLISH_VISUAL_CASES.flatMap(value=>THEMES.flatMap(theme=>WIDTHS.map(width=>`${value.state}-${theme}-${width}.html`)));
const SOURCE_FILES=Object.freeze(['subscription-view.mjs','subscription-view.css','cabinet-view.mjs','cabinet-client.mjs',
  'telegram-actions-view.mjs','partner-cabinet.css','partner-cabinet.html','cabinet-theme-bootstrap.js',
  'admin-view.mjs','admin-client.mjs','admin-cabinet.css','admin-cabinet.html']);
const INTERACTION_FIXTURES=Object.freeze(['partner','admin']);
const expectedInteractions=INTERACTION_FIXTURES.length*WIDTHS.length*2;

// Observe natural browser frames rather than assuming a timer callback lands
// inside the 220 ms transition. Busy CI can deliver a timer before the browser
// starts an animation. Endpoints-only samples still fail the strict verifier.
export async function observePolishCrossfade(read,{start,reducedMotion,nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve)),now=()=>performance.now(),timeoutMs=2000,maxFrames=120}={}) {
  const began=now(),observations=[];
  let sample=read();
  if(reducedMotion)return {sample,observed:false,frames:0,elapsedMs:now()-began,observations};
  for(let frame=0;frame<maxFrames;frame++) {
    const remaining=timeoutMs-(now()-began);
    if(remaining<=0)break;
    let timer;
    const arrived=await Promise.race([
      Promise.resolve().then(nextFrame).then(()=>true),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),remaining);})
    ]).finally(()=>clearTimeout(timer));
    if(!arrived)break;
    sample=read();
    const elapsedMs=now()-began;
    observations.push({elapsedMs,oldOpacity:sample.old.opacity,nextOpacity:sample.next.opacity});
    if(sample.old.opacity>0&&sample.old.opacity<1&&sample.next.opacity>0&&sample.next.opacity<1
      &&sample.old.opacity<start.old.opacity&&sample.next.opacity>start.next.opacity)
      return {sample,observed:true,frames:observations.length,elapsedMs,observations};
  }
  return {sample,observed:false,frames:observations.length,elapsedMs:now()-began,observations};
}

// Evidence metadata is fixed above the viewport, without changing the actual
// application layout or inserting synthetic values into its status controls.
function appendSyntheticLabel(document,fixture) {
  const label=document.createElement('p');label.className='visual-fixture-label';label.setAttribute('data-visual-synthetic',fixture);
  label.setAttribute('style','position:fixed;z-index:30;top:3px;right:6px;margin:0;padding:2px 5px;font:10px/1.2 system-ui,sans-serif;color:#ffffff;background:#263b56;border-radius:4px;pointer-events:none;max-width:calc(100vw - 12px)');
  label.textContent='Синтетический макет · только просмотр';document.body.append(label);
}

function createLaunchPolishVisual({after=()=>{}}={}) {
  const {document,window}=parseHTML(fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html',import.meta.url),'utf8'));
  appendSyntheticLabel(document,'launch');
  const close=()=>{};after(close);
  return {document,window,calls:[],providerCalls:[],fixtureScope:'launch',close};
}

// The owner remote is rendered through its actual view and client. These fixed
// in-memory DTOs are synthetic styling evidence, never account/role proof.
// Only a local session handshake and the two fixed reads are accepted; writes
// are unavailable both in the feature DTO and in this fake transport.
async function createAdminPolishVisual({after=()=>{}}={}) {
  const now=Math.floor(Date.now()/1000),calls=[];
  const {document,window}=parseHTML(fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/admin-cabinet.html',import.meta.url),'utf8'));
  window.HTMLElement.prototype.focus=function(){};
  const features={version:1,mutationsEnabled:false};
  const authorization={version:1,capability:'admin.cabinet.open',allowed:true,reasonCode:'allowed',
    policyVersion:'offline.synthetic.visual.1',effectivePlan:'free',accessState:'none',validUntil:now+300,quota:null,actionPolicy:'allow'};
  const envelope=section=>({readModelVersion:1,section,generatedAt:now,authorization,features:{mutationsEnabled:false}});
  const overview={...envelope('overview'),counts:{},release:{version:'1.4.3 · демо',mode:'owner_only',partnerBetaEnabled:false}};
  const settings={...envelope('settings'),items:[
    {key:'ai_rollout_mode',value:'all',allowedValues:['off','admin','all'],editable:true},
    {key:'official_web_enabled',value:false,allowedValues:[false,true],editable:true},
    {key:'official_web_stale_enabled',value:false,allowedValues:[false,true],editable:true}],
    publicEnablement:{providerConnected:true,activePrograms:1,approvedPrograms:1,ready:true,reasonCode:'ready'}};
  const client=new AdminClient({origin:'https://offline-visual.example',now:()=>now*1000,fetchImpl:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/session')&&init.method==='POST')return Response.json({sessionToken:'rpms1_'+'c'.repeat(43),tokenType:'Bearer',expiresAt:now+300,authorizationVersion:1,features});
    if(init.method!=='GET')throw new Error('polish_admin_forbidden_producer');
    if(url.endsWith('/admin/overview'))return Response.json(overview);
    if(url.endsWith('/admin/settings'))return Response.json(settings);
    throw new Error('polish_admin_unexpected_read');
  }});
  await client.authenticate('offline-visual-admin');
  const app=mountAdminCabinet({document,client});
  try {
    await app.start();
    if(!document.querySelector('.admin-ai-modes'))throw new Error('polish_admin_actual_view_missing');
    appendSyntheticLabel(document,'admin');
    const theme=mountThemeSelector({document,storage:null,media:null});
    const close=()=>{theme.destroy();app.destroy();};after(close);
    return {document,window,app,client,calls,providerCalls:[],fixtureScope:'admin',close};
  } catch(error){app.destroy();throw error;}
}

// The profile DTO below is intentionally synthetic, read-only and does not
// claim to describe any real person. Its DOM is produced by mountCabinet.
export async function createPolishVisual({state='current',after=()=>{}}={}) {
  if(state==='launch')return createLaunchPolishVisual({after});
  if(state==='admin')return createAdminPolishVisual({after});
  if(!['current','free','refunded','profile'].includes(state))throw new Error('polish_visual_fixture_invalid');
  const h=await createOfflineSubscriptionVisual({state:state==='free'?'purchase':'current'});
  const cleanup=[];
  try {
    if(state==='free') {
      const dialog=h.document.querySelector('dialog');
      [...dialog.querySelectorAll('button')].find(node=>node.textContent==='Назад').click();await h.flush();
    }
    if(state==='refunded') {
      const paid=h.f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment' AND direction='credit'").get();
      const order=h.f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(paid.order_id);
      await handleStarsRefundedPaymentUpdate(h.f.serverEnv,{update_id:1439777,message:{message_id:1439778,
        from:{id:101,is_bot:false},chat:{id:101,type:'private'},refunded_payment:{currency:'XTR',total_amount:paid.amount_stars,
          invoice_payload:order.invoice_payload,telegram_payment_charge_id:paid.telegram_payment_charge_id,provider_payment_charge_id:''}}},
        {receivedAt:h.f.now});
      await h.app.navigate('subscription',{preserveScroll:true});await h.flush();
    }
    if(state==='profile') {
      const authorization=runtimeAuthorizationDTO(await h.f.auth({operation:'profile.read_own'}));
      const partner={state:'active_partner',application:{ageConfirmed:true},
        profile:{partnerId:41,displayName:'Демо партнёр',telegramUsername:'demo_partner',publicUsernameEnabled:false},
        legalProfile:{profileKind:'self_employed',verificationState:'self_declared'},
        beta:{expired:false,accessStatus:'active',canCreatePrivateOffers:false,canSubmitOffers:false},
        actions:{submitApplication:false,declareLegalProfile:true,manageOffers:false}};
      const features={version:1,mutationsEnabled:false,offerActionsEnabled:false};
      const profile={readModelVersion:1,generatedAt:h.f.now,authorization,systemRole:'partner',partner,
        account:{memberSince:h.f.now-86400*30,generalTermsAccepted:true},
        access:{planName:'Free',planCode:'free',accessState:'none',reviewRequired:false,readPath:'system_default'}};
      const bootstrap={...profile,features,navigation:['profile','offers','applications','analytics','subscription']
        .map(section=>({section,enabled:true,reason:null})),counts:{visibleOffers:0,ownOffers:0,ownApplications:0,attributedApplications:0}};
      h.app.destroy();
      const client=new MiniAppClient({origin:'https://offline-visual.example',now:()=>h.f.now*1000,
        fetchImpl:async(url,init)=>{
          if(url.endsWith('/session'))return Response.json({sessionToken:'rpms1_'+'b'.repeat(43),tokenType:'Bearer',expiresAt:h.f.now+300,authorizationVersion:1,features});
          if(init.method!=='GET')throw new Error('polish_profile_forbidden_producer');
          if(!url.endsWith('/bootstrap')&&!url.endsWith('/profile'))throw new Error('polish_profile_unexpected_read');
          return Response.json(url.endsWith('/bootstrap')?bootstrap:profile);
        }});
      await client.authenticate('offline-visual-profile');h.window.location.hash='#profile';
      const app=mountCabinet({document:h.document,client});cleanup.push(()=>app.destroy());await app.start();
    }
    const theme=mountThemeSelector({document:h.document,storage:null,media:null});cleanup.push(()=>theme.destroy());
    const close=()=>{for(const fn of cleanup)fn();h.close();};after(close);
    return {...h,close,fixtureScope:state};
  } catch(error){for(const fn of cleanup)fn();h.close();throw error;}
}

// This evidence uses the actual browser modules with listeners intact. The
// DTOs and transport stay local and read-only; no real session is represented.
async function writeInteractionFixtures(directory,cssFor,manifest) {
  const requireRuntime=createRequire(process.env.CABINET_UI_RUNTIME_ROOT
    ? `${process.env.CABINET_UI_RUNTIME_ROOT}/package.json`
    : new URL('../tests/p11-runtime/package.json',import.meta.url));
  const {build}=requireRuntime('esbuild');
  const h=await createOfflineSubscriptionVisual({state:'current'});
  let subscription,now;
  try {subscription=await h.client.read('subscription');now=h.f.now;} finally {h.close();}
  const features={version:1,mutationsEnabled:false,offerActionsEnabled:false};
  subscription={...subscription,features};
  const authorization={version:1,capability:'profile.read_own',allowed:true,reasonCode:'allowed',
    policyVersion:'offline.synthetic.motion.1',effectivePlan:'free',accessState:'none',validUntil:now+300,quota:null,actionPolicy:'allow'};
  const partner={state:'active_partner',application:{ageConfirmed:true},
    profile:{partnerId:41,displayName:'Демо партнёр',telegramUsername:'demo_partner',publicUsernameEnabled:false},
    legalProfile:{profileKind:'self_employed',verificationState:'self_declared'},
    beta:{expired:false,accessStatus:'active',canCreatePrivateOffers:false,canSubmitOffers:false},
    actions:{submitApplication:false,declareLegalProfile:true,manageOffers:false}};
  const profile={readModelVersion:1,generatedAt:now,authorization,features,systemRole:'partner',partner,
    account:{memberSince:now-86400*30,generalTermsAccepted:true},
    access:{planName:'Free',planCode:'free',accessState:'none',reviewRequired:false,readPath:'system_default'}};
  const bootstrap={...profile,navigation:['profile','offers','applications','analytics','subscription']
    .map(section=>({section,enabled:true,reason:null})),counts:{visibleOffers:0,ownOffers:0,ownApplications:0,attributedApplications:0}};
  const adminAuthorization={...authorization,capability:'admin.cabinet.open'};
  const adminEnvelope=section=>({readModelVersion:1,section,generatedAt:now,authorization:adminAuthorization,features:{mutationsEnabled:false}});
  const overview={...adminEnvelope('overview'),counts:{},release:{version:'1.4.3 · демо',mode:'owner_only',partnerBetaEnabled:false}};
  const settings={...adminEnvelope('settings'),items:[
    {key:'ai_rollout_mode',value:'all',allowedValues:['off','admin','all'],editable:true},
    {key:'official_web_enabled',value:false,allowedValues:[false,true],editable:true},
    {key:'official_web_stale_enabled',value:false,allowedValues:[false,true],editable:true}],
    publicEnablement:{providerConnected:true,activePrograms:1,approvedPrograms:1,ready:true,reasonCode:'ready'}};
  const support={...adminEnvelope('support'),items:[],total:0,offset:0,limit:20,hasMore:false};
  const dto={now,features,bootstrap,profile,subscription,overview,settings,support};
  const source=`
    import {MiniAppClient,mountThemeSelector,CABINET_THEME_STORAGE_KEY} from './cabinet-client.mjs';
    import {mountCabinet} from './cabinet-view.mjs';
    import {AdminClient} from './admin-client.mjs';
    import {mountAdminCabinet} from './admin-view.mjs';
    const dto=${JSON.stringify(dto)};
    // The isolated readonly fixture uses the same fixed snapshot clock as its
    // clients. Actual CSS animation frames and performance.now stay untouched.
    const fixtureHostEpochMs=Date.now();
    Date.now=()=>dto.now*1000;
    const scope=document.documentElement.getAttribute('data-motion-fixture');
    const calls=[],values=new Map([[CABINET_THEME_STORAGE_KEY,'dark'],['re-subscription-receipt-seen-v1',JSON.stringify(dto.subscription.history.items.map(item=>item.receiptId))]]);
    const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
    const fetchImpl=async(url,init)=>{
      const parsed=new URL(url);calls.push({path:parsed.pathname,method:init.method});
      if(parsed.pathname.endsWith('/session')&&init.method==='POST')return Response.json({sessionToken:'rpms1_'+'d'.repeat(43),tokenType:'Bearer',expiresAt:dto.now+300,authorizationVersion:1,features:scope==='admin'?{version:1,mutationsEnabled:false}:dto.features});
      if(init.method!=='GET')throw new Error('motion_fixture_producer_forbidden');
      const name=parsed.pathname.split('/').pop();
      const value=(scope==='admin'?{overview:dto.overview,settings:dto.settings,support:dto.support}:{bootstrap:dto.bootstrap,profile:dto.profile,subscription:dto.subscription})[name];
      if(!value)throw new Error('motion_fixture_unexpected_read');
      return Response.json(value);
    };
    const client=scope==='admin'?new AdminClient({origin:'https://offline-visual.example',now:()=>dto.now*1000,fetchImpl}):new MiniAppClient({origin:'https://offline-visual.example',now:()=>dto.now*1000,fetchImpl,pendingStorage:storage});
    const home=scope==='admin'?'settings':'profile',other=scope==='admin'?'support':'subscription';
    const navSelector=scope==='admin'?'#admin-navigation':'#navigation';
    const nav=()=>document.querySelector(navSelector),buttons=()=>[...nav().querySelectorAll('button[data-section]')];
    const themeButtons=()=>[...document.querySelectorAll('#theme-switcher button[data-theme-value]')];
    const rectangle=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const appearance=node=>{const p=getComputedStyle(node,'::before'),s=getComputedStyle(node),ray=getComputedStyle(node,'::after');return {key:node.getAttribute('data-section')??node.getAttribute('data-theme-value'),selected:node.getAttribute('aria-current')==='page'||node.getAttribute('aria-pressed')==='true',opacity:Number(p.opacity),transitionDuration:p.transitionDuration,transitionProperty:p.transitionProperty,rect:rectangle(node),overflow:s.overflow,inset:[p.top,p.right,p.bottom,p.left],position:p.position,zIndex:p.zIndex,pointerEvents:p.pointerEvents,rayContent:ray.content,rayBackground:ray.backgroundImage};};
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const observeCrossfade=${observePolishCrossfade.toString()};
    const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const selected=()=>buttons().filter(node=>node.getAttribute('aria-current')==='page').map(node=>node.getAttribute('data-section'));
    const allSame=initial=>initial.length===buttons().length&&initial.every((node,i)=>node===buttons()[i]);
    const settled=async()=>{for(let i=0;i<100;i++){if(document.querySelector(scope==='admin'?'#admin-screen':'#screen').getAttribute('aria-busy')!=='true')return;await wait(10);}throw new Error('motion_fixture_read_unsettled');};
    let app,theme;
    window.__motionReady=(async()=>{
      try {localStorage.setItem('re-subscription-receipt-seen-v1',storage.getItem('re-subscription-receipt-seen-v1'));} catch {}
      await client.authenticate('offline-synthetic-motion');
      app=scope==='admin'?mountAdminCabinet({document,client}):mountCabinet({document,client});
      theme=mountThemeSelector({document,storage,media:matchMedia('(prefers-color-scheme: dark)')});
      await app.start();await wait(300);window.scrollTo(0,0);return true;
    })();
    window.__probeMotion=async()=>{
      await window.__motionReady;
      const initial=buttons(),initialGeometry=initial.map(rectangle),themeInitial=themeButtons();
      const old=themeButtons().find(node=>node.getAttribute('data-theme-value')==='dark'),next=themeButtons().find(node=>node.getAttribute('data-theme-value')==='system');
      const themeBefore={old:appearance(old),next:appearance(next)};
      next.click();const themeStart={old:appearance(old),next:appearance(next)};
      const themeSampling=await observeCrossfade(()=>({old:appearance(old),next:appearance(next)}),{start:themeStart,reducedMotion});
      const themeMid=themeSampling.sample;
      await wait(220);const themeEnd={old:appearance(old),next:appearance(next)};
      for(const value of ['dark','system','light','dark'])themeButtons().find(node=>node.getAttribute('data-theme-value')===value).click();
      await wait(300);
      const current=initial.find(node=>node.getAttribute('data-section')===home),target=initial.find(node=>node.getAttribute('data-section')===other);
      const navBefore={old:appearance(current),next:appearance(target)};
      target.click();const navStart={old:appearance(current),next:appearance(target)};
      const navSampling=await observeCrossfade(()=>({old:appearance(current),next:appearance(target)}),{start:navStart,reducedMotion});
      const navMid=navSampling.sample;
      await wait(220);await settled();const navEnd={old:appearance(current),next:appearance(target)};
      const stableAfterNavigate=allSame(initial);
      for(const section of [home,other,home])initial.find(node=>node.getAttribute('data-section')===section).click();
      await wait(300);await settled();
      const lastNavigation=selected(),stableAfterRapidClicks=allSame(initial);
      const readsBeforeRefresh=calls.length;
      if(scope==='partner')await app.navigate(home,{preserveScroll:true});else await app.navigate(home);
      await settled();await wait(260);
      const report={scope,requestedWidth:innerWidth,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,reducedMotion,
        fixtureClock:{mode:'SYNTHETIC_FIXED_SOURCE_SNAPSHOT',sourceEpochMs:dto.now*1000,dateNowMs:Date.now(),hostEpochMsBeforeAlignment:fixtureHostEpochMs,
          sessionExpiresAt:client.expiresAt,subscriptionValidUntil:dto.subscription.authorization.validUntil,
          performanceClock:'ACTUAL_BROWSER_MONOTONIC_UNCHANGED',monotonicNowMs:performance.now()},
        themeBefore,themeStart,themeMid,themeEnd,navBefore,navStart,navMid,navEnd,home,other,
        themeSampling,navSampling,
        stableAfterNavigate,stableAfterRapidClicks,stableAfterRefresh:allSame(initial),stableThemeButtons:themeInitial.every((node,i)=>node===themeButtons()[i]),
        finalNavigation:selected(),lastNavigation,finalTheme:document.documentElement.getAttribute('data-theme-mode'),savedTheme:storage.getItem(CABINET_THEME_STORAGE_KEY),
        refreshReadCount:calls.length-readsBeforeRefresh,calls,initialGeometry,finalGeometry:buttons().map(rectangle),
        finalButtons:buttons().map(appearance),finalThemeButtons:themeButtons().map(appearance),
        scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,writeControlsEnabled:document.querySelectorAll('[data-admin-write="true"]:not(:disabled)').length,
        currentPlan:document.querySelector('.subscription-current')?.getAttribute('data-current-plan')??null};
      theme.destroy();theme=mountThemeSelector({document,storage,media:matchMedia('(prefers-color-scheme: dark)')});
      report.remountedTheme=document.documentElement.getAttribute('data-theme-mode');report.selectedThemeCount=document.querySelectorAll('#theme-switcher [aria-pressed="true"]').length;
      return report;
    };
  `;
  const bundle=await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('../src/v1.4.0-rebuild/mini-app/',import.meta.url)),sourcefile:'offline-motion-fixture.mjs',loader:'js'},bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,logLevel:'silent'});
  const bundled=bundle.outputFiles[0].text;
  for(const fixture of INTERACTION_FIXTURES) {
    const filename=`interaction-${fixture}.html`;
    const {document}=parseHTML(fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/'+(fixture==='admin'?'admin-cabinet.html':'partner-cabinet.html'),import.meta.url),'utf8'));
    document.querySelectorAll('script, link[rel="stylesheet"]').forEach(node=>node.remove());
    document.documentElement.removeAttribute('data-launch-state');document.documentElement.setAttribute('data-color-theme','dark');
    document.documentElement.setAttribute('data-theme-mode','dark');document.documentElement.setAttribute('data-motion-fixture',fixture);
    const policy=document.createElement('meta');policy.setAttribute('http-equiv','Content-Security-Policy');
    policy.setAttribute('content',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'");document.head.prepend(policy);
    const style=document.createElement('style');style.textContent=cssFor(fixture);document.head.append(style);
    appendSyntheticLabel(document,'interactive-'+fixture);
    const script=document.createElement('script');script.textContent=bundled;document.body.append(script);
    const bytes=Buffer.from(document.toString());fs.writeFileSync(path.join(directory,filename),bytes);
    manifest.interactionFiles.push({filename,fixture,sha256:hash(bytes),bytes:bytes.length,bundleSha256:hash(Buffer.from(bundled)),clock:'Synthetic fixed source snapshot shared by views and clients; actual CSS/performance clocks unchanged.',transport:'In-memory synthetic responses; all producer requests rejected except one local session handshake.'});
  }
}

export async function writePolishedSubscriptionVisuals(directory) {
  if(globalThis.__RE_PART05_OFFLINE_NETWORK_BLOCKED__!==true)throw new Error('polish_visual_offline_guard_required');
  fs.mkdirSync(directory,{recursive:true});
  const base=new URL('../src/v1.4.0-rebuild/mini-app/',import.meta.url);
  const cssFor=fixture=>['partner-cabinet.css',fixture==='admin'?'admin-cabinet.css':'subscription-view.css']
    .map(name=>fs.readFileSync(new URL(name,base),'utf8')).join('\n');
  const sourceHashes=Object.fromEntries(SOURCE_FILES.map(name=>[name,hash(fs.readFileSync(new URL(name,base)))]));
  sourceHashes['fixtureProducer']=hash(fs.readFileSync(new URL('./v1.4.3-native40-ui-preview.mjs',import.meta.url)));
  sourceHashes['polishPreviewScript']=hash(fs.readFileSync(fileURLToPath(import.meta.url)));
  const manifest={schema:6,status:'OFFLINE_SYNTHETIC_POLISHED_ACTUAL_UI',
    sourceSha:process.env.GITHUB_SHA??null,workflowRunId:process.env.GITHUB_RUN_ID??null,
    sourceHashes,widths:WIDTHS,themes:THEMES,viewportHeight:800,deviceScaleFactor:1,
    states:POLISH_VISUAL_CASES,expectedFrames,
    fixtureScope:'Synthetic genuine local paid Professional, unpaid Free and Telegram refunded-payment projections; actual static partner launch HTML; explicitly synthetic read-only partner profile and owner remote. The loader is a visual initial state without authentication or network calls. The owner DTO does not prove a real role, account, AI or provider state. No live account, real transaction or provider cancellation claim. Dragon is inspected only as a catalog choice.',
    behaviorScope:'80 static browser renders inspect canonical partner/admin CSS, ray-free deep-blue backgrounds, clipped selected-control highlights, saved-profile badge, tariff identity and owner settings. Serialized static fixtures do not preserve application listeners. Separate bundled fixtures mount actual clients/views/listeners and prove selection transitions, rapid clicks, refresh identity and reduced motion in the same real Chrome run.',
    networkScope:'Node outbound transport guard plus Chrome pipe, local file navigation, restrictive CSP, blocked HTTP/WebSocket and DNS.',
    polishedSections:POLISHED_SECTIONS,files:[],interactionFiles:[],expectedInteractions};
  for(const visual of POLISH_VISUAL_CASES) {
    const h=await createPolishVisual({state:visual.fixture});
    try {
      const document=h.document;
      document.querySelectorAll('script, link[rel="stylesheet"]').forEach(node=>node.remove());
      if(visual.fixture!=='launch')document.documentElement.removeAttribute('data-launch-state');
      const policy=document.createElement('meta');policy.setAttribute('http-equiv','Content-Security-Policy');
      policy.setAttribute('content',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'");
      document.head.prepend(policy);
      const style=document.createElement('style');style.textContent=cssFor(visual.fixture);document.head.append(style);
      const dialog=document.querySelector('dialog');dialog?.removeAttribute('open');
      for(const selector of ['profile','admin','launch'].includes(visual.fixture)?[]:POLISHED_SECTIONS){
        const node=document.querySelector(selector);
        if(!node)throw new Error('polish_visual_section_missing:'+selector);
        for(let ancestor=node;ancestor;ancestor=ancestor.parentElement)
          if(ancestor.localName==='details'&&!ancestor.hasAttribute('open'))throw new Error('polish_visual_section_collapsed:'+selector);
      }
      if(!document.querySelector(visual.target))throw new Error('polish_visual_scroll_target_missing:'+visual.state);
      const baseHTML=document.toString();
      for(const theme of THEMES)for(const width of WIDTHS) {
        const {document:out}=parseHTML(baseHTML);
        out.documentElement.setAttribute('data-color-theme',theme);
        out.documentElement.setAttribute('data-theme-mode',theme);
        out.querySelectorAll('[data-theme-value]').forEach(node=>node.setAttribute('aria-pressed',String(node.getAttribute('data-theme-value')===theme)));
        out.documentElement.setAttribute('data-visual-state',visual.state);
        const script=out.createElement('script');script.textContent=`
          const dialog=document.querySelector('dialog');
          if(dialog){dialog.showModal();dialog.querySelector('[data-subscription-confirmation]').focus({preventScroll:true});}
          const scrollTarget=document.querySelector(${JSON.stringify(visual.target)});
          if(!dialog){const target=scrollTarget.classList.contains('legal-saved')?scrollTarget.closest('.card'):scrollTarget;window.scrollTo(0,Math.max(0,target.getBoundingClientRect().top+scrollY-18));}
          const measure=()=>{
            const visualFixtureLaunch=${JSON.stringify(visual.fixture==='launch')};
            const visible=node=>!!(node.offsetWidth||node.offsetHeight||node.getClientRects().length);
            const box=r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height});
            const rect=node=>box(node.getBoundingClientRect());
            const closedDetails=node=>{for(let n=node;n;n=n.parentElement)if(n.localName==='details'&&!n.open)return true;return false;};
            const targets=[...document.querySelectorAll('button,a[href],summary,.subscription-consent,.admin-switch-row')].filter(visible);
            const badTargets=targets.filter(node=>node.getBoundingClientRect().height<43.5).map(node=>({text:node.textContent,height:node.getBoundingClientRect().height}));
            // Measure content with decoration and clipping temporarily disabled,
            // then restore the exact body style before reporting/screenshotting.
            const overflowSelectors='.app,.hero,.admin-hero,.theme-bar,.theme-switcher,.navigation,.admin-navigation,.screen,.card,.launch-content,.launch-help,button,input:not([type="checkbox"]),select,textarea,a[href]:not(.skip),summary';
            const bodyStyle=document.body.getAttribute('style'),contentProbe=document.createElement('style');
            contentProbe.textContent='body::before,.launch-screen::before,.brand::after,.theme-switcher button::after,.navigation button::after,.button.primary::after,.admin-navigation button::after,.admin-ai-modes button::after{content:none!important}body,.app{overflow-x:visible!important}';
            document.head.append(contentProbe);
            let contentGeometry;
            try {
              document.body.style.setProperty('overflow-x','visible','important');
              const overflowNodes=[...document.querySelectorAll(overflowSelectors)].filter(visible).filter(node=>{const r=node.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5;}).map(node=>({tag:node.localName,className:node.className,text:node.textContent.slice(0,80),rect:rect(node)}));
              contentGeometry={scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth,clientWidth:document.documentElement.clientWidth,overflowNodes};
            } finally {
              contentProbe.remove();if(bodyStyle===null)document.body.removeAttribute('style');else document.body.setAttribute('style',bodyStyle);
            }
            const sections=${JSON.stringify(POLISHED_SECTIONS)}.map(selector=>{const node=document.querySelector(selector);return {selector,exists:!!node,visible:!!node&&visible(node),closedDetails:!!node&&closedDetails(node),rect:node?rect(node):null};});
            const cardStyles=['.subscription-current','.subscription-plans .subscription-plan-professional','.subscription-plans .subscription-plan-dragon','.subscription-monthly .subscription-plan-professional','.subscription-monthly .subscription-plan-dragon'].map(selector=>{const node=document.querySelector(selector);if(!node)return {selector,missing:true};const s=getComputedStyle(node);return {selector,className:node.className,backgroundColor:s.backgroundColor,backgroundImage:s.backgroundImage,borderColor:s.borderColor,color:s.color};});
            const parseColor=color=>{let match=color.match(/^rgba?\\(([^)]+)\\)$/),scale=255;if(!match){match=color.match(/^color\\(srgb ([^)]+)\\)$/);scale=1;}if(!match)return null;const raw=match[1].split(/[ ,/]+/).map(Number),values=raw.slice(0,3).map(value=>{value/=scale;return value<=.04045?value/12.92:Math.pow((value+.055)/1.055,2.4);});return {luminance:values[0]*.2126+values[1]*.7152+values[2]*.0722,alpha:raw[3]??1};};
            const styleOf=(selector,pseudo=null)=>{const node=document.querySelector(selector);if(!node)return null;const value=getComputedStyle(node,pseudo),ink=parseColor(value.color),baseColors=[...value.backgroundImage.matchAll(/rgba?\\([^)]+\\)|color\\(srgb [^)]+\\)/g)].map(match=>parseColor(match[0])).filter(color=>color?.alpha===1);if(!baseColors.length){const fill=parseColor(value.backgroundColor);if(fill?.alpha===1)baseColors.push(fill);}const baseContrasts=ink?baseColors.map(fill=>(Math.max(ink.luminance,fill.luminance)+.05)/(Math.min(ink.luminance,fill.luminance)+.05)):[];return {selector,pseudo,text:node.textContent,className:node.className,rect:rect(node),color:value.color,backgroundColor:value.backgroundColor,backgroundImage:value.backgroundImage,borderColor:value.borderColor,boxShadow:value.boxShadow,content:value.content,opacity:value.opacity,cursor:value.cursor,transform:value.transform,position:value.position,pointerEvents:value.pointerEvents,zIndex:value.zIndex,display:value.display,visibility:value.visibility,width:value.width,height:value.height,top:value.top,right:value.right,bottom:value.bottom,left:value.left,filter:value.filter,maskImage:value.maskImage,maskComposite:value.maskComposite,maskSize:value.maskSize,maskPosition:value.maskPosition,overflow:value.overflow,transitionProperty:value.transitionProperty,transitionDuration:value.transitionDuration,transitionTimingFunction:value.transitionTimingFunction,borderRadius:value.borderRadius,baseFillContrast:baseContrasts.length?Math.min(...baseContrasts):null};};
            const polishStyles={legalSaved:styleOf('.badge.success.legal-saved'),selectedTheme:styleOf('#theme-switcher [aria-pressed="true"]'),selectedNavigation:styleOf('.nav-button[aria-current="page"],#admin-navigation [aria-current="page"]'),selectedAiMode:styleOf('.admin-ai-modes [aria-pressed="true"]'),primary:styleOf('.button.primary:not(:disabled):not(.subscription-plan-professional .button,.subscription-plan-dragon .button,dialog .button)'),freeOrb:styleOf('.subscription-plan-free .subscription-current-heading h3','::before'),freeCatalogOrb:styleOf('.subscription-plan-free .subscription-plan-heading h4','::before'),refresh:styleOf('.screen-head .button')};
            const outwardLight={canvas:styleOf('body','::before'),launchCanvas:styleOf('#launch-screen','::before'),brand:styleOf(${JSON.stringify(visual.fixture==='admin'?'.admin-wordmark .brand':'.launch-brand')},'::after'),selectedTheme:styleOf('#theme-switcher [aria-pressed="true"]','::after'),selectedNavigation:styleOf('.nav-button[aria-current="page"],#admin-navigation [aria-current="page"]','::after'),selectedAiMode:styleOf('.admin-ai-modes [aria-pressed="true"]','::after'),primary:styleOf('.button.primary:not(:disabled):not(.subscription-plan-professional .button,.subscription-plan-dragon .button,dialog .button)','::after')};
            const insideHighlight={selectedTheme:styleOf('#theme-switcher [aria-pressed="true"]','::before'),selectedNavigation:styleOf('.nav-button[aria-current="page"],#admin-navigation [aria-current="page"]','::before'),selectedAiMode:styleOf('.admin-ai-modes [aria-pressed="true"]','::before')};
            const canvas={body:styleOf('body'),launch:styleOf('#launch-screen')};
            const syntheticLabel=document.querySelector('[data-visual-synthetic]'),labelRect=syntheticLabel?rect(syntheticLabel):null;
            const evidenceLabel=syntheticLabel?{text:syntheticLabel.textContent,position:getComputedStyle(syntheticLabel).position,pointerEvents:getComputedStyle(syntheticLabel).pointerEvents,inViewport:visible(syntheticLabel)&&labelRect.top>=0&&labelRect.bottom<=innerHeight&&labelRect.left>=0&&labelRect.right<=innerWidth}:null;
            const launch=visualFixtureLaunch?{state:document.documentElement.getAttribute('data-launch-state'),screen:styleOf('#launch-screen'),brand:styleOf('.launch-brand'),progress:document.querySelector('.launch-progress')?.textContent,statusRole:document.querySelector('#launch-screen')?.getAttribute('role'),themeBarHidden:document.querySelector('#theme-bar')?.hidden}:null;
            const adminNavigationContents=[...document.querySelectorAll('#admin-navigation button')].map(node=>{
              const label=node.querySelector('span:not(.nav-icon)'),icon=node.querySelector('.nav-icon'),svg=icon?.querySelector('svg');
              const range=document.createRange();if(label)range.selectNodeContents(label);
              return {section:node.getAttribute('data-section'),labelText:label?.textContent??null,button:rect(node),label:label?rect(label):null,
                icon:icon?rect(icon):null,svg:svg?rect(svg):null,textRects:label?[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(box):[]};
            });
            const admin=document.querySelector('#admin-cabinet')?{navigationContents:adminNavigationContents,syntheticLabel:syntheticLabel?.textContent??null,syntheticLabelInViewport:!!syntheticLabel&&visible(syntheticLabel)&&labelRect.top>=0&&labelRect.bottom<=innerHeight&&labelRect.left>=0&&labelRect.right<=innerWidth,selectedNavigation:document.querySelector('#admin-navigation [aria-current="page"]')?.getAttribute('data-section')??null,visibleNavigationIcons:[...document.querySelectorAll('#admin-navigation .nav-icon')].filter(visible).length,visibleNavigationSvg:[...document.querySelectorAll('#admin-navigation .nav-icon svg')].filter(visible).length,readOnlyBanner:[...document.querySelectorAll('#admin-screen .card')].some(node=>node.textContent.includes('Изменения сейчас отключены.')),aiModes:[...document.querySelectorAll('.admin-ai-modes button')].map(node=>({mode:node.getAttribute('data-ai-mode'),pressed:node.getAttribute('aria-pressed'),disabled:node.disabled,style:styleOf('.admin-ai-modes [data-ai-mode="'+node.getAttribute('data-ai-mode')+'"]'),ray:styleOf('.admin-ai-modes [data-ai-mode="'+node.getAttribute('data-ai-mode')+'"]','::after')})),disabledWriteCount:document.querySelectorAll('[data-admin-write="true"]:disabled').length,enabledWriteCount:document.querySelectorAll('[data-admin-write="true"]:not(:disabled)').length}:null;
            const report={polishStyles,outwardLight,insideHighlight,canvas,admin,launch,evidenceLabel,contentGeometry,themeMode:document.documentElement.getAttribute('data-theme-mode'),selectedThemeCount:document.querySelectorAll('#theme-switcher [aria-pressed="true"]').length,currentPlan:document.querySelector('.subscription-current')?.getAttribute('data-current-plan')??null,currentStatus:document.querySelector('.subscription-current .badge')?.textContent??null,state:${JSON.stringify(visual.state)},fixtureState:${JSON.stringify(visual.fixture)},theme:${JSON.stringify(theme)},requestedWidth:${width},width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
              scrollY,bodyScrollWidth:document.body.scrollWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,
              scrollTarget:${JSON.stringify(visual.target)},targetRect:rect(scrollTarget),sections,cardStyles,badTargets,
              planLabels:[...document.querySelectorAll('.subscription-plans [data-plan]')].map(node=>({plan:node.getAttribute('data-plan'),price:node.querySelector('.subscription-price')?.textContent,visible:visible(node)})),
              receiptLabels:[...document.querySelectorAll('.subscription-receipt-heading strong')].map(node=>node.textContent),
              termsOpen:[...document.querySelectorAll('details.subscription-terms')].map(node=>({open:node.open,text:node.querySelector('.subscription-terms-text')?.textContent??node.textContent})),
              nativeFeatureHeadings:[...document.querySelectorAll('.subscription-telegram-details .subscription-card >h3')].filter(visible).map(node=>node.textContent),
              dialog:dialog?{...rect(dialog),scrollHeight:dialog.scrollHeight,clientHeight:dialog.clientHeight,focusInside:dialog.contains(document.activeElement),modal:dialog.matches(':modal')}:null};
            let pre=document.getElementById('visual-geometry');if(!pre){pre=document.createElement('pre');pre.id='visual-geometry';pre.hidden=true;document.body.append(pre);}
            pre.textContent=JSON.stringify(report);return report;
          };window.__measureUi=measure;measure();`;
        out.body.append(script);
        const filename=`${visual.state}-${theme}-${width}.html`,bytes=Buffer.from(out.toString());
        fs.writeFileSync(path.join(directory,filename),bytes);
        manifest.files.push({filename,sha256:hash(bytes),bytes:bytes.length,state:visual.state,fixture:visual.fixture,theme,width,target:visual.target});
      }
    } finally {h.close();}
  }
  if(manifest.files.length!==expectedFrames)throw new Error('polish_visual_case_count_invalid');
  await writeInteractionFixtures(directory,cssFor,manifest);
  fs.writeFileSync(path.join(directory,'UI-POLISH-VISUAL-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

export function verifyPolishGeometryReport(report,visual) {
  const canonical=POLISH_VISUAL_CASES.find(value=>value.state===visual.state);
  if(!canonical||visual.fixture!==canonical.fixture||visual.target!==canonical.target||!WIDTHS.includes(visual.width)||!THEMES.includes(visual.theme))throw new Error('polish_fixture_binding_invalid');
  if(report.fixtureState!==visual.fixture)throw new Error('polish_report_fixture_mismatch');
  if(report.width!==visual.width||report.requestedWidth!==visual.width||report.height!==800||report.dpr!==1
    ||report.scrollWidth>report.clientWidth||report.badTargets.length)throw new Error('polish_mobile_geometry_failed');
  if(report.state!==visual.state||report.theme!==visual.theme||report.themeMode!==visual.theme||report.selectedThemeCount!==1
    ||report.scrollTarget!==visual.target)throw new Error('polish_visual_state_failed');
  if(report.targetRect.height<=0||report.targetRect.bottom<=0||report.targetRect.top>=800)throw new Error('polish_target_outside_frame');
  const content=report.contentGeometry;
  if(!content||content.clientWidth!==visual.width||content.scrollWidth>content.clientWidth||content.bodyScrollWidth>content.clientWidth||content.overflowNodes.length)throw new Error('polish_content_overflow_failed');
  const styles=report.polishStyles,rays=report.outwardLight;
  const ordinaryControl=(style,code)=>{
    if(!style||!style.backgroundImage.startsWith('linear-gradient(135deg,')||(style.backgroundImage.match(/gradient\(/gu)??[]).length!==1
      ||style.backgroundImage.includes('radial-gradient')||style.boxShadow==='none'||style.color!=='rgb(255, 255, 255)'
      ||!Number.isFinite(style.baseFillContrast)||style.baseFillContrast<4.5||style.opacity!=='1')throw new Error(code);
  };
  const noRay=(style,required=false)=>{
    if(!style){if(required)throw new Error('polish_ray_report_missing');return;}
    if(style.content!=='none'||style.backgroundImage!=='none'||style.filter!=='none')throw new Error('polish_directional_ray_present');
  };
  const clippedHighlight=(surface,highlight,code,neutralTheme=false)=>{
    // The restored historical dark theme choice is a neutral navy face with
    // pale-blue text. Navigation and AI choices retain ordinary white-on-blue
    // faces; every face keeps the same clipping, motion and contrast guards.
    const ink=neutralTheme?'rgb(183, 210, 255)':'rgb(255, 255, 255)';
    const faceValid=neutralTheme
      ? highlight?.backgroundImage==='none'&&highlight.backgroundColor==='rgb(23, 38, 65)'&&surface?.borderColor==='rgb(42, 61, 92)'
      : highlight?.backgroundImage.startsWith('linear-gradient(135deg,')&&(highlight.backgroundImage.match(/gradient\(/gu)??[]).length===1&&!highlight.backgroundImage.includes('radial-gradient');
    if(!surface||!highlight||surface.backgroundImage!=='none'||surface.overflow!=='hidden'
      ||surface.color!==ink||highlight.color!==ink||surface.opacity!=='1'
      ||highlight.content!=='""'||highlight.position!=='absolute'||highlight.pointerEvents!=='none'||highlight.zIndex!=='-1'
      ||['top','right','bottom','left'].some(side=>highlight[side]!=='0px')
      ||highlight.opacity!=='1'||!faceValid
      ||!Number.isFinite(highlight.baseFillContrast)||highlight.baseFillContrast<4.5
      ||(visual.theme==='dark'&&(!highlight.transitionProperty.split(', ').includes('opacity')||!highlight.transitionDuration.split(', ').includes('0.22s')))
      ||highlight.filter!=='none')throw new Error(code);
    if(visual.theme==='dark'&&surface.boxShadow!=='none'&&surface.boxShadow.split(/,(?![^()]*\))/u).some(value=>!value.includes('inset')))
      throw new Error('polish_dark_control_outside_shadow');
  };
  for(const [name,style] of Object.entries(rays??{}))noRay(style,['canvas','brand'].includes(name)&&['launch','admin'].includes(visual.fixture));
  // The owner's 22:48:14 correction restores the preserved Main340 navy
  // palette from reference screens 3/4, with contained selection motion.
  if(!report.canvas?.body||visual.theme==='dark'&&report.canvas.body.backgroundColor!=='rgb(14, 25, 44)')throw new Error('polish_dark_canvas_changed');
  if(visual.theme==='dark'&&(report.canvas.body.backgroundImage.match(/radial-gradient\(/gu)??[]).length!==1)throw new Error('polish_dark_canvas_atmosphere_missing');
  if(visual.fixture!=='launch') {
    clippedHighlight(styles?.selectedTheme,report.insideHighlight?.selectedTheme,'polish_selected_theme_highlight_invalid',visual.theme==='dark');
    clippedHighlight(styles?.selectedNavigation,report.insideHighlight?.selectedNavigation,'polish_selected_navigation_highlight_invalid');
    if(styles.primary)ordinaryControl(styles.primary,'polish_primary_surface_changed');
  }
  if(['launch','admin'].includes(visual.fixture)) {
    if(!report.evidenceLabel?.text.includes('Синтетический макет')||!report.evidenceLabel.inViewport
      ||report.evidenceLabel.position!=='fixed'||report.evidenceLabel.pointerEvents!=='none')throw new Error('polish_synthetic_marker_failed');
  }
  if(visual.fixture==='launch') {
    const launch=report.launch;
    if(launch?.state!=='loading'||launch.statusRole!=='status'||!launch.themeBarHidden
      ||launch.progress!=='Открываем ваш кабинет'||launch.screen?.display!=='flex'||launch.screen.visibility!=='visible'
      ||launch.screen.opacity!=='1'||launch.brand?.backgroundImage==='none'
      ||(visual.theme==='dark'&&launch.screen.backgroundColor!=='rgb(14, 25, 44)'))throw new Error('polish_actual_launch_failed');
    return true;
  }
  if(visual.fixture==='profile') {
    if(!styles.legalSaved||styles.legalSaved.backgroundImage==='none'||styles.legalSaved.color!=='rgb(255, 255, 255)'||styles.legalSaved.boxShadow==='none')throw new Error('polish_saved_status_unlit');
  } else if(visual.fixture==='admin') {
    clippedHighlight(styles.selectedAiMode,report.insideHighlight?.selectedAiMode,'polish_selected_ai_highlight_invalid');
    const admin=report.admin;
    if(!admin?.syntheticLabel?.includes('Синтетический макет')||!admin.syntheticLabelInViewport||admin.selectedNavigation!=='settings'
      ||admin.visibleNavigationIcons!==3||admin.visibleNavigationSvg!==3||!admin.readOnlyBanner||admin.enabledWriteCount!==0||admin.disabledWriteCount!==5
      ||admin.aiModes.length!==3||admin.aiModes.some(value=>!value.disabled)
      ||admin.aiModes.filter(value=>value.pressed==='true').length!==1
      ||!admin.aiModes.some(value=>value.mode==='all'&&value.pressed==='true'))throw new Error('polish_admin_read_only_state_failed');
    // The viewport can fit while children paint over neighboring buttons.
    // Check real icon/SVG and text-range rectangles independently of overflow.
    const navigation=admin.navigationContents,labels={settings:'Пульт',support:'Поддержка',payments:'Платежи'};
    const finiteRect=r=>r&&['left','right','top','bottom','width','height'].every(key=>Number.isFinite(r[key]))&&r.width>0&&r.height>0;
    const contained=(child,parent)=>finiteRect(child)&&child.left>=parent.left-.5&&child.right<=parent.right+.5&&child.top>=parent.top-.5&&child.bottom<=parent.bottom+.5;
    const intersects=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5;
    if(!Array.isArray(navigation)||navigation.length!==3||new Set(navigation.map(row=>row.section)).size!==3
      ||navigation.some(row=>labels[row.section]!==row.labelText||!finiteRect(row.button)||row.button.height<43.5
        ||!Array.isArray(row.textRects)||!row.textRects.length||![row.label,row.icon,row.svg,...row.textRects].every(part=>contained(part,row.button))
        ||row.textRects.some(text=>intersects(text,row.icon))))throw new Error('polish_admin_navigation_child_geometry_failed');
    for(let i=0;i<navigation.length;i++)for(let j=i+1;j<navigation.length;j++) {
      const a=navigation[i],b=navigation[j],parts=row=>[row.label,row.icon,row.svg,...row.textRects];
      if(parts(a).some(first=>parts(b).some(second=>intersects(first,second))))throw new Error('polish_admin_navigation_children_overlap');
    }
    if(styles.selectedAiMode.cursor!=='default'||styles.selectedAiMode.transform!=='none')throw new Error('polish_admin_current_indicator_interactive');
    if(admin.aiModes.filter(value=>value.pressed!=='true').some(value=>value.style.backgroundImage!=='none'
      ||value.style.boxShadow!=='none'||!(Number(value.style.opacity)>0&&Number(value.style.opacity)<1)
      ||value.ray.content!=='none'||value.ray.backgroundImage!=='none'))throw new Error('polish_admin_disabled_mode_lit');
  } else {
    if(report.sections.length!==POLISHED_SECTIONS.length||report.sections.some(value=>!value.exists||!value.visible||value.closedDetails))throw new Error('polish_sections_hidden');
    if(report.planLabels.length!==3||!['free','professional','dragon'].every(plan=>report.planLabels.some(value=>value.plan===plan&&value.visible)))throw new Error('polish_catalog_incomplete');
    if(!styles.freeCatalogOrb||styles.freeCatalogOrb.backgroundImage==='none'||styles.freeCatalogOrb.boxShadow==='none')throw new Error('polish_free_catalog_orb_unlit');
    if(['free','refunded'].includes(visual.fixture)) {
      if(report.currentPlan!=='free'||!styles.freeOrb||styles.freeOrb.backgroundImage==='none'||styles.freeOrb.boxShadow==='none')throw new Error('polish_free_current_unlit');
      if(visual.fixture==='refunded'&&report.currentStatus!=='Возврат учтён')throw new Error('polish_refund_state_mislabeled');
    } else if(report.currentPlan!=='professional')throw new Error('polish_paid_plan_mislabeled');
    for(const [plan,amount] of [['free',0],['professional',249],['dragon',499]])
      if(!report.planLabels.some(value=>value.plan===plan&&value.price.includes(String(amount)+' Stars')))throw new Error('polish_price_changed');
    if(visual.fixture!=='free'&&!report.receiptLabels.some(value=>value.includes('Professional')&&value.includes('249')))throw new Error('polish_receipt_hidden');
  }
  return true;
}

export function verifyPolishInteractionReport(report,{fixture,width,reducedMotion}) {
  if(!INTERACTION_FIXTURES.includes(fixture)||!WIDTHS.includes(width)||typeof reducedMotion!=='boolean'
    ||report.scope!==fixture||report.width!==width||report.requestedWidth!==width||report.height!==800||report.dpr!==1
    ||report.reducedMotion!==reducedMotion||report.scrollWidth>report.clientWidth||report.clientWidth!==width)
    throw new Error('polish_interaction_fixture_invalid');
  const clock=report.fixtureClock;
  if(clock?.mode!=='SYNTHETIC_FIXED_SOURCE_SNAPSHOT'||!Number.isSafeInteger(clock.sourceEpochMs)||clock.sourceEpochMs<=0
    ||clock.dateNowMs!==clock.sourceEpochMs||!Number.isSafeInteger(clock.hostEpochMsBeforeAlignment)
    ||!Number.isSafeInteger(clock.sessionExpiresAt)||clock.sessionExpiresAt<=clock.sourceEpochMs/1000||clock.sessionExpiresAt>clock.sourceEpochMs/1000+300
    ||!Number.isSafeInteger(clock.subscriptionValidUntil)||clock.subscriptionValidUntil<=clock.sourceEpochMs/1000||clock.subscriptionValidUntil>clock.sessionExpiresAt
    ||clock.performanceClock!=='ACTUAL_BROWSER_MONOTONIC_UNCHANGED'||!Number.isFinite(clock.monotonicNowMs)||clock.monotonicNowMs<0)
    throw new Error('polish_interaction_fixture_clock_invalid');
  const home=fixture==='admin'?'settings':'profile',other=fixture==='admin'?'support':'subscription';
  if(report.home!==home||report.other!==other||!report.stableAfterNavigate||!report.stableAfterRapidClicks||!report.stableAfterRefresh||!report.stableThemeButtons
    ||JSON.stringify(report.lastNavigation)!==JSON.stringify([home])||JSON.stringify(report.finalNavigation)!==JSON.stringify([home])
    ||report.finalTheme!=='dark'||report.savedTheme!=='dark'||report.remountedTheme!=='dark'||report.selectedThemeCount!==1
    ||report.refreshReadCount<1||report.writeControlsEnabled!==0)throw new Error('polish_interaction_selection_or_identity_failed');
  if(!Array.isArray(report.calls)||report.calls.filter(value=>value.method==='POST').length!==1
    ||report.calls.some(value=>!['GET','POST'].includes(value.method)||value.method==='POST'&&!value.path.endsWith('/session')))
    throw new Error('polish_interaction_producer_present');
  const requireSample=sample=>{
    if(!sample||!Number.isFinite(sample.opacity)||sample.opacity<0||sample.opacity>1
      ||sample.overflow!=='hidden'||sample.position!=='absolute'||sample.zIndex!=='-1'||sample.pointerEvents!=='none'
      ||sample.inset?.some(value=>value!=='0px')||sample.inset?.length!==4
      ||sample.rayContent!=='none'||sample.rayBackground!=='none')throw new Error('polish_interaction_highlight_bleed');
    const duration=sample.transitionDuration.split(', ').map(value=>parseFloat(value));
    if(reducedMotion?duration.some(value=>value!==0):!duration.includes(.22))throw new Error('polish_interaction_motion_preference_failed');
  };
  for(const kind of ['theme','nav']) {
    const before=report[kind+'Before'],start=report[kind+'Start'],mid=report[kind+'Mid'],end=report[kind+'End'];
    for(const phase of [before,start,mid,end])for(const sample of [phase?.old,phase?.next])requireSample(sample);
    if(before.old.opacity!==1||before.next.opacity!==0||end.old.opacity!==0||end.next.opacity!==1)
      throw new Error('polish_interaction_transition_endpoints_failed');
    if(!reducedMotion&&(mid.old.opacity<=0||mid.old.opacity>=1||mid.next.opacity<=0||mid.next.opacity>=1
      ||mid.old.opacity>=start.old.opacity||mid.next.opacity<=start.next.opacity))throw new Error('polish_interaction_crossfade_missing');
    if(reducedMotion&&(start.old.opacity!==0||start.next.opacity!==1||mid.old.opacity!==0||mid.next.opacity!==1))
      throw new Error('polish_interaction_reduced_motion_animated');
    if(JSON.stringify(before.old.rect)!==JSON.stringify(end.old.rect)||JSON.stringify(before.next.rect)!==JSON.stringify(end.next.rect))
      throw new Error('polish_interaction_button_geometry_moved');
  }
  const final=[...report.finalButtons,...report.finalThemeButtons];
  for(const sample of final){requireSample(sample);if(sample.opacity!==(sample.selected?1:0))throw new Error('polish_interaction_neighbor_highlight_leak');}
  if(JSON.stringify(report.initialGeometry)!==JSON.stringify(report.finalGeometry))throw new Error('polish_interaction_row_geometry_changed');
  return true;
}

// Local DevTools pipe only. Device metrics verify the requested CSS viewport;
// Chrome uses an ephemeral profile, restrictive CSP, blocked network protocols
// and a DNS deny rule. Every one of the 80 frames is counted and source-bound.
export async function renderPolishedSubscriptionVisuals(directory,chrome) {
  if(globalThis.__RE_PART05_OFFLINE_NETWORK_BLOCKED__!==true)throw new Error('polish_visual_offline_guard_required');
  if(!fs.existsSync(chrome))throw new Error('actual_polish_chrome_unavailable');
  const manifestBytes=fs.readFileSync(path.join(directory,'UI-POLISH-VISUAL-MANIFEST.json'));
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(manifest.schema!==6||manifest.status!=='OFFLINE_SYNTHETIC_POLISHED_ACTUAL_UI'||manifest.expectedFrames!==expectedFrames
    ||JSON.stringify(manifest.states)!==JSON.stringify(POLISH_VISUAL_CASES)||JSON.stringify(manifest.widths)!==JSON.stringify(WIDTHS)
    ||JSON.stringify(manifest.themes)!==JSON.stringify(THEMES)||manifest.files.length!==expectedFrames
    ||manifest.expectedInteractions!==expectedInteractions||manifest.interactionFiles?.length!==INTERACTION_FIXTURES.length
    ||JSON.stringify(manifest.files.map(value=>value.filename))!==JSON.stringify(expectedFiles()))throw new Error('polish_visual_manifest_invalid');
  for(const value of [...manifest.files,...manifest.interactionFiles]) {
    const bytes=fs.readFileSync(path.join(directory,value.filename));
    if(bytes.length!==value.bytes||hash(bytes)!==value.sha256)throw new Error('polish_visual_html_hash_mismatch:'+value.filename);
  }
  if(manifest.sourceHashes.polishPreviewScript!==hash(fs.readFileSync(fileURLToPath(import.meta.url))))throw new Error('polish_visual_renderer_source_changed');
  const base=new URL('../src/v1.4.0-rebuild/mini-app/',import.meta.url);
  for(const name of SOURCE_FILES)
    if(manifest.sourceHashes[name]!==hash(fs.readFileSync(new URL(name,base))))throw new Error('polish_visual_source_changed:'+name);
  if(manifest.sourceHashes.fixtureProducer!==hash(fs.readFileSync(new URL('./v1.4.3-native40-ui-preview.mjs',import.meta.url))))throw new Error('polish_visual_fixture_source_changed');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'re-ui-polish-render-'));
  const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check',
    '--host-resolver-rules=MAP * ~NOTFOUND','--hide-scrollbars','--remote-debugging-pipe',`--user-data-dir=${profile}`],
    {stdio:['ignore','ignore','ignore','pipe','pipe']});
  const write=child.stdio[3],read=child.stdio[4],decoder=new StringDecoder('utf8'),pending=new Map();
  let id=0,buffer='',ended=false;const networkViolations=[],requests=[];
  const rejectAll=error=>{ended=true;for(const value of pending.values()){clearTimeout(value.timer);value.reject(error);}pending.clear();};
  child.on('error',rejectAll);child.on('exit',code=>rejectAll(new Error('actual_polish_chrome_exited:'+code)));
  read.on('data',chunk=>{buffer+=decoder.write(chunk);let end;
    while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;
      let message;try {message=JSON.parse(raw);}catch {rejectAll(new Error('actual_polish_chrome_invalid_protocol'));continue;}
      if(message.method==='Network.requestWillBeSent'){
        const url=message.params?.request?.url??'';requests.push(url);
        if(!/^(?:file:|about:|data:)/u.test(url))networkViolations.push(url);
      }
      const waiting=pending.get(message.id);if(!waiting)continue;
      pending.delete(message.id);clearTimeout(waiting.timer);
      if(message.error)waiting.reject(new Error('actual_polish_chrome_protocol:'+JSON.stringify(message.error)));else waiting.resolve(message.result);
    }
  });
  const call=(method,params={},sessionId=null)=>new Promise((resolve,reject)=>{
    if(ended){reject(new Error('actual_polish_chrome_pipe_closed'));return;}
    // Cold Chrome startup may need longer on a shared runner. This is one
    // bounded request, without retries; every post-startup command stays 10s.
    const commandTimeout=method==='Browser.getVersion'?30000:10000;
    const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('actual_polish_chrome_timeout:'+method));},commandTimeout);
    pending.set(requestId,{resolve,reject,timer});write.write(JSON.stringify({id:requestId,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  const reports=[],interactions=[];let browser=null,renderError=null;
  const save=(status,error=null)=>{
    fs.writeFileSync(path.join(directory,'UI-POLISH-VISUAL-GEOMETRY.json'),JSON.stringify(reports,null,2)+'\n');
    fs.writeFileSync(path.join(directory,'UI-POLISH-VISUAL-INTERACTIONS.json'),JSON.stringify(interactions,null,2)+'\n');
    fs.writeFileSync(path.join(directory,'UI-POLISH-VISUAL-BROWSER.json'),JSON.stringify({status,browser,sourceSha:manifest.sourceSha,
      workflowRunId:manifest.workflowRunId,manifestSha256:hash(manifestBytes),expectedFrames,frames:reports.length,
      expectedInteractions,interactions:interactions.length,requestedViewport:{widths:WIDTHS,height:800,dpr:1},requests,networkViolations,error},null,2)+'\n');
  };
  try {
    browser=await call('Browser.getVersion');
    const target=await call('Target.createTarget',{url:'about:blank'});
    const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true}),session=attached.sessionId;
    await call('Page.enable',{},session);await call('Runtime.enable',{},session);await call('Network.enable',{},session);
    await call('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']},session);
    await call('Page.bringToFront',{},session);
    for(const visual of manifest.files) {
      const {filename,width}=visual;
      await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:true},session);
      const url=pathToFileURL(path.join(directory,filename)).href;
      const navigated=await call('Page.navigate',{url},session);if(navigated.errorText)throw new Error('actual_polish_chrome_navigation:'+navigated.errorText);
      let ready=false;
      for(let i=0;i<200;i++){
        const value=await call('Runtime.evaluate',{expression:`location.href===${JSON.stringify(url)}&&typeof window.__measureUi==='function'`,returnByValue:true},session);
        if(value.exceptionDetails)throw new Error('actual_polish_chrome_script_exception');
        if(value.result?.value===true){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,25));
      }
      if(!ready)throw new Error('actual_polish_chrome_document_not_ready:'+filename);
      const measured=await call('Runtime.evaluate',{expression:"Promise.resolve(document.fonts?.ready).then(()=>new Promise(resolve=>setTimeout(resolve,350))).then(()=>window.__measureUi())",awaitPromise:true,returnByValue:true},session);
      if(measured.exceptionDetails||!measured.result?.value)throw new Error('actual_polish_chrome_geometry_missing:'+filename);
      const report=measured.result.value;
      const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true},session);
      const png=Buffer.from(screenshot.data,'base64'),pngFilename=filename.replace(/\.html$/u,'.png');
      fs.writeFileSync(path.join(directory,pngFilename),png);
      Object.assign(report,{htmlFilename:filename,htmlSha256:visual.sha256,pngFilename,pngSha256:hash(png),pngBytes:png.length});
      reports.push(report);save('IN_PROGRESS_ACTUAL_POLISHED_BROWSER_RENDER');
      verifyPolishGeometryReport(report,visual);
      if(networkViolations.length)throw new Error('actual_polish_chrome_network_forbidden');
    }
    if(reports.length!==expectedFrames)throw new Error('actual_polish_chrome_case_count_invalid');
    for(const visual of manifest.interactionFiles)for(const width of WIDTHS)for(const reducedMotion of [false,true]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:true},session);
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reducedMotion?'reduce':'no-preference'},{name:'prefers-color-scheme',value:'dark'}]},session);
      const url=pathToFileURL(path.join(directory,visual.filename)).href;
      const navigated=await call('Page.navigate',{url},session);if(navigated.errorText)throw new Error('actual_polish_chrome_interaction_navigation:'+navigated.errorText);
      let ready=false;
      for(let i=0;i<200;i++) {
        const value=await call('Runtime.evaluate',{expression:`location.href===${JSON.stringify(url)}&&typeof window.__probeMotion==='function'`,returnByValue:true},session);
        if(value.exceptionDetails)throw new Error('actual_polish_chrome_interaction_script_exception');
        if(value.result?.value===true){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,25));
      }
      if(!ready)throw new Error('actual_polish_chrome_interaction_not_ready');
      const measured=await call('Runtime.evaluate',{expression:'window.__probeMotion()',awaitPromise:true,returnByValue:true},session);
      if(measured.exceptionDetails||!measured.result?.value)throw new Error('actual_polish_chrome_interaction_missing:'+JSON.stringify(measured.exceptionDetails??null));
      const report=measured.result.value;
      const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true},session);
      const png=Buffer.from(screenshot.data,'base64'),pngFilename=`interaction-${visual.fixture}-${reducedMotion?'reduced':'motion'}-${width}.png`;
      fs.writeFileSync(path.join(directory,pngFilename),png);
      Object.assign(report,{htmlFilename:visual.filename,htmlSha256:visual.sha256,bundleSha256:visual.bundleSha256,pngFilename,pngSha256:hash(png),pngBytes:png.length});
      interactions.push(report);save('IN_PROGRESS_ACTUAL_POLISHED_BROWSER_RENDER');
      verifyPolishInteractionReport(report,{fixture:visual.fixture,width,reducedMotion});
      if(networkViolations.length)throw new Error('actual_polish_chrome_network_forbidden');
    }
    if(interactions.length!==expectedInteractions)throw new Error('actual_polish_chrome_interaction_count_invalid');
    save('PASS_ACTUAL_POLISHED_BROWSER_RENDER');
    console.log(JSON.stringify({status:'PASS_ACTUAL_POLISHED_BROWSER_RENDER',frames:reports.length,expectedFrames,interactions:interactions.length,expectedInteractions,browser:browser.product}));
    return {browser,reports,interactions};
  } catch(error){renderError=error;save('FAILED_ACTUAL_POLISHED_BROWSER_RENDER',error.message);throw error;}
  finally {
    rejectAll(new Error('actual_polish_chrome_render_finished'));
    const exited=()=>child.exitCode!==null||child.signalCode!==null||!child.pid;
    const waitForExit=timeout=>{
      if(exited())return Promise.resolve(true);
      return new Promise(resolve=>{
        const finish=()=>{clearTimeout(timer);child.off('exit',finish);resolve(true);};
        const timer=setTimeout(()=>{child.off('exit',finish);resolve(false);},timeout);
        child.once('exit',finish);
        if(exited())finish();
      });
    };
    try {
      // Chrome writes its profile during shutdown. Wait for its parent process
      // to exit before deleting; bounded retries also cover child-process flushes.
      const gracefulExit=waitForExit(3000);
      if(!exited())child.kill('SIGTERM');
      if(!await gracefulExit){
        const forcedExit=waitForExit(3000);
        if(!exited())child.kill('SIGKILL');
        if(!await forcedExit)throw new Error('actual_polish_chrome_shutdown_timeout');
      }
      read.destroy();write.destroy();
      fs.rmSync(profile,{recursive:true,force:true,maxRetries:12,retryDelay:100});
    } catch(cleanupError){
      if(!renderError)throw cleanupError;
      // Preserve the original rendering failure and report cleanup separately.
      renderError.cleanupError=cleanupError.message;
      console.error(JSON.stringify({status:'FAILED_POLISH_BROWSER_CLEANUP',error:cleanupError.message,renderError:renderError.message}));
    } finally {read.destroy();write.destroy();}
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--render'){
    if(!process.argv[3]||!process.argv[4])throw new Error('polish_visual_render_arguments_required');
    await renderPolishedSubscriptionVisuals(process.argv[3],process.argv[4]);
  } else {
    if(!process.argv[2])throw new Error('polish_visual_directory_required');
    const manifest=await writePolishedSubscriptionVisuals(process.argv[2]);
    console.log(JSON.stringify({status:manifest.status,files:manifest.files.length,expectedFrames,sourceHashes:manifest.sourceHashes}));
  }
}
