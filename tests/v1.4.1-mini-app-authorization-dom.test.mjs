import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mountCabinet } from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import { readAuthorizationDTO } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';

const requireDom=createRequire(process.env.CABINET_UI_DOM_ROOT
  ? `${process.env.CABINET_UI_DOM_ROOT}/package.json`:new URL('./p08-ui/package.json',import.meta.url));
const {parseHTML}=requireDom('linkedom');
const html=await readFile(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html',import.meta.url),'utf8');
const now=1_791_000_000;
const decision=(used,allowed)=>readAuthorizationDTO({version:1,capability:'offer.create_private',allowed,
  reasonCode:allowed?'allowed':'quota_exceeded',policyVersion:'2026-10-02.v1.4.1.policy-proposal.1',
  effectivePlan:'preview',accessState:'trial',validUntil:now+300,
  quota:{limit:3,used,remaining:Math.max(0,3-used),resetsAt:null,scope:'own_partner_profile'},
  actionPolicy:allowed?'allow':'beta_cap'},'offer.create_private');
function fixture(t,{used=2,allowed=true,paused=false}={}) {
  const {document,window}=parseHTML(html);
  // This verifies rendered DOM and controls, not browser layout or Telegram UI.
  window.HTMLElement.prototype.focus=function(){};
  window.HTMLElement.prototype.reportValidity=function(){return true;};
  const profile={readModelVersion:1,generatedAt:now,systemRole:'partner',
    account:{memberSince:'2026-08-01 10:00:00',generalTermsAccepted:true},
    access:{status:'resolved',planCode:'free',planName:'Free',planMarker:'neutral',accessState:'trial',
      accessOverlay:'dragon_preview',reviewRequired:false,paidCapabilitiesEnabled:true,readPath:'canonical'},
    partner:{state:paused?'paused_partner':'active_partner',
      application:{status:'approved',displayName:'Партнёр',ageConfirmed:true},
      profile:{partnerId:'RE-P000011',displayName:'Партнёр',status:paused?'paused':'active',telegramUsername:'',publicUsernameEnabled:false},
      legalProfile:{profileKind:'individual',verificationState:'self_declared',revision:1},
      beta:{accessStatus:'active',expired:false,canCreatePrivateOffers:!paused,canSubmitOffers:!paused},
      actions:{submitApplication:false,declareLegalProfile:!paused,manageOffers:!paused,contactSupport:false}},
  };
  const item={scope:'own',code:'partner_offer',version:2,visibility:'private',businessStatus:'active',
    moderationStatus:'changes_requested',canEdit:true,canSubmit:true,
    content:{title:'Существующий оффер',buttonText:'Открыть',provider:'Банк',category:'debit',description:'Условия',
      minAge:18,maxAge:null,holdDays:14,startsAt:'2026-09-29 12:30:00',expiresAt:'2026-12-31 20:00:00'}};
  const client={canMutate:true,canOpenOffers:true,uncertain:false,authenticated:true,expiresAt:Date.now()/1000+300,
    clearSession(){this.authenticated=false;},
    async read(resource,params={}) {
      if(resource==='bootstrap')return{...profile,navigation:['profile','offers','applications','analytics','subscription'].map(section=>({section,enabled:true})),
        counts:{visibleOffers:1,ownOffers:1,ownApplications:0,attributedApplications:0}};
      if(resource==='offers')return{readModelVersion:1,collection:'offers',view:params.view,items:params.view==='mine'?[item]:[],nextCursor:null,
        ...(params.view==='mine'?{decisions:{'offer.create_private':decision(used,allowed)}}:{})};
      if(resource==='profile')return profile;
      throw new Error('unexpected_resource');
    },
    async mutate(){throw new Error('unexpected_mutation');},
  };
  const app=mountCabinet({document,client});t.after(()=>app.destroy());
  return{app,document,text:()=>document.querySelector('#screen').textContent,
    button:label=>[...document.querySelectorAll('#screen button')].find(node=>node.textContent===label)};
}
test('owned offer screen renders the server Beta ceiling and remaining slots in the existing layout',async t=>{
  const f=fixture(t);await f.app.start();await f.app.navigate('offers',{view:'mine'});
  assert.match(f.text(),/Офферы: 2 из 3\. Осталось 1\./u);
  assert.ok(f.button('Создать приватный черновик'));assert.ok(f.button('Редактировать'));
});
test('at the server create ceiling existing offer editing stays visible and uses its own form',async t=>{
  const f=fixture(t,{used:3,allowed:false});await f.app.start();await f.app.navigate('offers',{view:'mine'});
  assert.match(f.text(),/Использовано 3 из 3; осталось 0/u);
  assert.equal(f.button('Создать приватный черновик'),undefined);
  assert.ok(f.button('Редактировать'));f.button('Редактировать').click();
  assert.equal(f.document.querySelector('[name="title"]').value,'Существующий оффер');
});
test('a paused partner can select exact own history while growth and editing remain closed',async t=>{
  const f=fixture(t,{allowed:false,paused:true});await f.app.start();await f.app.navigate('offers',{view:'mine'});
  assert.ok(f.button('Мои офферы'));assert.match(f.text(),/Существующий оффер/u);
  assert.equal(f.button('Создать приватный черновик'),undefined);assert.equal(f.button('Редактировать'),undefined);
});
