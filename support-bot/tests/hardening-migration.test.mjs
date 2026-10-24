import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migration=(name)=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8");

test("final hardening migration is additive, idempotent and preserves legacy conversations",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(migration("0001-support.sql"));
    db.exec(migration("0002-guided-dialogue.sql"));
    db.exec("INSERT INTO support_people(user_id,name,seen_at) VALUES(1,'Legacy user',100)");
    db.exec("INSERT INTO support_tickets(id,user_id,status,created_at,updated_at,last_message_id) VALUES(7,1,'open',100,100,11)");
    db.exec("INSERT INTO support_messages(id,ticket_id,update_id,direction,body,created_at) VALUES(11,7,55,'user','Preserve me',100)");

    db.exec(migration("0003-final-hardening.sql"));
    db.exec(migration("0003-final-hardening.sql"));

    assert.deepEqual(db.prepare("SELECT id,user_id,status FROM support_tickets").all().map(row=>({...row})),[{id:7,user_id:1,status:"open"}]);
    assert.deepEqual(db.prepare("SELECT id,ticket_id,body FROM support_messages").all().map(row=>({...row})),[{id:11,ticket_id:7,body:"Preserve me"}]);
    for(const name of ["support_daily_rate","support_global_rate","support_runtime_health","support_deletion_requests"]) {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(name).n,1);
    }
    for(const name of ["support_ticket_retention","support_outbox_retention","support_update_expiry","support_deletion_admin_queue"]) {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name=?").get(name).n,1);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally {
    db.close();
  }
});
