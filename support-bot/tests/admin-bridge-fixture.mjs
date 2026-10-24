import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SUPPORT_ADMIN_SCHEMA_SQL,SUPPORT_ADMIN_BRIDGE_STATEMENTS} from '../src/admin-bridge-migration.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const configurationGlobal='__RE_PROGRAM_SUPPORT_ADMIN_BRIDGE__';
export async function createAdminSupportFixture(t,{ownerId=900,sourceSha='a'.repeat(40),now=Math.floor(Date.now()/1000),prepare=true}={}) {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0001-support.sql','0002-guided-dialogue.sql','0003-final-hardening.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const baseline=sqlite.prepare(SUPPORT_ADMIN_SCHEMA_SQL).all();
  const baselineHash=hash(JSON.stringify(baseline)),snapshotJson=JSON.stringify(baseline.map(row=>[row.type,row.name,row.tbl_name,row.sql]));
  for(const sql of SUPPORT_ADMIN_BRIDGE_STATEMENTS)sqlite.exec(sql);
  const prepared=sqlite.prepare(SUPPORT_ADMIN_SCHEMA_SQL).all(),preparedHash=hash(JSON.stringify(prepared));
  if(!prepare)sqlite.exec('DROP INDEX support_admin_command_ticket; DROP TABLE support_admin_commands');
  class Statement {
    constructor(q,args=[]){this.q=q;this.args=args;}
    bind(...args){return new Statement(this.q,args);}
    async first(){return sqlite.prepare(this.q).get(...this.args)??null;}
    async all(){return {success:true,results:sqlite.prepare(this.q).all(...this.args),meta:{rows_written:0}};}
    async run(){const result=sqlite.prepare(this.q).run(...this.args);return {success:true,results:[],meta:{changes:result.changes,last_row_id:result.lastInsertRowid}};}
  }
  const db={prepare:q=>new Statement(q),withSession(){return this;},async batch(statements){
    sqlite.exec('BEGIN');try{const result=[];for(const statement of statements){const query=sqlite.prepare(statement.q);if(/^\s*SELECT\b/iu.test(statement.q))result.push({success:true,results:query.all(...statement.args),meta:{changes:0}});else{const row=query.run(...statement.args);result.push({success:true,results:[],meta:{changes:row.changes,last_row_id:row.lastInsertRowid}});}}sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
  // The source is unchanged. The private deployment literals are compiled for
  // this genuine SQLite fixture, like the main Worker bundle's test literals.
  const directory=mkdtempSync(join(tmpdir(),'re-support-admin-test-'));mkdirSync(join(directory,'support-bot/src'),{recursive:true});mkdirSync(join(directory,'src/v1.4.1.1'),{recursive:true});
  for(const name of ['worker.mjs','faq.mjs','admin-bridge.mjs','admin-bridge-config.mjs','admin-bridge-migration.mjs'])writeFileSync(join(directory,'support-bot/src',name),readFileSync(new URL('../src/'+name,import.meta.url),'utf8'));
  writeFileSync(join(directory,'src/v1.4.1.1/admin-release-frame.mjs'),'export const ADMIN_RELEASE_FRAME=Object.freeze('+JSON.stringify({support:{rawSchemaSha256:baselineHash,preparedRawSchemaSha256:preparedHash,schemaSnapshotJson:snapshotJson}})+');\n');
  const configuration=Object.freeze({enabled:true,ownerId,sourceSha,key:'c'.repeat(64)});globalThis[configurationGlobal]=configuration;
  const bridge=await import(pathToFileURL(join(directory,'support-bot/src/admin-bridge.mjs')).href);
  const worker=await import(pathToFileURL(join(directory,'support-bot/src/worker.mjs')).href);
  const env={SUPPORT_DB:db,SUPPORT_ENABLED:'true',SUPPORT_PUBLIC_ENABLED:'true',SUPPORT_ADMIN_ID:String(ownerId),SUPPORT_RETENTION_DAYS:'30',SUPPORT_BOT_TOKEN:'123456:test_only_fake_token_never_for_telegram',SUPPORT_WEBHOOK_SECRET:'test-only-secret-01234567890123456789'};
  const close=()=>{if(globalThis[configurationGlobal]===configuration)delete globalThis[configurationGlobal];sqlite.close();rmSync(directory,{recursive:true,force:true});};t?.after(close);
  const seedTicket=(userId=101,text='Нужна помощь')=>{
    sqlite.prepare("INSERT INTO support_people(user_id,name,username,seen_at) VALUES(?,'Посетитель','visitor',?)").run(userId,now);
    const ticketId=Number(sqlite.prepare('INSERT INTO support_tickets(user_id,created_at,updated_at) VALUES(?,?,?)').run(userId,now,now).lastInsertRowid);
    const messageId=Number(sqlite.prepare("INSERT INTO support_messages(ticket_id,update_id,direction,body,created_at) VALUES(?,?,'user',?,?)").run(ticketId,100+userId,text,now).lastInsertRowid);
    sqlite.prepare('UPDATE support_tickets SET last_message_id=? WHERE id=?').run(messageId,ticketId);return {ticketId,lastMessageId:messageId};
  };
  const signedRequest=async(action,params,patch={})=>{
    const issuedAt=patch.issuedAt??now,requestId=crypto.randomUUID(),body=JSON.stringify({sourceSha,actorId:ownerId,sessionHash:'b'.repeat(64),issuedAt,expiresAt:issuedAt+30,action,params,...patch});
    return new Request('https://re-program-support.internal/internal/re-admin-support/v1',{method:'POST',headers:{'Content-Type':'application/json','X-RE-Bridge-Time':String(issuedAt),'X-RE-Bridge-Request':requestId,'X-RE-Bridge-Signature':await bridge.supportBridgeSignature(configuration.key,issuedAt,requestId,body)},body});
  };
  const call=async(action,params,patch={})=>{const response=await bridge.handleAdminSupportBridge(await signedRequest(action,params,patch),env,{nowSeconds:now});return {response,status:response.status,data:await response.clone().json()};};
  const binding={fetch:request=>bridge.handleAdminSupportBridge(request,env,{nowSeconds:Math.floor(Date.now()/1000)})};
  return {sqlite,db,env,now,configuration,bridge,worker,binding,seedTicket,signedRequest,call,close};
}
