import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import worker,{processUpdate,drainOutbox,maintenance,telegram,config} from "../src/worker.mjs";
import { matchFAQ } from "../src/faq.mjs";

const NOW=1788600000;
const ingest=(f,u,delta=0)=>processUpdate(f.env,u,NOW+delta);
const flush=(f,delta=0,send=f.send)=>drainOutbox(f.env,NOW+delta,send,100);
async function open(f,n,text=`Problem ${n}`) {
  await ingest(f,f.callback(n,"contact"));
  const question=f.message(n,text);
  await ingest(f,question);
  await ingest(f,f.callback(n,`draft:send:${question.update_id}`));
  return f.one("SELECT * FROM support_tickets WHERE user_id=? AND status<>'closed'",n);
}
async function prompt(f,ticket) {
  await ingest(f,f.callback(900,`reply:${ticket}`));
  await flush(f);
  return f.one("SELECT * FROM support_reply_targets WHERE ticket_id=? AND expires_at=? ORDER BY telegram_message_id DESC",ticket,NOW+3600);
}

test("semantic FAQ routing recognizes common meanings and avoids guessing on a vague question",()=>{
  assert.equal(matchFAQ("Бот вообще не открывается и не отвечает"),"start");
  assert.equal(matchFAQ("Мою заявку партнёра не пропустила модерация"),"partner");
  assert.equal(matchFAQ("Почему переходы по реферальной ссылке не засчитались?"),"stats");
  assert.equal(matchFAQ("Хочу удалить мой аккаунт и персональные данные"),"privacy");
  assert.equal(matchFAQ("Can you help with something wrong"),null);
  assert.equal(matchFAQ("Ошибка с оплатой"),null);
  assert.equal(matchFAQ("Привет"),null);
});

test("a vague question offers a specialist and stale buttons cannot replace the latest draft",async()=>{
  const f=fixture();
  const old=f.message(1,"Can you help with something wrong");await ingest(f,old);
  let draft=f.one("SELECT * FROM support_drafts WHERE user_id=1");
  assert.equal(draft.intent_key,null);
  const payload=JSON.parse(f.query("SELECT payload FROM support_outbox WHERE kind='ui' ORDER BY id DESC")[0].payload);
  assert.ok(payload.text.includes("Точного решения"));
  assert.ok(payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`draft:send:${old.update_id}`));
  const latest=f.message(1,"Почему статистика ссылки не обновляется?");await ingest(f,latest);
  await ingest(f,f.callback(1,`draft:solve:${old.update_id}`));
  draft=f.one("SELECT * FROM support_drafts WHERE user_id=1");
  assert.equal(draft.update_id,latest.update_id);
  assert.equal(draft.intent_key,"stats");
});

test("solved guidance removes its draft without creating a support ticket",async()=>{
  const f=fixture();const question=f.message(1,"Бот не отвечает на start");
  await ingest(f,question);
  await ingest(f,f.callback(1,`draft:solve:${question.update_id}`));
  assert.equal(f.one("SELECT COUNT(*) n FROM support_drafts").n,0);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_tickets").n,0);
});

test("guided answer keeps a draft until explicit escalation; the open dialogue accepts follow-ups",async()=>{
  const f=fixture();
  await ingest(f,f.message(1,"/start"));
  await ingest(f,f.callback(1,"faq:stats"));
  assert.equal(f.one("SELECT count(*) n FROM support_tickets").n,0);
  await ingest(f,f.callback(1,"contact"));
  const question=f.message(1,"Почему моя реферальная ссылка не показывает переходы?");
  await ingest(f,question);
  assert.equal(f.one("SELECT count(*) n FROM support_tickets").n,0);
  assert.equal(f.one("SELECT intent_key FROM support_drafts WHERE user_id=1").intent_key,"stats");
  await ingest(f,f.callback(1,`draft:send:${question.update_id}`));
  const t=f.one("SELECT * FROM support_tickets WHERE user_id=1 AND status<>'closed'");
  await ingest(f,f.message(1,"More detail"));
  assert.equal(f.one("SELECT count(*) n FROM support_tickets").n,1);
  assert.equal(f.one("SELECT count(*) n FROM support_messages WHERE ticket_id=?",t.id).n,2);
  assert.equal(f.one("SELECT count(*) n FROM support_drafts").n,0);
  await flush(f);
  assert.ok(f.calls.some(c=>c.body.chat_id===1 && c.body.text?.includes(`№${t.id}`)));
});

test("inline navigation edits one text screen while commands and real dialogue events stay separate",async()=>{
  const f=fixture();
  await ingest(f,f.message(1,"/start"));
  await flush(f);const homeMessage=f.calls.find(c=>c.method==="sendMessage").result.message_id;
  f.calls.length=0;
  await ingest(f,f.callback(1,"faq:stats",{message_id:homeMessage,text:"Old menu"}));
  await flush(f);
  const edits=f.calls.filter(c=>c.method==="editMessageText");
  assert.equal(edits.length,1);
  assert.equal(edits[0].body.message_id,homeMessage);
  assert.ok(edits[0].body.text.includes("Ссылка и статистика"));
  assert.equal(f.calls.filter(c=>c.method==="sendMessage").length,0);

  const question=f.message(1,"Can you help with something wrong");
  await ingest(f,question);await flush(f);
  const guidance=f.calls.findLast(c=>c.method==="sendMessage").result.message_id;
  f.calls.length=0;
  await ingest(f,f.callback(1,`draft:send:${question.update_id}`,{message_id:guidance,text:"Guidance"}));
  await flush(f);
  assert.ok(f.calls.some(c=>c.method==="editMessageText" && c.body.chat_id===1 && c.body.message_id===guidance && c.body.text.includes("Сообщение отправлено специалисту")));
  assert.ok(f.calls.some(c=>c.method==="sendMessage" && c.body.chat_id===900 && c.body.text.includes("Новое сообщение")));
  assert.ok(!f.calls.some(c=>c.method==="sendMessage" && c.body.chat_id===1));
});

test("a callback on a photo edits its caption and keeps the existing media message",async()=>{
  const f=fixture();
  await ingest(f,f.callback(1,"faq:start",{message_id:777,photo:[{file_id:"screen-photo"}],caption:"Old caption"}));
  await flush(f);
  const edit=f.calls.find(c=>c.method==="editMessageCaption");
  assert.ok(edit);
  assert.equal(edit.body.message_id,777);
  assert.ok(edit.body.caption.includes("Бот не отвечает"));
  assert.ok(!f.calls.some(c=>c.method==="sendMessage"));
});

test("a rejected edit falls back once to a fresh screen without retrying an accepted edit",async()=>{
  const f=fixture();const calls=[];
  await ingest(f,f.callback(1,"privacy",{message_id:321,text:"Old screen"}));
  await flush(f,0,async(_env,method,body)=>{
    calls.push({method,body});
    if(method==="editMessageText") return {state:"fallback",code:"edit_rejected"};
    return {state:"sent",result:{message_id:654}};
  });
  assert.deepEqual(calls.map(c=>c.method),["answerCallbackQuery","editMessageText","sendMessage"]);
  assert.equal(calls[2].body.message_id,undefined);
  assert.equal(f.one("SELECT state FROM support_outbox WHERE kind='ui'").state,"sent");
  assert.equal(f.one("SELECT telegram_message_id FROM support_outbox WHERE kind='ui'").telegram_message_id,654);
});

test("admin queue, ticket and close confirmation reuse the tapped panel",async()=>{
  const f=fixture(),t=await open(f,1,"Check the admin screen");
  await flush(f);
  for(const [messageId,action,fragment] of [
    [701,"queue:open:0","Центр обращений"],
    [702,`ticket:${t.id}`,`Обращение №${t.id}`],
    [703,`close:${t.id}`,`Закрыть обращение №${t.id}`],
  ]) {
    f.calls.length=0;
    await ingest(f,f.callback(900,action,{message_id:messageId,text:"Old admin panel"}));
    await flush(f);
    const edit=f.calls.find(c=>c.method==="editMessageText");
    assert.ok(edit);
    assert.equal(edit.body.message_id,messageId);
    assert.ok(edit.body.text.includes(fragment));
    assert.ok(!f.calls.some(c=>c.method==="sendMessage"));
  }
  f.calls.length=0;
  const last=f.one("SELECT last_message_id FROM support_tickets WHERE id=?",t.id).last_message_id;
  await ingest(f,f.callback(900,`confirmclose:${t.id}:${last}`,{message_id:704,text:"Close confirmation"}));
  await flush(f);
  assert.ok(f.calls.some(c=>c.method==="editMessageText" && c.body.message_id===704 && c.body.text.includes("Обращение закрыто")));
  assert.ok(f.calls.some(c=>c.method==="sendMessage" && c.body.chat_id===1 && c.body.text.includes("Обращение закрыто")));
});

test("two concurrent follow-up messages stay in one dialogue and neither is lost",async()=>{
  const f=fixture();await open(f,1,"Initial question");
  await Promise.all([ingest(f,f.message(1,"First")),ingest(f,f.message(1,"Second"))]);
  assert.equal(f.one("SELECT count(*) n FROM support_tickets").n,1);
  assert.equal(f.one("SELECT count(*) n FROM support_messages").n,3);
});

test("concurrent replay creates one durable message and one set of deliveries",async()=>{
  const f=fixture();await open(f,1,"Initial question");
  const u=f.message(1,"Exactly one");
  await Promise.all([ingest(f,u),ingest(f,u)]);
  const count=f.one("SELECT count(*) n FROM support_outbox").n;
  await ingest(f,u);
  assert.equal(f.one("SELECT count(*) n FROM support_messages").n,2);
  assert.equal(f.one("SELECT count(*) n FROM support_outbox").n,count);
});

test("failed D1 batch rolls back update receipt; replay can save the message",async()=>{
  const f=fixture();await open(f,1,"Initial question");
  f.sqlite.exec("CREATE TRIGGER fail_message BEFORE INSERT ON support_messages BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  const u=f.message(1,"Keep this");
  await assert.rejects(ingest(f,u));
  assert.equal(f.one("SELECT count(*) n FROM support_updates WHERE update_id=?",u.update_id).n,0);
  assert.equal(f.one("SELECT count(*) n FROM support_tickets").n,1);
  f.sqlite.exec("DROP TRIGGER fail_message");
  await ingest(f,u);
  assert.equal(f.one("SELECT body FROM support_messages ORDER BY id DESC").body,"Keep this");
});

test("username changes and recycled usernames do not change ticket ownership",async()=>{
  const f=fixture();const big=4000000000001;
  await ingest(f,f.callback(big,"contact"));
  const question=f.message(big,"A",{from:f.user(big,"Alice","old_name")});
  await ingest(f,question);
  await ingest(f,f.callback(big,`draft:send:${question.update_id}`));
  const t=f.one("SELECT * FROM support_tickets");
  await ingest(f,f.message(big,"B",{from:f.user(big,"Alice","new_name")}));
  await open(f,2);
  await ingest(f,f.message(2,"C",{from:f.user(2,"Bob","old_name")}));
  assert.equal(f.one("SELECT user_id FROM support_tickets WHERE id=?",t.id).user_id,big);
  assert.equal(f.one("SELECT username FROM support_people WHERE user_id=?",big).username,"new_name");
  const p=await prompt(f,t.id);
  await ingest(f,f.message(900,"Answer for Alice",{reply_to_message:{message_id:p.telegram_message_id}}));
  await flush(f);
  assert.equal(f.calls.find(c=>c.body.text?.includes("Answer for Alice"))?.body.chat_id,big);
});

test("out-of-order replies to two admin prompts stay with their own recipients",async()=>{
  const f=fixture();const a=await open(f,1),b=await open(f,2);
  const pa=await prompt(f,a.id),pb=await prompt(f,b.id);
  await ingest(f,f.message(900,"For Bob",{reply_to_message:{message_id:pb.telegram_message_id}}));
  await ingest(f,f.message(900,"For Alice",{reply_to_message:{message_id:pa.telegram_message_id}}));
  await flush(f);
  assert.equal(f.calls.find(c=>c.body.text?.includes("For Bob"))?.body.chat_id,2);
  assert.equal(f.calls.find(c=>c.body.text?.includes("For Alice"))?.body.chat_id,1);
  const outgoing=f.calls.filter(c=>[1,2].includes(c.body.chat_id) && /For Alice|For Bob/.test(c.body.text||""));
  assert.equal(outgoing.length,2);
  for(const c of outgoing){assert.equal(c.method,"sendMessage");assert.equal(c.body.from_chat_id,undefined);}
});

test("admin can reply directly to a new-message notification and receives a delivery confirmation",async()=>{
  const f=fixture(),t=await open(f,1,"The first real question");
  await flush(f);
  const notificationTarget=f.one("SELECT * FROM support_reply_targets WHERE ticket_id=? AND expires_at=? ORDER BY telegram_message_id DESC",t.id,NOW+7*86400);
  assert.ok(notificationTarget);
  await ingest(f,f.message(900,"Продолжаем диалог",{reply_to_message:{message_id:notificationTarget.telegram_message_id}}));
  await flush(f);
  assert.ok(f.calls.some(c=>c.body.chat_id===1 && c.body.text?.includes("Продолжаем диалог")));
  assert.ok(f.calls.some(c=>c.body.chat_id===900 && c.body.text?.includes("Ответ доставлен пользователю")));
  assert.ok(f.calls.some(c=>c.body.chat_id===1 && c.body.reply_markup?.inline_keyboard.flat().some(b=>b.text.includes("Ответить специалисту"))));
  assert.equal(f.one("SELECT status FROM support_tickets WHERE id=?",t.id).status,"waiting");
  assert.ok(f.query("SELECT * FROM support_reply_targets WHERE ticket_id=? AND expires_at=?",t.id,NOW+7*86400).length>=2);
});

test("admin cards and queue show a red new-message counter capped at 99+",async()=>{
  const f=fixture(),t=await open(f,1,"Initial");
  const insert=f.sqlite.prepare("INSERT INTO support_messages(ticket_id,update_id,direction,body,created_at) VALUES(?,?,?,?,?)");
  for(let n=0;n<105;n++) insert.run(t.id,10000+n,"user",`Extra ${n}`,NOW+n+1);
  f.sqlite.prepare("UPDATE support_tickets SET status='open' WHERE id=?").run(t.id);
  await ingest(f,f.callback(900,`ticket:${t.id}`),500);
  await ingest(f,f.callback(900,"queue:open:0"),501);
  const screens=f.query("SELECT payload FROM support_outbox WHERE kind='ui' AND chat_id=900 ORDER BY id DESC LIMIT 2").map(r=>JSON.parse(r.payload));
  assert.ok(screens.some(p=>p.text.includes("🔴 Новых сообщений: <b>99+</b>")));
  assert.ok(screens.some(p=>p.reply_markup.inline_keyboard.flat().some(b=>b.text.includes("🔴 99+"))));
});

test("forged staff callbacks, another user's ticket and message IDs never expose content",async()=>{
  const f=fixture(),t=await open(f,1,"TOP SECRET SUPPORT TEXT");
  await flush(f);f.calls.length=0;
  const targetsBefore=f.one("SELECT count(*) n FROM support_reply_targets").n;
  const m=f.one("SELECT id FROM support_messages");
  for(const action of [`ticket:${t.id}`,`hist:${t.id}:0`,`msg:${m.id}`,`continue:${t.id}`,`reply:${t.id}`,`confirmclose:${t.id}:${m.id}`,"queue:open:0","deliveries:0","confirmreview:1"]){
    await ingest(f,f.callback(2,action));
  }
  await flush(f);
  assert.ok(!f.calls.some(c=>JSON.stringify(c.body).includes("TOP SECRET")));
  assert.equal(f.one("SELECT status FROM support_tickets").status,"open");
  assert.equal(f.one("SELECT count(*) n FROM support_reply_targets").n,targetsBefore);
});

test("reply without mapped prompt, expired prompt, or reused prompt does not send",async()=>{
  const f=fixture(),t=await open(f,1);const p=await prompt(f,t.id);
  await ingest(f,f.message(900,"No recipient"));
  await ingest(f,f.message(900,"Fabricated",{reply_to_message:{message_id:999999}}));
  await ingest(f,f.message(900,"Valid",{reply_to_message:{message_id:p.telegram_message_id}}));
  await ingest(f,f.message(900,"Second reply",{reply_to_message:{message_id:p.telegram_message_id}}));
  const another=await prompt(f,t.id);
  await ingest(f,f.message(900,"Expired",{reply_to_message:{message_id:another.telegram_message_id}}),3601);
  assert.deepEqual(f.query("SELECT body FROM support_messages WHERE direction='staff'").map(m=>m.body),["Valid"]);
});

test("closing uses fresh message version, records audit, and rejects replies to closed ticket",async()=>{
  const f=fixture(),t=await open(f,1),p=await prompt(f,t.id);
  await ingest(f,f.message(1,"New detail"));
  await ingest(f,f.callback(900,`confirmclose:${t.id}:${t.last_message_id}`));
  assert.equal(f.one("SELECT status FROM support_tickets").status,"open");
  const fresh=f.one("SELECT last_message_id FROM support_tickets").last_message_id;
  const close=f.callback(900,`confirmclose:${t.id}:${fresh}`);
  await ingest(f,close);await ingest(f,close);
  assert.equal(f.one("SELECT status FROM support_tickets").status,"closed");
  assert.equal(f.one("SELECT count(*) n FROM support_events WHERE action='closed'").n,1);
  await ingest(f,f.message(900,"Too late",{reply_to_message:{message_id:p.telegram_message_id}}));
  assert.equal(f.one("SELECT count(*) n FROM support_messages WHERE direction='staff'").n,0);
  const next=await open(f,1,"New question");assert.ok(next.id>t.id);
});

test("queue pagination and history pagination work across many users",async()=>{
  const f=fixture();for(let n=1;n<=12;n++)await open(f,n);
  await ingest(f,f.callback(900,"queue:open:0"));
  await ingest(f,f.callback(900,"queue:open:5"));
  const screens=f.query("SELECT payload FROM support_outbox WHERE kind='ui' AND chat_id=900").map(r=>JSON.parse(r.payload));
  assert.ok(screens[0].text.includes("Person 1"));assert.ok(!screens[0].text.includes("Person 6"));
  assert.ok(screens[1].text.includes("Person 6"));assert.ok(!screens[1].text.includes("Person 1\n"));
  for(let i=0;i<6;i++)await ingest(f,f.message(1,`Details ${i}`),120+i*60);
  await ingest(f,f.callback(1,"ticket:1"),600);
  const card=JSON.parse(f.query("SELECT payload FROM support_outbox WHERE chat_id=1 AND kind='ui'").at(-1).payload);
  assert.ok(card.reply_markup.inline_keyboard.flat().some(b=>b.callback_data.startsWith("hist:1:")));
});

test("photos relay by file ID; markup is escaped; arbitrary attachments are not saved",async()=>{
  const f=fixture();await ingest(f,f.callback(1,"contact"));
  const photoUpdate=f.message(1,undefined,{caption:"<b>not markup</b>",photo:[{file_id:"fake-photo",file_size:1000}],from:f.user(1,"<Admin>","person_one")});
  await ingest(f,photoUpdate);
  const escalate=f.callback(1,`draft:send:${photoUpdate.update_id}`);
  escalate.callback_query.from=f.user(1,"<Admin>","person_one");
  await ingest(f,escalate);
  await flush(f);
  await ingest(f,f.message(1,undefined,{document:{file_id:"fake-doc"}}));
  await ingest(f,f.message(1,undefined,{photo:[{file_id:"huge",file_size:6000000}]}));
  await flush(f);
  assert.equal(f.one("SELECT count(*) n FROM support_messages").n,1);
  const photo=f.calls.find(c=>c.method==='sendPhoto');
  assert.equal(photo.body.photo,"fake-photo");assert.ok(photo.body.caption.includes("&lt;Admin&gt;"));assert.ok(photo.body.caption.includes("&lt;b&gt;not markup"));
});

test("Telegram photos without the optional file_size are accepted while reported oversized photos are rejected",async()=>{
  const f=fixture();
  await ingest(f,f.callback(1,"contact"));
  const valid=f.message(1,undefined,{caption:"No reported size",photo:[{file_id:"photo-without-size"}]});
  await ingest(f,valid);
  assert.equal(f.one("SELECT photo_id FROM support_drafts WHERE user_id=1").photo_id,"photo-without-size");
  const oversized=f.message(2,undefined,{caption:"Too large",photo:[{file_id:"oversized",file_size:5*1024*1024+1}]});
  await ingest(f,oversized);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_drafts WHERE user_id=2").n,0);
});

test("rate limit applies atomically; excess messages get one notice, not storage",async()=>{
  const f=fixture();await open(f,1);
  for(let i=0;i<20;i++)await ingest(f,f.message(1,`Flood ${i}`));
  assert.equal(f.one("SELECT count(*) n FROM support_messages").n,10);
  const warnings=f.query("SELECT payload FROM support_outbox WHERE kind='ui'").filter(r=>r.payload.includes("Слишком много"));assert.equal(warnings.length,1);
  await ingest(f,f.message(1,"After limit"),120);
  assert.equal(f.one("SELECT count(*) n FROM support_messages").n,11);
});

test("callbacks are always acknowledged even when the authoritative per-minute limit rejects their actions",async()=>{
  const f=fixture();f.env.SUPPORT_USER_MINUTE_LIMIT="2";f.env.SUPPORT_GLOBAL_MINUTE_LIMIT="20";
  for(let i=0;i<5;i++) await ingest(f,f.callback(1,"privacy"));
  assert.deepEqual(f.query("SELECT allowed FROM support_updates ORDER BY update_id").map(r=>r.allowed),[1,1,-1,0,0]);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_outbox WHERE kind='callback'").n,5);
  await flush(f);
  assert.equal(f.calls.filter(c=>c.method==="answerCallbackQuery").length,5);
  assert.equal(f.calls.filter(c=>c.method.startsWith("editMessage")).length,2);
});

test("daily, global, queue-backpressure and per-ticket limits fail closed from server configuration",async()=>{
  {
    const f=fixture();Object.assign(f.env,{SUPPORT_USER_MINUTE_LIMIT:"20",SUPPORT_USER_DAILY_LIMIT:"2",SUPPORT_GLOBAL_MINUTE_LIMIT:"100"});
    await ingest(f,f.message(1,"/start"));await ingest(f,f.message(1,"/start"));await ingest(f,f.message(1,"/start"));
    assert.deepEqual(f.query("SELECT allowed FROM support_updates ORDER BY update_id").map(r=>r.allowed),[1,1,-1]);
  }
  {
    const f=fixture();Object.assign(f.env,{SUPPORT_USER_MINUTE_LIMIT:"2",SUPPORT_GLOBAL_MINUTE_LIMIT:"2"});
    await ingest(f,f.message(1,"/start"));await ingest(f,f.message(2,"/start"));await ingest(f,f.message(3,"/start"));
    assert.equal(f.one("SELECT allowed FROM support_updates WHERE update_id=3").allowed,0);
    assert.equal(f.one("SELECT COUNT(*) n FROM support_people WHERE user_id=3").n,0);
  }
  {
    const f=fixture();f.env.SUPPORT_MAX_PENDING_OUTBOX="1";
    f.sqlite.prepare("INSERT INTO support_outbox(event_key,chat_id,kind,payload,ready_at,created_at) VALUES('pressure',900,'ui','{}',?,?)").run(NOW,NOW);
    await ingest(f,f.message(1,"/start"));
    assert.equal(f.one("SELECT allowed FROM support_updates").allowed,0);
    assert.equal(f.one("SELECT COUNT(*) n FROM support_people").n,0);
  }
  {
    const f=fixture();f.env.SUPPORT_MAX_TICKET_MESSAGES="2";
    const ticket=await open(f,1,"Initial");
    await ingest(f,f.message(1,"Second"),60);
    await ingest(f,f.message(1,"Third"),120);
    assert.equal(f.one("SELECT COUNT(*) n FROM support_messages WHERE ticket_id=?",ticket.id).n,2);
  }
});

test("two concurrent drains never claim the same delivery or reverse a chat's order",async()=>{
  const f=fixture();await open(f,1);
  await Promise.all([flush(f),flush(f)]);
  const ephemeral=f.calls.filter(c=>c.method==="answerCallbackQuery").length;
  assert.equal(f.one("SELECT count(*) n FROM support_outbox WHERE state='sent'").n+ephemeral,f.calls.length);
  assert.equal(f.one("SELECT count(*) n FROM support_outbox WHERE attempts>1").n,0);
});

test("Telegram 429 retries later; user answer remains open until actual delivery",async()=>{
  const f=fixture(),t=await open(f,1),p=await prompt(f,t.id);
  await ingest(f,f.message(900,"Rate limited reply",{reply_to_message:{message_id:p.telegram_message_id}}));
  await flush(f,0,async(env,method,body)=>body.chat_id===1?{state:"queued",retry:10,code:"rate_limited"}:f.send(env,method,body));
  assert.equal(f.one("SELECT status FROM support_tickets").status,"open");
  assert.equal(f.one("SELECT state FROM support_outbox WHERE kind='staff_message'").state,"queued");
  await flush(f,11);
  assert.equal(f.one("SELECT status FROM support_tickets").status,"waiting");
});

test("unknown delivery is preserved without auto-repeat and can be reviewed before closing",async()=>{
  const f=fixture(),t=await open(f,1),p=await prompt(f,t.id);
  await ingest(f,f.message(900,"Uncertain reply",{reply_to_message:{message_id:p.telegram_message_id}}));
  let attempts=0;
  await flush(f,0,async(env,method,body)=>{if(body.chat_id===1){attempts++;return {state:"unknown",code:"network_unknown"};}return f.send(env,method,body);});
  await flush(f,600);
  assert.equal(attempts,1);
  const delivery=f.one("SELECT * FROM support_outbox WHERE kind='staff_message'");assert.equal(delivery.state,"unknown");
  const last=f.one("SELECT last_message_id FROM support_tickets").last_message_id;
  await ingest(f,f.callback(900,`confirmclose:${t.id}:${last}`));
  assert.equal(f.one("SELECT status FROM support_tickets").status,"open");
  await ingest(f,f.callback(900,`confirmreview:${delivery.id}`));
  await ingest(f,f.callback(900,`confirmclose:${t.id}:${last}`));
  assert.equal(f.one("SELECT status FROM support_tickets").status,"closed");
  assert.equal(f.one("SELECT state FROM support_outbox WHERE id=?",delivery.id).state,"unknown");
});

test("a crash after external send becomes unknown, not a duplicated answer",async()=>{
  const f=fixture();await open(f,1);await flush(f);
  await ingest(f,f.message(1,"Crash case"));
  let sent=0;
  const original=f.db.batch;
  await assert.rejects(flush(f,0,async(env,method,body)=>{
    const result=await f.send(env,method,body);sent++;
    f.db.batch=async()=>{throw new Error("D1 disconnected after send");};return result;
  }));
  f.db.batch=original;
  await flush(f,121);
  assert.equal(sent,1);assert.equal(f.one("SELECT count(*) n FROM support_outbox WHERE state='unknown'").n,1);
});

test("blocked user response is failed and stays available in history",async()=>{
  const f=fixture(),t=await open(f,1),p=await prompt(f,t.id);
  await ingest(f,f.message(900,"Keep answer",{reply_to_message:{message_id:p.telegram_message_id}}));
  await flush(f,0,async(env,method,body)=>body.chat_id===1?{state:"failed",code:"telegram_403"}:f.send(env,method,body));
  assert.equal(f.one("SELECT body FROM support_messages WHERE direction='staff'").body,"Keep answer");
  assert.equal(f.one("SELECT state FROM support_outbox WHERE kind='staff_message'").state,"failed");
});

test("retention deletes expired closed conversations only, including dependent personal records",async()=>{
  const f=fixture(),closed=await open(f,1),active=await open(f,2);
  await ingest(f,f.callback(900,`confirmclose:${closed.id}:${closed.last_message_id}`));
  await flush(f);
  await maintenance(f.env,NOW+31*86400);
  assert.equal(f.one("SELECT count(*) n FROM support_tickets WHERE id=?",closed.id).n,0);
  assert.equal(f.one("SELECT count(*) n FROM support_messages WHERE ticket_id=?",closed.id).n,0);
  assert.equal(f.one("SELECT count(*) n FROM support_outbox WHERE ticket_id=?",closed.id).n,0);
  assert.equal(f.one("SELECT count(*) n FROM support_people WHERE user_id=1").n,0);
  assert.equal(f.one("SELECT count(*) n FROM support_tickets WHERE id=?",active.id).n,1);
  assert.equal(f.query("PRAGMA foreign_key_check").length,0);
});

test("data deletion is user-confirmed, admin dry-run reviewed, server-authorized and anonymized",async()=>{
  const f=fixture(),ticket=await open(f,1,"PRIVATE SUPPORT BODY");
  await ingest(f,f.message(1,"/deletedata"),60);
  const request=f.one("SELECT * FROM support_deletion_requests WHERE user_id=1");
  assert.equal(request.status,"pending");
  await ingest(f,f.callback(1,"delete:confirm"),120);
  assert.equal(f.one("SELECT status FROM support_deletion_requests WHERE id=?",request.id).status,"awaiting_admin");

  // Neither another user nor a forged request ID can authorize deletion.
  await ingest(f,f.callback(2,`delete:apply:${request.id}`),180);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_tickets WHERE id=?",ticket.id).n,1);

  await ingest(f,f.callback(900,`delete:review:${request.id}`),240);
  const dryRun=JSON.parse(f.query("SELECT payload FROM support_outbox WHERE chat_id=900 AND kind='ui' ORDER BY id DESC LIMIT 1")[0].payload);
  assert.ok(dryRun.text.includes("Будет удалено обращений: <b>1</b>"));
  assert.ok(dryRun.text.includes("Сообщений: <b>1</b>"));
  assert.equal(dryRun.text.includes("PRIVATE SUPPORT BODY"),false);

  await ingest(f,f.callback(900,`delete:apply:${request.id}`),300);
  const completed=f.one("SELECT * FROM support_deletion_requests WHERE id=?",request.id);
  assert.equal(completed.status,"completed");
  assert.equal(completed.user_id,null);assert.equal(completed.request_update_id,null);assert.equal(completed.confirm_update_id,null);
  assert.equal(completed.deleted_tickets,1);assert.equal(completed.deleted_messages,1);assert.equal(completed.decided_by,900);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_people WHERE user_id=1").n,0);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_tickets WHERE user_id=1").n,0);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_messages").n,0);
  assert.equal(f.query("SELECT payload FROM support_outbox").some(r=>r.payload.includes("PRIVATE SUPPORT BODY")),false);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_outbox WHERE chat_id=1 AND kind='callback'").n>=1,true);
  assert.equal(f.query("PRAGMA foreign_key_check").length,0);
});

test("data deletion refuses to interrupt an in-flight Telegram delivery",async()=>{
  const f=fixture(),ticket=await open(f,1,"Keep until delivery settles");
  await ingest(f,f.message(1,"/deletedata"),60);
  await ingest(f,f.callback(1,"delete:confirm"),120);
  f.sqlite.prepare("UPDATE support_outbox SET state='sending',claimed_at=? WHERE ticket_id=? AND id=(SELECT MIN(id) FROM support_outbox WHERE ticket_id=?)").run(NOW+120,ticket.id,ticket.id);
  await ingest(f,f.callback(900,"delete:apply:1"),180);
  assert.equal(f.one("SELECT status FROM support_deletion_requests WHERE id=1").status,"awaiting_admin");
  assert.equal(f.one("SELECT COUNT(*) n FROM support_tickets WHERE id=?",ticket.id).n,1);
  const result=f.query("SELECT payload FROM support_outbox WHERE chat_id=900 AND kind='ui' ORDER BY id DESC").map(r=>JSON.parse(r.payload).text);
  assert.ok(result.some(text=>text.includes("Удаление не выполнено")));
});

test("unsubmitted guided-help drafts expire after 24 hours",async()=>{
  const f=fixture();
  await ingest(f,f.message(1,"Непонятный тестовый вопрос"));
  assert.equal(f.one("SELECT COUNT(*) n FROM support_drafts").n,1);
  await maintenance(f.env,NOW+86401);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_drafts").n,0);
  assert.equal(f.one("SELECT COUNT(*) n FROM support_tickets").n,0);
});

test("webhook rejects unauthenticated requests before touching D1 or parsing body",async()=>{
  const f=fixture();let touched=0;
  const env={SUPPORT_WEBHOOK_SECRET:f.env.SUPPORT_WEBHOOK_SECRET,get SUPPORT_DB(){touched++;throw new Error("D1 should not be accessed");}};
  for(const secret of [undefined,"bad"]){
    const r=new Request("https://support.invalid/webhook",{method:"POST",headers:secret?{"X-Telegram-Bot-Api-Secret-Token":secret}:{},body:"not even json"});
    assert.equal((await worker.fetch(r,env,{})).status,404);
  }
  assert.equal(touched,0);
});

test("kill switch, malformed payload, oversized body and public rollout fail closed",async()=>{
  const f=fixture();const headers={"Content-Type":"application/json","X-Telegram-Bot-Api-Secret-Token":f.env.SUPPORT_WEBHOOK_SECRET};
  const request=(body)=>new Request("https://support.invalid/webhook",{method:"POST",headers,body});
  assert.equal((await worker.fetch(request("{}"),{...f.env,SUPPORT_ENABLED:"false"},{})).status,503);
  assert.equal((await worker.fetch(request("{"),f.env,{})).status,400);
  assert.equal((await worker.fetch(request("x".repeat(33000)),f.env,{})).status,400);
  f.env.SUPPORT_PUBLIC_ENABLED="false";f.env.SUPPORT_TEST_USER_IDS="2";
  await ingest(f,f.message(1,"/start"));assert.equal(f.one("SELECT count(*) n FROM support_people").n,0);
  await ingest(f,f.message(2,"/start"));assert.equal(f.one("SELECT count(*) n FROM support_people").n,1);
  assert.throws(()=>config({...f.env,SUPPORT_ADMIN_ID:"@someone"}));
  assert.throws(()=>config({...f.env,SUPPORT_RETENTION_DAYS:"0"}));
});

test("admin and test identities accept canonical decimal Telegram IDs only",()=>{
  const f=fixture();
  assert.equal(config({...f.env,SUPPORT_TEST_USER_IDS:"1,2"}).tests.length,2);
  for(const patch of [
    {SUPPORT_ADMIN_ID:"0x384"},{SUPPORT_ADMIN_ID:"9e2"},{SUPPORT_ADMIN_ID:" 900"},{SUPPORT_ADMIN_ID:"0900"},
    {SUPPORT_TEST_USER_IDS:"0x10"},{SUPPORT_TEST_USER_IDS:"1e3"},{SUPPORT_TEST_USER_IDS:"1, 2"},
    {SUPPORT_TEST_USER_IDS:"1,1"},{SUPPORT_TEST_USER_IDS:"900"},
    {SUPPORT_USER_DAILY_LIMIT:"0"},{SUPPORT_GLOBAL_MINUTE_LIMIT:"11"},{SUPPORT_MAX_PENDING_OUTBOX:"1e3"},
  ]) assert.throws(()=>config({...f.env,...patch}),/support_not_configured/);
  f.sqlite.close();
});

test("scheduled health records only fixed operational codes and no message content",async()=>{
  const f=fixture();let pending;
  const scheduledTime=Math.floor(NOW/3600)*3600*1000;
  await worker.scheduled({scheduledTime},f.env,{waitUntil(p){pending=p;}});
  await pending;
  const health=f.one("SELECT * FROM support_runtime_health WHERE id=1");
  assert.ok(health.last_drain_ok_at);assert.ok(health.last_maintenance_ok_at);
  assert.equal(health.last_failure_code,null);assert.equal(health.failure_count,0);
  assert.deepEqual(Object.keys(health).sort(),[
    "failure_count","id","last_drain_ok_at","last_failure_at","last_failure_code","last_maintenance_ok_at","updated_at",
  ]);
});

test("scheduled drain failures become a fixed non-PII operational signal",async()=>{
  const f=fixture();let pending;
  f.sqlite.prepare(`INSERT INTO support_outbox(event_key,chat_id,kind,payload,state,ready_at,claimed_at,created_at)
    VALUES('stuck',1,'ui',?,'sending',?,?,?)`).run(JSON.stringify({chat_id:1,text:"PRIVATE VALUE"}),NOW-500,NOW-500,NOW-500);
  f.sqlite.exec("CREATE TRIGGER fail_stale_outbox BEFORE UPDATE ON support_outbox BEGIN SELECT RAISE(ABORT,'PRIVATE VALUE'); END;");
  await worker.scheduled({scheduledTime:(Math.floor(NOW/60000)+1)*60000},f.env,{waitUntil(p){pending=p;}});
  await assert.rejects(pending,/support_scheduled_drain_failed/);
  const health=f.one("SELECT * FROM support_runtime_health WHERE id=1");
  assert.equal(health.last_failure_code,"scheduled_drain");assert.equal(health.failure_count,1);
  assert.equal(JSON.stringify(health).includes("PRIVATE VALUE"),false);
});

test("group messages, inline callbacks, edits and mismatched private chats are ignored",async()=>{
  const f=fixture(),u=f.message(1,"/start");
  u.message.chat.type="group";
  assert.deepEqual(await ingest(f,u),{ignored:true});
  const cb=f.callback(1,"queue:open:0");cb.callback_query.message.chat.id=900;
  assert.deepEqual(await ingest(f,cb),{ignored:true});
  assert.deepEqual(await ingest(f,{update_id:999,edited_message:u.message}),{ignored:true});
  assert.equal(f.one("SELECT count(*) n FROM support_updates").n,0);
});

test("transport blocks redirects without following them or assuming non-delivery",async()=>{
  const f=fixture();
  let calls=0;
  const result=await telegram(f.env,"sendMessage",{chat_id:900,text:"Test"},async(url,init)=>{
    calls++;
    assert.equal(init.redirect,"manual");
    assert.equal(new URL(url).hostname,"api.telegram.org");
    return new Response(null,{status:307,headers:{Location:"https://untrusted.example/"}});
  });
  assert.deepEqual(result,{state:"unknown",code:"redirect_blocked"});
  assert.equal(calls,1);
  f.sqlite.close();
});

test("transport never discloses tokens in returned errors and classifies ambiguous outcomes",async()=>{
  const f=fixture();
  const failure=await telegram(f.env,"sendMessage",{},async()=>{throw new Error(f.env.SUPPORT_BOT_TOKEN);});
  assert.deepEqual(failure,{state:"unknown",code:"network_unknown"});
  const throttled=await telegram(f.env,"sendMessage",{},async()=>new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:10}}),{status:429}));
  assert.equal(throttled.state,"queued");assert.equal(throttled.retry,10);
  const blocked=await telegram(f.env,"sendMessage",{},async()=>new Response(JSON.stringify({ok:false,error_code:403}),{status:403}));
  assert.equal(blocked.state,"failed");
  const unchanged=await telegram(f.env,"editMessageText",{chat_id:1,message_id:42,text:"Same"},async()=>new Response(JSON.stringify({ok:false,error_code:400,description:"Bad Request: message is not modified"}),{status:400}));
  assert.deepEqual(unchanged,{state:"sent",result:{message_id:42}});
  const stale=await telegram(f.env,"editMessageText",{chat_id:1,message_id:43,text:"New"},async()=>new Response(JSON.stringify({ok:false,error_code:400,description:"Bad Request: message to edit not found"}),{status:400}));
  assert.deepEqual(stale,{state:"fallback",code:"edit_rejected"});
});
