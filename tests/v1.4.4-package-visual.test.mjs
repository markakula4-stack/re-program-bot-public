import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Script} from 'node:vm';
import {readSubscriptionDTO} from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import {createPart3VisualDescriptor,writePart3Visuals,verifyPart3GeometryReport,verifyPart3InteractionReport,part3DocumentReadyExpression,
  PART3_VISUAL_CASES,PART3_VISUAL_WIDTHS,PART3_VISUAL_THEMES} from '../scripts/v1.4.4-part3-visual-preview.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('synthetic package descriptors preserve separate current access, future intent and reversed own receipt',async()=>{
  for(const row of PART3_VISUAL_CASES)assert.equal(readSubscriptionDTO(await createPart3VisualDescriptor(row.state)).authority,'worker');
  const offer=await createPart3VisualDescriptor('professional-offer');
  assert.equal(offer.access.current.planCode,'free');assert.equal(offer.packages.accessAuthority,false);
  const pro=offer.packages.offers.find(row=>row.planCode==='professional'&&row.packageCode==='3m');
  assert.equal(pro.amountStars,699);assert.equal(pro.priceComparison.amountStars,747);
  assert.equal(pro.priceComparison.basis,'same_plan_monthly_equivalent');assert.equal(pro.invoice.available,true);
  assert.equal(pro.preview.endsAt-pro.preview.startsAt,90*86400);assert.equal(pro.automaticRenewal,false);
  assert.ok(offer.packages.offers.filter(row=>['6m','12m'].includes(row.packageCode)).every(row=>!row.available));
  const future=await createPart3VisualDescriptor('future-transition');
  assert.equal(future.access.current.planCode,'professional');assert.equal(future.packages.paidPeriods[0].planCode,'dragon');
  assert.equal(future.packages.paidPeriods[0].state,'future');assert.equal(future.packages.paidPeriods[0].grantsCurrentAccess,false);
  assert.equal(future.packages.transitions[0].fromPlan,'dragon');assert.equal(future.packages.transitions[0].toPlan,'professional');
  assert.equal(future.packages.transitions[0].effectiveAt,future.packages.paidPeriods[0].endsAt);
  assert.equal(future.history.items[0].receiptId,future.packages.paidPeriods[0].receiptId);assert.equal(future.history.items[0].package.accessState,'future');
  assert.equal(future.packages.transitions[0].grantsAccess,false);assert.equal(future.packages.transitions[0].cancel.available,true);
  assert.equal(future.packages.transitions[0].monthlyCheckout.available,false);
  const reversed=await createPart3VisualDescriptor('refunded-package');
  assert.equal(reversed.access.current.planCode,'free');assert.equal(reversed.history.items[0].status,'refunded');
  assert.equal(reversed.packages.paidPeriods[0].grantsCurrentAccess,false);
  assert.equal(reversed.history.items[0].receipt.package.accessState,'refunded');
  assert.equal(reversed.history.items[0].receiptId,reversed.packages.paidPeriods[0].receiptId);
});

test('offline manifest pins 64 real-mounted frames, exact source hashes and complete self-contained listener bundles',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'re-part3-visual-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const manifest=await writePart3Visuals(directory);
  assert.equal(manifest.schema,1);assert.equal(manifest.expectedFrames,64);assert.equal(manifest.expectedInteractions,16);
  assert.deepEqual(manifest.widths,[320,360,390,430]);assert.deepEqual(manifest.themes,['light','dark']);
  assert.equal(manifest.files.length,64);assert.equal(manifest.interactionFiles.length,2);
  assert.deepEqual(manifest.files.map(row=>row.filename),PART3_VISUAL_CASES.flatMap(row=>PART3_VISUAL_THEMES.flatMap(theme=>PART3_VISUAL_WIDTHS.map(width=>`${row.state}-${theme}-${width}.html`))));
  for(const row of manifest.files){
    const bytes=fs.readFileSync(path.join(directory,row.filename)),html=bytes.toString();
    assert.equal(bytes.length,row.bytes);assert.equal(hash(bytes),row.sha256);
    assert.match(html,/Синтетический офлайн-макет · без оплаты/u);assert.match(html,/connect-src 'none'/u);
    assert.doesNotMatch(html,/<script[^>]+src=/iu);assert.doesNotMatch(html,/<link[^>]+stylesheet/iu);
    assert.match(html,/part3_visual_financial_producer_forbidden/u);assert.match(html,/__measurePart3/u);assert.match(html,/__probePart3/u);
    assert.match(html,/mountCabinet/u);assert.match(html,/MiniAppClient/u);assert.match(html,/SYNTHETIC_FIXED_SOURCE_SNAPSHOT/u);
    assert.match(html,new RegExp(`data-theme-mode="${row.theme}"`));assert.match(html,new RegExp(`data-package-visual-state="${row.state}"`));
    const inline=html.match(/<script>([\s\S]*?)<\/script>/u);assert.ok(inline);assert.doesNotThrow(()=>new Script(inline[1]));
    assert.equal(row.bundleSha256,hash(Buffer.from(inline[1])));
  }
  for(const [name,digest] of Object.entries(manifest.sourceHashes)){
    const url=name==='previewScript'?new URL('../scripts/v1.4.4-part3-visual-preview.mjs',import.meta.url):name==='baselineFixtureProducer'?new URL('../scripts/v1.4.3-native40-ui-preview.mjs',import.meta.url):name==='motionObserver'?new URL('../scripts/v1.4.3-native40-ui-polish-preview.mjs',import.meta.url):new URL('../src/v1.4.0-rebuild/mini-app/'+name,import.meta.url);
    assert.equal(digest,hash(fs.readFileSync(url)));
  }
  // Writing HTML is not a claim that Chrome ran. Only render mode creates
  // original PNGs and browser/geometry/listener reports.
  assert.equal(fs.existsSync(path.join(directory,'PART3-VISUAL-BROWSER.json')),false);
  assert.equal(fs.readdirSync(directory).filter(name=>name.endsWith('.png')).length,0);
});

test('generated inline initialization is ready only at its exact file document and subscription route',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'re-part3-route-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const manifest=await writePart3Visuals(directory),row=manifest.files[0];
  const html=fs.readFileSync(path.join(directory,row.filename),'utf8');
  const inline=html.match(/<script>([\s\S]*?)<\/script>/u);assert.ok(inline);
  const fileUrl=new URL('file:///offline-evidence/'+row.filename).href,location=new URL(fileUrl),window={};
  // Run the actual generated bundle, stopping authentication at the synthetic
  // response boundary. No DOM mounting or browser evidence is simulated here.
  new Script(inline[1]).runInNewContext({location,window,URL,TextEncoder,AbortController,crypto:crypto.webcrypto,
    document:{documentElement:{getAttribute:name=>name==='data-package-visual-state'?row.state:row.theme}},
    localStorage:{setItem(){}},Response:{json:()=>new Promise(()=>{})},setTimeout:()=>1,clearTimeout(){} });
  assert.equal(location.href,fileUrl+'#subscription');assert.equal(typeof window.__measurePart3,'function');
  const evaluate=(expression,currentLocation=location,probes=window)=>new Script(expression).runInNewContext({location:currentLocation,window:probes});
  // This reproduces the failed Chrome guard despite successful initialization.
  assert.equal(evaluate(`location.href===${JSON.stringify(fileUrl)}&&typeof window.__measurePart3==='function'`),false);
  const readiness=part3DocumentReadyExpression(fileUrl);assert.equal(evaluate(readiness),true);
  for(const href of [fileUrl,fileUrl+'#profile',fileUrl+'?other=1#subscription',
    'file:///offline-evidence/other.html#subscription','https://offline-evidence/'+row.filename+'#subscription'])
    assert.equal(evaluate(readiness,new URL(href)),false);
  assert.equal(evaluate(readiness,location,{}),false);
});

// Deliberately fabricated unit controls exercise rejection rules only. They are
// never saved as visual evidence and do not claim a browser measurement.
const geometry=()=>({state:'professional-offer',theme:'dark',width:320,height:800,dpr:1,scrollWidth:320,clientWidth:320,badTargets:[],
  overflowingText:[],canvas:{backgroundColor:'rgb(14, 25, 44)'},rays:[{before:'none',after:'none'},{before:'none',after:'none'},{before:'""',after:'none'}],
  planPaint:[{plan:'professional',backgroundImage:'rgb(18, 86, 189) rgb(41, 69, 180) rgb(57, 52, 141)'},{plan:'dragon',backgroundImage:'rgb(174, 35, 71) rgb(146, 34, 70) rgb(104, 39, 79)'}],
  freeMarker:{content:'""',borderRadius:'50%',backgroundImage:'rgb(255, 255, 255)'},
  sections:Array.from({length:8},()=>({visible:true,collapsed:false})),rejectedEconomyCopy:false,syntheticLabelVisible:true,targetRect:{height:600,top:18,bottom:618},dialog:null,
  professionalPrice:{text:'699 ⭐',style:{fontSize:'28px',color:'rgb(255, 255, 255)'},rect:{top:180,bottom:220}},
  comparison:{text:'747 ⭐',basis:'3 × 30 дней',ariaLabel:'3 отдельных месячных периодов: 747 Stars',interactive:false,style:{fontSize:'14px',color:'rgb(212, 220, 235)',textDecorationLine:'line-through'},rect:{top:155,bottom:175}}});
test('geometry rejects misleading comparison, small touch targets, absent sections and future-access conflation',()=>{
  const visual={state:'professional-offer',theme:'dark',width:320};assert.equal(verifyPart3GeometryReport(geometry(),visual),true);
  for(const mutate of [row=>row.comparison.interactive=true,row=>row.comparison.style.textDecorationLine='none',row=>row.comparison.style.fontSize='30px',
    row=>row.comparison.style.color='rgb(255, 255, 255)',row=>row.rejectedEconomyCopy=true,row=>row.badTargets=[{height:35}],
    row=>row.sections[0].collapsed=true,row=>row.professionalPrice.rect.bottom=820,row=>row.scrollWidth=330,row=>row.canvas.backgroundColor='rgb(21, 38, 56)',
    row=>row.planPaint[0].backgroundImage='none',row=>row.rays[0].after='""',row=>row.overflowingText=[{right:340}]]){
    const row=geometry();mutate(row);assert.throws(()=>verifyPart3GeometryReport(row,visual),/part3_visual_/u);
  }
  const future=geometry();future.state='future-transition';future.currentPlan='dragon';
  assert.throws(()=>verifyPart3GeometryReport(future,{...visual,state:'future-transition'}),/future_current_confused/u);
  const refunded=geometry();refunded.state='refunded-package';refunded.currentPlan='professional';
  assert.throws(()=>verifyPart3GeometryReport(refunded,{...visual,state:'refunded-package'}),/refund_access_failed/u);
});

const appearance=opacity=>({opacity,rect:{left:0,right:100,top:0,bottom:44},overflow:'hidden',inset:['0px','0px','0px','0px'],pointerEvents:'none',afterContent:'none',transitionDuration:'0s'});
const interaction=()=>({theme:'dark',width:320,height:800,dpr:1,reducedMotion:true,scrollWidth:320,clientWidth:320,stableAfterSelection:true,financialProducerCalls:0,durationTransition:'0s',
  durationBefore:{old:appearance(1),next:appearance(0)},durationStart:{old:appearance(0),next:appearance(1)},durationEnd:{old:appearance(0),next:appearance(1)},durationSampling:{observed:false,frames:0},
  refresh:{duration:'3m',focusDuration:'3m',termsOpen:true,scrollBefore:400,scrollAfter:400,readCount:1,stableNavigation:true,stableTheme:true,theme:'dark',highlightCount:1},
  confirmation:{modal:true,focusInside:true,submitDisabled:true,consentUnchecked:true,rect:{left:16,right:304,top:30,bottom:770}},modalRetained:true,focusRestored:true,
  clock:{mode:'SYNTHETIC_FIXED_SOURCE_SNAPSHOT',epochMs:1791327600000,dateNowMs:1791327600000,performanceClock:'ACTUAL_BROWSER_MONOTONIC_UNCHANGED'}});
test('listener verifier rejects refresh reset, implicit consent, removed modal, repeated producers and reduced-motion animation',()=>{
  const expected={width:320,theme:'dark',reducedMotion:true};assert.equal(verifyPart3InteractionReport(interaction(),expected),true);
  for(const mutate of [row=>row.refresh.duration='30d',row=>row.refresh.focusDuration=null,row=>row.refresh.termsOpen=false,row=>row.refresh.scrollAfter=0,
    row=>row.refresh.stableTheme=false,row=>row.refresh.highlightCount=2,row=>row.confirmation.consentUnchecked=false,row=>row.confirmation.submitDisabled=false,
    row=>row.modalRetained=false,row=>row.focusRestored=false,row=>row.financialProducerCalls=1,row=>row.durationTransition='.22s',
    row=>row.durationEnd.next.rect.right=110,row=>row.durationEnd.next.overflow='visible',row=>row.durationStart.next.opacity=0]){
    const row=interaction();mutate(row);assert.throws(()=>verifyPart3InteractionReport(row,expected),/part3_visual_/u);
  }
});
