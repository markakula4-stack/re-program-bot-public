import {
  readCabinetRuntimeConfig,
} from "./cabinet-foundation.mjs";
import {
  CABINET_MINI_APP_ROUTES,
  readCabinetMiniAppRuntimeConfig,
} from "./mini-app-cabinet.mjs";

export const CABINET_V140_WIRING_VERSION = "1.4.0-closed.1";
export const CABINET_V140_WIRING_RUNTIME_KEY =
  "__RE_PROGRAM_CABINET_V140_RUNTIME__";

export const CABINET_V140_SHELL_PATH =
  "/mini-app/v1.4.0/partner-cabinet";
export const CABINET_V140_SESSION_PATH =
  "/api/v1.4.0/cabinet/session";
export const CABINET_V140_ASSET_PATHS = Object.freeze([
  "/assets/v1.4.0/partner-cabinet.css",
  "/assets/v1.4.0/partner-cabinet.js",
]);

const CABINET_API_PREFIX = "/api/v1.4.0/cabinet";

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const foundationIsClosed = (config) =>
  config.rolloutMode === "off" &&
  config.masterEnabled === false &&
  config.profileEnabled === false &&
  config.offerEnabled === false &&
  config.applicationEnabled === false &&
  config.exportEnabled === false;

const miniAppIsClosed = (config) =>
  config.rolloutMode === "off" &&
  config.masterEnabled === false &&
  config.shellEnabled === false &&
  config.profileScreenEnabled === false &&
  config.offersScreenEnabled === false &&
  config.applicationsScreenEnabled === false &&
  config.resultsScreenEnabled === false &&
  config.readOnlyRecoveryEnabled === false;

export function getCabinetV140ClosedWiringSnapshot(env = {}) {
  try {
    const foundation = readCabinetRuntimeConfig(env);
    const miniApp = readCabinetMiniAppRuntimeConfig(env);
    const closed = foundationIsClosed(foundation) && miniAppIsClosed(miniApp);
    return deepFreeze({
      service: "re-program-bot",
      version: CABINET_V140_WIRING_VERSION,
      status: closed ? "closed" : "not_ready",
      reason: closed ? "all_switches_off" : "closed_candidate_rejects_enable",
      rollout: "off",
      routeCount: Object.keys(CABINET_MINI_APP_ROUTES).length,
      sessionEndpointPublished: false,
      shellPublished: false,
      assetsPublished: false,
      actionsEnabled: false,
      publicEnabled: false,
      databaseTouched: false,
    });
  } catch {
    return deepFreeze({
      service: "re-program-bot",
      version: CABINET_V140_WIRING_VERSION,
      status: "not_ready",
      reason: "invalid_closed_config",
      rollout: "off",
      routeCount: Object.keys(CABINET_MINI_APP_ROUTES).length,
      sessionEndpointPublished: false,
      shellPublished: false,
      assetsPublished: false,
      actionsEnabled: false,
      publicEnabled: false,
      databaseTouched: false,
    });
  }
}

export function isCabinetV140CandidateRequest(request) {
  let pathname;
  try {
    pathname = new URL(request?.url).pathname;
  } catch {
    return false;
  }
  return pathname === CABINET_API_PREFIX ||
    pathname.startsWith(`${CABINET_API_PREFIX}/`) ||
    pathname === CABINET_V140_SHELL_PATH ||
    CABINET_V140_ASSET_PATHS.includes(pathname);
}

export function concealedCabinetV140Response() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createCabinetV140ClosedWorker(stableWorker) {
  if (!stableWorker || typeof stableWorker !== "object" ||
      typeof stableWorker.fetch !== "function") {
    throw new TypeError("stable Worker fetch handler is required");
  }
  return {
    ...stableWorker,
    async fetch(request, env, ctx) {
      if (!isCabinetV140CandidateRequest(request)) {
        return stableWorker.fetch(request, env, ctx);
      }
      getCabinetV140ClosedWiringSnapshot(env);
      return concealedCabinetV140Response();
    },
  };
}
