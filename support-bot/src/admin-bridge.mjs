import {config} from './worker.mjs';
import {readSupportAdminBridgeConfiguration} from './admin-bridge-config.mjs';
import {prepareSupportAdminBridge,supportAdminBridgeSchemaStatus} from './admin-bridge-migration.mjs';

const PATH='/internal/re-admin-support/v1',BODY_LIMIT=32768;
const pendingResponses=new WeakSet();
const enc=new TextEncoder();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const positive=value=>Number.isSafeInteger(value)&&value>0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const statement=(db,q,...args)=>db.prepare(q).bind(...args);
const first=(db,q,...args)=>statement(db,q,...args).first();
const all=async(db,q,...args)=>(await statement(db,q,...args).all()).results;
const result=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export const supportBridgeNeedsDrain=response=>pendingResponses.has(response);
export async function supportBridgeSignature(key,time,requestId,body) {
  const material=Uint8Array.from(key.match(/../gu),hex=>parseInt(hex,16));
  const cryptoKey=await crypto.subtle.importKey('raw',material,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,enc.encode(`re-support-admin/v1\n${time}\n${requestId}\n${body}`))),b=>b.toString(16).padStart(2,'0')).join('');
}
async function bodyText(request) {
  if(!/^application\/json(?:;|$)/iu.test(request.headers.get('Content-Type')??''))fail('invalid_content_type',415);
  if(!request.body)fail('invalid_request');
  const reader=request.body.getReader(),chunks=[];let length=0;
  for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>BODY_LIMIT){await reader.cancel();fail('invalid_request');}chunks.push(next.value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
async function authenticate(request,env,now,configuration) {
  const time=request.headers.get('X-RE-Bridge-Time'),requestId=request.headers.get('X-RE-Bridge-Request'),signature=request.headers.get('X-RE-Bridge-Signature');
  if(!/^[1-9][0-9]{9}$/u.test(time??'')||Math.abs(now-Number(time))>30||!/^[a-f0-9-]{36}$/u.test(requestId??'')||!/^[a-f0-9]{64}$/u.test(signature??''))fail('not_found',404);
  const body=await bodyText(request),expected=await supportBridgeSignature(configuration.key,time,requestId,body);
  let difference=0;for(let i=0;i<64;i++)difference|=signature.charCodeAt(i)^expected.charCodeAt(i);if(difference!==0)fail('not_found',404);
  let envelope;try{envelope=JSON.parse(body);}catch{fail('invalid_request');}
  if(!exact(envelope,['sourceSha','actorId','sessionHash','issuedAt','expiresAt','action','params'])||envelope.sourceSha!==configuration.sourceSha||envelope.actorId!==configuration.ownerId||String(envelope.actorId)!==String(env.SUPPORT_ADMIN_ID)||!/^[a-f0-9]{64}$/u.test(envelope.sessionHash??'')||envelope.issuedAt!==Number(time)||!Number.isSafeInteger(envelope.expiresAt)||envelope.expiresAt<=now||envelope.expiresAt>envelope.issuedAt+30||!['status','prepare','list','ticket','reply','close'].includes(envelope.action))fail('not_found',404);
  return envelope;
}
const messageDelivery=value=>['queued','sending','sent','failed','unknown'].includes(value)?value:null;
const ticketDTO=row=>({ticketId:row.id,userLabel:String(row.name??'Пользователь').slice(0,80),username:row.username?String(row.username).slice(0,32):null,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,lastMessageId:row.last_message_id,pendingMessages:Number(row.pending??0)});
const ticketQuery=`SELECT t.*,p.name,p.username,(SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id=t.id AND m.direction='user' AND m.id>COALESCE((SELECT MAX(s.id) FROM support_messages s WHERE s.ticket_id=t.id AND s.direction='staff'),0)) pending FROM support_tickets t JOIN support_people p ON p.user_id=t.user_id`;
async function readList(db,params) {
  if(!exact(params,['status','limit','offset'])||!['open','waiting','closed'].includes(params.status)||!positive(params.limit)||params.limit>25||!Number.isSafeInteger(params.offset)||params.offset<0||params.offset>100000)fail('invalid_request');
  const counts=await first(db,'SELECT COUNT(*) n FROM support_tickets WHERE status=?',params.status);
  const rows=await all(db,ticketQuery+' WHERE t.status=? ORDER BY t.updated_at DESC,t.id DESC LIMIT ? OFFSET ?',params.status,params.limit,params.offset);
  return {items:rows.map(ticketDTO),total:counts.n,limit:params.limit,offset:params.offset,hasMore:params.offset+rows.length<counts.n};
}
async function readTicket(db,params,cfg) {
  if(!exact(params,['ticketId','before','limit'])||!positive(params.ticketId)||!Number.isSafeInteger(params.before)||params.before<0||!positive(params.limit)||params.limit>25)fail('invalid_request');
  const row=await first(db,ticketQuery+' WHERE t.id=?',params.ticketId);if(!row)fail('resource_unavailable',404);
  const messages=await all(db,`SELECT m.id,m.direction,m.body,m.photo_id IS NOT NULL AS has_photo,m.created_at,(SELECT state FROM support_outbox o WHERE o.message_id=m.id AND o.kind='staff_message' ORDER BY o.id DESC LIMIT 1) delivery FROM support_messages m WHERE m.ticket_id=? AND (?=0 OR m.id<?) ORDER BY m.id DESC LIMIT ?`,params.ticketId,params.before,params.before,params.limit+1);
  const unresolved=await first(db,"SELECT COUNT(*) n FROM support_outbox WHERE ticket_id=? AND kind='staff_message' AND state<>'sent' AND reviewed_at IS NULL",params.ticketId);
  const messageCount=await first(db,'SELECT COUNT(*) n FROM support_messages WHERE ticket_id=?',params.ticketId);
  const items=messages.slice(0,params.limit);
  return {ticket:{...ticketDTO(row),canReply:row.status!=='closed'&&unresolved.n===0&&messageCount.n<cfg.limits.ticketMessages,canClose:row.status!=='closed'&&unresolved.n===0},messages:items.reverse().map(m=>({messageId:m.id,direction:m.direction,text:m.body,hasPhoto:m.has_photo===1,createdAt:m.created_at,deliveryState:messageDelivery(m.delivery)})),hasMore:messages.length>params.limit,before:items.length?items[0].id:0};
}
async function executeCommand(env,envelope,now) {
  const {action,params}=envelope,db=env.SUPPORT_DB,cfg=config(env);
  if(!exact(params,action==='reply'?['ticketId','text','expectedLastMessageId','idempotencyKey']:['ticketId','expectedLastMessageId','idempotencyKey'])||!positive(params.ticketId)||!(params.expectedLastMessageId===null||positive(params.expectedLastMessageId))||!/^[A-Za-z0-9_.:-]{16,128}$/u.test(params.idempotencyKey??'')||action==='reply'&&(typeof params.text!=='string'||!params.text.trim()||params.text.length>2000))fail('invalid_request');
  const ticket=await first(db,'SELECT id FROM support_tickets WHERE id=?',params.ticketId);if(!ticket)fail('resource_unavailable',404);
  const commandKey=await hash(`support-admin-command/v1\n${envelope.actorId}\n${params.idempotencyKey}`);
  const requestHash=await hash(JSON.stringify({action,ticketId:params.ticketId,expectedLastMessageId:params.expectedLastMessageId,...(action==='reply'?{text:params.text}:{})}));
  const previous=await first(db,'SELECT id FROM support_admin_commands WHERE command_key=?',commandKey);
  const minute=Math.floor(now/60),createdToken=crypto.randomUUID();
  // The insert's reason token identifies only this first transaction. A repeat
  // returns the existing receipt and never creates another message/provider job.
  const q=[],add=(sql,...args)=>q.push(statement(db,sql,...args));
  add(`INSERT OR IGNORE INTO support_admin_commands(command_key,request_hash,origin_token,actor_id,source_sha,session_hash,action,ticket_id,expected_last_message_id,reason_code,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM support_tickets WHERE id=?)`,commandKey,requestHash,createdToken,envelope.actorId,envelope.sourceSha,envelope.sessionHash,action,params.ticketId,params.expectedLastMessageId,createdToken,now,params.ticketId);
  const current="EXISTS(SELECT 1 FROM support_admin_commands WHERE command_key=? AND request_hash=? AND state='pending' AND origin_token=?)",gateArgs=[commandKey,requestHash,createdToken];
  add(`INSERT INTO support_rate(user_id,minute,total) SELECT ?,?,1 WHERE ${current} ON CONFLICT(user_id,minute) DO UPDATE SET total=MIN(total+1,?)`,cfg.admin,minute,...gateArgs,cfg.limits.adminMinute+2);
  const safe=`unixepoch()<? AND EXISTS(SELECT 1 FROM support_tickets t WHERE t.id=support_admin_commands.ticket_id AND t.status<>'closed' AND t.last_message_id IS support_admin_commands.expected_last_message_id AND (?='close' OR (SELECT COUNT(*) FROM support_messages WHERE ticket_id=t.id)<?) AND NOT EXISTS(SELECT 1 FROM support_outbox WHERE ticket_id=t.id AND kind='staff_message' AND state<>'sent' AND reviewed_at IS NULL)) AND (SELECT total FROM support_rate WHERE user_id=? AND minute=?)<=? AND (SELECT COUNT(*) FROM support_outbox WHERE state IN ('queued','sending'))<?`;
  add(`UPDATE support_admin_commands SET state=CASE WHEN (${safe}) THEN 'accepted' ELSE 'rejected' END,reason_code=CASE WHEN (${safe}) THEN NULL ELSE 'state_conflict' END,completed_at=? WHERE command_key=? AND request_hash=? AND state='pending' AND origin_token=?`,...[envelope.expiresAt,action,cfg.limits.ticketMessages,cfg.admin,minute,cfg.limits.adminMinute,cfg.limits.queued],...[envelope.expiresAt,action,cfg.limits.ticketMessages,cfg.admin,minute,cfg.limits.adminMinute,cfg.limits.queued],now,...gateArgs);
  const accepted="SELECT id FROM support_admin_commands WHERE command_key=? AND request_hash=? AND state='accepted' AND origin_token=? AND message_id IS NULL";
  if(action==='reply') {
    add(`INSERT INTO support_messages(ticket_id,update_id,direction,body,photo_id,created_at) SELECT ticket_id,-id,'staff',?,NULL,? FROM support_admin_commands WHERE id=(${accepted})`,params.text,now,commandKey,requestHash,createdToken);
    add(`UPDATE support_admin_commands SET message_id=(SELECT id FROM support_messages WHERE update_id=-support_admin_commands.id) WHERE id=(${accepted})`,commandKey,requestHash,createdToken);
    add(`UPDATE support_tickets SET last_message_id=(SELECT message_id FROM support_admin_commands WHERE command_key=?),updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM support_admin_commands WHERE command_key=? AND request_hash=? AND origin_token=? AND state='accepted' AND message_id IS NOT NULL)`,commandKey,now,params.ticketId,commandKey,requestHash,createdToken);
    add(`INSERT OR IGNORE INTO support_outbox(event_key,chat_id,kind,payload,ticket_id,message_id,ready_at,created_at) SELECT 'miniapp:'||c.id||':staff',t.user_id,'staff_message','{}',t.id,c.message_id,?,? FROM support_admin_commands c JOIN support_tickets t ON t.id=c.ticket_id WHERE c.command_key=? AND c.request_hash=? AND c.origin_token=? AND c.state='accepted' AND c.message_id IS NOT NULL`,now,now,commandKey,requestHash,createdToken);
  } else {
    add(`INSERT OR IGNORE INTO support_events(ticket_id,actor_id,action,update_id,created_at) SELECT ticket_id,actor_id,'closed',-id,? FROM support_admin_commands WHERE id=(${accepted})`,now,commandKey,requestHash,createdToken);
    add(`UPDATE support_tickets SET status='closed',closed_at=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM support_admin_commands c JOIN support_events e ON e.update_id=-c.id AND e.action='closed' WHERE c.command_key=? AND c.request_hash=? AND c.origin_token=? AND c.state='accepted')`,now,now,params.ticketId,commandKey,requestHash,createdToken);
    add(`INSERT OR IGNORE INTO support_outbox(event_key,chat_id,kind,payload,ticket_id,ready_at,created_at) SELECT 'miniapp:'||c.id||':closed',t.user_id,'closed',json_object('updateId',-c.id),t.id,?,? FROM support_admin_commands c JOIN support_tickets t ON t.id=c.ticket_id WHERE c.command_key=? AND c.request_hash=? AND c.origin_token=? AND c.state='accepted'`,now,now,commandKey,requestHash,createdToken);
  }
  await db.batch(q);
  const saved=await first(db,"SELECT c.*,(SELECT state FROM support_outbox WHERE event_key='miniapp:'||c.id||CASE WHEN c.action='reply' THEN ':staff' ELSE ':closed' END) delivery FROM support_admin_commands c WHERE command_key=?",commandKey);
  if(!saved)fail('resource_unavailable',404);if(saved.request_hash!==requestHash)fail('idempotency_conflict',409);
  return {ticketId:saved.ticket_id,commandId:saved.id,receiptStatus:saved.state==='accepted'?'completed':'rejected',deliveryState:messageDelivery(saved.delivery),messageId:saved.message_id,duplicate:Boolean(previous),reasonCode:saved.state==='rejected'?saved.reason_code:null};
}
export async function handleAdminSupportBridge(request,env,{nowSeconds=Math.floor(Date.now()/1000)}={}) {
  const url=new URL(request.url);if(url.pathname!==PATH)return null;
  if(request.method!=='POST'||url.search)return new Response('Not found',{status:404});
  let configuration;try{configuration=readSupportAdminBridgeConfiguration();}catch{return new Response('Not found',{status:404});}
  if(!configuration)return new Response('Not found',{status:404});
  try {
    const envelope=await authenticate(request,env,nowSeconds,configuration);
    const cfg=config(env);if(cfg.admin!==configuration.ownerId||env.SUPPORT_ENABLED!=='true')fail('support_unavailable',503);
    if(envelope.action==='prepare')return result(await prepareSupportAdminBridge({env,envelope,configuration}));
    const schema=await supportAdminBridgeSchemaStatus({env});
    if(envelope.action==='status'){if(!exact(envelope.params,[]))fail('invalid_request');return result({...schema,sourceSha:configuration.sourceSha,enabled:true,ownerMatchesConfiguredAdmin:true});}
    if(schema.schemaVersion!==4||schema.ready!==true)fail('support_unavailable',503);
    const db=env.SUPPORT_DB.withSession('first-primary');
    if(envelope.action==='list')return result(await readList(db,envelope.params));
    if(envelope.action==='ticket')return result(await readTicket(db,envelope.params,cfg));
    const data=await executeCommand({...env,SUPPORT_DB:db},envelope,nowSeconds),response=result(data,data.receiptStatus==='rejected'?409:200);
    if(data.receiptStatus==='completed'&&data.deliveryState==='queued')pendingResponses.add(response);
    return response;
  }catch(error){return result({error:{code:['invalid_request','invalid_content_type','resource_unavailable','idempotency_conflict','state_conflict','support_unavailable','not_found'].includes(error?.code)?error.code:'support_unavailable'}},error?.status??503);}
}
