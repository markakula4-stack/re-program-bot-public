import { CAPABILITY_DEFINITIONS } from './capability-policy.mjs';

// Compiled server dispatch inventory. Selectors never carry actor, plan or
// capability authority. Confirmation screens are reads; their later domain
// writes have separate fixed entries and current-source admission.
const capabilities=new Set(CAPABILITY_DEFINITIONS.map(row=>row.capability));
const handlers=[],freeze=value=>{
  if(value && typeof value==='object' && !Object.isFrozen(value)) {
    for(const child of Object.values(value)) freeze(child);Object.freeze(value);
  }return value;
};
const add=(id,channel,pattern,capability,{effect='read',ref=null,intent=null,source='re-program-bot-worker.js',flow=null}={})=>{
  if(!capabilities.has(capability)) throw new Error('unknown_compiled_capability');
  handlers.push({id,channel,pattern,capability,effect,ref,intent,source,flow});
};
const exact=(names,capability,options={})=>{
  for(const name of names.split(' ')) add('callback.'+name,'telegram_callback',new RegExp('^'+name+'$','u'),capability,options);
};
const callback=(id,pattern,capability,options={})=>add('callback.'+id,'telegram_callback',pattern,capability,options);
const command=(names,capability,options={})=>{
  for(const name of names.split(' ')) add('command.'+name,'telegram_command',new RegExp('^/'+name+'(?:@RE_Program_Bot)?$','iu'),capability,options);
};
const own={kind:'offer_collection',key:'mine'},mine={kind:'application_collection',key:'mine'};
const admin={kind:'admin_surface',key:'cabinet'};
const codeRef=kind=>(match)=>({kind,key:match[1]});
const idRef=kind=>(match)=>({kind,key:Number(match[1])});

command('myid profile','profile.read_own');
command('menu cabinet','account.menu.read');
command('privacy','privacy.read_own');command('data','privacy.export_own');
command('delete_me','privacy.request_delete_own',{effect:'flow',flow:'privacy_delete_prepare'});
command('terms','terms.read');command('support','support.basic');command('paysupport','billing.payment_help');
command('help','help.read');command('plans','access.read_own');
command('link','referral.link.read_own');command('stats','referral.stats.read_own');
command('notifications','notification.read_own');command('applications','application.read_own',{ref:mine});
command('programs','account.menu.read',{flow:'catalog_navigation'});
command('cancel','flow.cancel_own',{effect:'flow',flow:'cancel_current'});
command('admin offers_admin admin_offers offer_help cabinet_admin cabine_admin','admin.cabinet.open',{ref:admin});
command('cabinet_offers','offer.read_own',{ref:own});
command('sync_menu','admin.settings.manage',{effect:'existing_domain',ref:{kind:'admin_surface',key:'settings'},flow:'sync_menu'});
command('analytics analytics_v139 ambassadors ambassadors_v139','admin.cabinet.open',{ref:admin,source:'src/v1.3.9/admin-analytics-product-runtime.mjs'});
command('admin_blocks admin_block','admin.cabinet.open',{ref:admin,source:'src/v1.3.8/admin-safety-chat-hotfix.mjs'});
command('ai_partner','ai.partner_draft',{effect:'flow',flow:'ai_owner_session',source:'src/v1.3.8/ai-partner-owner-worker-runtime-part5.mjs'});
add('command.start','telegram_command',/^\/start(?:@RE_Program_Bot)?(?:\s+(.{1,256}))?$/iu,'account.register',
  {effect:'existing_domain',flow:'registration_attribution',source:'re-program-bot-worker.js:6561'});
add('command.cabinet_result','telegram_command',/^\/cabinet_result(?:@RE_Program_Bot)? ([1-9][0-9]*) (confirm ([0-9]+)|mark_paid|reject (.{1,300}))$/iu,
  'admin.application.result',{effect:'atomic',ref:idRef('application'),intent:match=>({leadId:Number(match[1]),
    decision:match[2].split(' ')[0].toLowerCase(),...(match[3]===undefined?{}:{rewardKopecks:Number(match[3])}),...(match[4]===undefined?{}:{reason:match[4]})}),
    source:'src/v1.4.0-rebuild/telegram-cabinet.mjs'});
add('command.confirm','telegram_command',/^\/confirm ([1-9][0-9]*) ([a-z0-9_-]{3,24}) ([0-9]+(?:[.,][0-9]{1,2})?)$/u,'admin.result.repair',
  {effect:'existing_domain',flow:'legacy_conversion_repair',source:'re-program-bot-worker.js:25288'});
add('command.paid','telegram_command',/^\/paid ([1-9][0-9]*) ([a-z0-9_-]{3,24})$/u,'admin.result.repair',
  {effect:'existing_domain',flow:'legacy_conversion_repair',source:'re-program-bot-worker.js:25400'});
for(const name of ['offer_add','offer_set','offer_show','offer_delete']) {
  add('command.'+name,'telegram_command',new RegExp('^/'+name+'(?:@RE_Program_Bot)?(?:\\s+(.{1,2048}))?$','iu'),
    name==='offer_show'?'admin.cabinet.open':'admin.catalog.manage',
    {effect:name==='offer_show'?'read':'existing_domain',ref:admin,flow:'existing_typed_admin_command'});
}

exact('accept_terms','terms.accept',{effect:'existing_domain'});
exact('start_continue menu single_menu','account.menu.read');
exact('how_it_works single_how_it_works stats_help channel noop','help.read');
exact('check_subscription','channel.check_membership',{effect:'existing_domain'});
exact('terms','terms.read');exact('support','support.basic');exact('paysupport','billing.payment_help');
exact('privacy','privacy.read_own');exact('privacy_data','privacy.export_own');
exact('privacy_delete_ask privacy_delete_prepare','privacy.request_delete_own',{effect:'flow',flow:'privacy_delete_prepare'});
callback('privacy_delete_token',/^privacy_delete_(confirm|cancel):([A-Za-z0-9_-]{16,192})$/u,'privacy.request_delete_own',
  {effect:'existing_domain',flow:'privacy_delete_token'});
exact('dragon_preview_open stars_my_plan plans partner_beta','access.read_own');
exact('sub143:status sub143:cancel sub143:enable sub143:optin sub143:packages','access.read_own',
  {source:'src/v1.4.3/subscription-bot.mjs'});
exact('sub143:history','billing.read_history_own',{source:'src/v1.4.3/subscription-bot.mjs'});
callback('subscription_receipt',/^sub143:receipt:([0-4])$/u,'billing.read_history_own',
  {source:'src/v1.4.3/subscription-bot.mjs'});
exact('stars_buy:terms','billing.payment_help');
exact('dragon_preview_check','preview.activate_own',{effect:'existing_domain',flow:'preview_membership_activation'});
callback('stars_purchase',/^stars_(buy|accept):(professional|dragon)(?::[A-Za-z0-9_.:-]{1,96})?$/u,'billing.purchase_monthly',
  {effect:'existing_domain',flow:'stars_invoice',source:'src/v1.3.6/stars-commerce-runtime.mjs'});
exact('referral_reward_status','referral.stats.read_own');exact('referral_bonus_claim','referral.bonus.claim_own',{effect:'existing_domain'});
exact('partner_programs offers','account.menu.read',{flow:'catalog_navigation'});
callback('catalog_page',/^(?:partner_programs_page|offers_page):([0-9]{1,6})$/u,'account.menu.read',{flow:'catalog_navigation'});
callback('catalog_category',/^offers_cat:([a-z0-9_-]{1,32}):([0-9]{1,6})$/u,'account.menu.read',{flow:'catalog_navigation'});
callback('partner_program',/^partner_program:([a-z0-9_-]{2,32})$/u,'account.menu.read',{flow:'catalog_navigation'});
callback('catalog_offer',/^program_offer:([1-9][0-9]*)$/u,'offer.read_public',{ref:idRef('catalog_offer')});
callback('catalog_open',/^open_program_offer:([1-9][0-9]*)$/u,'offer.open_action',{effect:'existing_domain',ref:idRef('catalog_offer')});
callback('catalog_lead_ask',/^program_lead_ask:([1-9][0-9]*)$/u,'offer.read_public',{ref:idRef('catalog_offer')});
callback('catalog_lead_submit',/^program_lead_submit:([1-9][0-9]*)$/u,'application.create',
  {effect:'atomic',ref:idRef('catalog_offer'),flow:'canonical_application_intent'});
callback('public_offer',/^(?:custom_offer|offer):([a-z0-9_-]{3,24})$/u,'offer.read_public',{ref:codeRef('offer')});
callback('public_open',/^custom_offer_open:([a-z0-9_-]{3,24})$/u,'offer.open_action',{effect:'existing_domain',ref:codeRef('offer')});
callback('public_lead_ask',/^(?:custom_offer_lead_ask|lead_submit_ask):([a-z0-9_-]{3,24})$/u,'offer.read_public',{ref:codeRef('offer')});
callback('public_lead_submit',/^(?:custom_offer_lead_submit|lead_submit_confirm):([a-z0-9_-]{3,24})$/u,'application.create',
  {effect:'atomic',ref:codeRef('offer'),flow:'canonical_application_intent'});
exact('my_leads','application.read_own',{ref:mine});
callback('lead_view',/^lead_view:([1-9][0-9]*)$/u,'application.read_own',{ref:idRef('application')});
exact('my_link','referral.link.read_own');exact('stats','referral.stats.read_own');
exact('favorites recent_offers favorites_clear_ask recent_clear_ask','catalog.preference.read_own');
exact('favorites_clear_do recent_clear_do','catalog.preference.update_own',{effect:'existing_domain'});
callback('favorite',/^fav_(add|remove):([a-z0-9_-]{3,24})$/u,'catalog.preference.update_own',{effect:'existing_domain',flow:'visible_favorite'});
exact('notifications notifications_archive','notification.read_own');
callback('notification_page',/^notifications(?:_archive)?_page:([0-9]{1,6})$/u,'notification.read_own');
callback('notification_view',/^notification_view:([1-9][0-9]*)$/u,'notification.manage_own',{effect:'existing_domain',ref:idRef('notification')});
callback('notification_manage',/^notification_(archive|restore):([1-9][0-9]*)$/u,'notification.manage_own',
  {effect:'existing_domain',ref:match=>({kind:'notification',key:Number(match[2])})});
exact('notifications_read_all notifications_archive_read','notification.manage_own',{effect:'existing_domain',flow:'own_notification_collection'});
exact('notifications_toggle_push','notification.settings.update_own',{effect:'existing_domain'});
exact('partner partner_apply partner_age_confirm partner_contact_refresh partner_links partner_link_add','profile.read_own',{effect:'flow',flow:'partner_identity'});
exact('partner_submit','partner.apply',{effect:'atomic',flow:'canonical_partner_application'});
exact('partner_contact_update','profile.update_own',{effect:'flow',flow:'partner_contact'});
exact('partner_username_toggle','partner.public_username.update_own',{effect:'atomic',flow:'canonical_username_toggle'});
callback('partner_link_view',/^partner_link_view:([1-9][0-9]*)$/u,'partner.link.manage_own',{ref:idRef('partner_link')});
callback('partner_link_status',/^partner_link_(pause|resume|archive):([1-9][0-9]*)$/u,'partner.link.manage_own',
  {effect:'existing_domain',ref:match=>({kind:'partner_link',key:Number(match[2])})});
callback('partner_links_page',/^partner_links_page:([0-9]{1,6})$/u,'profile.read_own');
callback('partner_link_select',/^partner_link_(program|offer):([a-z0-9_-]{1,32})$/u,'partner.link.manage_own',{effect:'flow',flow:'partner_link_submission'});
exact('partner_link_submit_confirm','partner.link.manage_own',{effect:'existing_domain',flow:'partner_link_submission'});
exact('partner_link_submit_cancel po_cancel','flow.cancel_own',{effect:'flow'});
exact('po_list','offer.read_own',{ref:own});callback('po_page',/^po_page:([0-9]{1,6})$/u,'offer.read_own',{ref:own});
exact('po_new','offer.create_private',{effect:'atomic',intent:()=>({})});
callback('po_read',/^po_(?:view|preview|edit|submit_ask|archive_ask|cat):([a-z0-9_-]{3,24})$/u,'offer.read_own',{ref:codeRef('offer')});
callback('po_links',/^po_links:([a-z0-9_-]{3,24}):([0-9]{1,6})$/u,'offer.read_own',{ref:codeRef('offer')});
callback('po_field',/^poe:([a-z0-9_-]{3,24}):([a-z]{2})$/u,'offer.edit_own',{effect:'flow',ref:codeRef('offer'),flow:'canonical_offer_field'});
callback('po_link',/^pol:([a-z0-9_-]{3,24}):([1-9][0-9]*)$/u,'offer.edit_own',{effect:'atomic',ref:codeRef('offer'),flow:'canonical_offer_patch'});
callback('po_category',/^poc:([a-z0-9_-]{3,24}):([a-z]{1,32})$/u,'offer.edit_own',{effect:'atomic',ref:codeRef('offer'),flow:'canonical_offer_patch'});
callback('po_activate',/^po_ready:([a-z0-9_-]{3,24})$/u,'offer.activate_own',{effect:'atomic',ref:codeRef('offer'),flow:'current_version'});
callback('po_submit',/^po_submit:([a-z0-9_-]{3,24}):([1-9][0-9]*)$/u,'offer.submit_moderation',
  {effect:'atomic',ref:codeRef('offer'),intent:match=>({expectedVersionId:Number(match[2])})});
callback('po_archive',/^po_archive:([a-z0-9_-]{3,24})$/u,'offer.archive_own',{effect:'atomic',ref:codeRef('offer'),flow:'current_version'});

// Fixed known admin namespaces; there is no startsWith('admin_') authorization.
exact('admin_dashboard admin_analytics_v2 admin_ambassadors_v2 admin_referral_rewards admin_referral_repair_ask admin_analytics admin_sources admin_health admin_stars admin_stars_reconcile_ask admin_stars_refunds admin_ai admin_ai_sources admin_ow admin_ow_sources admin_audit admin_broadcast admin_leads admin_partners admin_pb admin_partner_links admin_offers admin_offer_help admin_offer_new','admin.cabinet.open',{ref:admin});
exact('admin_session_cancel','flow.cancel_own',{effect:'flow',flow:'admin_cancel'});
callback('admin_read_page',/^admin_(?:analytics|sources):(1|7|30|all)$/u,'admin.cabinet.open',{ref:admin});
callback('admin_lead_queue',/^admin_leads:(pending|confirmed|rejected|paid|all):([0-9]{1,6})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_partner_queue',/^admin_partners:(pending|approved|rejected|all):([0-9]{1,6})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_link_queue',/^admin_partner_links:(pending|approved|rejected|paused|archived|all):([0-9]{1,6})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_offer_queue',/^admin_poq:(pending|approved|changes_requested|rejected|not_submitted|all):([0-9]{1,6})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_offer_page',/^admin_offers_page:([0-9]{1,6})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_target_read',/^admin_(?:lead|partner|partner_profile|pbv|partner_link):([1-9][0-9]*)$/u,'admin.cabinet.open',{ref:admin});
callback('admin_partner_offer_read',/^admin_(?:pov|poh|povis|edit_menu|preview|offer|delete_request):([a-z0-9_-]{3,24})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_offer_flow',/^admin_(?:poa_ask|posv_ask|poas|poaa|edit|poar_ask):([a-z0-9_-]{3,24}):([A-Za-z0-9_:]{1,48})$/u,'admin.cabinet.open',{ref:admin,effect:'flow',flow:'canonical_admin_offer'});
callback('admin_profile_offers',/^admin_pop:([1-9][0-9]*):([0-9]{1,6})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_partner_ask',/^admin_partner_approve_ask:([1-9][0-9]*)$/u,'admin.cabinet.open',{ref:admin});
callback('admin_partner_approve',/^admin_partner_approve:([1-9][0-9]*)$/u,'admin.partner.review',
  {effect:'atomic',ref:idRef('partner_application'),intent:()=>({decision:'approve'})});
callback('admin_partner_reject',/^admin_partner_reject:([1-9][0-9]*)$/u,'admin.cabinet.open',{ref:admin,effect:'flow',flow:'canonical_partner_rejection'});
callback('admin_beta_ask',/^admin_pb(?:g|p|r|x)_ask:([1-9][0-9]*)$/u,'admin.cabinet.open',{ref:admin});
callback('admin_beta',/^admin_pb(g|p|r|x):([1-9][0-9]*)$/u,'admin.partner.beta.manage',
  {effect:'existing_domain',ref:match=>({kind:'partner_profile',key:Number(match[2])}),flow:'canonical_beta_action'});
callback('admin_offer_approve',/^admin_poa:([a-z0-9_-]{3,24}):([1-9][0-9]*)$/u,'admin.offer.moderate',
  {effect:'atomic',ref:codeRef('offer'),intent:match=>({expectedVersionId:Number(match[2]),decision:'approved'})});
callback('admin_offer_reason',/^admin_por:(c|r):([a-z0-9_-]{3,24}):([1-9][0-9]*)$/u,'admin.cabinet.open',{ref:admin,effect:'flow',flow:'canonical_offer_rejection'});
callback('admin_offer_visibility',/^admin_posv:([a-z0-9_-]{3,24}):(p|a|u):([1-9][0-9]*)$/u,'admin.offer.visibility',
  {effect:'atomic',ref:codeRef('offer'),intent:match=>({expectedVersionId:Number(match[3]),visibility:{p:'private',a:'assigned',u:'public'}[match[2]]})});
callback('admin_offer_revoke',/^admin_poar:([a-z0-9_-]{3,24}):([1-9][0-9]*):([1-9][0-9]*)$/u,'admin.offer.assign',
  {effect:'atomic',ref:codeRef('offer'),intent:match=>({targetTelegramId:Number(match[3]),expectedVersionId:Number(match[2]),action:'revoke'}),flow:'assignment_version'});
callback('admin_partner_link_ask',/^admin_partner_link_(?:approve_ask|reject):([1-9][0-9]*)$/u,'admin.cabinet.open',{ref:admin,effect:'flow'});
callback('admin_partner_link_approve',/^admin_partner_link_approve:([1-9][0-9]*)$/u,'admin.partner_link.review',{effect:'existing_domain',ref:idRef('partner_link'),intent:()=>({decision:'approve'})});
callback('admin_lead_flow',/^admin_lead_(confirm|reject|paid_ask):([1-9][0-9]*)$/u,'admin.cabinet.open',{ref:admin,effect:'flow',flow:'canonical_lead_result'});
callback('admin_lead_paid',/^admin_lead_paid_confirm:([1-9][0-9]*)$/u,'admin.application.result',
  {effect:'atomic',ref:idRef('application'),intent:match=>({leadId:Number(match[1]),decision:'mark_paid'})});
callback('admin_system_offer_write',/^admin_(?:delete_confirm|offer_status|set_category):([a-z0-9_-]{3,24})(?::([a-z_]{1,32}))?$/u,'admin.catalog.manage',
  {effect:'existing_domain',ref:codeRef('offer'),flow:'canonical_system_catalog'});
callback('admin_new_category',/^admin_new_category:([a-z]{1,32})$/u,'admin.catalog.manage',{effect:'flow',flow:'canonical_system_catalog'});
callback('admin_settings_read',/^admin_(?:ow_source|ai_mode_ask|ai_source):([A-Za-z0-9_.-]{1,96})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_settings',/^admin_(?:ow_toggle|ow_status|ow_check|ai_mode|ai_mode_confirm|ai_source_refresh|ai_source_approve|ai_source_reject):([A-Za-z0-9_:.-]{1,96})$/u,'admin.settings.manage',
  {effect:'existing_domain',ref:{kind:'admin_surface',key:'settings'},flow:'canonical_admin_settings'});
exact('admin_stars_reconcile','admin.stars.reconcile',{effect:'existing_domain',ref:{kind:'admin_surface',key:'stars_reconciliation'}});
callback('admin_stars_refund_ask',/^admin_stars_refund_ask:([0-9a-f-]{36})$/u,'admin.cabinet.open',{ref:admin});
callback('admin_stars_refund',/^admin_stars_refund_confirm:([0-9a-f-]{36})$/u,'admin.stars.refund',{effect:'existing_domain',ref:codeRef('payment'),flow:'stars_refund_confirmation'});
callback('admin_broadcast',/^admin_broadcast_(send|continue|cancel):([1-9][0-9]*)$/u,'admin.broadcast.send',
  {effect:'existing_domain',ref:{kind:'admin_surface',key:'broadcast'},flow:'canonical_broadcast'});
exact('admin_referral_repair','admin.result.repair',{effect:'existing_domain',flow:'referral_repair'});

// Optional owners remain subject to their actual sealed/runtime producers.
callback('h138_blocks_read',/^h138:(?:blocks|block:(?:new|cancel|view:[1-9][0-9]*)|unblock:ask:[1-9][0-9]*:[1-9][0-9]*)$/u,'admin.cabinet.open',{ref:admin,source:'src/v1.3.8/admin-safety-chat-hotfix.mjs'});
callback('h138_blocks_write',/^h138:(?:block:confirm|unblock:ok:([1-9][0-9]*):([1-9][0-9]*))$/u,'admin.user.moderation',{effect:'existing_domain',flow:'canonical_moderation',source:'src/v1.3.8/admin-safety-chat-hotfix.mjs'});
callback('h138_ai_read',/^h138:ai(?::deepseek)?$/u,'admin.cabinet.open',{ref:admin,source:'src/v1.3.8/admin-safety-chat-hotfix.mjs'});
callback('h138_ai_start',/^h138:ai:(?:qwen|deepseek:ok)$/u,'ai.partner_draft',{effect:'existing_domain',flow:'ai_owner_session',source:'src/v1.3.8/admin-safety-chat-hotfix.mjs'});
callback('h138_ai_clear',/^h138:ai:clear$/u,'ai.memory.clear_own',{effect:'existing_domain',flow:'ai_owner_session'});
callback('h138_ai_revoke',/^h138:ai:revoke$/u,'ai.consent.manage_own',{effect:'existing_domain',flow:'ai_owner_session'});
callback('h138_ai_exit',/^h138:ai:exit$/u,'flow.cancel_own',{effect:'existing_domain',flow:'ai_owner_session'});
exact('ai_hub','ai.settings.update_own');exact('ai_consent','ai.consent.manage_own');
exact('ai_consent_accept ai_consent_revoke','ai.consent.manage_own',{effect:'existing_domain'});
exact('ai_memory_clear_ask','ai.memory.read_own');exact('ai_memory_clear_do','ai.memory.clear_own',{effect:'existing_domain'});
exact('ai_enable ai_disable','ai.settings.update_own',{effect:'existing_domain'});
callback('analytics_product',/^a139r:([ofrdpabcmx]):([0-9a-z]+):([0-9a-z]+):([0-9a-f]{24})$/u,'admin.cabinet.open',{ref:admin,source:'src/v1.3.9/admin-analytics-product-runtime.mjs'});
callback('sealed_cabinet',/^r14:(pa|pr|bg|oa|op|om|or|ov):([a-z0-9_-]{1,24}):([0-9a-z]{1,8}):([0-9a-z]{1,8}):([A-Za-z0-9_-]{16})$/u,
  'admin.cabinet.open',{effect:'sealed',flow:'verified_r14',source:'src/v1.4.0-rebuild/telegram-cabinet.mjs'});

export const TELEGRAM_HANDLER_REGISTRY=freeze(handlers.map(({pattern,ref,intent,...row})=>({...row,selector:pattern.source})));
export function resolveTelegramHandler(update) {
  const callback=update?.callback_query;
  const channel=callback?'telegram_callback':'telegram_command';
  const value=callback?.data ?? update?.message?.text;
  if(typeof value!=='string' || value.length>(callback?64:4096)) return null;
  const normalized=callback?value:value.trim();
  for(const row of handlers) {
    if(row.channel!==channel) continue;
    const match=row.pattern.exec(normalized);if(!match) continue;
    const ref=typeof row.ref==='function'?row.ref(match):row.ref;
    const intent=row.intent?row.intent(match):null;
    if(ref?.key && typeof ref.key==='number' && !Number.isSafeInteger(ref.key)) return null;
    return freeze({id:row.id,channel,capability:row.capability,effect:row.effect,resourceRef:ref,
      requestPayload:intent,flow:row.flow,source:row.source,selector:normalized});
  }
  return null;
}
