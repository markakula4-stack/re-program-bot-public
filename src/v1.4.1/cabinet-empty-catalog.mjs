import { consumeVerifiedEmptyCabinetCatalogPage } from '../v1.4.0-rebuild/cabinet-service.mjs';
import { readTrustedContext } from './trusted-context.mjs';

// An empty HTTP page discloses no offer. Its proof belongs to the fixed server
// projector and the repository's captured candidate/filter reads, never JSON
// supplied by a client or a count of unrelated legacy system templates.
const boundContexts = new WeakMap();
const fail = () => { throw Object.assign(new Error('untrusted_catalog_projection'),
  {code:'untrusted_catalog_projection',status:403}); };

// A proof is consumed once by the authenticated runtime for this exact result,
// route/cursor and session. Copies and direct selectedKeys=[] have no proof.
export function bindCabinetEmptyCatalogProof({context,legacyContext,route,result}) {
  const source=consumeVerifiedEmptyCabinetCatalogPage(result,legacyContext,route);
  if(!source) return false;
  const facts=readTrustedContext(context),payload=facts.requestPayload;
  if(source.context!==legacyContext ||
      facts.actorKind!=='customer' || facts.channel!=='mini_app' || facts.operation!=='offer.read_public' ||
      facts.telegramId!==legacyContext.telegramId || facts.botId!==legacyContext.botId ||
      facts.verifiedSessionId!==legacyContext.sessionId ||
      !Number.isSafeInteger(legacyContext.expiresAt) || facts.expiresAt>legacyContext.expiresAt ||
      facts.nowSeconds!==source.nowSeconds ||
      payload?.routeCode!=='cabinet.offers' || payload.view!=='catalog' ||
      !Array.isArray(payload.selectedKeys) || payload.selectedKeys.length!==0 ||
      !Array.isArray(result.items) || result.items.length!==0 || result.nextCursor!==null) fail();
  // The trusted context also snapshots the same signed session and source
  // epoch; derivation, serialization and a later request create new handles.
  boundContexts.set(context,Object.freeze({result,key:source.key,legacyContext}));
  return true;
}

export const takeVerifiedEmptyCabinetCatalog = context => {
  if(!boundContexts.has(context)) return false;
  boundContexts.delete(context);
  return true;
};
