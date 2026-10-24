import {V143_READINESS_INSTALL_PLAN as PLAN} from './readiness-install-plan.mjs';

const quote=value=>'"'+value.replace(/"/gu,'""')+'"';

// Fixed tables/columns come from the sealed parent schema. VALUES keeps each
// table in its own bounded result row without a 20-term compound SELECT.
// Explicit ordinals retain the existing snapshot/guard ordering in one D1 call.
export function buildReadinessRetainedQueries(){
  const entries=Object.entries(PLAN.retainedColumns).map(([table,columns])=>{
    const groups=[];
    for(let i=0;i<columns.length;i+=16)groups.push('json_array('+columns.slice(i,i+16).map(quote).join(',')+')');
    const sql=`SELECT COALESCE(json_group_array(json(snapshot)),'[]') value FROM
      (SELECT json_array(${groups.join(',')}) snapshot FROM ${quote(table)} ORDER BY ${columns.map(quote).join(',')} LIMIT 16385)`;
    return Object.freeze({table,sql});
  });
  const combined='WITH retained_snapshot(ordinal,table_name,value) AS (VALUES '+
    entries.map(({table,sql},i)=>`(${i},'${table}',(${sql}))`).join(',')+
    ') SELECT table_name,value FROM retained_snapshot ORDER BY ordinal';
  return Object.freeze({entries:Object.freeze(entries),combined});
}
