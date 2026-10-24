// Policy for the isolated, confirmed owner mode. Only exact values from the
// approved fact bundle may carry a claim; all other text uses neutral wording.
export const AI_PARTNER_OWNER_FACTUALITY_POLICY_VERSION =
  "2026-09-23.owner-confirmed-factuality-v1";

export const AI_PARTNER_OWNER_NEUTRAL_WORDS = Object.freeze([
  "оффер", "оффере", "предложение", "предложения", "предложении",
  "условие", "условия", "условий", "условием", "описание", "детали",
  "деталях", "информация", "информации", "информацию", "сведения",
  "сведений", "источник", "источника", "источнике", "данные", "данным",
  "вариант", "варианты", "обзор", "пример", "тема", "темы", "идея",
  "сценарий", "кадр", "текст", "шаг", "шаги", "черновик", "заголовок",
  "изменённый", "измененный", "партнёр", "партнер", "партнёра",
  "партнера", "проверьте", "проверить", "изучите", "изучить",
  "ознакомьтесь", "уточните", "уточнить", "посмотрите", "смотрите",
  "по", "о", "об", "для", "в", "на", "с", "и", "или", "из", "у",
  "от", "к", "это", "offer", "terms", "details", "review",
  "check", "source", "draft",
]);

const NEUTRAL = new Set(AI_PARTNER_OWNER_NEUTRAL_WORDS);
const PLACEHOLDER = /\{\{fact:[^{}]{1,240}\}\}/gu;
const PRIVATE_DATA = Object.freeze([
  /(?:https?:\/\/|www\.|t\.me\/|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/iu,
  /(?:^|\s)@[A-Za-z0-9_]{5,}\b/u,
  /(?:\+?\d[\d\s()\-]{8,}\d)/u,
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b|\bbot\d{6,}:[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b)/iu,
]);

function policyError(code) {
  const error = new Error("Owner confirmed factuality policy rejected text");
  error.name = "AiPartnerOwnerFactualityError";
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function factValues(bundle) {
  if (!plainObject(bundle) || !Array.isArray(bundle.sources) ||
    bundle.sources.length !== 1) {
    throw policyError("ai_partner_owner_part4_fact_bundle_invalid");
  }
  const values = [];
  const walk = (value, depth = 0) => {
    if (depth > 16) throw policyError("ai_partner_owner_part4_fact_depth_invalid");
    if (value === null) return;
    if (typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean") {
      values.push(String(value).normalize("NFKC").trim().toLocaleLowerCase("ru"));
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (plainObject(value)) {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(bundle.sources[0].facts);
  return values.filter(Boolean);
}

function containsFactValue(value, facts) {
  const text = value.normalize("NFKC").toLocaleLowerCase("ru");
  return facts.some((fact) => {
    if (fact.length >= 4) return text.includes(fact);
    const escaped = fact.replace(/[.*+?^$\{\}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u")
      .test(text);
  });
}

export function assertOwnerPromptDataBoundary(prompt, bundle) {
  if (typeof prompt !== "string" || !prompt.trim() ||
    PRIVATE_DATA.some((pattern) => pattern.test(prompt)) ||
    /\{\{fact:/u.test(prompt) ||
    containsFactValue(prompt, factValues(bundle))) {
    throw policyError("ai_partner_owner_part4_prompt_private_data");
  }
  return prompt;
}

export function assertOwnerProviderPayloadBoundary(payload, bundle) {
  if (!plainObject(payload) || Object.keys(payload).join() !== "messages" ||
    !Array.isArray(payload.messages) || payload.messages.length !== 2 ||
    payload.messages.some((message, index) =>
      !plainObject(message) ||
      Object.keys(message).sort().join() !== "content,role" ||
      message.role !== (index === 0 ? "system" : "user") ||
      typeof message.content !== "string")) {
    throw policyError("ai_partner_owner_part4_provider_payload_invalid");
  }
  const content = payload.messages[1].content;
  if (PRIVATE_DATA.some((pattern) => pattern.test(content)) ||
    containsFactValue(content, factValues(bundle))) {
    throw policyError("ai_partner_owner_part4_provider_private_data");
  }
  return payload;
}

export function assertOwnerDraftClaims(output) {
  if (!plainObject(output)) {
    throw policyError("ai_partner_owner_part4_claim_invalid");
  }
  const walk = (value, depth = 0) => {
    if (depth > 16) throw policyError("ai_partner_owner_part4_claim_invalid");
    if (typeof value === "string") {
      const literal = value.replace(PLACEHOLDER, "").normalize("NFKC")
        .toLocaleLowerCase("ru");
      if (/[\p{C}\p{N}\p{S}]/u.test(literal) ||
        /[^\p{L}\p{M}\s.,!?;:()«»"'—–-]/u.test(literal)) {
        throw policyError("ai_partner_owner_part4_claim_unapproved");
      }
      for (const word of literal.match(/\p{L}+/gu) || []) {
        if (!NEUTRAL.has(word)) {
          throw policyError("ai_partner_owner_part4_claim_unapproved");
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (plainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key !== "format") walk(item, depth + 1);
      }
    } else {
      throw policyError("ai_partner_owner_part4_claim_invalid");
    }
  };
  walk(output);
  return output;
}
