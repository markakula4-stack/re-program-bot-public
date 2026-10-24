// Fictional presentation data only. It is not a financial proof or test of Telegram.
export function subscriptionUIFixture({ state='active',billingMode='recurring',paid=true,now=Math.floor(Date.now()/1000) }={}) {
  const end=now+2592000,closed=['refunded','chargeback','suspended'].includes(state),live=paid&&!closed&&state!=='expired';
  const periodEnd=state==='expired'?now-1:end;
  const current={planCode:live?'professional':'free',accessState:live?state:'none',accessOverlay:'none',status:'verified',reasonCode:'verified',
    sourceKind:live?'stars':'free',startsAt:live?now-200:null,expiresAt:live?end:null,remainingSeconds:live?2592000:null,
    durationKind:live?'finite':'free_unlimited',activeDragon:false,previewActive:false};
  const lifecycle={schemaVersion:1,state,renewalState:billingMode==='prepaid'?'not_applicable':state==='cancel_at_period_end'?'canceled':state==='payment_failed'?'failed':'unknown',
    paidAccess:live,subscriptionId:'11111111-1111-4111-8111-111111111111',planCode:'professional',billingMode,startsAt:now-200,paidUntil:periodEnd,
    accessUntil:live?end:null,contractId:billingMode==='recurring'?'22222222-2222-4222-8222-222222222222':null,
    reasonCode:'verified_paid_period',reviewRequired:false,reviewReasons:[],graceSeconds:0,gracePolicyVersion:'zero',pendingOperations:0,nextChargeAt:null};
  const receipt={receiptId:'stars-'+'a'.repeat(24),planCode:'professional',amountStars:249,currency:'XTR',occurredAt:now-200,status:'paid',
    billingMode,paidPeriod:{startsAt:now-200,endsAt:end},reviewRequired:false};
  return {readModelVersion:1,authority:'worker',observedAt:now,
    access:{current,lifecycle,sessionExpiresAt:now+300,preview:{historyUsed:false,canRequestActivation:false,reasonCode:'preview_access_conflict',durationSeconds:604800,oneTime:true},
      ownerException:{applies:false,source:null,isPaidPlan:false}},lifecycle,
    renewalActions:{contractId:lifecycle.contractId,expectedRevision:1,renewalState:lifecycle.renewalState,pendingOperations:0,
      cancel:{available:billingMode==='recurring',route:'/subscription/renewal/cancel'},enable:{available:billingMode==='recurring'&&state==='cancel_at_period_end',route:'/subscription/renewal/enable'},actionAdmissionRequired:true},
    history:{version:1,authority:'worker',accessAuthority:false,observedAt:now,available:true,reasonCode:null,items:[{...receipt,receipt}],hasMore:false,limit:20},
    quotas:{actionAdmissionRequired:true,quotas:['active_applications','own_working_offers','active_campaigns'].map((key,i)=>({key,used:[9,2,0][i],limit:[25,5,10][i],remaining:[16,3,10][i],planLimit:[25,5,10][i],betaLimit:null,status:'available',restrictions:[],actionAdmissionRequired:true}))},
    catalog:{offers:['free','professional','dragon'].map((planCode,i)=>({planCode,published:true,amountStars:[0,249,499][i],priceVersion:i?1:null,accessSeconds:i?2592000:null,
      purchaseEligibility:{eligible:!!i,reasonCode:i?'eligible':'free_plan_no_purchase',mode:'new_period'},checkout:i?{available:true,url:`https://t.me/RE_Program_Bot?start=subscribe_${planCode}`}:null})),
      termsRevision:'2026-09-10.stars-v1',terms:{available:true,revision:'2026-09-10.stars-v1',accepted:true,text:'Разовая предоплата. Возврат рассматривается по обстоятельствам.'},
      support:{url:'https://t.me/RE_Program_Support_Bot?start=paysupport'},
      comparison:{version:1,authority:'worker',publishedPolicyOnly:true,grantsRoles:false,rows:['active_applications','own_working_offers','active_campaigns'].map((key,i)=>({key,limits:{free:[5,1,2][i],professional:[25,5,10][i],dragon:[50,10,20][i]}})),support:{basic:'included',paymentHelp:'included'}},
      recurring:{enabled:true,ready:true,billingMode:'recurring',periodSeconds:2592000,automaticRenewal:true,priceVersion:1,
        terms:{revision:'2026-10-03.stars-recurring-v1',available:true,accepted:false,scope:'stars_purchase',explicitConsentRequired:true,
          text:'Подписка продлевается автоматически каждые 30 дней. Будущие продления можно отменить; уже оплаченный срок сохраняется.'},
        offers:['professional','dragon'].map((planCode,i)=>({planCode,amountStars:[249,499][i],currency:'XTR',priceVersion:1,termsRevision:'2026-10-03.stars-recurring-v1',
          accessSeconds:2592000,billingMode:'recurring',recurringConsentRequired:true,purchaseEligibility:{eligible:true,reasonCode:'eligible'},
          checkout:{available:true,kind:'authenticated_own_post',route:'/subscription/recurring-invoice',actionAdmissionRequired:true}}))},
      nativeDependencies:{referralShare:{available:false,reasonCode:'referral_partner_required',ownUrl:null},dragonEmoji:{available:false,reasonCode:'active_dragon_required',customEmojiId:null}}}};
}
