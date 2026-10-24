import {readTrustedContext} from './trusted-context.mjs';
import {readRuntimeAuthorization,requireRuntimeAuthorization,runtimeAuthorizationDTO,assertRuntimeAuthorizationFresh} from './runtime-authorizer.mjs';
import {readResourceFacts} from './resource-resolver.mjs';
import {canonicalCabinetOwnerId} from '../v1.4.0-rebuild/cabinet-participants.mjs';

const encoder=new TextEncoder(),actions=new Set(['list','ticket','reply','close']);
const fail=(code,status=503)=>{throw Object.assign(new Error(code),{code,status});};
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const canonical=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
};
async function sign(key,time,requestId,body) {
  const bytes=Uint8Array.from(key.match(/../gu),hex=>parseInt(hex,16));
  const hmacKey=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmacKey,encoder.encode(`re-support-admin/v1\n${time}\n${requestId}\n${body}`))),b=>b.toString(16).padStart(2,'0')).join('');
}
// This is a fixed server adapter. A caller-supplied actor, session, role or gate
// cannot replace the genuine owner authorization and immutable request payload.
export async function callAdminSupportBridge({env,authorization,action,params}) {
  requireRuntimeAuthorization(authorization);
  const input=readRuntimeAuthorization(authorization),facts=readTrustedContext(input.context),resource=readResourceFacts(input.resource),dto=runtimeAuthorizationDTO(authorization);
  const owner=canonicalCabinetOwnerId(facts.env),mutation=action==='reply'||action==='close';
  if(!actions.has(action)||facts.actorKind!=='customer'||facts.channel!=='mini_app'||facts.operation!=='admin.cabinet.open'||dto.capability!=='admin.cabinet.open'||facts.telegramId!==owner||!owner||typeof facts.verifiedSessionId!=='string'||!facts.verifiedSessionId||resource.kind!=='admin_surface'||resource.ref!=='cabinet'||canonical(facts.requestPayload)!==canonical({supportAction:action,supportParams:params}))fail('admin_required',403);
  if(mutation&&(facts.env.REBUILD_V140_WRITES_ENABLED!=='true'||facts.transportBinding?.kind!=='http'||facts.transportBinding.idempotencyKey!==params?.idempotencyKey||!facts.operationId))fail('writes_unavailable',403);
  const key=env?.V141_ADMIN_SUPPORT_BRIDGE_KEY,sourceSha=env?.V141_ADMIN_SUPPORT_CANDIDATE_SHA;
  if(!/^[a-f0-9]{64}$/u.test(key??'')||!/^[a-f0-9]{40}$/u.test(sourceSha??'')||sourceSha!==facts.env.V141_SOURCE_SHA||!env.ADMIN_SUPPORT?.fetch)fail('support_unavailable');
  await assertRuntimeAuthorizationFresh(authorization);
  const now=Math.floor(Date.now()/1000),expiresAt=Math.min(facts.expiresAt,now+30);
  if(now>=expiresAt)fail('expired_authentication',403);
  const requestId=crypto.randomUUID(),sessionHash=await hash('re-support-admin-session/v1\n'+facts.verifiedSessionId);
  const body=JSON.stringify({sourceSha,actorId:owner,sessionHash,issuedAt:now,expiresAt,action,params});
  let response;
  try {response=await env.ADMIN_SUPPORT.fetch(new Request('https://re-program-support.internal/internal/re-admin-support/v1',{method:'POST',headers:{'Content-Type':'application/json','X-RE-Bridge-Time':String(now),'X-RE-Bridge-Request':requestId,'X-RE-Bridge-Signature':await sign(key,now,requestId,body)},body,redirect:'manual',signal:AbortSignal.timeout(15000)}));}
  catch{fail(mutation?'support_outcome_unknown':'support_unavailable');}
  let data;
  try {
    if(!response||response.status>=300&&response.status<400)fail('support_unavailable');
    const reader=response.body.getReader(),chunks=[];let size=0;
    for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>128*1024){await reader.cancel();fail('support_unavailable');}chunks.push(next.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!data||typeof data!=='object'||Array.isArray(data))fail('support_unavailable');
  }catch{fail(mutation?'support_outcome_unknown':'support_unavailable');}
  try{await assertRuntimeAuthorizationFresh(authorization);}catch(error){if(mutation)fail('support_outcome_unknown');throw error;}
  if(!response.ok) {
    // A durable rejected command is useful to display as a rejected receipt.
    if(response.status===409&&data.receiptStatus==='rejected')return data;
    const code=data.error?.code;
    if(['invalid_request','resource_unavailable','idempotency_conflict','state_conflict'].includes(code))fail(code,response.status);
    fail(mutation?'support_outcome_unknown':'support_unavailable');
  }
  return data;
}
