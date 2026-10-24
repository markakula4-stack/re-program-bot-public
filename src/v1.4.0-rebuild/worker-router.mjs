import { createCabinetHttp } from "./cabinet-http.mjs";
import { drainRebuildOutbox } from './effect-outbox.mjs';
import { runRebuildRetention } from './privacy-runtime.mjs';
import {wrapRebuildPrivacyBinding} from './privacy-binding.mjs';
import {createTelegramCabinet,scopedCabinetBetaEnv} from './telegram-cabinet.mjs';
import {inheritRuntimeContext} from '../v1.4.1/runtime-binding.mjs';
import {drainRuntimeAiRecovery} from '../v1.4.1/service-runtime.mjs';

export function createRebuildWorker(stable, options = {}) {
  if (typeof stable?.fetch !== "function") throw new TypeError("accepted Worker is required");
  const cabinet = createCabinetHttp(options);
  const telegram = createTelegramCabinet(options);
  return Object.freeze({ ...stable,
    async fetch(request, env, ctx) {
      const response = await cabinet(request, scopedCabinetBetaEnv(env), ctx);
      if (response?.ok&&request.method==='POST'&&typeof ctx?.waitUntil==='function') {
        ctx.waitUntil(drainRebuildOutbox(env).catch(()=>({status:'unavailable'})));
      }
      if(response)return response;
      const handled=await telegram(request,env);
      if(handled.response)return handled.response;
      const legacyEnv=inheritRuntimeContext(handled.legacyEnv,
        {...handled.legacyEnv,DB:wrapRebuildPrivacyBinding(env?.DB)});
      return stable.fetch.call(stable,request,legacyEnv,ctx);
    },
    scheduled(controller,env,ctx) {
      stable.scheduled?.call(stable,controller,env,ctx);
      ctx.waitUntil(drainRebuildOutbox(env).catch(()=>({status:'unavailable'})));
      ctx.waitUntil(runRebuildRetention(env).catch(()=>({status:'unavailable'})));
      ctx.waitUntil(drainRuntimeAiRecovery(env).catch(()=>({status:'unavailable'})));
    },
  });
}
