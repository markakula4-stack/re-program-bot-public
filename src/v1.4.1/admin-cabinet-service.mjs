import {authorityError,hasRole} from '../v1.4.0-rebuild/cabinet-authority.mjs';
import {canonicalCabinetOwnerId,loadCabinetWindowActor} from '../v1.4.0-rebuild/cabinet-participants.mjs';
import {readAdminAuxiliarySection} from './admin-cabinet-management.mjs';
import {projectAdminPartnerOffer,OFFER_CATEGORIES} from '../v1.4.0-rebuild/offer-lifecycle.mjs';
import {sha256Hex} from '../v1.4.0-rebuild/mini-app-security.mjs';
import {publicReleaseVersion} from '../v1.4.0-rebuild/release-presentation.mjs';

const prefix='/api/v1.4.0/cabinet/admin/';
const statuses=Object.freeze({
  partners:['pending','approved','rejected','all'],
  offers:['pending','approved','changes_requested','rejected','not_submitted','all'],
});
const sections=new Set(['overview','partners','offers','users','settings','support','journal']);
const integer=(value,min,max)=>/^(?:0|[1-9][0-9]*)$/u.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>=min&&Number(value)<=max;
export function resolveAdminCabinetRoute({method,url}) {
  const parsed=new URL(url),path=parsed.pathname;
  if(!path.startsWith(prefix)) return null;
  if(parsed.hash||parsed.username||parsed.password) authorityError('invalid_request',400);
  if(method==='GET') {
    const detail=/^support\/tickets\/([1-9][0-9]*)$/u.exec(path.slice(prefix.length));
    const offerDetail=/^offers\/([a-z0-9_-]{3,24})$/u.exec(path.slice(prefix.length));
    const section=detail?'support':offerDetail?'offers':path.slice(prefix.length);
    if(!sections.has(section)||detail&&!Number.isSafeInteger(Number(detail[1]))) authorityError('not_found',404);
    const values=Object.create(null);
    for(const [key,value] of parsed.searchParams) {
      if(Object.hasOwn(values,key)) authorityError('invalid_request',400);
      values[key]=value;
    }
    if(offerDetail) {
      if(Object.keys(values).length!==1||!Object.hasOwn(values,'expectedVersionId')||
          !integer(values.expectedVersionId,1,Number.MAX_SAFE_INTEGER)) authorityError('invalid_request',400);
      return {kind:'read',section:'offers',offerDetail:true,
        params:{code:offerDetail[1],expectedVersionId:Number(values.expectedVersionId)}};
    }
    if(detail) {
      const limit=values.limit??'20',before=values.beforeMessageId??'0';
      if(Object.keys(values).some(key=>!['limit','beforeMessageId'].includes(key))||!integer(limit,1,25)||
          !integer(before,0,Number.MAX_SAFE_INTEGER)) authorityError('invalid_request',400);
      return {kind:'read',section:'support',supportAction:'ticket',params:{ticketId:Number(detail[1]),limit:Number(limit),before:Number(before)}};
    }
    if(['overview','settings'].includes(section)) {
      if(Object.keys(values).length) authorityError('invalid_request',400);
      return {kind:'read',section,params:{}};
    }
    if(Object.keys(values).some(key=>!['limit','offset','status','query'].includes(key)) ||
        values.status!==undefined&&!['partners','offers','users','support'].includes(section) ||
        values.query!==undefined&&section!=='users') authorityError('invalid_request',400);
    const limit=values.limit??'20',offset=values.offset??'0';
    if(!integer(limit,1,25)||!integer(offset,0,100000)) authorityError('invalid_request',400);
    const params={limit:Number(limit),offset:Number(offset)};
    if(statuses[section]) {
      params.status=values.status??'pending';
      if(!statuses[section].includes(params.status)) authorityError('invalid_request',400);
    } else if(section==='support') {
      params.status=values.status??'open';
      if(!['open','waiting','closed'].includes(params.status)||params.offset>1000) authorityError('invalid_request',400);
    } else if(values.status!==undefined) params.status=values.status;
    if(values.query!==undefined) {
      if(values.query.length>80) authorityError('invalid_request',400);
      params.query=values.query;
    }
    return {kind:'read',section,params};
  }
  if(method!=='POST' || parsed.search) authorityError('not_found',404);
  const partner=/^partners\/([1-9][0-9]*)\/review$/u.exec(path.slice(prefix.length));
  if(partner && Number.isSafeInteger(Number(partner[1]))) return {kind:'write',action:'admin.partner.review',target:{applicationId:Number(partner[1])}};
  const offer=/^offers\/([a-z0-9_-]{3,24})\/(moderation|visibility)$/u.exec(path.slice(prefix.length));
  if(offer) return {kind:'write',action:offer[2]==='moderation'?'admin.offer.moderate':'admin.offer.visibility',target:{code:offer[1]}};
  const user=/^users\/([1-9][0-9]*)\/moderation$/u.exec(path.slice(prefix.length));
  if(user&&Number.isSafeInteger(Number(user[1]))) return {kind:'write',action:'admin.user.moderation',target:{telegramId:Number(user[1])}};
  if(path===prefix+'settings') return {kind:'write',action:'admin.settings.update',target:{}};
  const support=/^support\/tickets\/([1-9][0-9]*)\/(reply|close)$/u.exec(path.slice(prefix.length));
  if(support&&Number.isSafeInteger(Number(support[1]))) return {kind:'write',action:'admin.support.'+support[2],target:{ticketId:Number(support[1])}};
  authorityError('not_found',404);
}
const text=(value,max=300)=>typeof value==='string'?value.slice(0,max):'';
const count=row=>{
  if(!Number.isSafeInteger(row?.n)||row.n<0) authorityError('storage_unavailable',503);
  return row.n;
};
const page=(items,total,params)=>({items,total,limit:params.limit,offset:params.offset,hasMore:params.offset+items.length<total});
const detailTextFields=Object.freeze({buttonText:[1,60],title:[1,180],description:[0,1200],provider:[0,120],
  payoutText:[0,200],requiredAction:[0,500],geo:[0,160],trafficSources:[0,500],sourceName:[0,160]});
const contentFields=Object.freeze([...Object.keys(detailTextFields),'category','minAge','maxAge','holdDays','startsAt','expiresAt']);
const snake=field=>field.replace(/[A-Z]/gu,letter=>'_'+letter.toLowerCase());
const snapshotDate=value=>{
  if(value===null)return true;
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/u.test(value))return false;
  const parsed=Date.parse(value.replace(' ','T')+'Z');
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,19).replace('T',' ')===value;
};
async function capturedOfferContent(version,projection) {
  if(version.snapshotSchemaVersion!==1||typeof version.snapshotJson!=='string'||
      version.contentHash!=='sha256:'+await sha256Hex(version.snapshotJson)) authorityError('state_conflict',409);
  let snapshot;
  try{snapshot=JSON.parse(version.snapshotJson);}catch{authorityError('state_conflict',409);}
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)||snapshot.code!==projection.code||
      snapshot.status!==projection.businessStatus) authorityError('state_conflict',409);
  // Return only captured content fields, never the snapshot's route URL,
  // tracking key, catalogue IDs, raw JSON or integrity hash.
  const content=Object.fromEntries(contentFields.map(field=>[field,snapshot[snake(field)]]));
  for(const [field,[min,max]] of Object.entries(detailTextFields)) {
    const value=content[field],length=typeof value==='string'?Array.from(value).length:-1;
    if(typeof value!=='string'||length<min||length>max||value.normalize('NFKC').trim()!==value||/\p{Cc}/u.test(value)) authorityError('state_conflict',409);
  }
  if(!OFFER_CATEGORIES.includes(content.category)) authorityError('state_conflict',409);
  for(const [field,max] of [['minAge',100],['maxAge',100],['holdDays',3650]]) {
    const value=content[field];
    if(value!==null&&(!Number.isSafeInteger(value)||value<0||value>max)) authorityError('state_conflict',409);
  }
  if(!snapshotDate(content.startsAt)||!snapshotDate(content.expiresAt)||
      content.minAge!==null&&content.maxAge!==null&&content.minAge>content.maxAge||
      content.startsAt!==null&&content.expiresAt!==null&&content.startsAt>=content.expiresAt||
      contentFields.some(field=>content[field]!==projection.content[field])) authorityError('state_conflict',409);
  return content;
}

export function createAdminCabinetService({repo,env,context,gate,nowSeconds,runtime}) {
  const owner=canonicalCabinetOwnerId(env);
  const authorizeOwner=async()=>{
    if(!owner || context?.telegramId!==owner || gate?.accessScope!=='admin' || !runtime) authorityError('admin_required');
    const actor=await loadCabinetWindowActor({repo,env,gate,telegramId:owner,nowSeconds});
    if(!hasRole(actor,'admin')) authorityError('admin_required');
    return actor;
  };
  const total=async(sql,params=[])=>count((await repo.readQuery(sql,params,['n']))[0]);
  const overview=async()=>{
    const names=['users','blocked_users','pending_partners','active_partners','pending_offers','approved_offers','pending_leads','confirmed_leads'];
    const rows=await repo.readQuery(`SELECT 
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM user_moderation_blocks WHERE status='active') AS blocked_users,
      (SELECT COUNT(*) FROM partner_applications WHERE status='pending') AS pending_partners,
      (SELECT COUNT(*) FROM partner_profiles WHERE status='active') AS active_partners,
      (SELECT COUNT(*) FROM offer_visibility_rules r JOIN offer_owners own ON own.offer_code=r.offer_code AND own.owner_kind='partner' WHERE r.moderation_status='pending') AS pending_offers,
      (SELECT COUNT(*) FROM offer_visibility_rules r JOIN offer_owners own ON own.offer_code=r.offer_code AND own.owner_kind='partner' WHERE r.moderation_status='approved') AS approved_offers,
      (SELECT COUNT(*) FROM lead_requests WHERE status='pending') AS pending_leads,
      (SELECT COUNT(*) FROM lead_requests WHERE status='confirmed') AS confirmed_leads`,[],names);
    if(rows.length!==1) authorityError('storage_unavailable',503);
    const counts=Object.fromEntries(names.map(name=>{
      const key=name.replace(/_([a-z])/gu,(_,letter)=>letter.toUpperCase()),value=rows[0][key];
      if(!Number.isSafeInteger(value)||value<0) authorityError('storage_unavailable',503);
      return [key,value];
    }));
    const settings=await repo.one('partner_beta_settings','id=1');
    if(!settings) authorityError('storage_unavailable',503);
    return {counts,release:{version:publicReleaseVersion(),revision:Number(env.REBUILD_V140_RELEASE_REVISION),
      mode:env.V141_RELEASE_MODE??'enabled',partnerBetaEnabled:settings.enabled===1&&env.PARTNER_BETA_ENABLED==='true'}};
  };
  const partners=async params=>{
    const where=params.status==='all'?'1=1':'a.status=?',bound=params.status==='all'?[]:[params.status];
    const size=await total(`SELECT COUNT(*) AS n FROM partner_applications a WHERE ${where}`,bound);
    const rows=await repo.readQuery(`SELECT a.id AS application_id,a.telegram_id,a.display_name,a.contact,a.age_confirmed,a.status,
      a.submitted_at AS created_at,a.updated_at,p.id AS partner_profile_id,p.status AS profile_status
      FROM partner_applications a LEFT JOIN partner_profiles p ON p.application_id=a.id
      WHERE ${where} ORDER BY a.updated_at DESC,a.id DESC LIMIT ? OFFSET ?`,[...bound,params.limit,params.offset],
      ['application_id','telegram_id','display_name','contact','age_confirmed','status','created_at','updated_at','partner_profile_id','profile_status']);
    return page(rows.map(row=>({applicationId:row.applicationId,displayName:text(row.displayName,80),contact:text(row.contact,120),
      ageConfirmed:row.ageConfirmed===1,status:row.status,createdAt:row.createdAt,updatedAt:row.updatedAt,
      partnerProfileId:row.partnerProfileId,profileStatus:row.profileStatus,canReview:row.telegramId!==owner&&row.status==='pending'})),size,params);
  };
  const offers=async params=>{
    const where=params.status==='all'?'1=1':'r.moderation_status=?',bound=params.status==='all'?[]:[params.status];
    const joins=`FROM offers o JOIN offer_owners own ON own.offer_code=o.code AND own.owner_kind='partner'
      JOIN offer_visibility_rules r ON r.offer_code=o.code JOIN offer_versions v ON v.id=r.current_version_id AND v.offer_code=o.code
      JOIN partner_profiles p ON p.id=own.partner_profile_id`;
    const size=await total(`SELECT COUNT(*) AS n ${joins} WHERE ${where}`,bound);
    const beta=await repo.one('partner_beta_settings','id=1');
    const rows=await repo.readQuery(`SELECT o.code,o.title,o.provider,o.status AS business_status,r.moderation_status,r.visibility,
      v.version_number AS version,v.id AS expected_version_id,p.id AS owner_profile_id,p.display_name AS owner_name,p.telegram_id AS owner_telegram_id,o.updated_at
      ${joins} WHERE ${where} ORDER BY o.updated_at DESC,o.code LIMIT ? OFFSET ?`,[...bound,params.limit,params.offset],
      ['code','title','provider','business_status','moderation_status','visibility','version','expected_version_id','owner_profile_id','owner_name','owner_telegram_id','updated_at']);
    return page(rows.map(row=>({code:row.code,title:text(row.title,160),provider:text(row.provider,120),businessStatus:row.businessStatus,
      moderationStatus:row.moderationStatus,visibility:row.visibility,version:row.version,expectedVersionId:row.expectedVersionId,
      ownerProfileId:row.ownerProfileId,ownerName:text(row.ownerName,80),updatedAt:row.updatedAt,
      canModerate:row.ownerTelegramId!==owner&&row.moderationStatus==='pending',canChangeVisibility:row.ownerTelegramId!==owner&&row.moderationStatus==='approved',
      publicVisibilityEnabled:beta?.enabled===1&&beta?.publicVisibilityEnabled===1&&
        env.PARTNER_BETA_ENABLED==='true'&&env.PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED==='true'})),size,params);
  };
  const offerDetail=async(params,actor)=>{
    const {code,expectedVersionId}=params;
    const offer=await repo.one('offers','code=?',[code]);
    const ownerRow=await repo.one('offer_owners','offer_code=?',[code]);
    if(!offer||ownerRow?.ownerKind!=='partner') authorityError('not_found',404);
    const rule=await repo.one('offer_visibility_rules','offer_code=?',[code]);
    if(!rule||rule.currentVersionId!==expectedVersionId) authorityError('state_conflict',409);
    const version=await repo.one('offer_versions','id=? AND offer_code=?',[expectedVersionId,code]);
    const profile=await repo.one('partner_profiles','id=?',[ownerRow.partnerProfileId]);
    if(!version||!profile) authorityError('state_conflict',409);
    let projection;
    try{projection=projectAdminPartnerOffer({context,...actor,offer,owner:ownerRow,currentVersion:version,visibilityRule:rule});}
    catch(error){
      if(error?.code==='admin_required'||error?.code==='actor_blocked')throw error;
      authorityError('state_conflict',409);
    }
    const content=await capturedOfferContent(version,projection),beta=await repo.one('partner_beta_settings','id=1');
    return {offer:{code,expectedVersionId,version:projection.currentVersionNumber,ownerProfileId:projection.partnerProfileId,
      ownerName:text(profile.displayName,80),businessStatus:projection.businessStatus,moderationStatus:projection.moderationStatus,
      visibility:projection.visibility,...content,allowedDecisions:projection.allowedDecisions,
      canModerate:profile.telegramId!==owner&&projection.moderationStatus==='pending',
      canChangeVisibility:profile.telegramId!==owner&&projection.moderationStatus==='approved',
      publicVisibilityEnabled:beta?.enabled===1&&beta?.publicVisibilityEnabled===1&&
        env.PARTNER_BETA_ENABLED==='true'&&env.PARTNER_OFFER_PUBLIC_VISIBILITY_ENABLED==='true'}};
  };
  const journal=async params=>{
    const size=await total('SELECT COUNT(*) AS n FROM admin_audit_log');
    // Raw audit details can contain private content and are intentionally not
    // part of this response. The panel shows genuine operation metadata only.
    const rows=await repo.readQuery(`SELECT id AS event_id,actor_id,action,entity_type,entity_id,created_at
      FROM admin_audit_log ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,[params.limit,params.offset],
      ['event_id','actor_id','action','entity_type','entity_id','created_at']);
    return page(rows.map(row=>({eventId:row.eventId,action:text(row.action,96),entityType:text(row.entityType,48),
      entityId:text(row.entityId,96),createdAt:row.createdAt,actorLabel:row.actorId===owner?'Вы':'Администратор'})),size,params);
  };
  return Object.freeze({
    async read({section,params,supportAction,offerDetail:detail}) {
      if(!sections.has(section)) authorityError('not_found',404);
      const actor=await authorizeOwner();
      let data;
      if(section==='overview') data=await overview();
      else if(section==='partners') data=await partners(params);
      else if(section==='offers') data=detail?await offerDetail(params,actor):await offers(params);
      else if(section==='journal') data=await journal(params);
      else if(section==='support') data=await runtime.supportRead(supportAction??'list',params);
      else data=await readAdminAuxiliarySection({repo,env,context,gate,nowSeconds,section,params});
      const projected={...data,readModelVersion:1,section,generatedAt:nowSeconds};
      const result=section==='support'?projected:await runtime.read(section,projected);
      await repo.assertReadFence({context,gate});
      return result;
    },
    async mutate(action,payload,target,clientKey) {
      await authorizeOwner();
      if(env.REBUILD_V140_WRITES_ENABLED!=='true') authorityError('writes_unavailable');
      if(['admin.support.reply','admin.support.close'].includes(action)) return runtime.supportMutate(action.slice('admin.support.'.length),payload,target,clientKey);
      return runtime.mutate(action,payload,target,clientKey);
    },
  });
}
