import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Script,runInNewContext} from 'node:vm';
import {createPolishVisual,writePolishedSubscriptionVisuals,POLISH_VISUAL_CASES,observePolishCrossfade,verifyPolishGeometryReport,verifyPolishInteractionReport} from '../scripts/v1.4.3-native40-ui-polish-preview.mjs';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const ordinary={backgroundImage:'linear-gradient(135deg, rgb(23, 110, 230), rgb(32, 93, 216) 64%, rgb(52, 85, 203))',
  boxShadow:'rgba(255, 255, 255, .25) 0px 1px 0px inset, rgba(23, 94, 216, .21) 0px 7px 18px',color:'rgb(255, 255, 255)',baseFillContrast:4.7,opacity:'1',cursor:'default',transform:'none'};
const radial='radial-gradient(rgba(44, 127, 255, .16), transparent)';
const noRay=()=>({content:'none',backgroundImage:'none',filter:'none'});
const light=()=>({canvas:noRay(),brand:noRay(),launchCanvas:noRay(),selectedTheme:noRay(),selectedNavigation:noRay(),selectedAiMode:noRay()});
const selected={...ordinary,backgroundImage:'none',overflow:'hidden',boxShadow:'rgba(255, 255, 255, .25) 0px 1px 0px inset'};
const highlight={...ordinary,content:'""',position:'absolute',pointerEvents:'none',zIndex:'-1',top:'0px',right:'0px',bottom:'0px',left:'0px',filter:'none',transitionProperty:'opacity',transitionDuration:'0.22s'};
const neutralTheme={...selected,color:'rgb(183, 210, 255)',borderColor:'rgb(42, 61, 92)'};
const neutralThemeFace={...highlight,color:'rgb(183, 210, 255)',backgroundColor:'rgb(23, 38, 65)',backgroundImage:'none',baseFillContrast:9.8};
const highlights=(theme='light')=>({selectedTheme:{...(theme==='dark'?neutralThemeFace:highlight)},selectedNavigation:{...highlight},selectedAiMode:{...highlight}});
const canvas=()=>({body:{backgroundColor:'rgb(14, 25, 44)',backgroundImage:radial}});
const content=width=>({scrollWidth:width,bodyScrollWidth:width,clientWidth:width,overflowNodes:[]});
const evidenceLabel={text:'Синтетический макет · только просмотр',position:'fixed',pointerEvents:'none',inViewport:true};
const box=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
const navigationContents=()=>[['settings','Пульт'],['support','Поддержка'],['payments','Платежи']].map(([section,labelText],i)=>{
  const left=20+i*96;return {section,labelText,button:box(left,200,92,62),label:box(left+6,232,80,17),icon:box(left+38,210,16,16),svg:box(left+38,210,16,16),textRects:[box(left+6,232,80,17)]};
});
const shiftNavigation=(row,dx,dy=0)=>{for(const r of [row.button,row.label,row.icon,row.svg,...row.textRects]){r.left+=dx;r.right+=dx;r.top+=dy;r.bottom+=dy;}};

test('natural frame sampling records a real crossfade when animation starts after the old 90 ms timer',async()=>{
  const start={old:{opacity:1},next:{opacity:0}},interior={old:{opacity:.82},next:{opacity:.18}};
  let elapsed=0;
  const result=await observePolishCrossfade(()=>elapsed<160?start:interior,{
    start,reducedMotion:false,now:()=>elapsed,nextFrame:async()=>{elapsed+=16;}
  });
  assert.equal(result.observed,true);assert.equal(result.sample,interior);
  assert.equal(result.frames,10);assert.equal(result.elapsedMs,160);
  assert.deepEqual(result.observations[8],{elapsedMs:144,oldOpacity:1,nextOpacity:0});
  assert.deepEqual(result.observations[9],{elapsedMs:160,oldOpacity:.82,nextOpacity:.18});
});

test('natural frame sampling never invents an intermediate when the face jumps directly to its endpoint',async()=>{
  const start={old:{opacity:1},next:{opacity:0}},end={old:{opacity:0},next:{opacity:1}};
  let elapsed=0;
  const result=await observePolishCrossfade(()=>elapsed<32?start:end,{
    start,reducedMotion:false,now:()=>elapsed,nextFrame:async()=>{elapsed+=16;},timeoutMs:80,maxFrames:5
  });
  assert.equal(result.observed,false);assert.equal(result.sample,end);assert.equal(result.frames,5);
  assert.ok(result.observations.every(value=>[0,1].includes(value.oldOpacity)&&[0,1].includes(value.nextOpacity)));
});

test('natural frame sampling preserves instant reduced motion without scheduling an animation frame',async()=>{
  const end={old:{opacity:0},next:{opacity:1}};
  const result=await observePolishCrossfade(()=>end,{
    start:end,reducedMotion:true,now:()=>0,nextFrame:()=>assert.fail('reduced motion must not wait for a frame')
  });
  assert.equal(result.sample,end);assert.equal(result.frames,0);assert.deepEqual(result.observations,[]);
});

test('natural frame sampling is bounded when Chrome does not deliver a frame or never progresses',async()=>{
  const start={old:{opacity:1},next:{opacity:0}};
  const absent=await observePolishCrossfade(()=>start,{
    start,reducedMotion:false,nextFrame:()=>new Promise(()=>{}),timeoutMs:20
  });
  assert.equal(absent.observed,false);assert.equal(absent.sample,start);assert.equal(absent.frames,0);
  const frozen=await observePolishCrossfade(()=>start,{
    start,reducedMotion:false,now:()=>0,nextFrame:async()=>{},maxFrames:3
  });
  assert.equal(frozen.observed,false);assert.equal(frozen.frames,3);assert.equal(frozen.sample,start);
});


test('unpaid Free and real local compensated payment project truthful Free states without new provider requests',async t=>{
  for(const state of ['free','refunded']) {
    const h=await createPolishVisual({state,after:close=>t.after(close)});
    const card=h.document.querySelector('.subscription-current');
    assert.equal(card.getAttribute('data-current-plan'),'free');
    assert.equal(card.querySelector('h3').textContent,'Free');
    assert.equal(card.querySelector('.badge').textContent,state==='refunded'?'Возврат учтён':'Бесплатный доступ');
    assert.equal(h.document.querySelector('dialog'),null);assert.deepEqual(h.providerCalls,[]);
    assert.equal(h.calls.filter(call=>call.init.method==='POST'&&!call.url.endsWith('/session')).length,0);
    const debits=h.f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='refund' AND direction='debit'").all();
    assert.equal(debits.length,state==='refunded'?1:0);
    if(state==='refunded')assert.equal(debits[0].amount_stars,249);
  }
});

test('synthetic profile uses actual profile DOM, visible legal acknowledgement and canonical theme selector',async t=>{
  const h=await createPolishVisual({state:'profile',after:close=>t.after(close)});
  assert.equal(h.document.querySelector('.profile-name').textContent,'Демо партнёр');
  assert.equal(h.document.querySelector('.legal-saved').textContent,'✅ Статус сохранён');
  assert.equal(h.document.querySelector('#theme-bar').hidden,false);
  const dark=h.document.querySelector('[data-theme-value="dark"]');dark.click();
  assert.equal(h.document.documentElement.getAttribute('data-color-theme'),'dark');
  assert.equal(dark.getAttribute('aria-pressed'),'true');
  assert.equal(h.document.querySelectorAll('#theme-switcher [aria-pressed="true"]').length,1);
  assert.equal(h.document.querySelector('.nav-button[aria-current="page"]').getAttribute('data-section'),'profile');
});

test('synthetic owner remote uses actual client/view with current All selected and every write disabled',async t=>{
  const h=await createPolishVisual({state:'admin',after:close=>t.after(close)});
  assert.equal(h.document.querySelector('.admin-wordmark h1').textContent,'Пульт владельца');
  assert.match(h.document.querySelector('[data-visual-synthetic="admin"]').textContent,/Синтетический макет/u);
  assert.equal(h.document.querySelector('#admin-navigation [aria-current="page"]').getAttribute('data-section'),'settings');
  const choices=[...h.document.querySelectorAll('.admin-ai-modes button')];
  assert.deepEqual(choices.map(node=>[node.getAttribute('data-ai-mode'),node.getAttribute('aria-pressed'),node.disabled]),
    [['off','false',true],['admin','false',true],['all','true',true]]);
  assert.match(h.document.querySelector('#admin-screen').textContent,/Сейчас: Всем/u);
  assert.match(h.document.querySelector('#admin-screen').textContent,/Изменения сейчас отключены/u);
  assert.equal(h.client.canMutate,false);assert.equal(h.document.querySelectorAll('[data-admin-write="true"]:not(:disabled)').length,0);
  await assert.rejects(h.client.mutate('setting.update',{action:'update_setting',key:'ai_rollout_mode',value:'off',expectedValue:'all',confirmed:true}),{code:'writes_unavailable'});
  assert.deepEqual(h.calls.map(call=>[new URL(call.url).pathname,call.init.method]),[
    ['/api/v1.4.0/cabinet/session','POST'],['/api/v1.4.0/cabinet/admin/overview','GET'],['/api/v1.4.0/cabinet/admin/settings','GET']]);
  assert.deepEqual(h.providerCalls,[]);
  h.document.querySelector('[data-theme-value="dark"]').click();
  assert.equal(h.document.documentElement.getAttribute('data-color-theme'),'dark');
});

test('complete mobile fixture manifest pins actual loader and sources with exact 80 frame bytes without externally loaded scripts',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'re-polish-preview-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const launch=await createPolishVisual({state:'launch',after:close=>t.after(close)});
  assert.equal(launch.document.documentElement.getAttribute('data-launch-state'),'loading');
  assert.equal(launch.document.querySelector('.launch-progress').textContent,'Открываем ваш кабинет');
  assert.deepEqual(launch.calls,[]);assert.deepEqual(launch.providerCalls,[]);
  const manifest=await writePolishedSubscriptionVisuals(directory);
  assert.equal(manifest.schema,6);assert.equal(manifest.status,'OFFLINE_SYNTHETIC_POLISHED_ACTUAL_UI');
  assert.equal(manifest.files.length,80);assert.equal(manifest.expectedFrames,80);assert.equal(POLISH_VISUAL_CASES.length,10);assert.equal(manifest.expectedInteractions,16);assert.equal(manifest.interactionFiles.length,2);
  assert.deepEqual(manifest.widths,[320,360,390,430]);assert.deepEqual(manifest.themes,['light','dark']);
  const expected=POLISH_VISUAL_CASES.flatMap(value=>manifest.themes.flatMap(theme=>manifest.widths.map(width=>`${value.state}-${theme}-${width}.html`)));
  assert.deepEqual(manifest.files.map(value=>value.filename),expected);
  // Exercise the same serialized manifest-file entry used by the Chrome
  // renderer. A missing fixture must not turn a profile into subscription UI.
  const savedManifest=JSON.parse(fs.readFileSync(path.join(directory,'UI-POLISH-VISUAL-MANIFEST.json'),'utf8'));
  const first=savedManifest.files.find(row=>row.state==='profile-top'&&row.theme==='light'&&row.width===320);
  const lit=selected;
  const profileReport={state:'profile-top',fixtureState:'profile',theme:'light',themeMode:'light',selectedThemeCount:1,scrollTarget:'#theme-bar',
    width:320,requestedWidth:320,height:800,dpr:1,scrollWidth:320,clientWidth:320,badTargets:[],targetRect:{height:52,bottom:70,top:18},
    sections:[],planLabels:[],receiptLabels:[],contentGeometry:content(320),outwardLight:light(),insideHighlight:highlights(),canvas:canvas(),polishStyles:{selectedTheme:lit,selectedNavigation:lit,legalSaved:ordinary}};
  assert.equal(verifyPolishGeometryReport(profileReport,first),true);
  const missingFixture={...first};delete missingFixture.fixture;
  assert.throws(()=>verifyPolishGeometryReport(profileReport,missingFixture),/polish_fixture_binding_invalid/u);
  for(const row of manifest.files) {
    const definition=POLISH_VISUAL_CASES.find(value=>value.state===row.state);assert.equal(row.fixture,definition.fixture);assert.equal(row.target,definition.target);
    const bytes=fs.readFileSync(path.join(directory,row.filename));assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);
    const html=bytes.toString();assert.doesNotMatch(html,/<script[^>]+src=/iu);assert.doesNotMatch(html,/<link[^>]+stylesheet/iu);
    assert.match(html,/connect-src 'none'/u);assert.match(html,new RegExp(`data-theme-mode="${row.theme}"`));
    assert.match(html,/polishStyles/u);assert.match(html,/contentGeometry/u);assert.match(html,/content:none!important/u);assert.match(html,/body,\.app\{overflow-x:visible!important\}/u);
    // Validate the actual serialized measurement script, including the CSS
    // color parser, before a remote browser can accept the frame as evidence.
    const inline=html.match(/<script>([\s\S]*?)<\/script>/u);assert.ok(inline);assert.doesNotThrow(()=>new Script(inline[1]));
    if(row.fixture==='launch') {
      assert.match(html,/data-launch-state="loading"/u);assert.match(html,/Открываем ваш кабинет/u);assert.match(html,/data-visual-synthetic="launch"/u);
    } else assert.doesNotMatch(html.match(/<html[^>]*>/u)[0],/data-launch-state=/u);
    if(row.fixture==='admin') {
      assert.match(html,/Синтетический макет/u);assert.match(html,/Сейчас: Всем/u);
      assert.match(html,/admin-ai-modes/u);assert.match(html,/range\.getClientRects/u);assert.match(html,/navigationContents/u);assert.doesNotMatch(html,/class="[^"]*subscription-current/u);
    }
  }
  for(const filename of ['cabinet-theme-bootstrap.js','cabinet-view.mjs','cabinet-client.mjs','partner-cabinet.css','subscription-view.css','partner-cabinet.html',
    'admin-view.mjs','admin-client.mjs','admin-cabinet.css','admin-cabinet.html'])
    assert.equal(manifest.sourceHashes[filename],sha(fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/'+filename,import.meta.url))));
  for(const row of manifest.interactionFiles) {
    const bytes=fs.readFileSync(path.join(directory,row.filename)),html=bytes.toString();
    assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);
    assert.match(html,/window\.__probeMotion/u);assert.match(html,/mountCabinet/u);assert.match(html,/mountAdminCabinet/u);
    assert.match(html,/MiniAppClient/u);assert.match(html,/AdminClient/u);assert.match(html,/motion_fixture_producer_forbidden/u);
    assert.match(html,/connect-src 'none'/u);assert.doesNotMatch(html,/<script[^>]+src=/iu);
    const inline=html.match(/<script>([\s\S]*?)<\/script>/u);assert.ok(inline);assert.doesNotThrow(()=>new Script(inline[1]));
    assert.match(row.clock,/Synthetic fixed source snapshot shared by views and clients/u);
    assert.match(inline[1],/SYNTHETIC_FIXED_SOURCE_SNAPSHOT/u);
    const alignment=inline[1].match(/Date\.now = \(\) => dto\.now \* (?:1e3|1000);/u);assert.ok(alignment);
    const isolated=runInNewContext(`${alignment[0]};({wall:Date.now(),monotonic:performance.now(),deadline:dto.subscription.authorization.validUntil})`,{
      Date:class {static now(){return 999999;}},performance:{now:()=>123.456},
      dto:{now:1791316094,subscription:{authorization:{validUntil:1791316154}}}
    });
    assert.equal(isolated.wall,1791316094000);assert.equal(isolated.monotonic,123.456);assert.equal(isolated.deadline,1791316154);
    assert.doesNotMatch(inline[1],/performance\.now\s*=|requestAnimationFrame\s*=/u);
    assert.equal(inline[1].match(/Date\.now\s*=/gu).length,1);
  }
});

test('browser proof rejects directional rays, unclipped highlights, clipped content, mislabeled refund and hidden choices',()=>{
  const sections=['.subscription-current','.subscription-plans','.subscription-monthly','.subscription-history','.subscription-capacity','.subscription-preview','.subscription-payment-help','.subscription-telegram-details'].map(selector=>({selector,exists:true,visible:true,closedDetails:false}));
  const visual={...POLISH_VISUAL_CASES.find(row=>row.state==='refunded-current'),width:390,theme:'dark'};
  const report={state:visual.state,fixtureState:visual.fixture,theme:visual.theme,themeMode:'dark',selectedThemeCount:1,scrollTarget:visual.target,width:390,requestedWidth:390,height:800,dpr:1,scrollWidth:390,clientWidth:390,badTargets:[],targetRect:{height:260,bottom:290,top:30},sections,
    contentGeometry:content(390),outwardLight:light(),insideHighlight:highlights('dark'),canvas:canvas(),polishStyles:{selectedTheme:neutralTheme,selectedNavigation:selected,freeCatalogOrb:ordinary,freeOrb:ordinary},currentPlan:'free',currentStatus:'Возврат учтён',
    planLabels:[{plan:'free',price:'0 Stars',visible:true},{plan:'professional',price:'249 Stars',visible:true},{plan:'dragon',price:'499 Stars',visible:true}],receiptLabels:['Professional · 249 Stars']};
  assert.equal(verifyPolishGeometryReport(report,visual),true);
  for(const mutate of [r=>r.fixtureState='profile',r=>r.themeMode='light',r=>r.selectedThemeCount=0,r=>r.insideHighlight.selectedTheme.backgroundImage=ordinary.backgroundImage,
    r=>r.insideHighlight.selectedTheme.backgroundColor='rgb(32, 56, 76)',r=>r.polishStyles.selectedTheme.borderColor='rgb(115, 155, 187)',
    r=>r.polishStyles.selectedTheme.color='rgb(255, 255, 255)',r=>r.polishStyles.selectedTheme.boxShadow='rgba(66, 106, 212, .2) 0px 4px 10px',
    r=>r.polishStyles.selectedNavigation.backgroundImage=radial+', '+ordinary.backgroundImage,r=>r.polishStyles.selectedTheme.color='rgb(0, 0, 0)',
    r=>r.insideHighlight.selectedTheme.baseFillContrast=4.49,r=>r.polishStyles.selectedNavigation.opacity='.5',
    r=>r.outwardLight.selectedNavigation.content='""',r=>r.outwardLight.selectedTheme.backgroundImage=radial,
    r=>r.insideHighlight.selectedTheme.pointerEvents='auto',r=>r.insideHighlight.selectedTheme.left='-1px',r=>r.insideHighlight.selectedTheme.zIndex='1',
    r=>r.polishStyles.selectedTheme.overflow='visible',r=>r.insideHighlight.selectedTheme.transitionDuration='0s',r=>r.canvas.body.backgroundColor='rgb(21, 38, 56)',
    r=>r.canvas.body.backgroundImage=radial+', '+radial,
    r=>r.scrollWidth=391,r=>r.contentGeometry.scrollWidth=391,r=>r.contentGeometry.bodyScrollWidth=391,
    r=>r.contentGeometry.overflowNodes.push({rect:{right:391}}),r=>r.badTargets.push({height:20}),
    r=>r.polishStyles.freeOrb.backgroundImage='none',r=>r.currentPlan='professional',r=>r.currentStatus='Активна',r=>r.planLabels.pop(),
    r=>r.sections[0].closedDetails=true,r=>r.planLabels[1].price='248 Stars',r=>r.receiptLabels=[]]) {
    const changed=structuredClone(report);mutate(changed);assert.throws(()=>verifyPolishGeometryReport(changed,visual));
  }
  const profile={...POLISH_VISUAL_CASES.find(row=>row.state==='profile-top'),width:390,theme:'dark'};
  const profileReport={...structuredClone(report),state:profile.state,fixtureState:profile.fixture,scrollTarget:profile.target,polishStyles:{...report.polishStyles,legalSaved:ordinary}};
  assert.equal(verifyPolishGeometryReport(profileReport,JSON.parse(JSON.stringify(profile))),true);
  assert.throws(()=>verifyPolishGeometryReport(profileReport,{...profile,fixture:undefined}),/polish_fixture_binding_invalid/u);
  assert.throws(()=>verifyPolishGeometryReport(profileReport,{...profile,fixture:'current'}),/polish_fixture_binding_invalid/u);
  profileReport.polishStyles.legalSaved={...ordinary,color:'rgb(30, 60, 90)'};assert.throws(()=>verifyPolishGeometryReport(profileReport,profile));
  // The loader is the actual initial HTML/CSS. It cannot be accepted as an
  // authenticated cabinet or as a fabricated successful loading operation.
  const launch={...POLISH_VISUAL_CASES.find(row=>row.state==='partner-launch'),width:390,theme:'dark'};
  const launchReport={...structuredClone(report),state:launch.state,fixtureState:launch.fixture,scrollTarget:launch.target,
    evidenceLabel,outwardLight:light(),
    launch:{state:'loading',statusRole:'status',themeBarHidden:true,progress:'Открываем ваш кабинет',screen:{display:'flex',visibility:'visible',opacity:'1',backgroundColor:'rgb(14, 25, 44)'},brand:ordinary}};
  assert.equal(verifyPolishGeometryReport(launchReport,launch),true);
  for(const mutate of [r=>r.launch.state='ready',r=>r.launch.themeBarHidden=false,r=>r.launch.progress='Вход выполнен',
    r=>r.outwardLight.brand.content='""',r=>r.outwardLight.brand.backgroundImage=radial,r=>r.evidenceLabel.position='static']) {
    const changed=structuredClone(launchReport);mutate(changed);assert.throws(()=>verifyPolishGeometryReport(changed,launch));
  }
});

test('owner geometry requires contained navigation children, restored icons and truthful disabled states',()=>{
  const visual={...POLISH_VISUAL_CASES.find(row=>row.state==='admin-pult'),width:320,theme:'light'};
  const muted={backgroundImage:'none',boxShadow:'none',opacity:'0.6'},absentRay=noRay();
  const report={state:visual.state,fixtureState:'admin',theme:'light',themeMode:'light',selectedThemeCount:1,scrollTarget:visual.target,
    width:320,requestedWidth:320,height:800,dpr:1,scrollWidth:320,clientWidth:320,badTargets:[],targetRect:{height:102,bottom:120,top:18},
    contentGeometry:content(320),evidenceLabel,outwardLight:light(),insideHighlight:highlights(),canvas:canvas(),
    polishStyles:{selectedTheme:selected,selectedNavigation:selected,selectedAiMode:selected},
    admin:{navigationContents:navigationContents(),syntheticLabel:'Синтетический макет · только просмотр',syntheticLabelInViewport:true,selectedNavigation:'settings',visibleNavigationIcons:3,visibleNavigationSvg:3,readOnlyBanner:true,
      disabledWriteCount:5,enabledWriteCount:0,aiModes:[{mode:'off',pressed:'false',disabled:true,style:muted,ray:absentRay},
        {mode:'admin',pressed:'false',disabled:true,style:muted,ray:absentRay},{mode:'all',pressed:'true',disabled:true,style:selected,ray:absentRay}]}};
  assert.equal(verifyPolishGeometryReport(report,visual),true);
  for(const mutate of [r=>r.admin.syntheticLabel=null,r=>r.admin.syntheticLabelInViewport=false,r=>r.admin.visibleNavigationIcons=0,r=>r.admin.visibleNavigationSvg=0,r=>r.admin.enabledWriteCount=1,
    r=>r.admin.readOnlyBanner=false,r=>r.admin.navigationContents.pop(),r=>r.admin.navigationContents[1].icon.left=100,
    r=>r.admin.navigationContents[1].textRects[0].right=209,r=>shiftNavigation(r.admin.navigationContents[1],-60),
    r=>{const row=r.admin.navigationContents[1];row.textRects[0].top=215;row.textRects[0].bottom=232;},
    r=>r.admin.aiModes[2].pressed='false',r=>r.admin.aiModes[1].disabled=false,
    r=>r.admin.aiModes[0].style.backgroundImage=ordinary.backgroundImage,r=>r.admin.aiModes[0].ray.content='""',r=>r.polishStyles.selectedAiMode.cursor='pointer',
    r=>r.polishStyles.selectedAiMode.transform='matrix(1, 0, 0, 1, 0, -1)',r=>r.polishStyles.selectedAiMode.color='rgb(20, 40, 60)']) {
    const changed=structuredClone(report);mutate(changed);assert.throws(()=>verifyPolishGeometryReport(changed,visual));
  }
});

test('actual listener evidence requires intermediate crossfade, stable nodes, last selection, read-only refresh and instant reduced motion',async()=>{
  const sample=(opacity,key='profile',selected=opacity===1,reduced=false)=>({key,selected,opacity,transitionDuration:reduced?'0s':'0.22s',transitionProperty:'opacity',rect:box(20,200,100,54),overflow:'hidden',inset:['0px','0px','0px','0px'],position:'absolute',zIndex:'-1',pointerEvents:'none',rayContent:'none',rayBackground:'none'});
  const pair=(old,next,reduced)=>({old:sample(old,'profile',false,reduced),next:sample(next,'subscription',true,reduced)});
  const report=(reduced=false)=>({scope:'partner',requestedWidth:390,width:390,height:800,dpr:1,reducedMotion:reduced,
    fixtureClock:{mode:'SYNTHETIC_FIXED_SOURCE_SNAPSHOT',sourceEpochMs:1791316094000,dateNowMs:1791316094000,hostEpochMsBeforeAlignment:1791319999000,
      sessionExpiresAt:1791316394,subscriptionValidUntil:1791316154,performanceClock:'ACTUAL_BROWSER_MONOTONIC_UNCHANGED',monotonicNowMs:123.456},
    home:'profile',other:'subscription',themeBefore:pair(1,0,reduced),themeStart:pair(reduced?0:1,reduced?1:0,reduced),themeMid:pair(reduced?0:.4,reduced?1:.6,reduced),themeEnd:pair(0,1,reduced),
    navBefore:pair(1,0,reduced),navStart:pair(reduced?0:1,reduced?1:0,reduced),navMid:pair(reduced?0:.4,reduced?1:.6,reduced),navEnd:pair(0,1,reduced),
    stableAfterNavigate:true,stableAfterRapidClicks:true,stableAfterRefresh:true,stableThemeButtons:true,lastNavigation:['profile'],finalNavigation:['profile'],
    finalTheme:'dark',savedTheme:'dark',remountedTheme:'dark',selectedThemeCount:1,refreshReadCount:1,writeControlsEnabled:0,
    calls:[{path:'/api/v1.4.0/cabinet/session',method:'POST'},{path:'/api/v1.4.0/cabinet/profile',method:'GET'}],
    initialGeometry:[box(20,200,100,54)],finalGeometry:[box(20,200,100,54)],finalButtons:[sample(1,'profile',true,reduced),sample(0,'subscription',false,reduced)],
    finalThemeButtons:[sample(1,'dark',true,reduced),sample(0,'system',false,reduced)],scrollWidth:390,clientWidth:390});
  assert.equal(verifyPolishInteractionReport(report(),{fixture:'partner',width:390,reducedMotion:false}),true);
  assert.equal(verifyPolishInteractionReport(report(true),{fixture:'partner',width:390,reducedMotion:true}),true);
  for(const mutate of [r=>r.scope='admin',r=>r.stableAfterNavigate=false,r=>r.stableAfterRapidClicks=false,r=>r.stableAfterRefresh=false,
    r=>r.fixtureClock.dateNowMs+=1000,r=>r.fixtureClock.subscriptionValidUntil=1791316000,r=>r.fixtureClock.sessionExpiresAt+=1,
    r=>r.fixtureClock.performanceClock='SYNTHETIC_FIXED',r=>r.fixtureClock.monotonicNowMs=-1,
    r=>r.stableThemeButtons=false,r=>r.lastNavigation=['subscription'],r=>r.finalTheme='light',r=>r.savedTheme='light',r=>r.remountedTheme='light',r=>r.selectedThemeCount=2,
    r=>r.refreshReadCount=0,r=>r.writeControlsEnabled=1,r=>r.calls.push({path:'/api/v1.4.0/cabinet/subscription/cancel',method:'POST'}),
    r=>r.themeMid.next.opacity=1,r=>r.navMid.old.opacity=0,r=>r.navEnd.next.opacity=.9,r=>r.themeStart.old.inset[0]='-1px',
    r=>r.navMid.next.overflow='visible',r=>r.navMid.next.transitionDuration='0.1s',r=>r.finalButtons[1].opacity=.2,r=>r.finalThemeButtons[0].rayContent='""',r=>r.finalGeometry[0].top=201]) {
    const changed=report();mutate(changed);assert.throws(()=>verifyPolishInteractionReport(changed,{fixture:'partner',width:390,reducedMotion:false}));
  }
  const animatedReduced=report(true);animatedReduced.navMid.next.opacity=.6;
  assert.throws(()=>verifyPolishInteractionReport(animatedReduced,{fixture:'partner',width:390,reducedMotion:true}),/polish_interaction_reduced_motion_animated/u);
  const jumped=report(),observed=await observePolishCrossfade(()=>jumped.navEnd,{
    start:jumped.navStart,reducedMotion:false,now:()=>0,nextFrame:async()=>{},maxFrames:2
  });
  jumped.navMid=observed.sample;
  assert.equal(observed.observed,false);
  assert.throws(()=>verifyPolishInteractionReport(jumped,{fixture:'partner',width:390,reducedMotion:false}),/polish_interaction_crossfade_missing/u);
});
