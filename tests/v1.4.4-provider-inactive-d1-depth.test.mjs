import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {runPublicPython} from './helpers/public-python.mjs';
import {cabinetSubscriptionFixture} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';

const read=name=>fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
const marker=' AND NOT EXISTS(SELECT 1 FROM subscription_provider_commands inactive\n';
const nested=[`refunded_charge.related_ledger_entry_id=paid_charge.ledger_entry_id AND refunded_charge.entry_type='refund'
      AND refunded_charge.direction='debit' AND refunded_charge.telegram_id=c.telegram_id AND refunded_charge.order_id=paid_charge.order_id
      AND refunded_charge.currency=paid_charge.currency AND refunded_charge.amount_stars=paid_charge.amount_stars
      AND refunded_charge.telegram_payment_charge_id=paid_charge.telegram_payment_charge_id AND refunded_charge.recorded_at<=rejected.received_at`,
 `retained_payment.ledger_entry_id=retained.ledger_entry_id
     AND retained_refund.entry_type='refund' AND retained_refund.direction='debit' AND retained_refund.telegram_id=c.telegram_id
     AND retained_refund.order_id=retained_payment.order_id AND retained_refund.currency=retained_payment.currency
     AND retained_refund.amount_stars=retained_payment.amount_stars AND retained_refund.telegram_payment_charge_id=retained_payment.telegram_payment_charge_id
     AND retained_refund.recorded_at<=rejected.received_at`];
const joins=[['subscription_provider_events rejected',1],[`(SELECT id,actor_id,entity_id,created_at,
   CASE WHEN json_valid(details) THEN details ELSE '{}' END AS diagnostic
   FROM admin_audit_log WHERE action='subscription_provider_diagnostic' AND entity_type='subscription_provider_command') audit`,2],
 ['payment_ledger first',1],['subscription_orders origin',1],['price_book original_price',1],['terms_acceptances consent',1],
 ['subscription_first_recurring_receipts receipt',1],['subscription_payment_links incoming',1],['subscription_orders applied',1],
 ['payment_ledger reversal',1],['payment_refunds refund',1],['subscription_access_grants grant_row',1]];
function closing(sql,start){
 let depth=0,quoted=false;
 for(let i=start;i<sql.length;i++){
  if(sql[i]==="'"){if(quoted&&sql[i+1]==="'"){i++;continue;}quoted=!quoted;}
  else if(!quoted){if(sql[i]==='(')depth++;else if(sql[i]===')'&&--depth===0)return i;}
 }
 throw Error('unbalanced inactive SQL');
}
function conjunctions(expression){
 const parts=[];let depth=0,quoted=false,start=0;
 for(let i=0;i<expression.length;i++){
  if(expression[i]==="'"){if(quoted&&expression[i+1]==="'"){i++;continue;}quoted=!quoted;}
  else if(!quoted){
   if(expression[i]==='(')depth++;else if(expression[i]===')')depth--;
   else if(depth===0&&expression.slice(i,i+3)==='AND'&&!/[\w]/u.test(expression[i-1]??'')&&!/[\w]/u.test(expression[i+3]??'')){
    parts.push(expression.slice(start,i).trim());start=i+3;i+=2;
   }
  }
 }
 parts.push(expression.slice(start).trim());return parts;
}
function leaves(expression){
 const text=expression.trim(),inner=text[0]==='('&&closing(text,0)===text.length-1?text.slice(1,-1):text;
 const parts=conjunctions(inner);if(parts.length>1)return parts.flatMap(leaves);
 return [text];
}
function balanced(rows){
 if(rows.length===1)return rows[0];const mid=Math.floor(rows.length/2);
 return '('+balanced(rows.slice(0,mid))+'\n  AND '+balanced(rows.slice(mid))+')';
}
const python=String.raw`
import json, sqlite3, sys
p=json.load(sys.stdin)
def run(sql,ddl):
 db=sqlite3.connect(':memory:')
 for statement in p['tables']:db.execute(statement)
 db.execute(p['oldTrigger'])
 db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
 assert db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH)==100
 stage='create' if ddl else 'owner_select'
 try:
  if ddl:
   db.executescript(sql)
   stage='trigger_insert'
   columns=[row[1] for row in db.execute('PRAGMA table_info(subscription_package_periods)')]
   db.execute('EXPLAIN INSERT INTO subscription_package_periods ('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',[None]*len(columns)).fetchall()
   value=True
  else:value=db.execute(sql).fetchone()[0]
  return {'ok':True,'value':value}
 except sqlite3.Error as e:return {'ok':False,'stage':stage,'error':str(e)}
 finally:db.close()
print(json.dumps({name:run(p[name],name.endswith('Migration')) for name in
 ['oldMigration','balancedMigration','oldOwner','balancedOwner']}))
`;

test('provider inactive migration and exact owner query preserve predicates within D1 expression depth 100',t=>{
 const migration=read('0075-v1.4.4-provider-inactive-exit.sql');
 const addition=migration.indexOf(marker);assert.ok(addition>=0);
 const opening=migration.indexOf('(',addition),end=closing(migration,opening);
 const where=migration.indexOf('\n  WHERE ',opening)+9;
 let canonical=migration.slice(where,end);
 for(const original of nested){const grouped=balanced(conjunctions(original));assert.ok(canonical.includes(grouped));canonical=canonical.replace(grouped,original);}
 const allPredicates=leaves(canonical);assert.equal(allPredicates.length,153);
 assert.deepEqual(allPredicates.slice(0,2),['c.telegram_id=NEW.telegram_id','c.retired_at IS NULL']);
 const on=allPredicates.slice(2,15),predicates=allPredicates.slice(15);
 assert.equal(createHash('sha256').update(on.join('\nAND\n')).digest('hex'),
  'd85f8753c7c50fd33307f5a9e959b2d7f067ddc8cd905735a08058d76fc741bc','all 13 original INNER JOIN ON checks remain exact');
 assert.equal(predicates.length,138);
 assert.equal(createHash('sha256').update(predicates.join('\nAND\n')).digest('hex'),
  'ce74782d33e7f534823ee8caf5b517015c32da8ce35da3c39c76c2e353cec781',
  'all 138 original inactive predicates, including nested financial guards, remain exact');
 const original=read('0072-v1.4.4-package-contract.sql');
 const oldStart=original.indexOf('CREATE TRIGGER IF NOT EXISTS v144_package_period_binding ');assert.ok(oldStart>=0);
 const oldEnd=original.indexOf("BEGIN SELECT RAISE(ABORT,'v144_package_period_binding_invalid'); END;",oldStart)+
  "BEGIN SELECT RAISE(ABORT,'v144_package_period_binding_invalid'); END;".length;
 const oldTrigger=original.slice(oldStart,oldEnd).replace('CREATE TRIGGER IF NOT EXISTS','CREATE TRIGGER');
 const restored=migration.slice(migration.indexOf('CREATE TRIGGER '),addition-1)+migration.slice(end+1);
 assert.equal(restored,oldTrigger+'\n','all old guards and six reviewed comments remain verbatim');
 let head=migration.slice(opening+1,where-9).replace('\n  CROSS JOIN subscription_billing_contracts c','');
 let offset=0;
 for(const [relation,count] of joins){const source='CROSS JOIN '+relation;assert.ok(head.includes(source));
  head=head.replace(source,'JOIN '+relation+' ON '+on.slice(offset,offset+count).join(' AND '));offset+=count;}
 assert.equal(offset,13);assert.ok(!head.includes('CROSS JOIN'));
 const oldProof=head+'\n  WHERE '+predicates.join('\n  AND ');
 const contractStart=oldTrigger.indexOf(' OR EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE');
 const contractEnd=closing(oldTrigger,oldTrigger.indexOf('(',contractStart));
 const oldMigration='DROP TRIGGER v144_package_period_binding;\n'+oldTrigger.slice(0,contractEnd)+'\n AND NOT EXISTS('+oldProof+')'+oldTrigger.slice(contractEnd);
 const replacement=sql=>sql.replaceAll('NEW.telegram_id','8987576334').replaceAll('NEW.recorded_at','unixepoch()');
 const oldOwner='SELECT EXISTS(SELECT 1 FROM subscription_billing_contracts c WHERE c.telegram_id=8987576334 AND c.retired_at IS NULL AND EXISTS('+replacement(oldProof)+'))';
 const balancedOwner='SELECT EXISTS('+replacement(migration.slice(opening+1,end))+')';
 const f=cabinetSubscriptionFixture(t);
 for(const name of ['0069-v1.4.3-d1-compatibility.sql','0070-v1.4.3-refund-notification.sql','0071-v1.4.3-refund-contract-retirement.sql',
  '0072-v1.4.4-package-contract.sql','0073-v1.4.4-package-payment-review.sql','0074-v1.4.4-package-referral-compatibility.sql'])f.sqlite.exec(read(name));
 const tables=f.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row=>row.sql);
 const child=runPublicPython(['-c',python],{encoding:'utf8',timeout:60000,
  input:JSON.stringify({tables,oldTrigger,oldMigration,balancedMigration:migration,oldOwner,balancedOwner})});
 assert.equal(child.status,0,child.stderr);
 const result=JSON.parse(child.stdout);
 for(const name of ['oldMigration','oldOwner']){
  assert.equal(result[name].ok,false,name);
  assert.match(result[name].error,/Expression tree is too large \(maximum depth 100\)/u,name);
 }
 assert.deepEqual(result.balancedMigration,{ok:true,value:true},JSON.stringify(result));
 assert.deepEqual(result.balancedOwner,{ok:true,value:0},'empty own history fails closed after successful depth-100 compilation');
});
