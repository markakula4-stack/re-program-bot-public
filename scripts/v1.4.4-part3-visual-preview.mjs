// Source-only visual evidence. Synthetic descriptors are mounted through the
// actual cabinet client/view/listeners; no Telegram account or provider is used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {createOfflineSubscriptionVisual} from './v1.4.3-native40-ui-preview.mjs';
import {cabinetSubscriptionFixture} from '../tests/helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {readSubscriptionData} from '../src/v1.4.2/subscription-read-model.mjs';
import {runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {observePolishCrossfade} from './v1.4.3-native40-ui-polish-preview.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const base=new URL('../src/v1.4.0-rebuild/mini-app/',import.meta.url);
const sourceFiles=Object.freeze(['cabinet-client.mjs','cabinet-view.mjs','cabinet-theme-bootstrap.js',
  'subscription-view.mjs','subscription-view.css','partner-cabinet.css','partner-cabinet.html',
  'telegram-native.mjs','telegram-actions-view.mjs']);
export const PART3_VISUAL_WIDTHS=Object.freeze([320,360,390,430]);
export const PART3_VISUAL_THEMES=Object.freeze(['light','dark']);
export const PART3_VISUAL_CASES=Object.freeze([
  {state:'professional-offer',target:'.subscription-plans .subscription-plan-professional'},
  {state:'dragon-offer',target:'.subscription-plans .subscription-plan-dragon'},
  {state:'future-transition',target:'.subscription-transitions'},
  {state:'paid-package',target:'.subscription-current'},
  {state:'refunded-package',target:'.subscription-history'},
  {state:'package-confirmation',target:'dialog'},
  {state:'cancel-transition',target:'dialog'},
  {state:'paid-receipt',target:'.subscription-receipt-paper'}
].map(Object.freeze));
const epoch=1791327600,receiptId='stars-'+ 'e'.repeat(24);
const frameCount=PART3_VISUAL_CASES.length*PART3_VISUAL_WIDTHS.length*PART3_VISUAL_THEMES.length;
const interactionCount=PART3_VISUAL_WIDTHS.length*PART3_VISUAL_THEMES.length*2;
const guard=()=>{if(globalThis.__RE_PART05_OFFLINE_NETWORK_BLOCKED__!==true)throw new Error('part3_visual_offline_guard_required');};
const fail=message=>{throw new Error(message);};
let baseline;

async function baselineDescriptors(){
  if(!baseline)baseline=(async()=>{
      const paid=await createOfflineSubscriptionVisual({state:'current'});
      let paidData;try {paidData=alignFixtureClock(structuredClone(paid.initial),paid.initial.observedAt);}finally{paid.close();}
      const cleanups=[],free=cabinetSubscriptionFixture({after:close=>cleanups.push(close)});
      let freeData;try {free.now=Math.floor(Date.now()/1000);const authorization=await free.auth();
        const projected={...await readSubscriptionData({authorization}),authorization:runtimeAuthorizationDTO(authorization)};
        freeData=alignFixtureClock(projected,projected.observedAt);
      }finally{cleanups.forEach(close=>close());}
      // These identifiers are fixture inputs, not claims about an owner record.
      paidData.lifecycle.contractId='14400000-0000-4000-8000-000000000001';
      paidData.lifecycle.subscriptionId='14400000-0000-4000-8000-000000000002';
      paidData.access.current={...paidData.access.current,startsAt:epoch,expiresAt:epoch+2592000,remainingSeconds:2592000};
      paidData.lifecycle={...paidData.lifecycle,startsAt:epoch,paidUntil:epoch+2592000,accessUntil:epoch+2592000};
      paidData.access.lifecycle=structuredClone(paidData.lifecycle);paidData.renewalActions.contractId=paidData.lifecycle.contractId;
      paidData.history.items=paidData.history.items.map(item=>({...item,receiptId,occurredAt:epoch,paidPeriod:{startsAt:epoch,endsAt:epoch+2592000},
        receipt:{...item.receipt,receiptId,occurredAt:epoch,paidPeriod:{startsAt:epoch,endsAt:epoch+2592000}}}));
      return {paid:paidData,free:freeData};
  })();
  return baseline;
}

// Local admission uses its real clock. Only the exported synthetic read snapshot
// is shifted to a fixed epoch; provider/runtime authority is never backdated.
function alignFixtureClock(value,sourceNow){
  if(Array.isArray(value))return value.map(row=>alignFixtureClock(row,sourceNow));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
    Number.isSafeInteger(item)&&item>0&&/(?:At|Until|From)$/u.test(key)?item-sourceNow+epoch:alignFixtureClock(item,sourceNow)]));
}

export async function createPart3VisualDescriptor(state='professional-offer'){
  guard();if(!PART3_VISUAL_CASES.some(row=>row.state===state))fail('part3_visual_state_invalid');
  const old=await baselineDescriptors();
  const paid=['future-transition','paid-package','cancel-transition','paid-receipt'].includes(state);
  const data=structuredClone(paid?old.paid:old.free);
  const prices={professional:[249,699,1299,2299],dragon:[499,1399,2599,4499]};
  const durations=[['30d',30],['3m',90],['6m',180],['12m',360]];
  const available=packageCode=>packageCode==='3m';
  data.packages={version:1,modelVersion:'2026-10-07.v1.4.4.p03',authority:'worker',accessAuthority:false,available:true,reasonCode:null,
    observedAt:epoch,validUntil:epoch+60,canWrite:true,paidPeriods:[],transitions:[],offers:[],pendingInvoices:[],
    terms:{revision:'2026-10-06.packages-v1',available:true,accepted:true,telegramCommand:'/terms'}};
  for(const planCode of ['professional','dragon'])for(let index=0;index<durations.length;index++){
    const [packageCode,durationDays]=durations[index],monthly=packageCode==='30d';
    const startsAt=paid?epoch+2592000:epoch;
    data.packages.offers.push({planCode,packageCode,durationDays,periodSeconds:durationDays*86400,published:monthly||available(packageCode),available:monthly||available(packageCode),reasonCode:monthly||available(packageCode)?null:'package_disabled',
      amountStars:monthly||available(packageCode)?prices[planCode][index]:null,currency:'XTR',billingMode:monthly?'recurring':'prepaid',automaticRenewal:monthly,
      termsRevision:monthly||available(packageCode)?'2026-10-06.packages-v1':null,priceVersion:monthly||available(packageCode)?1:null,offerVersion:monthly||available(packageCode)?'2026-10-06.packages-v1':null,campaignCode:null,
      freshConsentRequired:monthly,terms:{available:monthly||available(packageCode),accepted:monthly||available(packageCode),revision:monthly||available(packageCode)?'2026-10-06.packages-v1':null,text:monthly||available(packageCode)?'Синтетические условия для офлайн-проверки. Разовая предоплата; новый период подтверждается после оплаты.':null,telegramCommand:'/terms'},
      priceComparison:monthly||!available(packageCode)?null:{amountStars:prices[planCode][0]*(durationDays/30),basis:'same_plan_monthly_equivalent',periodCount:durationDays/30,monthlyAmountStars:prices[planCode][0],currency:'XTR'},
      preview:monthly||available(packageCode)?{startsAt,endsAt:startsAt+durationDays*86400,datesAreEstimate:true,validUntil:epoch+60}:null,
      invoice:{available:!paid&&available(packageCode),reasonCode:!paid&&available(packageCode)?null:available(packageCode)?'paid_period_active':'package_disabled',route:'/packages/invoice',actionAdmissionRequired:true},
      schedule:{available:paid&&(monthly||available(packageCode)),reasonCode:paid&&(monthly||available(packageCode))?null:'package_schedule_paid_source_required',route:'/packages/schedule',actionAdmissionRequired:true}});
  }
  if(['future-transition','cancel-transition'].includes(state))data.packages.transitions=[{
    transitionId:'14400000-0000-4000-8000-000000000003',revision:1,fromPlan:'professional',toPlan:'dragon',
    packageCode:'30d',billingMode:'recurring',durationDays:30,effectiveAt:epoch+2592000,sourceCompensated:false,grantsAccess:false,
    state:'scheduled',status:'scheduled',cancel:{available:true,reasonCode:null,route:'/packages/cancel',actionAdmissionRequired:true},
    monthlyCheckout:{available:false,reasonCode:'package_monthly_invoice_not_due',route:'/packages/monthly-invoice',actionAdmissionRequired:true,freshConsentRequired:true,amountStars:499,currency:'XTR',termsRevision:'2026-10-06.packages-v1',priceVersion:1,invoiceUrl:null,expiresAt:epoch+2592900}}];
  if(state==='future-transition'){
    const futureReceiptId='stars-'+ 'd'.repeat(24),startsAt=epoch+2592000,endsAt=startsAt+7776000;
    const futurePeriod={packageCode:'3m',durationDays:90,accessState:'future',startsAt,endsAt,receiptId:futureReceiptId,
      planCode:'dragon',amountStars:1399,currency:'XTR',billingMode:'prepaid',state:'future',grantsCurrentAccess:false};
    data.packages.paidPeriods=[futurePeriod];
    const receipt={receiptId:futureReceiptId,planCode:'dragon',amountStars:1399,currency:'XTR',occurredAt:epoch,status:'paid',billingMode:'prepaid',
      paidPeriod:{startsAt,endsAt},reviewRequired:false,package:{packageCode:'3m',durationDays:90,accessState:'future',startsAt,endsAt}};
    data.history.items.unshift({...receipt,receipt:{...receipt}});
    // The separate unpaid intent follows the already paid future Dragon period.
    // Neither the paid future row nor this intent changes current Professional.
    data.packages.transitions[0]={...data.packages.transitions[0],fromPlan:'dragon',toPlan:'professional',effectiveAt:endsAt,
      monthlyCheckout:{...data.packages.transitions[0].monthlyCheckout,amountStars:249,expiresAt:endsAt+900}};
    for(const offer of data.packages.offers)if(offer.preview)offer.preview={...offer.preview,startsAt:endsAt,endsAt:endsAt+offer.periodSeconds};
  }
  if(['paid-package','paid-receipt','refunded-package'].includes(state)){
    const refunded=state==='refunded-package';
    const packagePeriod={receiptId,planCode:'professional',packageCode:'3m',durationDays:90,
      amountStars:699,currency:'XTR',billingMode:'prepaid',startsAt:epoch,endsAt:epoch+7776000,
      state:refunded?'refunded':'current',accessState:refunded?'refunded':'current',grantsCurrentAccess:!refunded};
    data.packages.paidPeriods=[packagePeriod];
    const receipt={receiptId,planCode:'professional',amountStars:699,currency:'XTR',occurredAt:epoch,
      billingMode:'prepaid',status:refunded?'refunded':'paid',paidPeriod:{startsAt:epoch,endsAt:epoch+7776000},
      reviewRequired:false,package:{packageCode:'3m',durationDays:90,startsAt:epoch,endsAt:epoch+7776000,accessState:refunded?'refunded':'current'}};
    data.history={...data.history,available:true,authority:'worker',items:[{...receipt,receipt:{...receipt}}],hasMore:false};
    if(!refunded){data.access.current={...data.access.current,sourceKind:'package_payment',startsAt:epoch,expiresAt:epoch+7776000,remainingSeconds:7776000};
      data.lifecycle={...data.lifecycle,billingMode:'prepaid',contractId:null,startsAt:epoch,paidUntil:epoch+7776000,accessUntil:epoch+7776000,renewalState:'not_applicable'};
      data.access.lifecycle=structuredClone(data.lifecycle);data.renewalActions={...data.renewalActions,contractId:null,expectedRevision:null,renewalState:'not_applicable',cancel:{available:false,route:'/subscription/renewal/cancel'},enable:{available:false,route:'/subscription/renewal/enable'}};}
  }
  data.authorization={...data.authorization,validUntil:epoch+300};data.access.sessionExpiresAt=epoch+300;
  return data;
}

function sourceHashes(){
  return {...Object.fromEntries(sourceFiles.map(name=>[name,hash(fs.readFileSync(new URL(name,base)))])),
    previewScript:hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    baselineFixtureProducer:hash(fs.readFileSync(new URL('./v1.4.3-native40-ui-preview.mjs',import.meta.url))),
    motionObserver:hash(fs.readFileSync(new URL('./v1.4.3-native40-ui-polish-preview.mjs',import.meta.url)))};
}

function browserFixtureSource(dto){
  return `
    import {MiniAppClient,mountThemeSelector,CABINET_THEME_STORAGE_KEY} from './cabinet-client.mjs';
    import {mountCabinet} from './cabinet-view.mjs';
    const dto=${JSON.stringify(dto)};
    const state=document.documentElement.getAttribute('data-package-visual-state');
    const themeMode=document.documentElement.getAttribute('data-theme-mode');
    const sourceEpochMs=${epoch}*1000;Date.now=()=>sourceEpochMs;
    const calls=[],values=new Map([[CABINET_THEME_STORAGE_KEY,themeMode],['re-subscription-receipt-seen-v1',JSON.stringify(dto.history.items.map(row=>row.receiptId))]]);
    const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
    const features={version:1,mutationsEnabled:false,offerActionsEnabled:false,nativeOwnerInvoiceOnly:true,existingRenewalCancellationEnabled:true};
    dto.features=features;
    const authorization={...dto.authorization,capability:'profile.read_own'};
    const bootstrap={readModelVersion:1,authorization,features,systemRole:'user',partner:{state:'no_application',application:null,profile:null,legalProfile:null,beta:null,actions:{}},navigation:['profile','offers','applications','analytics','subscription'].map(section=>({section,enabled:section!=='analytics',reason:null})),counts:{visibleOffers:0,ownOffers:0,ownApplications:0,attributedApplications:0}};
    const fetchImpl=async(url,init)=>{
      const pathname=new URL(url).pathname;calls.push({pathname,method:init.method});
      if(pathname.endsWith('/session')&&init.method==='POST')return Response.json({sessionToken:'rpms1_'+'d'.repeat(43),tokenType:'Bearer',expiresAt:${epoch}+300,authorizationVersion:1,features});
      if(init.method!=='GET')throw new Error('part3_visual_financial_producer_forbidden');
      if(pathname.endsWith('/bootstrap'))return Response.json(bootstrap);
      if(pathname.endsWith('/subscription'))return Response.json(dto);
      throw new Error('part3_visual_unexpected_read');
    };
    const client=new MiniAppClient({origin:'https://offline-visual.example',now:()=>sourceEpochMs,fetchImpl,pendingStorage:storage});
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const must=(node,name)=>{if(!node)throw new Error('part3_visual_control_missing:'+name);return node;};
    const settled=async()=>{for(let index=0;index<200;index++){if(document.getElementById('screen').getAttribute('aria-busy')!=='true')return;await wait(10);}throw new Error('part3_visual_read_unsettled');};
    let app,theme;
    window.__part3Ready=(async()=>{
      try{localStorage.setItem('re-subscription-receipt-seen-v1',values.get('re-subscription-receipt-seen-v1'));}catch{}
      location.hash='#subscription';await client.authenticate('offline-synthetic-part3');
      app=mountCabinet({document,client});theme=mountThemeSelector({document,storage,media:matchMedia('(prefers-color-scheme: dark)')});
      await app.start();await wait(300);
      if(state==='package-confirmation'){must(document.querySelector('[data-package-purchase="professional:3m"]'),'purchase').click();await wait(50);await settled();}
      if(state==='cancel-transition'){must(document.querySelector('[data-transition-cancel]'),'cancel').click();await wait(50);await settled();}
      if(state==='paid-receipt'){const history=document.querySelector('.subscription-history');must([...history.querySelectorAll('button')].find(node=>node.textContent==='Открыть квитанцию'),'receipt').click();await wait(50);}
      return true;
    })();
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const visible=node=>!!(node.offsetWidth||node.offsetHeight||node.getClientRects().length);
    const styles=node=>{const s=getComputedStyle(node);return {color:s.color,fontSize:s.fontSize,fontWeight:s.fontWeight,textDecorationLine:s.textDecorationLine,backgroundImage:s.backgroundImage,backgroundColor:s.backgroundColor};};
    const observeCrossfade=${observePolishCrossfade.toString()};
    const chipAppearance=node=>{const s=getComputedStyle(node),p=getComputedStyle(node,'::before');return {opacity:Number(p.opacity),rect:rect(node),overflow:s.overflow,inset:[p.top,p.right,p.bottom,p.left],pointerEvents:p.pointerEvents,afterContent:getComputedStyle(node,'::after').content,transitionDuration:p.transitionDuration};};
    const sourceDate=value=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value*1000))+' МСК';
    window.__measurePart3=async()=>{
      await window.__part3Ready;await document.fonts.ready;await settled();
      const target=must(document.querySelector(document.documentElement.getAttribute('data-package-visual-target')),'target');
      if(!document.querySelector('dialog'))window.scrollTo(0,Math.max(0,target.getBoundingClientRect().top+scrollY-18));
      const sections=['.subscription-current','.subscription-plans','.subscription-monthly','.subscription-history','.subscription-capacity','.subscription-preview','.subscription-payment-help','.subscription-telegram-details'].map(selector=>{const node=document.querySelector(selector);return {selector,visible:!!node&&visible(node),collapsed:!!node&&!!node.closest('details:not([open])')};});
      const badTargets=[...document.querySelectorAll('button,a[href],summary,.subscription-consent')].filter(visible).filter(node=>rect(node).height<43.5).map(node=>({text:node.textContent,height:rect(node).height}));
      const overflowingText=[...document.querySelectorAll('h2,h3,h4,p,dt,dd,button,summary')].filter(visible).flatMap(node=>{const range=document.createRange();range.selectNodeContents(node);return [...range.getClientRects()].filter(r=>r.left<-.5||r.right>innerWidth+.5).map(r=>({tag:node.tagName,left:r.left,right:r.right}));});
      const offer=document.querySelector('.subscription-plans .subscription-plan-professional');
      const price=offer?.querySelector('.subscription-price'),comparison=offer?.querySelector('.subscription-price-comparison s');
      const dialog=document.querySelector('dialog');
      const controls=[...document.querySelectorAll('[data-package-duration]')].map(node=>({plan:node.getAttribute('data-package-plan'),duration:node.getAttribute('data-package-duration'),pressed:node.getAttribute('aria-pressed'),height:rect(node).height}));
      const paidFutureRows=[...document.querySelectorAll('[data-future-package]')].map(node=>{const item=dto.packages.paidPeriods.find(row=>row.receiptId===node.getAttribute('data-future-package'));const receipt=dto.history.items.find(row=>row.receiptId===item?.receiptId);return {
        receiptId:item?.receiptId,plan:node.querySelector('h4')?.textContent,label:node.querySelector('.badge')?.textContent,badgeRect:rect(node.querySelector('.badge')),
        dates:[...node.querySelectorAll('dd')].map(row=>row.textContent),dateRects:[...node.querySelectorAll('dd')].map(rect),expectedDates:item?[sourceDate(item.startsAt),sourceDate(item.endsAt)]:[],
        grantsCurrentAccess:item?.grantsCurrentAccess,ownReceiptMatches:!!receipt&&receipt.status==='paid'&&receipt.planCode===item?.planCode&&receipt.amountStars===item?.amountStars&&receipt.package?.accessState==='future'&&receipt.paidPeriod.startsAt===item.startsAt&&receipt.paidPeriod.endsAt===item.endsAt};});
      const unpaidIntentRows=[...document.querySelectorAll('[data-transition-id]')].map(node=>{const item=dto.packages.transitions.find(row=>row.transitionId===node.getAttribute('data-transition-id'));return {
        label:node.querySelector('.badge')?.textContent,badgeRect:rect(node.querySelector('.badge')),heading:node.querySelector('h4')?.textContent,
        date:node.querySelector('dd')?.textContent,dateRect:rect(node.querySelector('dd')),expectedDate:item?sourceDate(item.effectiveAt):null,grantsAccess:item?.grantsAccess};});
      return {state,theme:themeMode,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,
        targetRect:rect(target),badTargets,overflowingText,sections,controls,currentPlan:document.querySelector('.subscription-current')?.getAttribute('data-current-plan'),
        professionalPrice:price?{text:price.textContent,style:styles(price),rect:rect(price)}:null,comparison:comparison?{text:comparison.textContent,style:styles(comparison),rect:rect(comparison),basis:offer.querySelector('.subscription-comparison-basis')?.textContent,ariaLabel:comparison.parentElement.getAttribute('aria-label'),interactive:!!comparison.closest('button,a,[role="button"]')}:null,
        rejectedEconomyCopy:/эконом.{0,12}48|48.{0,12}(?:звёзд|Stars)/iu.test(document.getElementById('screen').textContent),
        canvas:styles(document.body),planPaint:['professional','dragon'].map(plan=>({plan,...styles(document.querySelector('.subscription-plans .subscription-plan-'+plan))})),
        freeMarker:(()=>{const s=getComputedStyle(document.querySelector('.subscription-plans .subscription-plan-free h4'),'::before');return {content:s.content,width:s.width,height:s.height,borderRadius:s.borderRadius,backgroundImage:s.backgroundImage};})(),
        rays:[document.body,document.querySelector('.launch-brand'),document.querySelector('#theme-switcher [aria-pressed="true"]')].filter(Boolean).map(node=>({before:getComputedStyle(node,'::before').content,after:getComputedStyle(node,'::after').content})),
        dialog:dialog?{...rect(dialog),modal:dialog.matches(':modal'),focusInside:dialog.contains(document.activeElement),scrollHeight:dialog.scrollHeight,clientHeight:dialog.clientHeight}:null,
        paidFutureRows,unpaidIntentRows,syntheticLabelVisible:visible(document.querySelector('[data-part3-synthetic]')),calls};
    };
    window.__probePart3=async()=>{
      await window.__part3Ready;
      const nav=[...document.querySelectorAll('#navigation button')],themes=[...document.querySelectorAll('#theme-switcher button')];
      const duration=code=>must(document.querySelector('[data-package-plan="professional"][data-package-duration="'+code+'"]'),'duration'+code);
      const chips=[duration('30d'),duration('3m')],reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
      const chipPair=()=>({old:chipAppearance(chips[1]),next:chipAppearance(chips[0])});
      const durationBefore=chipPair();duration('30d').click();const durationStart=chipPair();
      const durationSampling=await observeCrossfade(chipPair,{start:durationStart,reducedMotion:reducedMotion||themeMode==='light'});
      await wait(240);const durationEnd=chipPair();duration('3m').click();await wait(240);
      const stableAfterSelection=chips.every(node=>node===duration(node.getAttribute('data-package-duration')));
      const terms=must(document.querySelector('.subscription-payment-help details.subscription-terms'),'terms');terms.open=true;
      duration('3m').focus();window.scrollTo(0,Math.max(0,duration('3m').getBoundingClientRect().top+scrollY-80));
      const scrollBefore=scrollY,readsBefore=calls.length;
      await app.navigate('subscription',{preserveScroll:true});await settled();await wait(300);
      const selected=document.querySelector('[data-package-plan="professional"][aria-pressed="true"]');
      const refresh={duration:selected?.getAttribute('data-package-duration'),focusDuration:document.activeElement?.getAttribute('data-package-duration'),termsOpen:document.querySelector('.subscription-payment-help details.subscription-terms')?.open,
        scrollBefore,scrollAfter:scrollY,readCount:calls.length-readsBefore,stableNavigation:nav.every((node,index)=>node===document.querySelectorAll('#navigation button')[index]),stableTheme:themes.every((node,index)=>node===document.querySelectorAll('#theme-switcher button')[index]),
        theme:document.documentElement.getAttribute('data-theme-mode'),highlightCount:document.querySelectorAll('#theme-switcher [aria-pressed="true"]').length};
      must(document.querySelector('[data-package-purchase="professional:3m"]'),'purchase after refresh').click();await wait(50);await settled();
      const dialog=must(document.querySelector('dialog'),'dialog'),consent=dialog.querySelector('input[type="checkbox"]'),submit=dialog.querySelector('[data-subscription-confirm]');
      const confirmation={modal:dialog.matches(':modal'),focusInside:dialog.contains(document.activeElement),submitDisabled:!!submit?.disabled,consentUnchecked:consent? !consent.checked:true,rect:rect(dialog)};
      await app.navigate('subscription',{preserveScroll:true});await wait(50);await settled();
      const modalRetained=dialog===document.querySelector('dialog')&&dialog.matches(':modal')&&dialog.contains(document.activeElement);
      must([...dialog.querySelectorAll('button')].find(node=>node.textContent==='Назад'),'back').click();await wait(50);
      const focusRestored=document.activeElement?.getAttribute('data-package-purchase')==='professional:3m';
      const durationTransition=getComputedStyle(duration('3m'),'::before').transitionDuration;
      return {theme:themeMode,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,reducedMotion,
        stableAfterSelection,refresh,confirmation,modalRetained,focusRestored,durationTransition,durationBefore,durationStart,durationSampling,durationEnd,calls,
        financialProducerCalls:calls.filter(row=>row.method!=='GET'&&!row.pathname.endsWith('/session')).length,
        scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,
        clock:{mode:'SYNTHETIC_FIXED_SOURCE_SNAPSHOT',epochMs:sourceEpochMs,dateNowMs:Date.now(),performanceClock:'ACTUAL_BROWSER_MONOTONIC_UNCHANGED'}};
    };`;
}

export async function writePart3Visuals(directory){
  guard();fs.mkdirSync(directory,{recursive:true});
  const dom=createRequire(process.env.CABINET_UI_DOM_ROOT?`${process.env.CABINET_UI_DOM_ROOT}/package.json`:new URL('../tests/p08-ui/package.json',import.meta.url));
  const runtime=createRequire(process.env.CABINET_UI_RUNTIME_ROOT?`${process.env.CABINET_UI_RUNTIME_ROOT}/package.json`:new URL('../tests/p11-runtime/package.json',import.meta.url));
  const {parseHTML}=dom('linkedom'),{build}=runtime('esbuild');
  const css=['partner-cabinet.css','subscription-view.css'].map(name=>fs.readFileSync(new URL(name,base),'utf8')).join('\n');
  const manifest={schema:1,status:'OFFLINE_SYNTHETIC_ACTUAL_PART3_UI',sourceSha:process.env.GITHUB_SHA??null,workflowRunId:process.env.GITHUB_RUN_ID??null,
    sourceHashes:sourceHashes(),widths:PART3_VISUAL_WIDTHS,themes:PART3_VISUAL_THEMES,states:PART3_VISUAL_CASES,
    expectedFrames:frameCount,expectedInteractions:interactionCount,viewportHeight:800,deviceScaleFactor:1,
    scope:'Synthetic package descriptors layered over actual local native subscription read fixtures. Actual mounted clients, views and listeners; no real account, invoice, refund, migration or deployment.',
    files:[],interactionFiles:[]};
  for(const visual of PART3_VISUAL_CASES){
    const dto=await createPart3VisualDescriptor(visual.state);
    const bundle=await build({stdin:{contents:browserFixtureSource(dto),resolveDir:fileURLToPath(base),sourcefile:'part3-offline-visual-fixture.mjs',loader:'js'},bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,logLevel:'silent'});
    const script=bundle.outputFiles[0].text;
    for(const theme of PART3_VISUAL_THEMES)for(const width of PART3_VISUAL_WIDTHS){
      const {document}=parseHTML(fs.readFileSync(new URL('partner-cabinet.html',base),'utf8'));
      document.querySelectorAll('script,link[rel="stylesheet"]').forEach(node=>node.remove());
      document.documentElement.removeAttribute('data-launch-state');
      for(const [name,value] of Object.entries({'data-color-theme':theme,'data-theme-mode':theme,'data-package-visual-state':visual.state,'data-package-visual-target':visual.target}))document.documentElement.setAttribute(name,value);
      const policy=document.createElement('meta');policy.setAttribute('http-equiv','Content-Security-Policy');policy.setAttribute('content',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'");document.head.prepend(policy);
      const style=document.createElement('style');style.textContent=css;document.head.append(style);
      const label=document.createElement('aside');label.setAttribute('data-part3-synthetic','true');label.textContent='Синтетический офлайн-макет · без оплаты';label.setAttribute('style','position:fixed;bottom:0;left:0;right:0;z-index:2147483647;padding:4px 8px;background:#172641;color:#fff;font:10px system-ui;text-align:center;pointer-events:none');document.body.append(label);
      const node=document.createElement('script');node.textContent=script;document.body.append(node);
      const filename=`${visual.state}-${theme}-${width}.html`,bytes=Buffer.from(document.toString());fs.writeFileSync(path.join(directory,filename),bytes);
      manifest.files.push({filename,state:visual.state,theme,width,target:visual.target,bytes:bytes.length,sha256:hash(bytes),bundleSha256:hash(Buffer.from(script))});
    }
  }
  manifest.interactionFiles=manifest.files.filter(row=>row.state==='professional-offer'&&row.width===320).map(row=>({...row}));
  fs.writeFileSync(path.join(directory,'PART3-VISUAL-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}

export function verifyPart3GeometryReport(report,visual){
  if(report.state!==visual.state||report.theme!==visual.theme||report.width!==visual.width||report.height!==800||report.dpr!==1||report.scrollWidth>report.clientWidth||!Array.isArray(report.badTargets)||report.badTargets.length||!Array.isArray(report.overflowingText)||report.overflowingText.length||report.sections?.length!==8||report.sections.some(row=>!row.visible||row.collapsed)||report.rejectedEconomyCopy!==false||report.syntheticLabelVisible!==true)fail('part3_visual_geometry_failed');
  if(report.theme==='dark'&&report.canvas?.backgroundColor!=='rgb(14, 25, 44)')fail('part3_visual_accepted_canvas_changed');
  const professional=report.planPaint?.find(row=>row.plan==='professional')?.backgroundImage,dragon=report.planPaint?.find(row=>row.plan==='dragon')?.backgroundImage;
  if(!['rgb(18, 86, 189)','rgb(41, 69, 180)','rgb(57, 52, 141)'].every(color=>professional?.includes(color))||!['rgb(174, 35, 71)','rgb(146, 34, 70)','rgb(104, 39, 79)'].every(color=>dragon?.includes(color))||report.rays?.length!==3||report.rays.some(row=>row.after!=='none')||report.rays[0].before!=='none'||report.freeMarker?.content!=='""'||report.freeMarker.borderRadius!=='50%'||!report.freeMarker.backgroundImage?.includes('rgb(255, 255, 255)'))fail('part3_visual_accepted_plan_paint_changed');
  if(!report.targetRect||report.targetRect.height<=0||report.targetRect.bottom<=0||report.targetRect.top>=800)fail('part3_visual_target_outside_frame');
  const dialog=report.dialog;if(dialog&&(dialog.left<0||dialog.right>visual.width||dialog.top<0||dialog.bottom>800||!dialog.modal||!dialog.focusInside))fail('part3_visual_modal_failed');
  if(report.professionalPrice?.text!=='699 ⭐'||report.comparison?.text!=='747 ⭐'||report.comparison.interactive!==false||!report.comparison.style?.textDecorationLine?.includes('line-through')||Number.parseFloat(report.professionalPrice.style?.fontSize)<=Number.parseFloat(report.comparison.style?.fontSize)||report.comparison.basis!=='3 × 30 дней'||!report.comparison.ariaLabel?.includes('747'))fail('part3_visual_price_hierarchy_failed');
  const channels=value=>value?.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u)?.slice(1).map(Number);
  const comparisonColor=channels(report.comparison.style.color),priceColor=channels(report.professionalPrice.style.color);
  if(!comparisonColor||!priceColor||Math.max(...comparisonColor)-Math.min(...comparisonColor)>40||Math.min(...comparisonColor)>245||Math.min(...priceColor)<=Math.min(...comparisonColor))fail('part3_visual_price_color_failed');
  if(report.state==='professional-offer'&&(report.professionalPrice.rect.top<0||report.professionalPrice.rect.bottom>800||report.comparison.rect.top<0||report.comparison.rect.bottom>800))fail('part3_visual_price_not_in_viewport');
  if(report.state==='refunded-package'&&report.currentPlan!=='free')fail('part3_visual_refund_access_failed');
  if(['future-transition','cancel-transition'].includes(report.state)&&report.currentPlan!=='professional')fail('part3_visual_future_current_confused');
  if(report.state==='future-transition'){
    const paid=report.paidFutureRows?.[0],intent=report.unpaidIntentRows?.[0],inView=box=>box?.top>=0&&box.bottom<=800;
    if(report.paidFutureRows.length!==1||report.unpaidIntentRows.length!==1||paid?.plan!=='Dragon'||paid.label!=='Оплачен · начнётся позже'||!paid.ownReceiptMatches||paid.grantsCurrentAccess!==false||paid.dates?.length!==2||JSON.stringify(paid.dates)!==JSON.stringify(paid.expectedDates)||!inView(paid.badgeRect)||!paid.dateRects.every(inView)||
      !intent?.label?.includes('ещё не оплачено')||intent.heading!=='Dragon → Professional'||intent.grantsAccess!==false||intent.date!==intent.expectedDate||intent.date!==paid.dates[1]||!inView(intent.badgeRect)||!inView(intent.dateRect))fail('part3_visual_paid_future_intent_conflated');
  }
  return true;
}

export function verifyPart3InteractionReport(report,{width,theme,reducedMotion}){
  if(report.width!==width||report.theme!==theme||report.reducedMotion!==reducedMotion||report.height!==800||report.dpr!==1||report.scrollWidth>report.clientWidth||!report.stableAfterSelection||report.financialProducerCalls!==0)fail('part3_visual_interaction_geometry_failed');
  const refresh=report.refresh;if(!refresh||refresh.duration!=='3m'||refresh.focusDuration!=='3m'||!refresh.termsOpen||Math.abs(refresh.scrollBefore-refresh.scrollAfter)>1||refresh.readCount<1||!refresh.stableNavigation||!refresh.stableTheme||refresh.theme!==theme||refresh.highlightCount!==1)fail('part3_visual_refresh_state_failed');
  const confirm=report.confirmation;if(!confirm?.modal||!confirm.focusInside||!confirm.submitDisabled||!confirm.consentUnchecked||confirm.rect.left<0||confirm.rect.right>width||confirm.rect.top<0||confirm.rect.bottom>800||!report.modalRetained||!report.focusRestored)fail('part3_visual_confirmation_behavior_failed');
  if(report.clock?.mode!=='SYNTHETIC_FIXED_SOURCE_SNAPSHOT'||report.clock.epochMs!==epoch*1000||report.clock.dateNowMs!==epoch*1000||report.clock.performanceClock!=='ACTUAL_BROWSER_MONOTONIC_UNCHANGED')fail('part3_visual_clock_invalid');
  if(reducedMotion&&report.durationTransition?.split(',').some(value=>Number.parseFloat(value)!==0))fail('part3_visual_reduced_motion_failed');
  const {durationBefore:before,durationStart:start,durationSampling:sampling,durationEnd:end}=report;
  if(!before||!start||!sampling||!end||before.old.opacity!==1||before.next.opacity!==0||end.old.opacity!==0||end.next.opacity!==1)fail('part3_visual_duration_selection_failed');
  for(const key of ['old','next'])if(JSON.stringify(before[key].rect)!==JSON.stringify(end[key].rect)||end[key].overflow!=='hidden'||end[key].inset.some(value=>value!=='0px')||end[key].pointerEvents!=='none'||end[key].afterContent!=='none')fail('part3_visual_duration_highlight_spill');
  const instant=theme==='light'||reducedMotion;
  if(instant?(sampling.observed!==false||sampling.frames!==0||start.old.opacity!==0||start.next.opacity!==1):
    (sampling.observed!==true||sampling.frames<1||sampling.sample?.old.opacity<=0||sampling.sample.old.opacity>=1||sampling.sample.next.opacity<=0||sampling.sample.next.opacity>=1||end.old.transitionDuration!=='0.22s'))fail('part3_visual_duration_crossfade_failed');
  return true;
}

function readManifest(directory){
  const bytes=fs.readFileSync(path.join(directory,'PART3-VISUAL-MANIFEST.json')),manifest=JSON.parse(bytes);
  const expected=PART3_VISUAL_CASES.flatMap(row=>PART3_VISUAL_THEMES.flatMap(theme=>PART3_VISUAL_WIDTHS.map(width=>`${row.state}-${theme}-${width}.html`)));
  if(manifest.schema!==1||manifest.status!=='OFFLINE_SYNTHETIC_ACTUAL_PART3_UI'||manifest.expectedFrames!==frameCount||manifest.expectedInteractions!==interactionCount||JSON.stringify(manifest.widths)!==JSON.stringify(PART3_VISUAL_WIDTHS)||JSON.stringify(manifest.themes)!==JSON.stringify(PART3_VISUAL_THEMES)||JSON.stringify(manifest.states)!==JSON.stringify(PART3_VISUAL_CASES)||JSON.stringify(manifest.files?.map(row=>row.filename))!==JSON.stringify(expected)||manifest.interactionFiles?.length!==2)fail('part3_visual_manifest_invalid');
  if(JSON.stringify(manifest.sourceHashes)!==JSON.stringify(sourceHashes()))fail('part3_visual_sources_changed');
  if(JSON.stringify(manifest.interactionFiles)!==JSON.stringify(manifest.files.filter(row=>row.state==='professional-offer'&&row.width===320)))fail('part3_visual_interaction_binding_invalid');
  for(const row of manifest.files){const actual=fs.readFileSync(path.join(directory,row.filename));if(actual.length!==row.bytes||hash(actual)!==row.sha256)fail('part3_visual_html_hash_mismatch:'+row.filename);}
  return {manifest,bytes};
}

export function part3DocumentReadyExpression(url){
  return `location.href===${JSON.stringify(url+'#subscription')}&&typeof window.__measurePart3==='function'`;
}

export async function renderPart3Visuals(directory,chrome){
  guard();const {manifest,bytes}=readManifest(directory);if(!fs.existsSync(chrome))fail('actual_part3_chrome_unavailable');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'re-part3-render-'));
  const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--host-resolver-rules=MAP * ~NOTFOUND','--hide-scrollbars','--remote-debugging-pipe',`--user-data-dir=${profile}`],{stdio:['ignore','ignore','ignore','pipe','pipe']});
  const write=child.stdio[3],read=child.stdio[4],decoder=new StringDecoder('utf8'),pending=new Map(),requests=[],networkViolations=[];
  let id=0,buffer='',ended=false,browser=null;const reports=[],interactions=[],pageErrors=[];
  const rejectAll=error=>{ended=true;for(const value of pending.values()){clearTimeout(value.timer);value.reject(error);}pending.clear();};
  child.on('error',rejectAll);child.on('exit',code=>rejectAll(new Error('actual_part3_chrome_exited:'+code)));
  read.on('data',chunk=>{buffer+=decoder.write(chunk);let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;let message;try{message=JSON.parse(raw);}catch{rejectAll(new Error('actual_part3_chrome_invalid_protocol'));continue;}if(message.method==='Network.requestWillBeSent'){const url=message.params?.request?.url??'';requests.push(url);if(!/^(?:file:|about:|data:)/u.test(url))networkViolations.push(url);}if(message.method==='Runtime.exceptionThrown')pageErrors.push(message.params?.exceptionDetails?.exception?.description??message.params?.exceptionDetails?.text??'unknown_browser_exception');const value=pending.get(message.id);if(!value)continue;pending.delete(message.id);clearTimeout(value.timer);if(message.error)value.reject(new Error('actual_part3_chrome_protocol:'+JSON.stringify(message.error)));else value.resolve(message.result);}});
  const call=(method,params={},sessionId=null)=>new Promise((resolve,reject)=>{if(ended)return reject(new Error('actual_part3_chrome_pipe_closed'));const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('actual_part3_chrome_timeout:'+method));},method==='Browser.getVersion'?30000:10000);pending.set(requestId,{resolve,reject,timer});write.write(JSON.stringify({id:requestId,method,params,...(sessionId?{sessionId}:{})})+'\0');});
  const save=(status,error=null)=>{
    fs.writeFileSync(path.join(directory,'PART3-VISUAL-GEOMETRY.json'),JSON.stringify(reports,null,2)+'\n');fs.writeFileSync(path.join(directory,'PART3-VISUAL-INTERACTIONS.json'),JSON.stringify(interactions,null,2)+'\n');
    fs.writeFileSync(path.join(directory,'PART3-VISUAL-BROWSER.json'),JSON.stringify({status,browser,sourceSha:manifest.sourceSha,workflowRunId:manifest.workflowRunId,manifestSha256:hash(bytes),expectedFrames:frameCount,frames:reports.length,expectedInteractions:interactionCount,interactions:interactions.length,requests,networkViolations,pageErrors,error},null,2)+'\n');
  };
  let renderError=null;
  try{
    browser=await call('Browser.getVersion');const target=await call('Target.createTarget',{url:'about:blank'});const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true}),session=attached.sessionId;
    await call('Page.enable',{},session);await call('Runtime.enable',{},session);await call('Network.enable',{},session);await call('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']},session);
    const navigate=async(row,width,theme,reducedMotion)=>{
      await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:true},session);await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reducedMotion?'reduce':'no-preference'},{name:'prefers-color-scheme',value:theme}]},session);
      const url=pathToFileURL(path.join(directory,row.filename)).href;const result=await call('Page.navigate',{url},session);if(result.errorText)fail('actual_part3_chrome_navigation:'+result.errorText);
      for(let index=0;index<200;index++){const ready=await call('Runtime.evaluate',{expression:part3DocumentReadyExpression(url),returnByValue:true},session);if(ready.result?.value===true)return;await new Promise(resolve=>setTimeout(resolve,25));}fail('actual_part3_chrome_document_not_ready');
    };
    const measure=async(expression)=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(result.exceptionDetails||!result.result?.value)fail('actual_part3_chrome_script:'+JSON.stringify(result.exceptionDetails??null));return result.result.value;};
    const screenshot=async(filename,row,report)=>{const result=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true},session),png=Buffer.from(result.data,'base64');fs.writeFileSync(path.join(directory,filename),png);Object.assign(report,{htmlFilename:row.filename,htmlSha256:row.sha256,pngFilename:filename,pngSha256:hash(png),pngBytes:png.length,bundleSha256:row.bundleSha256});};
    for(const row of manifest.files){await navigate(row,row.width,row.theme,false);const report=await measure('window.__measurePart3()');await screenshot(row.filename.replace(/\.html$/u,'.png'),row,report);reports.push(report);save('IN_PROGRESS_ACTUAL_PART3_BROWSER_RENDER');verifyPart3GeometryReport(report,row);if(networkViolations.length)fail('actual_part3_chrome_network_forbidden');}
    for(const row of manifest.interactionFiles)for(const width of PART3_VISUAL_WIDTHS)for(const reducedMotion of [false,true]){await navigate(row,width,row.theme,reducedMotion);const report=await measure('window.__probePart3()');await screenshot(`interaction-${row.theme}-${reducedMotion?'reduced':'motion'}-${width}.png`,row,report);interactions.push(report);save('IN_PROGRESS_ACTUAL_PART3_BROWSER_RENDER');verifyPart3InteractionReport(report,{width,theme:row.theme,reducedMotion});if(networkViolations.length)fail('actual_part3_chrome_network_forbidden');}
    if(pageErrors.length)fail('actual_part3_chrome_page_exception');save('PASS_ACTUAL_PART3_BROWSER_RENDER');return {browser,reports,interactions};
  }catch(error){renderError=error;save('FAILED_ACTUAL_PART3_BROWSER_RENDER',error.message);throw error;}
  finally{
    rejectAll(new Error('actual_part3_chrome_render_finished'));
    const exited=()=>child.exitCode!==null||child.signalCode!==null||!child.pid;
    const waitForExit=timeout=>exited()?Promise.resolve(true):new Promise(resolve=>{const finish=()=>{clearTimeout(timer);child.off('exit',finish);resolve(true);};const timer=setTimeout(()=>{child.off('exit',finish);resolve(false);},timeout);child.once('exit',finish);if(exited())finish();});
    try{const graceful=waitForExit(3000);if(!exited())child.kill('SIGTERM');if(!await graceful){const forced=waitForExit(3000);if(!exited())child.kill('SIGKILL');if(!await forced)fail('actual_part3_chrome_shutdown_timeout');}read.destroy();write.destroy();fs.rmSync(profile,{recursive:true,force:true,maxRetries:12,retryDelay:100});}catch(error){if(!renderError)throw error;renderError.cleanupError=error.message;}finally{read.destroy();write.destroy();}
  }
}

export function verifyPart3VisualEvidence(directory,{sourceSha,runId}={}){
  guard();const {manifest,bytes}=readManifest(directory);const browser=JSON.parse(fs.readFileSync(path.join(directory,'PART3-VISUAL-BROWSER.json'))),reports=JSON.parse(fs.readFileSync(path.join(directory,'PART3-VISUAL-GEOMETRY.json'))),interactions=JSON.parse(fs.readFileSync(path.join(directory,'PART3-VISUAL-INTERACTIONS.json')));
  if(!/^[a-f0-9]{40}$/u.test(sourceSha??'')||!/^[1-9][0-9]*$/u.test(String(runId??''))||manifest.sourceSha!==sourceSha||String(manifest.workflowRunId)!==String(runId)||browser.sourceSha!==sourceSha||String(browser.workflowRunId)!==String(runId)||browser.status!=='PASS_ACTUAL_PART3_BROWSER_RENDER'||!/^Chrome\/[0-9.]+$/u.test(browser.browser?.product??'')||browser.manifestSha256!==hash(bytes)||browser.networkViolations?.length!==0||browser.pageErrors?.length!==0||browser.error!==null||reports.length!==frameCount||interactions.length!==interactionCount||browser.frames!==frameCount||browser.interactions!==interactionCount)fail('part3_visual_evidence_provenance_invalid');
  const artifacts=[];const verifyPng=(row,report,expectedFilename)=>{if(report.htmlFilename!==row.filename||report.htmlSha256!==row.sha256||report.bundleSha256!==row.bundleSha256||report.pngFilename!==expectedFilename||!/^[a-z0-9-]+\.png$/u.test(report.pngFilename??''))fail('part3_visual_render_binding_invalid');const png=fs.readFileSync(path.join(directory,report.pngFilename));if(png.length!==report.pngBytes||hash(png)!==report.pngSha256||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(16)!==report.width||png.readUInt32BE(20)!==800)fail('part3_visual_png_invalid');artifacts.push({filename:report.pngFilename,bytes:png.length,sha256:hash(png)});};
  reports.forEach((report,index)=>{const row=manifest.files[index];verifyPart3GeometryReport(report,row);verifyPng(row,report,row.filename.replace(/\.html$/u,'.png'));});
  let index=0;for(const row of manifest.interactionFiles)for(const width of PART3_VISUAL_WIDTHS)for(const reducedMotion of [false,true]){const report=interactions[index++];verifyPart3InteractionReport(report,{width,theme:row.theme,reducedMotion});verifyPng(row,report,`interaction-${row.theme}-${reducedMotion?'reduced':'motion'}-${width}.png`);}
  if(new Set(artifacts.map(row=>row.filename)).size!==frameCount+interactionCount)fail('part3_visual_png_duplicate');
  artifacts.push(...manifest.files.map(row=>({filename:row.filename,bytes:row.bytes,sha256:row.sha256})));
  for(const filename of ['PART3-VISUAL-MANIFEST.json','PART3-VISUAL-BROWSER.json','PART3-VISUAL-GEOMETRY.json','PART3-VISUAL-INTERACTIONS.json']){const actual=fs.readFileSync(path.join(directory,filename));artifacts.push({filename,bytes:actual.length,sha256:hash(actual)});}
  const pricePolicy=reports.filter(row=>row.state==='professional-offer').map(row=>({theme:row.theme,width:row.width,currentPrice:row.professionalPrice.text,currentFontSize:row.professionalPrice.style.fontSize,currentColor:row.professionalPrice.style.color,
    comparison:row.comparison.text,comparisonFontSize:row.comparison.style.fontSize,comparisonColor:row.comparison.style.color,comparisonStruck:row.comparison.style.textDecorationLine.includes('line-through'),comparisonInteractive:row.comparison.interactive,basis:row.comparison.basis,rejectedEconomyCopy:row.rejectedEconomyCopy}));
  return {status:'PASS_ACTUAL_PART3_BROWSER_RENDER',sourceSha,runId:String(runId),frames:frameCount,interactions:interactionCount,browser:browser.browser,sourceHashes:manifest.sourceHashes,pricePolicy,artifacts};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='--render'){const result=await renderPart3Visuals(process.argv[3],process.argv[4]);console.log(JSON.stringify({status:'PASS_ACTUAL_PART3_BROWSER_RENDER',frames:result.reports.length,interactions:result.interactions.length,browser:result.browser.product}));}
  else{const result=await writePart3Visuals(process.argv[2]);console.log(JSON.stringify({status:result.status,files:result.files.length,expectedFrames:result.expectedFrames,expectedInteractions:result.expectedInteractions}));}
}
