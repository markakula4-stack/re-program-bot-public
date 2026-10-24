import { FAQ, WARNING, matchFAQ } from "./faq.mjs";
import {handleAdminSupportBridge,supportBridgeNeedsDrain} from './admin-bridge.mjs';

const WIKI = "https://re-program-wiki.pages.dev";
const VERSION = "0.2.1";
const PAGE = 5;
const MAX_TEXT = 2000;
const MAX_PHOTO = 5 * 1024 * 1024;
const BODY_LIMIT = 32 * 1024;
const CAPTION_LIMIT = 1024;
const DEFAULT_LIMITS = Object.freeze({
  userMinute: 12,
  adminMinute: 60,
  userDay: 120,
  globalMinute: 240,
  queued: 500,
  ticketMessages: 200,
});
const LABEL = { open: "Ждёт ответа специалиста", waiting: "Ждём пользователя", closed: "Закрыто" };
const escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const id = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const button = (text, callback_data) => ({ text, callback_data });
const keyboard = (...rows) => ({ inline_keyboard: rows });
const cleanName = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max);
const sql = (db, q, ...args) => db.prepare(q).bind(...args);
const first = (db, q, ...args) => sql(db, q, ...args).first();
const all = async (db, q, ...args) => (await sql(db, q, ...args).all()).results;
const say = (chat_id, text, reply_markup) => ({ chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(reply_markup ? { reply_markup } : {}) });
const countLabel = value => Number(value) > 99 ? "99+" : String(Math.max(0, Number(value) || 0));
const faqKeys = () => keyboard(...Object.entries(FAQ).map(([k, f]) => [button(f.title, `faq:${k}`)]), [button("📮 Написать специалисту", "contact")], [button("📂 Мои обращения", "mine")]);
const home = (chat) => say(chat, `<b>RE Program · Поддержка</b>\n\nВыберите частый вопрос или просто напишите проблему обычными словами. Я попробую сразу найти решение. Если оно не подойдёт — подключим специалиста.\n\n${WARNING}`, faqKeys());
const draftKeys = (matched, updateId) => keyboard(...(matched ? [[button("✅ Проблема решена", `draft:solve:${updateId}`)]] : []), [button("📮 Написать специалисту", `draft:send:${updateId}`)], [button("✏️ Описать иначе", "contact")]);

function guidedReply(chat, intent, updateId) {
  const item = intent ? FAQ[intent] : null;
  if (item) return say(chat, `<b>✨ Возможно, решение уже здесь</b>\n\n<b>${item.title}</b>\n${item.text}\n\nЕсли это не решило проблему, передам ваше сообщение специалисту. Повторно описывать вопрос не придётся.`, draftKeys(true, updateId));
  return say(chat, `<b>🤔 Точного решения пока не нашлось</b>\n\nЧтобы не дать неверный совет, лучше передать вопрос специалисту. Ваш текст и фото уже подготовлены — повторять их не нужно.`, draftKeys(false, updateId));
}

async function pendingUserMessages(db, ticketId) {
  return (await first(db, `SELECT COUNT(*) n FROM support_messages m WHERE m.ticket_id=? AND m.direction='user'
    AND m.id>COALESCE((SELECT MAX(s.id) FROM support_messages s WHERE s.ticket_id=? AND s.direction='staff'),0)`, ticketId, ticketId))?.n || 0;
}

export function config(env) {
  const adminRaw = String(env.SUPPORT_ADMIN_ID ?? "");
  const testsRaw = String(env.SUPPORT_TEST_USER_IDS ?? "");
  const admin = Number(adminRaw);
  const retention = Number(env.SUPPORT_RETENTION_DAYS);
  const tests = testsRaw ? testsRaw.split(",").map(Number) : [];
  const limit = (name, fallback, maximum) => {
    const raw = env[name];
    if (raw === undefined || raw === null || raw === "") return fallback;
    if (!/^[1-9][0-9]*$/.test(String(raw))) return NaN;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value <= maximum ? value : NaN;
  };
  const limits = {
    userMinute: limit("SUPPORT_USER_MINUTE_LIMIT", DEFAULT_LIMITS.userMinute, 120),
    adminMinute: limit("SUPPORT_ADMIN_MINUTE_LIMIT", DEFAULT_LIMITS.adminMinute, 600),
    userDay: limit("SUPPORT_USER_DAILY_LIMIT", DEFAULT_LIMITS.userDay, 10000),
    globalMinute: limit("SUPPORT_GLOBAL_MINUTE_LIMIT", DEFAULT_LIMITS.globalMinute, 10000),
    queued: limit("SUPPORT_MAX_PENDING_OUTBOX", DEFAULT_LIMITS.queued, 100000),
    ticketMessages: limit("SUPPORT_MAX_TICKET_MESSAGES", DEFAULT_LIMITS.ticketMessages, 10000),
  };
  if (!id(admin) || !/^[1-9][0-9]*$/.test(adminRaw) ||
      !Number.isInteger(retention) || retention < 1 || retention > 365 ||
      (testsRaw !== "" && !/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(testsRaw)) ||
      tests.some((v) => !id(v)) || new Set(tests).size !== tests.length || tests.includes(admin) ||
      Object.values(limits).some((v) => !Number.isSafeInteger(v)) || limits.globalMinute < limits.userMinute ||
      !env.SUPPORT_DB ||
      !/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.SUPPORT_BOT_TOKEN || "") ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(env.SUPPORT_WEBHOOK_SECRET || "")) {
    throw new Error("support_not_configured");
  }
  return { admin, retention, tests, limits, public: env.SUPPORT_PUBLIC_ENABLED === "true" };
}

function actor(update) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const cb = update.callback_query;
  const message = cb?.message || update.message;
  const user = cb?.from || message?.from;
  if (!id(user?.id) || user.is_bot || !id(message?.message_id) ||
      message.chat?.type !== "private" || message.chat.id !== user.id) return null;
  if (cb && (typeof cb.id !== "string" || typeof cb.data !== "string" || cb.data.length > 64)) return null;
  return { user, message, cb };
}

function content(message) {
  const text = message.text ?? message.caption ?? "";
  if (typeof text !== "string" || text.length > MAX_TEXT) return null;
  if (message.photo) {
    const photo = Array.isArray(message.photo) && message.photo.at(-1);
    if (!photo || typeof photo.file_id !== "string" || photo.file_id.length > 512 ||
        (photo.file_size !== undefined && (!Number.isInteger(photo.file_size) || photo.file_size > MAX_PHOTO || photo.file_size < 1)) ||
        text.length > 700) return null;
    return { text, photo: photo.file_id };
  }
  // Stickers, arbitrary files, contacts, voice and service messages are not relayed.
  return typeof message.text === "string" && text.trim() ? { text, photo: null } : null;
}

function tx(db, update, who, cfg, now) {
  const token = crypto.randomUUID(); // Server generated; no caller text is interpolated in SQL.
  const has = `EXISTS (SELECT 1 FROM support_updates WHERE token = '${token}')`;
  const gate = `EXISTS (SELECT 1 FROM support_updates WHERE token = '${token}' AND allowed = 1)`;
  const incomingId = `(SELECT update_id FROM support_updates WHERE token = '${token}')`;
  const messageId = `(SELECT id FROM support_messages WHERE update_id = ${incomingId})`;
  const ticketId = `(SELECT ticket_id FROM support_messages WHERE update_id = ${incomingId})`;
  const statements = [sql(db, "INSERT OR IGNORE INTO support_updates(update_id, token, created_at) VALUES(?,?,?)", update.update_id, token, now)];
  const add = (q, ...args) => statements.push(sql(db, q, ...args));
  const minute = Math.floor(now / 60);
  const day = Math.floor(now / 86400);
  const isAdmin = who.id === cfg.admin;
  const limit = isAdmin ? cfg.limits.adminMinute : cfg.limits.userMinute;
  add(`INSERT INTO support_rate(user_id, minute, total) SELECT ?,?,1 WHERE ${has}
    ON CONFLICT(user_id, minute) DO UPDATE SET total = MIN(total + 1, ?)`, who.id, minute, limit + 2);
  if (!isAdmin) {
    add(`INSERT INTO support_daily_rate(user_id, day, total) SELECT ?,?,1 WHERE ${has}
      ON CONFLICT(user_id, day) DO UPDATE SET total = MIN(total + 1, ?)`, who.id, day, cfg.limits.userDay + 2);
    add(`INSERT INTO support_global_rate(minute, total) SELECT ?,1 WHERE ${has}
      ON CONFLICT(minute) DO UPDATE SET total = MIN(total + 1, ?)`, minute, cfg.limits.globalMinute + 2);
  }
  add(`UPDATE support_updates SET allowed = (
    SELECT CASE
      WHEN r.total <= ?
        AND (? = 1 OR (SELECT total FROM support_daily_rate WHERE user_id=? AND day=?) <= ?)
        AND (? = 1 OR (SELECT total FROM support_global_rate WHERE minute=?) <= ?)
        AND (? = 1 OR (SELECT COUNT(*) FROM support_outbox WHERE state IN ('queued','sending')) < ?)
      THEN 1
      WHEN r.total = ? OR (? = 0 AND (SELECT total FROM support_daily_rate WHERE user_id=? AND day=?) = ?)
      THEN -1 ELSE 0 END
    FROM support_rate r WHERE r.user_id = ? AND r.minute = ?) WHERE token = ?`,
    limit,isAdmin?1:0,who.id,day,cfg.limits.userDay,isAdmin?1:0,minute,cfg.limits.globalMinute,isAdmin?1:0,cfg.limits.queued,
    limit+1,isAdmin?1:0,who.id,day,cfg.limits.userDay+1,who.id,minute,token);
  let count = 0;
  function enqueue(kind, chat, payload = {}, ticket = null, message = null, condition = "1", specialGate = gate) {
    const ticketSQL = ticket === "current" ? ticketId : "?";
    const messageSQL = message === "current" ? messageId : "?";
    const args = [`${update.update_id}:${count++}`, chat, kind, JSON.stringify(payload)];
    if (ticket !== "current") args.push(ticket);
    if (message !== "current") args.push(message);
    args.push(now, now);
    add(`INSERT INTO support_outbox(event_key, chat_id, kind, payload, ticket_id, message_id, ready_at, created_at)
      SELECT ?,?,?,?,${ticketSQL},${messageSQL},?,? WHERE ${specialGate} AND (${condition})`, ...args);
  }
  const limitNotice = () => enqueue("ui", who.id,
    say(who.id, "Слишком много сообщений. Подождите минуту и отправьте последнее сообщение снова."), null, null, "1",
    `EXISTS (SELECT 1 FROM support_updates WHERE token = '${token}' AND allowed = -1)`);
  return { add, enqueue, limitNotice, has, gate, messageId, ticketId, commit: () => db.batch(statements) };
}

async function history(db, ticketId, before = 0) {
  const rows = await all(db, `SELECT m.*, (SELECT state FROM support_outbox WHERE message_id=m.id AND kind='staff_message' ORDER BY id DESC LIMIT 1) delivery
    FROM support_messages m WHERE ticket_id=? AND (?=0 OR m.id<?) ORDER BY m.id DESC LIMIT ?`, ticketId, before, before, PAGE);
  return rows;
}

async function ticketCard(db, ticketId, viewer, admin, before = 0) {
  const t = await first(db, `SELECT t.*, p.name, p.username FROM support_tickets t JOIN support_people p ON p.user_id=t.user_id
    WHERE t.id=? AND (?=? OR t.user_id=?)`, ticketId, viewer, admin, viewer);
  if (!t) return say(viewer, "Обращение недоступно.");
  const rows = await history(db, t.id, before);
  const isAdmin = viewer === admin;
  const pending = isAdmin ? await pendingUserMessages(db, t.id) : 0;
  const state = isAdmin ? LABEL[t.status] : ({open:"Специалист скоро ответит",waiting:"Диалог открыт",closed:"Закрыто"})[t.status];
  let text = `<b>Обращение №${t.id}</b>\n${state}`;
  if (isAdmin) {
    text += `\n👤 ${escape(t.name)}${t.username ? ` · @${escape(t.username)}` : " · без username"}`;
    if (pending) text += `\n🔴 Новых сообщений: <b>${countLabel(pending)}</b>`;
  }
  for (const m of [...rows].reverse()) {
    const body = m.body.length > 220 ? `${m.body.slice(0,220)}…` : m.body;
    text += `\n\n${m.direction === "user" ? "👤 Пользователь" : "🛠 Специалист"} · ${new Date(m.created_at * 1000).toISOString().slice(0,16).replace("T"," ")} UTC`;
    if (m.direction === "staff") text += ` · ${({sent:"отправлено",queued:"в очереди",sending:"отправляется",failed:"не доставлено",unknown:"доставка неизвестна"})[m.delivery] || "в очереди"}`;
    text += `\n${m.photo_id ? "📷 " : ""}${escape(body || "Скриншот")}`;
  }
  const buttons = [];
  if (isAdmin && t.status !== "closed") buttons.push([button("✍️ Ответить", `reply:${t.id}`), button("✅ Закрыть", `close:${t.id}`)]);
  if (!isAdmin && t.status !== "closed") buttons.push([button("💬 Написать ещё", `continue:${t.id}`)]);
  if (!isAdmin && t.status === "closed") buttons.push([button("📮 Новый вопрос", "contact")]);
  for (const m of [...rows].reverse()) buttons.push([button(`${m.photo_id ? "📷" : "💬"} Сообщение ${m.id}`, `msg:${m.id}`)]);
  if (rows.length === PAGE) buttons.push([button("Ранее", `hist:${t.id}:${rows.at(-1).id}`)]);
  buttons.push([button("🔄 Обновить", `ticket:${t.id}`), button(isAdmin ? "Все обращения" : "Мои обращения", isAdmin ? "queue:open:0" : "mine")]);
  return say(viewer, text, keyboard(...buttons));
}

async function queueCard(db, admin, status = "open", after = 0) {
  if (!Object.hasOwn(LABEL,status)) return say(admin,"Неизвестный раздел.");
  const rows = await all(db, `SELECT t.*,p.name,p.username,
    (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id=t.id AND m.direction='user'
      AND m.id>COALESCE((SELECT MAX(s.id) FROM support_messages s WHERE s.ticket_id=t.id AND s.direction='staff'),0)) pending
    FROM support_tickets t JOIN support_people p ON p.user_id=t.user_id
    WHERE status=? AND t.id>? ORDER BY t.id LIMIT ?`, status, after, PAGE);
  const counts = await all(db,"SELECT status,COUNT(*) n FROM support_tickets GROUP BY status");
  const total = Object.fromEntries(counts.map(r=>[r.status,r.n]));
  const unread = await first(db, `SELECT COUNT(*) n FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id
    WHERE t.status='open' AND m.direction='user' AND m.id>COALESCE(
      (SELECT MAX(s.id) FROM support_messages s WHERE s.ticket_id=t.id AND s.direction='staff'),0)`);
  const issues = await first(db,"SELECT COUNT(*) n FROM support_outbox WHERE state IN ('failed','unknown') AND reviewed_at IS NULL AND COALESCE(error_code,'')<>'obsolete' AND kind<>'callback'");
  const deletions = await first(db,"SELECT COUNT(*) n FROM support_deletion_requests WHERE status='awaiting_admin'");
  const lines = rows.map(t=>`${t.pending ? `🔴 ${countLabel(t.pending)} · ` : ""}№${t.id} · ${escape(t.name)}${t.username ? ` · @${escape(t.username)}` : " · без username"}`);
  const keys = [
    [button(`🔴 Ждут ответа ${countLabel(total.open)}`,"queue:open:0"),button(`🟢 Ждём клиента ${countLabel(total.waiting)}`,"queue:waiting:0")],
    [button(`✅ Закрытые ${countLabel(total.closed)}`,"queue:closed:0"),button(`⚠️ Доставка ${countLabel(issues.n)}`,"deliveries:0")],
    [button(`🗑 Запросы на удаление ${countLabel(deletions.n)}`,"deletions:0")],
    ...rows.map(t=>[button(`${t.pending ? `🔴 ${countLabel(t.pending)} · ` : ""}№${t.id} · ${t.name.slice(0,24)}`,`ticket:${t.id}`)]),
  ];
  if(rows.length === PAGE) keys.push([button("Дальше",`queue:${status}:${rows.at(-1).id}`)]);
  return say(admin,`<b>Центр обращений · ${LABEL[status]}</b>\n${unread.n ? `🔴 Новых сообщений: <b>${countLabel(unread.n)}</b>\n` : ""}\n${lines.join("\n")||"В этом разделе пока пусто."}`,keyboard(...keys));
}

async function deletionRequest(db, requestId) {
  return first(db, `SELECT r.*,
    (SELECT COUNT(*) FROM support_tickets WHERE user_id=r.user_id) ticket_count,
    (SELECT COUNT(*) FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id WHERE t.user_id=r.user_id) message_count,
    (SELECT COUNT(*) FROM support_outbox o WHERE o.state='sending' AND (o.chat_id=r.user_id OR o.ticket_id IN
      (SELECT id FROM support_tickets WHERE user_id=r.user_id))) sending_count
    FROM support_deletion_requests r WHERE r.id=?`, requestId);
}

export async function processUpdate(env, update, now = Math.floor(Date.now()/1000)) {
  const cfg = config(env);
  const a = actor(update);
  if (!a) return { ignored: true };
  const {user,message,cb} = a;
  const admin = user.id === cfg.admin;
  const db = env.SUPPORT_DB;
  if (!cfg.public && !admin && !cfg.tests.includes(user.id)) return { ignored: true };
  if (await first(db,"SELECT update_id FROM support_updates WHERE update_id=?",update.update_id)) return { duplicate: true };
  const op = tx(db,update,user,cfg,now);
  const minute=Math.floor(now/60),day=Math.floor(now/86400);
  const pressure=await first(db,`SELECT
    COALESCE((SELECT total FROM support_rate WHERE user_id=? AND minute=?),0) user_minute,
    COALESCE((SELECT total FROM support_daily_rate WHERE user_id=? AND day=?),0) user_day,
    COALESCE((SELECT total FROM support_global_rate WHERE minute=?),0) global_minute,
    (SELECT COUNT(*) FROM support_outbox WHERE state IN ('queued','sending')) pending_outbox`,user.id,minute,user.id,day,minute);
  const preflightLimited=Number(pressure.user_minute) >= (admin ? cfg.limits.adminMinute : cfg.limits.userMinute) || (!admin && (
    Number(pressure.user_day) >= cfg.limits.userDay || Number(pressure.global_minute) >= cfg.limits.globalMinute ||
    Number(pressure.pending_outbox) >= cfg.limits.queued));
  if(preflightLimited) {
    if(cb) op.enqueue("callback",user.id,{callback_query_id:cb.id},null,null,"1",op.has);
    op.limitNotice();
    await op.commit();
    return { stored: true, limited: true };
  }
  let callbackScreen = cb ? { message_id: message.message_id, photo: Array.isArray(message.photo) && message.photo.length > 0 } : null;
  const screen = (kind,chat,payload={},ticket=null,storedMessage=null,condition="1",specialGate) => {
    const target = callbackScreen && chat === user.id ? callbackScreen : null;
    if (target) callbackScreen = null;
    op.enqueue(kind,chat,target ? {...payload,__edit:target} : payload,ticket,storedMessage,condition,specialGate);
  };
  const ui = (p,ticket=null) => screen("ui",user.id,p,ticket);
  const command = (message.text||"").match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase();
  const action = cb?.data || (command === "start" || command === "help" ? "home" : command === "admin" ? "queue:open:0" : command === "my" ? "mine" : command === "new" ? "contact" : command === "privacy" ? "privacy" : command === "deletedata" ? "delete:request" : command === "cancel" ? "cancel" : command ? "unknown" : null);
  // Refresh display data only, never use username for ownership or delivery.
  const name = cleanName([user.first_name,user.last_name].filter(Boolean).join(" "),100) || "Пользователь";
  const username = /^[A-Za-z0-9_]{1,32}$/.test(user.username||"") ? user.username : null;
  // Telegram requires every accepted callback query to be answered, including
  // callbacks rejected by the intake limiter. The acknowledgement is still
  // deduplicated and cannot authorize the requested action.
  if (cb) op.enqueue("callback",user.id,{callback_query_id:cb.id},null,null,"1",op.has);
  op.limitNotice();
  op.add(`INSERT INTO support_people(user_id,name,username,seen_at) SELECT ?,?,?,? WHERE ${op.gate}
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,username=excluded.username,seen_at=excluded.seen_at`,user.id,name,username,now);

  if(action === "home") ui(admin ? await queueCard(db,cfg.admin) : home(user.id));
  else if(action?.startsWith("faq:")) {
    const item=FAQ[action.slice(4)];
    ui(item ? say(user.id,`<b>${item.title}</b>\n\n${item.text}`,keyboard([button("✅ Всё получилось","home")],[button("📮 Написать специалисту","contact")])) : home(user.id));
  } else if(action === "privacy") {
    ui(say(user.id,`<b>Данные поддержки</b>\n\nДля ответа сохраняются Telegram ID, имя, username при наличии, текст и идентификаторы присланных фото. Первичный поиск ответа работает внутри бота: переписка не передаётся внешней ИИ-модели.\n\nНеотправленный специалисту вопрос хранится до 24 часов. Закрытые обращения удаляются из базы поддержки через ${cfg.retention} дней. Копии сообщений в Telegram управляются отдельно. Запросить удаление данных базы поддержки можно командой /deletedata.\n\n${WARNING}`,keyboard([button("🗑 Запросить удаление","delete:request")],[button("📮 Написать специалисту","contact")],[{text:"Правила RE Program",url:`${WIKI}/privacy.html`}])));
  } else if(action === "delete:request" && !admin) {
    const existing=await first(db,"SELECT id,status FROM support_deletion_requests WHERE user_id=? AND status IN ('pending','awaiting_admin')",user.id);
    if(existing?.status === "awaiting_admin") {
      ui(say(user.id,"Запрос на удаление уже подтверждён и ожидает проверки специалистом. Повторно отправлять его не нужно.",keyboard([button("Назад к данным","privacy")])));
    } else {
      if(!existing) op.add(`INSERT OR IGNORE INTO support_deletion_requests(user_id,request_update_id,status,requested_at,updated_at)
        SELECT ?,?,'pending',?,? WHERE ${op.gate}`,user.id,update.update_id,now,now);
      ui(say(user.id,"<b>Удалить данные поддержки?</b>\n\nПосле отдельной проверки будут удалены профиль поддержки, черновики, обращения и их сообщения. Это не удаляет аккаунт RE Program и копии сообщений в Telegram. Отменить выполненное удаление будет нельзя.",keyboard([button("Да, отправить запрос","delete:confirm")],[button("Нет, оставить данные","delete:keep")])));
    }
  } else if(action === "delete:keep" && !admin) {
    op.add(`UPDATE support_deletion_requests SET user_id=NULL,request_update_id=NULL,status='cancelled',updated_at=?
      WHERE user_id=? AND status='pending' AND ${op.gate}`,now,user.id);
    ui(say(user.id,"Данные оставлены без изменений.",keyboard([button("Назад к данным","privacy")])));
  } else if(action === "delete:confirm" && !admin) {
    const request=await first(db,"SELECT id,status FROM support_deletion_requests WHERE user_id=? AND status IN ('pending','awaiting_admin')",user.id);
    if(!request) {
      ui(say(user.id,"Активный запрос не найден. Откройте раздел данных и создайте его ещё раз.",keyboard([button("Открыть раздел данных","privacy")])));
    } else if(request.status === "awaiting_admin") {
      ui(say(user.id,"Запрос уже подтверждён и ожидает проверки специалистом.",keyboard([button("Назад к данным","privacy")])));
    } else {
      op.add(`UPDATE support_deletion_requests SET status='awaiting_admin',confirm_update_id=?,confirmed_at=?,updated_at=?
        WHERE id=? AND user_id=? AND status='pending' AND ${op.gate}`,update.update_id,now,now,request.id,user.id);
      op.enqueue("ui",cfg.admin,say(cfg.admin,`<b>Запрос на удаление данных №${request.id}</b>\n\nПеред выполнением откройте dry-run: бот покажет только количество записей, без текста обращений.`,keyboard([button("Проверить dry-run",`delete:review:${request.id}`)])),null,null,
        `EXISTS(SELECT 1 FROM support_deletion_requests WHERE id=${request.id} AND confirm_update_id=${update.update_id} AND status='awaiting_admin')`);
      ui(say(user.id,"Запрос подтверждён и передан специалисту. После проверки бот сообщит результат.",keyboard([button("Назад к данным","privacy")])))
    }
  } else if(/^deletions:\d+$/.test(action||"") && admin) {
    const after=Number(action.split(":")[1]);
    if(Number.isSafeInteger(after) && after>=0) {
      const rows=await all(db,"SELECT id,requested_at FROM support_deletion_requests WHERE status='awaiting_admin' AND id>? ORDER BY id LIMIT 5",after);
      const keys=rows.map(r=>[button(`Dry-run запроса №${r.id}`,`delete:review:${r.id}`)]);
      if(rows.length===5) keys.push([button("Дальше",`deletions:${rows.at(-1).id}`)]);
      keys.push([button("Очередь","queue:open:0")]);
      ui(say(cfg.admin,`<b>Запросы на удаление</b>\n\n${rows.map(r=>`№${r.id} · ${new Date(r.requested_at*1000).toISOString().slice(0,16).replace("T"," ")} UTC`).join("\n")||"Новых запросов нет."}`,keyboard(...keys)));
    }
  } else if(/^delete:review:\d+$/.test(action||"") && admin) {
    const requestId=Number(action.split(":")[2]);
    const request=id(requestId) && await deletionRequest(db,requestId);
    if(!request || request.status !== "awaiting_admin" || !id(request.user_id)) {
      ui(say(cfg.admin,"Запрос уже обработан или недоступен.",keyboard([button("Очередь","queue:open:0")])));
    } else {
      ui(say(cfg.admin,`<b>Dry-run удаления №${request.id}</b>\n\nБудет удалено обращений: <b>${Number(request.ticket_count)}</b>\nСообщений: <b>${Number(request.message_count)}</b>\nАктивных отправок: <b>${Number(request.sending_count)}</b>\n\nВыполнение возможно только при отсутствии активной отправки. После удаления Telegram ID пользователя не сохраняется в журнале запроса.`,keyboard([button("Подтвердить удаление",`delete:apply:${request.id}`)],[button("Отклонить запрос",`delete:cancel:${request.id}`)])));
    }
  } else if(/^delete:apply:\d+$/.test(action||"") && admin) {
    const requestId=Number(action.split(":")[2]);
    const request=id(requestId) && await deletionRequest(db,requestId);
    if(!request || request.status !== "awaiting_admin" || !id(request.user_id)) {
      ui(say(cfg.admin,"Запрос уже обработан или недоступен.",keyboard([button("Очередь","queue:open:0")])));
    } else {
      const target=request.user_id;
      const safe=`EXISTS(SELECT 1 FROM support_deletion_requests WHERE id=${request.id} AND user_id=${target} AND status='awaiting_admin')
        AND NOT EXISTS(SELECT 1 FROM support_outbox o WHERE o.state='sending' AND (o.chat_id=${target} OR o.ticket_id IN
          (SELECT id FROM support_tickets WHERE user_id=${target})))`;
      op.add(`UPDATE support_deletion_requests SET
        deleted_tickets=(SELECT COUNT(*) FROM support_tickets WHERE user_id=?),
        deleted_messages=(SELECT COUNT(*) FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id WHERE t.user_id=?),updated_at=?
        WHERE id=? AND ${op.gate} AND ${safe}`,target,target,now,request.id);
      op.add(`DELETE FROM support_outbox WHERE chat_id=? AND ticket_id IS NULL AND kind<>'callback' AND state<>'sending' AND ${op.gate} AND ${safe}`,target);
      op.add(`DELETE FROM support_drafts WHERE user_id=? AND ${op.gate} AND ${safe}`,target);
      op.add(`DELETE FROM support_tickets WHERE user_id=? AND ${op.gate} AND ${safe}`,target);
      op.add(`DELETE FROM support_rate WHERE user_id=? AND ${op.gate} AND ${safe}`,target);
      op.add(`DELETE FROM support_daily_rate WHERE user_id=? AND ${op.gate} AND ${safe}`,target);
      op.add(`DELETE FROM support_people WHERE user_id=? AND ${op.gate} AND ${safe}`,target);
      op.add(`UPDATE support_deletion_requests SET user_id=NULL,request_update_id=NULL,confirm_update_id=NULL,
        status='completed',completed_at=?,decided_by=?,updated_at=? WHERE id=? AND status='awaiting_admin'
        AND NOT EXISTS(SELECT 1 FROM support_people WHERE user_id=?) AND ${op.gate}`,now,cfg.admin,now,request.id,target);
      op.enqueue("privacy_notice",target,say(target,"Удаление данных поддержки завершено. Аккаунт RE Program и сообщения в Telegram этим действием не затрагивались."),null,null,
        `EXISTS(SELECT 1 FROM support_deletion_requests WHERE id=${request.id} AND status='completed' AND decided_by=${cfg.admin})`);
      screen("ui",cfg.admin,say(cfg.admin,"Удаление выполнено и обезличенный результат сохранён в аудите.",keyboard([button("Очередь","queue:open:0")])),null,null,
        `EXISTS(SELECT 1 FROM support_deletion_requests WHERE id=${request.id} AND status='completed' AND decided_by=${cfg.admin})`);
      op.enqueue("ui",cfg.admin,say(cfg.admin,"Удаление не выполнено: обнаружена активная отправка или состояние запроса изменилось. Повторите dry-run позже.",keyboard([button("Повторить dry-run",`delete:review:${request.id}`)])),null,null,
        `NOT EXISTS(SELECT 1 FROM support_deletion_requests WHERE id=${request.id} AND status='completed' AND decided_by=${cfg.admin})`);
    }
  } else if(/^delete:cancel:\d+$/.test(action||"") && admin) {
    const requestId=Number(action.split(":")[2]);
    const request=id(requestId) && await deletionRequest(db,requestId);
    if(!request || request.status !== "awaiting_admin" || !id(request.user_id)) {
      ui(say(cfg.admin,"Запрос уже обработан или недоступен.",keyboard([button("Очередь","queue:open:0")])));
    } else {
      const target=request.user_id;
      op.add(`UPDATE support_deletion_requests SET user_id=NULL,request_update_id=NULL,confirm_update_id=NULL,status='cancelled',completed_at=?,decided_by=?,updated_at=?
        WHERE id=? AND user_id=? AND status='awaiting_admin' AND ${op.gate}`,now,cfg.admin,now,request.id,target);
      op.enqueue("privacy_notice",target,say(target,"Запрос на удаление отклонён после проверки. Если нужна дополнительная информация, создайте обращение в поддержку."),null,null,
        `EXISTS(SELECT 1 FROM support_deletion_requests WHERE id=${request.id} AND status='cancelled' AND decided_by=${cfg.admin})`);
      screen("ui",cfg.admin,say(cfg.admin,"Решение зафиксировано, Telegram ID удалён из журнала запроса.",keyboard([button("Очередь","queue:open:0")])),null,null,
        `EXISTS(SELECT 1 FROM support_deletion_requests WHERE id=${request.id} AND status='cancelled' AND decided_by=${cfg.admin})`);
    }
  } else if(action === "contact" && !admin) {
    const active=await first(db,"SELECT id FROM support_tickets WHERE user_id=? AND status<>'closed'",user.id);
    if(active) ui(say(user.id,`<b>Диалог уже открыт · обращение №${active.id}</b>\n\nПросто отправьте следующее сообщение или фото — специалист увидит его в этом же обращении.`,keyboard([button("📖 Открыть диалог",`ticket:${active.id}`)],[button("Отмена","cancel")])));
    else {
      op.add(`UPDATE support_people SET composing=1 WHERE user_id=? AND ${op.gate}`,user.id);
      ui(say(user.id,`<b>Опишите проблему</b>\n\nНапишите вопрос обычными словами. Сначала я попробую найти готовое решение. Если оно не подойдёт, одним нажатием передадим ваш текст и фото специалисту.\n\nМожно приложить фото до 5 МБ с подписью до 700 символов. ${WARNING}`,keyboard([button("Отмена","cancel")])));
    }
  } else if(action === "cancel") {
    op.add(`UPDATE support_people SET composing=0 WHERE user_id=? AND ${op.gate}`,user.id);
    op.add(`DELETE FROM support_drafts WHERE user_id=? AND ${op.gate}`,user.id);
    ui(say(user.id,"Ввод вопроса отменён. Уже отправленные специалисту сообщения сохранены.",faqKeys()));
  } else if(/^draft:solve:\d+$/.test(action||"") && !admin) {
    const draftUpdate=Number(action.split(":")[2]);
    const draft=Number.isSafeInteger(draftUpdate) && await first(db,"SELECT user_id FROM support_drafts WHERE user_id=? AND update_id=? AND escalated_update_id IS NULL AND expires_at>=?",user.id,draftUpdate,now);
    if(draft) {
      op.add(`DELETE FROM support_drafts WHERE user_id=? AND update_id=? AND ${op.gate}`,user.id,draftUpdate);
      op.add(`UPDATE support_people SET composing=0 WHERE user_id=? AND ${op.gate}`,user.id);
      ui(say(user.id,"<b>✅ Отлично, вопрос решён</b>\n\nЕсли понадобится помощь снова, просто напишите мне.",faqKeys()));
    } else ui(say(user.id,"Этот вариант ответа уже устарел. Отправьте актуальный вопрос ещё раз.",keyboard([button("✏️ Написать вопрос","contact")],[button("📂 Мои обращения","mine")])));
  } else if(/^draft:send:\d+$/.test(action||"") && !admin) {
    const draftUpdate=Number(action.split(":")[2]);
    const draft=Number.isSafeInteger(draftUpdate) && await first(db,"SELECT user_id FROM support_drafts WHERE user_id=? AND update_id=? AND escalated_update_id IS NULL AND expires_at>=?",user.id,draftUpdate,now);
    if(!draft) ui(say(user.id,"Этот вопрос уже отправлен, изменён или устарел. Напишите его ещё раз — я сразу предложу решение или связь со специалистом.",keyboard([button("✏️ Написать вопрос","contact")],[button("📂 Мои обращения","mine")])));
    else {
      op.add(`UPDATE support_drafts SET escalated_update_id=? WHERE user_id=? AND update_id=? AND escalated_update_id IS NULL AND expires_at>=? AND ${op.gate}`,
        update.update_id,user.id,draftUpdate,now);
      op.add(`INSERT INTO support_tickets(user_id,created_at,updated_at)
        SELECT ?,?,? WHERE ${op.gate} AND EXISTS(SELECT 1 FROM support_drafts WHERE user_id=? AND escalated_update_id=?)
        AND NOT EXISTS(SELECT 1 FROM support_tickets WHERE user_id=? AND status<>'closed')`,user.id,now,now,user.id,update.update_id,user.id);
      op.add(`INSERT INTO support_messages(ticket_id,update_id,direction,body,photo_id,created_at)
        SELECT t.id,?,'user',d.body,d.photo_id,? FROM support_drafts d JOIN support_tickets t ON t.user_id=d.user_id AND t.status<>'closed'
        WHERE d.user_id=? AND d.escalated_update_id=? AND ${op.gate}
        AND (SELECT COUNT(*) FROM support_messages WHERE ticket_id=t.id) < ?`,update.update_id,now,user.id,update.update_id,cfg.limits.ticketMessages);
      op.add(`UPDATE support_people SET composing=0 WHERE user_id=? AND ${op.gate} AND ${op.messageId} IS NOT NULL`,user.id);
      op.add(`UPDATE support_tickets SET status='open',last_message_id=${op.messageId},updated_at=? WHERE id=${op.ticketId} AND ${op.gate}`,now);
      op.add(`DELETE FROM support_drafts WHERE user_id=? AND escalated_update_id=? AND ${op.messageId} IS NOT NULL`,user.id,update.update_id);
      op.enqueue("user_message",cfg.admin,{},"current","current",`${op.messageId} IS NOT NULL`);
      screen("received",user.id,{},"current","current",`${op.messageId} IS NOT NULL`);
      op.enqueue("ui",user.id,say(user.id,"Не удалось передать вопрос. Нажмите кнопку ещё раз или напишите его заново."),null,null,`${op.messageId} IS NULL`);
    }
  } else if(action?.startsWith("continue:") && !admin) {
    const ticket=Number(action.split(":")[1]);
    const active=id(ticket) && await first(db,"SELECT id FROM support_tickets WHERE id=? AND user_id=? AND status<>'closed'",ticket,user.id);
    if(active) {
      op.add(`UPDATE support_people SET composing=1 WHERE user_id=? AND ${op.gate}`,user.id);
      ui(say(user.id,`<b>Сообщение специалисту · обращение №${ticket}</b>\n\nОтправьте текст или фото следующим сообщением. Оно добавится в текущий диалог.`,keyboard([button("📖 Вернуться к диалогу",`ticket:${ticket}`)])));
    } else ui(say(user.id,"Обращение уже закрыто или недоступно.",keyboard([button("📮 Новый вопрос","contact")],[button("📂 Мои обращения","mine")])));
  } else if(action === "mine" && !admin) {
    const rows=await all(db,"SELECT id,status FROM support_tickets WHERE user_id=? ORDER BY id DESC LIMIT 10",user.id);
    ui(say(user.id,"<b>Мои обращения</b>\n"+(rows.length ? "Выберите обращение." : "Обращений пока нет."),keyboard(...rows.map(t=>[button(`№${t.id} · ${{open:"Ждёт специалиста",waiting:"Диалог открыт",closed:"Закрыто"}[t.status]}`,`ticket:${t.id}`)]),[button("📮 Новый вопрос","contact")])));
  } else if (/^(ticket|hist|msg):/.test(action||"")) {
    const parts=action.split(":");
    const num=Number(parts[1]),before=Number(parts[2]||0);
    if(!id(num) || !Number.isSafeInteger(before) || before<0) ui(say(user.id,"Обращение недоступно."));
    else if(parts[0] === "msg") {
      const m=await first(db,`SELECT m.* FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id
        WHERE m.id=? AND (?=? OR t.user_id=?)`,num,user.id,cfg.admin,user.id);
      if(m) screen("history_message",user.id,{},m.ticket_id,m.id);
      else ui(say(user.id,"Сообщение недоступно."));
    } else ui(await ticketCard(db,num,user.id,cfg.admin,before),await first(db,"SELECT id FROM support_tickets WHERE id=? AND (?=? OR user_id=?)",num,user.id,cfg.admin,user.id) ? num : null);
  } else if (action?.startsWith("queue:") && admin) {
    const [,state,offset]=action.split(":");
    if(/^\d{1,12}$/.test(offset)) ui(await queueCard(db,cfg.admin,state,Number(offset)));
  } else if (action?.startsWith("reply:") && admin) {
    const ticket=Number(action.split(":")[1]);
    const t=id(ticket) && await first(db,"SELECT id FROM support_tickets WHERE id=? AND status<>'closed'",ticket);
    if(t) op.enqueue("prompt",cfg.admin,{},ticket);
    else ui(say(cfg.admin,"Обращение уже закрыто или недоступно."));
  } else if (action?.startsWith("close:") && admin) {
    const ticket=Number(action.split(":")[1]);
    const t=id(ticket) && await first(db,"SELECT id,last_message_id FROM support_tickets WHERE id=? AND status<>'closed'",ticket);
    if(t) ui(say(cfg.admin,`Закрыть обращение №${t.id}? Новое сообщение пользователя потребует повторной проверки.`,keyboard([button("Закрыть обращение",`confirmclose:${t.id}:${t.last_message_id}`)],[button("Вернуться",`ticket:${t.id}`)])),t.id);
    else ui(say(cfg.admin,"Обращение уже закрыто или недоступно."));
  } else if (action?.startsWith("confirmclose:") && admin) {
    const [,tn,mn]=action.split(":"); const ticket=Number(tn), last=Number(mn);
    if(id(ticket) && id(last)) {
      const t=await first(db,"SELECT user_id FROM support_tickets WHERE id=?",ticket);
      if(t) {
        op.add(`INSERT INTO support_events(ticket_id,actor_id,action,update_id,created_at)
          SELECT id,?,'closed',?,? FROM support_tickets WHERE id=? AND last_message_id=? AND status<>'closed' AND ${op.gate}
          AND NOT EXISTS(SELECT 1 FROM support_outbox WHERE ticket_id=? AND kind='staff_message' AND state<>'sent' AND reviewed_at IS NULL)`,cfg.admin,update.update_id,now,ticket,last,ticket);
        op.add(`UPDATE support_tickets SET status='closed',closed_at=?,updated_at=? WHERE id=? AND ${op.gate}
          AND EXISTS(SELECT 1 FROM support_events WHERE update_id=? AND action='closed')`,now,now,ticket,update.update_id);
        screen("closure_result",cfg.admin,{updateId:update.update_id},ticket);
        op.enqueue("closed",t.user_id,{updateId:update.update_id},ticket);
      }
    }
  } else if(action?.startsWith("deliveries:") && admin) {
    const after=Number(action.split(":")[1]);
    if(Number.isSafeInteger(after) && after>=0) {
      const rows=await all(db,"SELECT id,ticket_id,state FROM support_outbox WHERE state IN ('failed','unknown') AND reviewed_at IS NULL AND COALESCE(error_code,'')<>'obsolete' AND kind<>'callback' AND id>? ORDER BY id LIMIT 5",after);
      const keys=rows.map(r=>[...(r.ticket_id?[button(`№${r.ticket_id}`,`ticket:${r.ticket_id}`)]:[]),button(`Проверено · ${r.id}`,`review:${r.id}`)]);
      if(rows.length===5)keys.push([button("Дальше",`deliveries:${rows.at(-1).id}`)]);
      keys.push([button("Очередь","queue:open:0")]);
      ui(say(cfg.admin,`<b>Проверка доставки</b>\n\n${rows.map(r=>`Отправка ${r.id}${r.ticket_id?` · обращение №${r.ticket_id}`:""} · ${r.state==='unknown'?'исход неизвестен':'не доставлено'}`).join("\n")||"Ошибок нет."}\n\nПри неизвестном исходе автоматического повтора нет: сообщение могло дойти. Сначала проверьте результат. Переписка сохранена.`,keyboard(...keys)));
    }
  } else if(action?.startsWith("review:") && admin) {
    const num=Number(action.split(":")[1]);
    if(id(num))ui(say(cfg.admin,"Вы проверили результат этой отправки? Отметка снимет её с очереди ошибок, но не объявит сообщение доставленным и не отправит его повторно.",keyboard([button("Да, проверено",`confirmreview:${num}`)],[button("Вернуться","deliveries:0")])));
  } else if(action?.startsWith("confirmreview:") && admin) {
    const num=Number(action.split(":")[1]);
    if(id(num)) {
      op.add(`INSERT INTO support_events(ticket_id,actor_id,action,update_id,created_at)
        SELECT ticket_id,?,?,?,? FROM support_outbox WHERE id=? AND ticket_id IS NOT NULL AND state IN ('failed','unknown') AND reviewed_at IS NULL AND ${op.gate}`,
        cfg.admin,`delivery_reviewed:${num}`,update.update_id,now,num);
      op.add(`UPDATE support_outbox SET reviewed_at=? WHERE id=? AND state IN ('failed','unknown') AND ${op.gate}`,now,num);
      ui(say(cfg.admin,"Проверка зафиксирована для завершённой отправки. Доставку можно посмотреть в истории обращения.",keyboard([button("Очередь ошибок","deliveries:0")])));
    }
  } else if(action) {
    ui(say(user.id,admin ? "Используйте /admin для очереди обращений." : "Этот раздел недоступен. Используйте /start или /my."));
  } else if(admin) {
    const body=content(message);
    const replied=message.reply_to_message?.message_id;
    const target=id(replied) && await first(db,`SELECT r.ticket_id FROM support_reply_targets r JOIN support_tickets t ON t.id=r.ticket_id
      WHERE r.chat_id=? AND r.telegram_message_id=? AND r.used_update_id IS NULL AND r.expires_at>? AND t.status<>'closed'`,cfg.admin,replied,now);
    if(!body) ui(say(cfg.admin,"Отправьте текст до 2000 символов или фото до 5 МБ с подписью до 700 символов."));
    else if(!target) ui(say(cfg.admin,"Получатель не выбран. Откройте обращение, нажмите «Ответить» и ответьте именно на появившееся сообщение."));
    else {
      op.add(`INSERT INTO support_messages(ticket_id,update_id,direction,body,photo_id,created_at)
        SELECT r.ticket_id,?,'staff',?,?,? FROM support_reply_targets r JOIN support_tickets t ON t.id=r.ticket_id
        WHERE r.chat_id=? AND r.telegram_message_id=? AND r.used_update_id IS NULL AND r.expires_at>? AND t.status<>'closed' AND ${op.gate}
        AND (SELECT COUNT(*) FROM support_messages WHERE ticket_id=t.id) < ?`,
        update.update_id,body.text,body.photo,now,cfg.admin,replied,now,cfg.limits.ticketMessages);
      op.add(`UPDATE support_reply_targets SET used_update_id=? WHERE chat_id=? AND telegram_message_id=? AND ${op.gate}
        AND ${op.messageId} IS NOT NULL`,update.update_id,cfg.admin,replied);
      op.add(`UPDATE support_tickets SET last_message_id=${op.messageId},updated_at=? WHERE id=${op.ticketId} AND ${op.gate}`,now);
      const t=await first(db,"SELECT user_id FROM support_tickets WHERE id=?",target.ticket_id);
      if(t) op.enqueue("staff_message",t.user_id,{},"current","current",`${op.messageId} IS NOT NULL`);
      op.enqueue("staff_saved",cfg.admin,{},"current","current",`${op.messageId} IS NOT NULL`);
      op.enqueue("ui",cfg.admin,say(cfg.admin,"Ответ не сохранён: обращение закрыто или запрос ответа уже использован. Откройте актуальную карточку."),null,null,`${op.messageId} IS NULL`);
    }
  } else {
    const body=content(message);
    const active=await first(db,"SELECT id FROM support_tickets WHERE user_id=? AND status<>'closed'",user.id);
    if(!body) ui(say(user.id,"Можно отправить текст до 2000 символов или фото до 5 МБ с подписью до 700 символов. Документы и голосовые пока не поддерживаются."));
    else if(active) {
      op.add(`INSERT INTO support_messages(ticket_id,update_id,direction,body,photo_id,created_at)
        SELECT id,?,'user',?,?,? FROM support_tickets t WHERE user_id=? AND status<>'closed' AND ${op.gate}
        AND (SELECT COUNT(*) FROM support_messages WHERE ticket_id=t.id) < ?`,
        update.update_id,body.text,body.photo,now,user.id,cfg.limits.ticketMessages);
      op.add(`UPDATE support_people SET composing=0 WHERE user_id=? AND ${op.gate} AND ${op.messageId} IS NOT NULL`,user.id);
      op.add(`DELETE FROM support_drafts WHERE user_id=? AND ${op.gate}`,user.id);
      op.add(`UPDATE support_tickets SET status='open',last_message_id=${op.messageId},updated_at=? WHERE id=${op.ticketId} AND ${op.gate}`,now);
      op.enqueue("user_message",cfg.admin,{},"current","current",`${op.messageId} IS NOT NULL`);
      op.enqueue("received",user.id,{},"current","current",`${op.messageId} IS NOT NULL`);
      op.enqueue("ui",user.id,say(user.id,"Не удалось добавить сообщение. Откройте обращение и попробуйте ещё раз."),null,null,`${op.messageId} IS NULL`);
    } else {
      const intent=matchFAQ(body.text);
      op.add(`INSERT INTO support_drafts(user_id,update_id,body,photo_id,intent_key,created_at,expires_at)
        SELECT ?,?,?,?,?,?,? WHERE ${op.gate}
        ON CONFLICT(user_id) DO UPDATE SET update_id=excluded.update_id,body=excluded.body,photo_id=excluded.photo_id,
          intent_key=excluded.intent_key,escalated_update_id=NULL,created_at=excluded.created_at,expires_at=excluded.expires_at`,
        user.id,update.update_id,body.text,body.photo,intent,now,now+86400);
      op.add(`UPDATE support_people SET composing=0 WHERE user_id=? AND ${op.gate}`,user.id);
      ui(guidedReply(user.id,intent,update.update_id));
    }
  }
  await op.commit();
  return { stored: true };
}

async function render(db, row, admin) {
  const p=JSON.parse(row.payload);
  const edit=p.__edit;
  delete p.__edit;
  if(row.kind === "callback") return {method:"answerCallbackQuery",body:p};
  if(row.kind === "ui" || row.kind === "privacy_notice") return editRequest({method:"sendMessage",body:p},edit);
  const t=await first(db,"SELECT t.*,p.name,p.username FROM support_tickets t JOIN support_people p ON p.user_id=t.user_id WHERE t.id=?",row.ticket_id);
  if(!t) return null;
  if(row.chat_id!==admin && row.chat_id!==t.user_id) throw new Error("delivery_scope");
  const fullName=`${escape(t.name)}${t.username?` · @${escape(t.username)}`:" · без username"}`;
  const title=`<b>Обращение №${t.id}</b>`;
  const nav=keyboard([button("📖 Открыть диалог",`ticket:${t.id}`)]);
  let payload;
  if(row.kind === "prompt") {
    if(row.chat_id!==admin || t.status === "closed") return null;
    payload=say(admin,`✍️ <b>Ответ клиенту · обращение №${t.id}</b>\n👤 ${fullName}\n\nНапишите ответ реплаем на это сообщение. Бот отправит его клиенту и сохранит в общем диалоге.`,{force_reply:true,input_field_placeholder:`Ответ клиенту по обращению №${t.id}`});
  } else if(row.kind === "received") payload=say(row.chat_id,`✅ <b>Сообщение отправлено специалисту</b>\n\nОбращение №${t.id} остаётся открытым. Можете продолжать писать сюда — все сообщения попадут в один диалог.`,keyboard([button("💬 Написать ещё",`continue:${t.id}`)],[button("📖 Открыть диалог",`ticket:${t.id}`)]));
  else if(row.kind === "staff_saved") payload=say(admin,`⏳ <b>Ответ принят</b>\n\nОтправляю его пользователю по обращению №${t.id}. После подтверждённой доставки появится отдельное уведомление.`,nav);
  else if(row.kind === "staff_delivered") payload=say(admin,`✅ <b>Ответ доставлен пользователю</b>\n\nОбращение №${t.id} остаётся открытым. Можно продолжить диалог или дождаться ответа пользователя.`,keyboard([button("✍️ Ответить ещё",`reply:${t.id}`),button("📖 Диалог",`ticket:${t.id}`)],[button("✅ Закрыть",`close:${t.id}`)]));
  else if(row.kind === "closed" || row.kind === "closure_result") {
    const closed=await first(db,"SELECT id FROM support_events WHERE update_id=? AND action='closed' AND ticket_id=?",p.updateId,t.id);
    if(row.kind === "closed" && !closed) return null;
    const markup=row.chat_id===admin ? nav : keyboard([button("📮 Новый вопрос","contact")],[button("📖 История",`ticket:${t.id}`)]);
    payload=say(row.chat_id,closed ? `✅ ${title}\nОбращение закрыто. История сохранена и доступна через /my.` : `⚠️ ${title}\nЗакрытие не выполнено: появилось новое сообщение или ответ ещё не доставлен. Откройте диалог и проверьте его.`,markup);
  } else {
    const m=await first(db,"SELECT * FROM support_messages WHERE id=? AND ticket_id=?",row.message_id,t.id);
    if(!m) return null;
    if(row.kind === "user_message" && row.chat_id!==admin) throw new Error("delivery_scope");
    if(row.kind === "staff_message" && row.chat_id!==t.user_id) throw new Error("delivery_scope");
    const pending=row.chat_id===admin ? await pendingUserMessages(db,t.id) : 0;
    const header=row.chat_id===admin
      ? `${title}\n🔴 <b>Новое сообщение · ${countLabel(pending)}</b>\n👤 ${fullName}`
      : m.direction==='staff' ? `💬 <b>Ответ специалиста · обращение №${t.id}</b>` : `${title}\nВаше сообщение`;
    const markup=row.chat_id===admin && t.status!=='closed'
      ? keyboard([button("✍️ Ответить",`reply:${t.id}`),button("📖 Диалог",`ticket:${t.id}`)],[button("✅ Закрыть",`close:${t.id}`)])
      : row.chat_id===t.user_id && t.status!=='closed'
        ? keyboard([button("✍️ Ответить специалисту",`continue:${t.id}`)],[button("📖 Весь диалог",`ticket:${t.id}`)])
        : nav;
    if(m.photo_id) return editRequest({method:"sendPhoto",body:{chat_id:row.chat_id,photo:m.photo_id,caption:`${header}\n\n${escape(m.body)}`,parse_mode:"HTML",reply_markup:markup}},edit);
    payload=say(row.chat_id,`${header}\n\n${escape(m.body)}`,markup);
  }
  return editRequest({method:"sendMessage",body:payload},edit);
}

function editRequest(request, target) {
  const message_id=Number(target?.message_id);
  if(!id(message_id)) return request;
  const fallback=request;
  if(request.method === "sendMessage") {
    const {chat_id,text,parse_mode,link_preview_options,reply_markup}=request.body;
    if(target.photo) {
      if(Array.from(String(text||"")).length>CAPTION_LIMIT) return fallback;
      return {method:"editMessageCaption",body:{chat_id,message_id,caption:text,parse_mode,...(reply_markup?{reply_markup}:{})},fallback};
    }
    return {method:"editMessageText",body:{chat_id,message_id,text,parse_mode,link_preview_options,...(reply_markup?{reply_markup}:{})},fallback};
  }
  if(request.method === "sendPhoto" && target.photo) {
    const {chat_id,photo,caption,parse_mode,reply_markup}=request.body;
    return {method:"editMessageMedia",body:{chat_id,message_id,media:{type:"photo",media:photo,caption,parse_mode},...(reply_markup?{reply_markup}:{})},fallback};
  }
  return fallback;
}

export async function telegram(env, method, body, fetcher=fetch) {
  try {
    const response=await fetcher(`https://api.telegram.org/bot${env.SUPPORT_BOT_TOKEN}/${method}`,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
      // workerd rejects redirect:"error" before making a request. Never follow redirects.
      signal:AbortSignal.timeout(10000),redirect:"manual",
    });
    if(response.status>=300 && response.status<400) return {state:"unknown",code:"redirect_blocked"};
    let data;
    try { data=await response.json(); } catch { return {state:"unknown",code:"unreadable_response"}; }
    if(response.ok && data.ok===true) return {state:"sent",result:data.result};
    if(data.ok===false && data.error_code===429) return {state:"queued",retry:Math.max(1,Math.min(3600,Number(data.parameters?.retry_after)||30)),code:"rate_limited"};
    if(method.startsWith("editMessage") && data.ok===false && data.error_code===400) {
      if(String(data.description||"").toLowerCase().includes("message is not modified")) return {state:"sent",result:{message_id:body.message_id}};
      return {state:"fallback",code:"edit_rejected"};
    }
    if(data.ok===false && Number(data.error_code)>=400 && Number(data.error_code)<500) return {state:"failed",code:`telegram_${data.error_code}`};
    return {state:"unknown",code:"telegram_unknown"};
  } catch { return {state:"unknown",code:"network_unknown"}; }
}

export async function drainOutbox(env, now=Math.floor(Date.now()/1000), send=telegram, maximum=8) {
  const {admin}=config(env),db=env.SUPPORT_DB;
  const deadline=Date.now()+18000;
  // A process may die after Telegram accepts a message. Never blindly resend it.
  await sql(db,"UPDATE support_outbox SET state='unknown',error_code='interrupted_delivery' WHERE state='sending' AND claimed_at<?",now-120).run();
  for(let n=0;n<maximum;n++) {
    if(Date.now()>=deadline)break;
    const row=await first(db,`UPDATE support_outbox SET state='sending',claimed_at=?,attempts=attempts+1 WHERE id=(
      SELECT o.id FROM support_outbox o WHERE o.state='queued' AND o.ready_at<=?
      AND NOT EXISTS(SELECT 1 FROM support_outbox earlier WHERE earlier.chat_id=o.chat_id AND earlier.id<o.id AND earlier.state IN ('queued','sending'))
      ORDER BY o.id LIMIT 1) AND state='queued' RETURNING *`,now,now);
    if(!row) break;
    let outcome;
    try {
      const request=await render(db,row,admin);
      outcome=request ? await send(env,request.method,request.body) : {state:"failed",code:"obsolete"};
      if(outcome.state==='fallback' && request?.fallback) outcome=await send(env,request.fallback.method,request.fallback.body);
    } catch { outcome={state:"unknown",code:"delivery_processing"}; }
    if(outcome.state==='queued' && row.attempts>=5) outcome={state:"failed",code:"retry_exhausted"};
    if(outcome.state==='sent' && row.kind!=='callback' && !id(outcome.result?.message_id)) outcome={state:"unknown",code:"missing_message_id"};
    const forgetAfterDelivery=outcome.state==='sent' && ["callback","privacy_notice"].includes(row.kind);
    const changes=forgetAfterDelivery
      ? [sql(db,"DELETE FROM support_outbox WHERE id=? AND state='sending'",row.id)]
      : [sql(db,`UPDATE support_outbox SET state=?,telegram_message_id=?,error_code=?,ready_at=? WHERE id=? AND state='sending'`,
        outcome.state,outcome.result?.message_id||null,outcome.code||null,now+(outcome.retry||0),row.id)];
    if(outcome.state==='sent' && row.chat_id===admin && ["prompt","user_message","staff_delivered"].includes(row.kind)) {
      const lifetime=row.kind==="prompt" ? 3600 : 7*86400;
      changes.push(sql(db,`INSERT OR IGNORE INTO support_reply_targets(chat_id,telegram_message_id,ticket_id,expires_at)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM support_tickets WHERE id=? AND status<>'closed')`,admin,outcome.result.message_id,row.ticket_id,now+lifetime,row.ticket_id));
    }
    if(outcome.state==='sent' && row.kind==='staff_message') {
      changes.push(sql(db,"UPDATE support_tickets SET status='waiting' WHERE id=? AND last_message_id=? AND status<>'closed'",row.ticket_id,row.message_id));
      changes.push(sql(db,`INSERT OR IGNORE INTO support_outbox(event_key,chat_id,kind,payload,ticket_id,message_id,ready_at,created_at)
        VALUES(?,?,?,?,?,?,?,?)`,`${row.event_key}:delivered`,admin,"staff_delivered","{}",row.ticket_id,row.message_id,now,now));
    }
    // If persistence fails here, the durable 'sending' row becomes 'unknown' later.
    await db.batch(changes);
  }
}

async function operationalSuccess(env, kind, now=Math.floor(Date.now()/1000)) {
  const column=kind === "drain" ? "last_drain_ok_at" : kind === "maintenance" ? "last_maintenance_ok_at" : null;
  if(!column) throw new Error("invalid_operational_kind");
  await sql(env.SUPPORT_DB,`INSERT INTO support_runtime_health(id,${column},updated_at) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`,now,now).run();
}

async function operationalFailure(env, code, now=Math.floor(Date.now()/1000)) {
  if(!["webhook_drain","scheduled_drain","scheduled_maintenance"].includes(code)) throw new Error("invalid_operational_code");
  await sql(env.SUPPORT_DB,`INSERT INTO support_runtime_health(id,last_failure_at,last_failure_code,failure_count,updated_at)
    VALUES(1,?,?,1,?) ON CONFLICT(id) DO UPDATE SET last_failure_at=excluded.last_failure_at,
    last_failure_code=excluded.last_failure_code,failure_count=support_runtime_health.failure_count+1,
    updated_at=excluded.updated_at`,now,code,now).run();
}

export async function maintenance(env, now=Math.floor(Date.now()/1000)) {
  const {retention}=config(env),db=env.SUPPORT_DB;
  const cutoff=now-retention*86400;
  await db.batch([
    sql(db,"DELETE FROM support_reply_targets WHERE expires_at<?",now),
    sql(db,"DELETE FROM support_drafts WHERE expires_at<?",now),
    sql(db,"DELETE FROM support_tickets WHERE status='closed' AND closed_at<?",cutoff),
    sql(db,"DELETE FROM support_outbox WHERE ticket_id IS NULL AND created_at<? AND state NOT IN ('queued','sending')",now-7*86400),
    sql(db,`DELETE FROM support_people WHERE seen_at<? AND NOT EXISTS(SELECT 1 FROM support_tickets WHERE user_id=support_people.user_id)
      AND NOT EXISTS(SELECT 1 FROM support_outbox WHERE chat_id=support_people.user_id)`,cutoff),
    sql(db,"DELETE FROM support_rate WHERE minute<?",Math.floor(now/60)-1440),
    sql(db,"DELETE FROM support_daily_rate WHERE day<?",Math.floor(now/86400)-7),
    sql(db,"DELETE FROM support_global_rate WHERE minute<?",Math.floor(now/60)-1440),
    sql(db,`UPDATE support_deletion_requests SET user_id=NULL,request_update_id=NULL,status='cancelled',updated_at=?
      WHERE status='pending' AND requested_at<?`,now,now-7*86400),
    sql(db,"DELETE FROM support_deletion_requests WHERE status IN ('completed','cancelled') AND updated_at<?",cutoff),
    sql(db,"DELETE FROM support_updates WHERE (allowed<=0 AND created_at<?) OR created_at<?",now-86400,now-7*86400),
  ]);
}

async function limitedJSON(request) {
  if(!request.body) return null;
  const reader=request.body.getReader(),parts=[];
  let length=0;
  for(;;) {
    const {done,value}=await reader.read(); if(done)break;
    length+=value.byteLength;
    if(length>BODY_LIMIT) {await reader.cancel();throw new Error("body_too_large");}
    parts.push(value);
  }
  const bytes=new Uint8Array(length); let offset=0;
  for(const p of parts) {bytes.set(p,offset);offset+=p.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if(request.method==='GET' && url.pathname==='/health') return Response.json({service:"re-program-support",version:VERSION,enabled:env.SUPPORT_ENABLED==='true'});
    const bridge=await handleAdminSupportBridge(request,env);
    if(bridge){if(supportBridgeNeedsDrain(bridge))ctx.waitUntil((async()=>{try{await drainOutbox(env);}catch{await operationalFailure(env,'webhook_drain');throw new Error('support_bridge_drain_failed');}})());return bridge;}
    if(request.method!=='POST' || url.pathname!=='/webhook')return new Response("Not found",{status:404});
    const secret=env.SUPPORT_WEBHOOK_SECRET;
    if(!secret || request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==secret) return new Response("Not found",{status:404});
    if(env.SUPPORT_ENABLED!=='true')return new Response("Support paused",{status:503});
    try {config(env);}catch{return new Response("Support unavailable",{status:503});}
    if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')||''))return new Response("Invalid content type",{status:415});
    let update;
    try {update=await limitedJSON(request);}catch{return new Response("Invalid update",{status:400});}
    try {
      await processUpdate(env,update);
      ctx.waitUntil((async()=>{
        try {
          await drainOutbox(env);
        } catch {
          await operationalFailure(env,"webhook_drain");
          throw new Error("support_webhook_drain_failed");
        }
      })());
      return new Response("OK");
    } catch {return new Response("Please retry",{status:503});}
  },
  async scheduled(controller,env,ctx) {
    if(env.SUPPORT_ENABLED!=='true')return;
    ctx.waitUntil((async()=>{
      try {
        await drainOutbox(env);
        await operationalSuccess(env,"drain");
      } catch {
        await operationalFailure(env,"scheduled_drain");
        throw new Error("support_scheduled_drain_failed");
      }
      if(Math.floor(controller.scheduledTime/60000)%60===0) {
        try {
          await maintenance(env);
          await operationalSuccess(env,"maintenance");
        } catch {
          await operationalFailure(env,"scheduled_maintenance");
          throw new Error("support_scheduled_maintenance_failed");
        }
      }
    })());
  },
};
