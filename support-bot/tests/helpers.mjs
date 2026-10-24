import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function database() {
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const migrations=["0001-support.sql","0002-guided-dialogue.sql","0003-final-hardening.sql"].map(name=>
    readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8"));
  for(const migration of migrations) sqlite.exec(migration);
  for(const migration of migrations) sqlite.exec(migration);
  class Statement {
    constructor(q,args=[]) {this.q=q;this.args=args;}
    bind(...args) {return new Statement(this.q,args);}
    async first() {return sqlite.prepare(this.q).get(...this.args)||null;}
    async all() {return {success:true,results:sqlite.prepare(this.q).all(...this.args)};}
    async run() {const r=sqlite.prepare(this.q).run(...this.args);return {success:true,meta:{changes:r.changes,last_row_id:r.lastInsertRowid}};}
  }
  const db={
    prepare(q){return new Statement(q);},
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {const rows=[];for(const s of statements)rows.push(sqlite.prepare(s.q).run(...s.args));sqlite.exec("COMMIT");return rows;}
      catch(e){sqlite.exec("ROLLBACK");throw e;}
    },
  };
  return {db,sqlite};
}

export function fixture() {
  const {db,sqlite}=database();
  const env={
    SUPPORT_DB:db,SUPPORT_ENABLED:"true",SUPPORT_PUBLIC_ENABLED:"true",
    SUPPORT_ADMIN_ID:"900",SUPPORT_RETENTION_DAYS:"30",
    SUPPORT_BOT_TOKEN:"123456:test_only_fake_token_never_for_telegram",
    SUPPORT_WEBHOOK_SECRET:"test-only-secret-01234567890123456789",
  };
  let sequence=1,telegramId=1000;
  const user=(n,name=`Person ${n}`,username)=>({id:n,is_bot:false,first_name:name,...(username?{username}:{})});
  const message=(n,text,extra={})=>({update_id:sequence++,message:{message_id:sequence,from:user(n),chat:{id:n,type:"private"},text,...extra}});
  const callback=(n,data,extra={})=>({update_id:sequence++,callback_query:{id:`cb-${sequence}`,from:user(n),data,message:{message_id:99,chat:{id:n,type:"private"},...extra}}});
  const calls=[];
  const send=async (_env,method,body)=>{const result=method==='answerCallbackQuery'?true:method.startsWith('editMessage')?{message_id:body.message_id}:{message_id:telegramId++};calls.push({method,body,result});return {state:"sent",result};};
  const query=(q,...a)=>sqlite.prepare(q).all(...a);
  const one=(q,...a)=>query(q,...a)[0];
  return {env,db,sqlite,user,message,callback,calls,send,query,one};
}
