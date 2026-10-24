// Request-local compatibility for the accepted deletion transaction. Its
// conversion FK requires an anonymous parent before the old UPDATE executes.
// The accepted Worker file and every historical table definition stay intact.
const CONVERSION_ANONYMIZATION=`UPDATE conversions
  SET telegram_id = CASE WHEN telegram_id = ? THEN ? ELSE telegram_id END,
      inviter_id = CASE WHEN inviter_id = ? THEN NULL ELSE inviter_id END,
      updated_at = CURRENT_TIMESTAMP
  WHERE telegram_id = ? OR inviter_id = ?`;
const normalize=sql=>sql.trim().replace(/\s+/gu,' ');
const expected=normalize(CONVERSION_ANONYMIZATION);
// Schema initialization may share readiness for wrappers of the same binding,
// but never for a different database. This alias carries no actor or authority.
const schemaBindings=new WeakMap();
export const canonicalRebuildPrivacyBinding=binding=>schemaBindings.get(binding)??binding;
export function wrapRebuildPrivacyBinding(binding) {
  if(!binding?.prepare||!binding?.batch)return binding;
  const records=new WeakMap();
  const wrapStatement=(native,sql,params=[])=>{
    const statement={bind(...values){return wrapStatement(native.bind(...values),sql,values);},
      first(...args){return native.first(...args);},all(...args){return native.all(...args);},
      run(...args){return native.run(...args);},raw(...args){return native.raw(...args);}};
    records.set(statement,{native,sql,params});return statement;
  };
  const wrap=raw=>{
    const result={
    prepare(sql){return wrapStatement(raw.prepare(sql),sql);},
    async batch(statements){
      const known=statements.map(s=>records.get(s));
      const guards=known.filter(r=>r&&r.sql.startsWith('INSERT INTO mini_app_privacy_guard(guard_key,subject_id,')&&r.sql.includes("'subject_deletion'"));
      const updates=known.filter(r=>r&&normalize(r.sql)===expected);
      const native=statements.map((s,i)=>known[i]?.native??s);
      if(guards.length||updates.length){
        // Only an exact accepted conversion update plus this request's guarded
        // deletion extension permits the compatibility insertion.
        if(guards.length===1&&updates.length===1){
          const guard=guards[0],update=updates[0],subject=guard.params[1],requestId=guard.params[2],anonymous=update.params[1];
          if(!Number.isSafeInteger(subject)||subject<1||typeof requestId!=='string'||
            !Number.isSafeInteger(anonymous)||anonymous>=0||update.params.length!==5||
            [0,2,3,4].some(i=>update.params[i]!==subject))throw new Error('privacy_compatibility_authority_invalid');
          // Anonymous row: no identity, role, access, contact or referral parent.
          // It is inserted in the SAME batch and vanishes on any later failure.
          native.unshift(raw.prepare(`INSERT INTO users(telegram_id,referral_code,is_blocked,accepted_terms)
            SELECT ?,?,1,0 WHERE EXISTS(SELECT 1 FROM privacy_deletion_requests
              WHERE request_id=? AND telegram_id=? AND status='pending' AND unixepoch(expires_at)>unixepoch())
              AND NOT EXISTS(SELECT 1 FROM partner_profiles WHERE telegram_id=?)`)
            .bind(anonymous,'privacy_anonymous_'+String(-anonymous),requestId,subject,subject));
        }
      }
      return raw.batch(native);
    },
    };
    if(typeof raw.withSession==='function')result.withSession=mode=>wrap(raw.withSession(mode));
    for(const name of ['exec','dump','getBookmark'])if(typeof raw[name]==='function')result[name]=(...args)=>raw[name](...args);
    schemaBindings.set(result,canonicalRebuildPrivacyBinding(raw));
    return result;
  };return wrap(binding);
}
