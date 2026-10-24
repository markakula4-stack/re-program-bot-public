import {materializeReleaseEnv} from './release-config.mjs';
import {readCabinetAdminGate,canonicalCabinetOwnerId,loadCabinetWindowActor} from './cabinet-participants.mjs';
import {reviewedRepositoryFactory,makeQueryBudget} from './storage-factory.mjs';

export const ADMIN_CABINET_MENU_RUNTIME='__RE_PROGRAM_V140_ADMIN_CABINET_MENU_RUNTIME__';
export function createAdminCabinetMenuRuntime({repositoryFactory=reviewedRepositoryFactory,
  clock=()=>Math.floor(Date.now()/1000)}={}) {
  const authorizedButton=async({env,telegramId},adminRemote)=>{
    try {
      const scoped=await materializeReleaseEnv(env),now=clock(),gate=readCabinetAdminGate(scoped,now);
      if(!gate||telegramId!==canonicalCabinetOwnerId(scoped)||
        (adminRemote&&scoped.V141_ADMIN_MINI_APP_ENABLED!=='true'))return null;
      const repo=await repositoryFactory(scoped,{readOnly:true,budget:makeQueryBudget(),accessScope:'admin'});
      await repo.assertCandidateSchema();
      await loadCabinetWindowActor({repo,env:scoped,gate,telegramId,nowSeconds:now});
      await repo.assertReadFence({context:{expiresAt:gate.expiresAt},gate});
      const path=adminRemote?'/v1.4.0/cabinet/admin-cabinet.html':'/v1.4.0/cabinet/';
      return {text:adminRemote?'🎛 Пульт владельца':
        scoped.V141_ADMIN_MINI_APP_ENABLED==='true'?'🧩 Мой кабинет':'🧩 Кабинет администратора',web_app:{url:gate.origin+path}};
    } catch { return null; }
  };
  return Object.freeze({menuButton:input=>authorizedButton(input,false),
    adminMenuButton:input=>authorizedButton(input,true)});
}
export function installAdminCabinetMenuRuntime() {
  if(globalThis[ADMIN_CABINET_MENU_RUNTIME]===undefined)
    globalThis[ADMIN_CABINET_MENU_RUNTIME]=createAdminCabinetMenuRuntime();
}
