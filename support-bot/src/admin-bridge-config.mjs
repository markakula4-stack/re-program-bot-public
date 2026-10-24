export const SUPPORT_ADMIN_BRIDGE_GLOBAL='__RE_PROGRAM_SUPPORT_ADMIN_BRIDGE__';
export function readSupportAdminBridgeConfiguration() {
  const value=globalThis[SUPPORT_ADMIN_BRIDGE_GLOBAL];
  if(value===undefined)return null;
  if(value&&typeof value==='object'&&!Array.isArray(value)&&value.enabled===false&&Object.keys(value).length===1)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='enabled,key,ownerId,sourceSha'||value.enabled!==true||!Number.isSafeInteger(value.ownerId)||value.ownerId<1||!/^[a-f0-9]{40}$/u.test(value.sourceSha??'')||!/^[a-f0-9]{64}$/u.test(value.key??''))throw new Error('support_bridge_compiled_configuration_invalid');
  return value;
}
