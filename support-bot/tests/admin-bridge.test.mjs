import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAdminSupportFixture} from './admin-bridge-fixture.mjs';

test('signed support bridge lists actual tickets and history without exposing sender IDs, files or credentials',async t=>{
  const f=await createAdminSupportFixture(t),ticket=f.seedTicket();
  const list=await f.call('list',{status:'open',limit:10,offset:0});assert.equal(list.status,200,JSON.stringify(list.data));assert.equal(list.data.items[0].ticketId,ticket.ticketId);assert.equal(list.data.total,1);
  const detail=await f.call('ticket',{ticketId:ticket.ticketId,before:0,limit:10});assert.equal(detail.status,200);assert.equal(detail.data.ticket.canReply,true);assert.equal(detail.data.messages[0].direction,'user');
  const encoded=JSON.stringify(detail.data);assert.equal(encoded.includes(f.env.SUPPORT_BOT_TOKEN),false);assert.equal(encoded.includes('sessionHash'),false);assert.equal(encoded.includes('photo_id'),false);assert.equal(encoded.includes('user_id'),false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_admin_commands').get().n,0);
});
test('support bridge denies public unauthenticated, wrong owner/source, expired and unready requests without writes',async t=>{
  const f=await createAdminSupportFixture(t,{prepare:false}),ticket=f.seedTicket();
  const unready=await f.call('reply',{ticketId:ticket.ticketId,text:'Ответ',expectedLastMessageId:ticket.lastMessageId,idempotencyKey:'support_unready_0001'});assert.equal(unready.status,503);
  const invalid=new Request('https://re-program-support.internal/internal/re-admin-support/v1',{method:'POST',body:'{}'});
  assert.equal((await f.bridge.handleAdminSupportBridge(invalid,f.env)).status,404);
  for(const patch of [{actorId:901},{sourceSha:'d'.repeat(40)},{issuedAt:Math.floor(Date.now()/1000)-90},{expiresAt:Math.floor(Date.now()/1000)-1}])assert.equal((await f.call('status',{},patch)).status,404);
  const mismatch=await f.signedRequest('status',{});assert.equal((await f.bridge.handleAdminSupportBridge(mismatch,{...f.env,SUPPORT_ADMIN_ID:'901'})).status,404);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_messages').get().n,1);
});
test('reply reuses genuine outbox, durable unknown receipt never resends and same-second replay preserves new user message',async t=>{
  const f=await createAdminSupportFixture(t),ticket=f.seedTicket(),params={ticketId:ticket.ticketId,text:'Разобрались, вот решение',expectedLastMessageId:ticket.lastMessageId,idempotencyKey:'support_reply_exact_0001'};
  const first=await f.call('reply',params);assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.receiptStatus,'completed');assert.equal(first.data.deliveryState,'queued');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_updates').get().n,0,'internal commands never forge Telegram updates');
  let calls=0;await f.worker.drainOutbox(f.env,f.now,async()=>{calls++;return {state:'unknown',code:'network_unknown'};},10);assert.equal(calls,1);
  const newMessageId=Number(f.sqlite.prepare("INSERT INTO support_messages(ticket_id,update_id,direction,body,created_at) VALUES(?,999,'user','Дополнение',?)").run(ticket.ticketId,f.now).lastInsertRowid);
  f.sqlite.prepare("UPDATE support_tickets SET status='open',last_message_id=? WHERE id=?").run(newMessageId,ticket.ticketId);
  const duplicate=await f.call('reply',params);assert.equal(duplicate.status,200);assert.equal(duplicate.data.deliveryState,'unknown');assert.equal(duplicate.data.duplicate,true);assert.equal(f.bridge.supportBridgeNeedsDrain(duplicate.response),false);
  assert.equal(f.sqlite.prepare('SELECT last_message_id FROM support_tickets WHERE id=?').get(ticket.ticketId).last_message_id,newMessageId);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_messages').get().n,3);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_outbox').get().n,1);
  await f.worker.drainOutbox(f.env,f.now,async()=>{calls++;return {state:'sent',result:{message_id:99}};},10);assert.equal(calls,1);
  const changed=await f.call('reply',{...params,text:'Другой текст'});assert.equal(changed.status,409);assert.equal(changed.data.error.code,'idempotency_conflict');
  const close=await f.call('close',{ticketId:ticket.ticketId,expectedLastMessageId:newMessageId,idempotencyKey:'support_close_unknown_0001'});assert.equal(close.status,409);assert.equal(close.data.receiptStatus,'rejected');
});
test('reply deadline and latest ticket are rechecked inside its atomic D1 effect batch',async t=>{
  const f=await createAdminSupportFixture(t),ticket=f.seedTicket();
  // Authentication starts within the deadline. The database clock advances
  // before the effect, representing a delayed or queued bridge request.
  f.sqlite.function('unixepoch',()=>f.now+60);
  const response=await f.call('reply',{ticketId:ticket.ticketId,text:'Запоздавший ответ',expectedLastMessageId:ticket.lastMessageId,idempotencyKey:'support_reply_deadline_0001'});
  assert.equal(response.status,409);assert.equal(response.data.receiptStatus,'rejected');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_messages').get().n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_outbox').get().n,0);
});
test('queued, sending, sent, failed and unknown reply receipt replays never enqueue another provider delivery',async t=>{
  const f=await createAdminSupportFixture(t),ticket=f.seedTicket(),params={ticketId:ticket.ticketId,text:'Один ответ',expectedLastMessageId:ticket.lastMessageId,idempotencyKey:'support_reply_states_0001'};
  const accepted=await f.call('reply',params);assert.equal(accepted.status,200);
  for(const state of ['queued','sending','sent','failed','unknown']) {
    f.sqlite.prepare('UPDATE support_outbox SET state=?').run(state);
    const replay=await f.call('reply',params);assert.equal(replay.status,200);assert.equal(replay.data.deliveryState,state);assert.equal(replay.data.duplicate,true);
    assert.equal(f.bridge.supportBridgeNeedsDrain(replay.response),state==='queued');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_messages').get().n,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_outbox').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT last_message_id FROM support_tickets').get().last_message_id,accepted.data.messageId);
  }
});
test('stale close rolls back its effect; successful close and same receipt replay produce one real event/outbox',async t=>{
  const f=await createAdminSupportFixture(t),ticket=f.seedTicket(),params={ticketId:ticket.ticketId,expectedLastMessageId:ticket.lastMessageId,idempotencyKey:'support_close_exact_0001'};
  const stale=await f.call('close',{...params,expectedLastMessageId:ticket.lastMessageId+100,idempotencyKey:'support_close_stale_0001'});assert.equal(stale.status,409);assert.equal(f.sqlite.prepare('SELECT status FROM support_tickets').get().status,'open');
  const closed=await f.call('close',params);assert.equal(closed.status,200,JSON.stringify(closed.data));assert.equal(f.sqlite.prepare('SELECT status FROM support_tickets').get().status,'closed');
  const repeated=await f.call('close',params);assert.equal(repeated.status,200);assert.equal(repeated.data.duplicate,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_events').get().n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM support_outbox').get().n,1);
  let calls=0;await f.worker.drainOutbox(f.env,Math.floor(Date.now()/1000),async(_env,method,body)=>{calls++;assert.equal(method,'sendMessage');assert.match(body.text,/закрыто/u);return {state:'sent',result:{message_id:88}};},10);assert.equal(calls,1);
});
