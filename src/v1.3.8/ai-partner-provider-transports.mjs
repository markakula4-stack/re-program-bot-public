import {
  AI_GATEWAY_HARD_LIMITS,
} from "./ai-partner-gateway.mjs";

export const AI_PARTNER_DEEPSEEK_CHAT_URL =
  "https://api.deepseek.com/chat/completions";
export const AI_PARTNER_DEEPSEEK_FLASH_MODEL = "deepseek-flash";
export const AI_PARTNER_QWEN_SAFE_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

// Peak pricing is intentionally used for every request so off-peak discounts
// can only create budget headroom, never weaken a monetary ceiling.
export const AI_PARTNER_DEEPSEEK_FLASH_PRICING = Object.freeze({
  version: "2026-09-12.deepseek-v4.1-flash-peak-v1",
  inputMicrousdPerMillion: 300_000,
  cachedInputMicrousdPerMillion: 6_000,
  outputMicrousdPerMillion: 1_200_000,
});

const PROVIDER_USER_ID = /^reai_[0-9a-f]{40}$/;
const MESSAGE_ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 16;
const MAX_MESSAGE_CHARACTERS = 20_000;
const MAX_RESPONSE_CHARACTERS = 40_000;
// Only an actual invocation of these fixed server transports can produce this
// proof. JSON fields such as outcomeKnown cannot manufacture a cost receipt.
const TERMINAL_OUTCOMES = new WeakMap();
function terminalOutcome(value, usage, statusCode, invoked = true, usageKnown = true, estimatedUsage = null) {
  TERMINAL_OUTCOMES.set(value, Object.freeze({ invoked, usageKnown,
    usage: Object.freeze({ ...usage }), statusCode,
    status:value instanceof Error?'failed':'success',
    estimatedUsage:estimatedUsage?Object.freeze({...estimatedUsage}):null }));
  return value;
}
export const readAiProviderTerminalOutcome = value => TERMINAL_OUTCOMES.get(value) ?? null;
export function preserveAiProviderTerminalOutcome(error, source) {
  const outcome = TERMINAL_OUTCOMES.get(source);
  if (!outcome || !error || typeof error !== 'object') return error;
  TERMINAL_OUTCOMES.set(error, outcome);
  return error;
}
function reportedUsageKnown(value) {
  if (!value || typeof value !== 'object') return false;
  const input = value.prompt_tokens ?? value.input_tokens ?? value.inputTokens;
  const output = value.completion_tokens ?? value.output_tokens ?? value.outputTokens;
  const cached = value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ??
    value.cached_input_tokens ?? value.cachedInputTokens ?? 0;
  return [input, output, cached].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000) && cached <= input;
}
const estimatedTokens=value=>Math.max(1,Math.ceil(Array.from(String(value??'')).length/3));
function responseContent(value) {
  const root=value?.result ?? value ?? {},choices=root.choices ?? value?.choices ?? [];
  const content=choices?.[0]?.message?.content ?? choices?.[0]?.text ?? root.response ?? value?.response ?? root.content ?? '';
  return Array.isArray(content)?content.map(part=>typeof part==='string'?part:part?.text??'').join(' '):String(content);
}

function transportError(code, statusCode = null, usage = null) {
  const error = new Error("AI provider transport failed");
  error.code = code;
  if (Number.isInteger(statusCode)) error.statusCode = statusCode;
  if (usage) error.usage = usage;
  return error;
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizeUsage(value = {}) {
  const inputTokens = nonNegativeInteger(
    value.prompt_tokens ?? value.input_tokens ?? value.inputTokens,
  );
  return Object.freeze({
    inputTokens,
    cachedInputTokens: Math.min(
      inputTokens,
      nonNegativeInteger(
        value.prompt_cache_hit_tokens ??
        value.prompt_tokens_details?.cached_tokens ??
        value.cached_input_tokens ??
        value.cachedInputTokens,
      ),
    ),
    outputTokens: nonNegativeInteger(
      value.completion_tokens ?? value.output_tokens ?? value.outputTokens,
    ),
  });
}

function plainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function normalizeMessages(payload) {
  if (!plainObject(payload)) {
    throw transportError("provider_payload_invalid");
  }
  const keys = Object.keys(payload).sort();
  if (keys.length !== 1 || keys[0] !== "messages") {
    throw transportError("provider_payload_contract_denied");
  }
  if (
    !Array.isArray(payload.messages) ||
    payload.messages.length < 1 ||
    payload.messages.length > MAX_MESSAGES
  ) {
    throw transportError("provider_messages_invalid");
  }
  let totalCharacters = 0;
  const messages = payload.messages.map((message) => {
    if (!plainObject(message)) {
      throw transportError("provider_message_invalid");
    }
    const messageKeys = Object.keys(message).sort();
    if (
      messageKeys.length !== 2 ||
      messageKeys[0] !== "content" ||
      messageKeys[1] !== "role"
    ) {
      throw transportError("provider_message_contract_denied");
    }
    const role = String(message.role || "").trim().toLowerCase();
    const content = typeof message.content === "string"
      ? message.content.replace(/\r\n?/g, "\n").trim()
      : "";
    if (
      !MESSAGE_ROLES.has(role) ||
      !content ||
      content.length > MAX_MESSAGE_CHARACTERS ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(content)
    ) {
      throw transportError("provider_message_invalid");
    }
    totalCharacters += content.length;
    return Object.freeze({ role, content });
  });
  if (totalCharacters > AI_GATEWAY_HARD_LIMITS.maximumPayloadCharacters) {
    throw transportError("provider_payload_too_large");
  }
  return Object.freeze(messages);
}

function assertEnvelope(envelope, providerCode) {
  if (!plainObject(envelope)) {
    throw transportError("provider_envelope_invalid");
  }
  if (
    envelope.providerCode !== providerCode ||
    envelope.thinkingEnabled !== false ||
    envelope.internetEnabled !== false ||
    !Array.isArray(envelope.tools) ||
    envelope.tools.length !== 0 ||
    !PROVIDER_USER_ID.test(String(envelope.providerUserId || "")) ||
    !Number.isSafeInteger(envelope.maxOutputTokens) ||
    envelope.maxOutputTokens < 1 ||
    envelope.maxOutputTokens > AI_GATEWAY_HARD_LIMITS.maxOutputTokens
  ) {
    throw transportError("provider_envelope_contract_denied");
  }
  return normalizeMessages(envelope.payload);
}

async function readProviderJson(response) {
  try {
    return await response.json();
  } catch {
    throw transportError(
      "provider_response_invalid",
      Number.isInteger(response?.status) ? response.status : null,
    );
  }
}

function extractProviderContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (
    typeof content !== "string" ||
    !content.trim() ||
    content.length > MAX_RESPONSE_CHARACTERS
  ) {
    throw transportError(
      "provider_empty_response",
      200,
      normalizeUsage(payload?.usage),
    );
  }
  return content.trim();
}

export function buildDeepSeekFlashRequest(envelope) {
  const messages = assertEnvelope(envelope, "deepseek");
  if (
    envelope.providerModel !== AI_PARTNER_DEEPSEEK_FLASH_MODEL ||
    envelope.modelAlias !== "deepseek_flash_dragon"
  ) {
    throw transportError("deepseek_flash_route_denied");
  }
  return Object.freeze({
    model: AI_PARTNER_DEEPSEEK_FLASH_MODEL,
    messages,
    max_tokens: envelope.maxOutputTokens,
    stream: false,
    thinking: Object.freeze({ type: "disabled" }),
    user_id: envelope.providerUserId,
  });
}

export function buildQwenSafeRequest(envelope) {
  const messages = assertEnvelope(envelope, "cloudflare");
  if (envelope.providerModel !== null || envelope.modelAlias !== "qwen_safe") {
    throw transportError("qwen_safe_route_denied");
  }
  return Object.freeze({
    messages,
    max_tokens: envelope.maxOutputTokens,
    stream: false,
  });
}

export function createDeepSeekFlashTransport(env, {
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch transport is required");
  }
  return async function deepseekFlash(envelope, { signal } = {}) {
    const apiKey = String(env?.DEEPSEEK_API_KEY || "").trim();
    let body;
    try {
      if (apiKey.length < 20) throw transportError("deepseek_secret_missing");
      if (signal?.aborted) throw transportError("provider_timeout");
      body = buildDeepSeekFlashRequest(envelope);
    } catch (error) {
      throw terminalOutcome(error, normalizeUsage(), null, false);
    }
    let response;
    try {
      response = await fetchImpl(AI_PARTNER_DEEPSEEK_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (cause?.name === "AbortError") {
        throw transportError("provider_timeout");
      }
      throw transportError("provider_unavailable");
    }
    const payload = await readProviderJson(response);
    const usageKnown=reportedUsageKnown(payload?.usage);
    const usage = normalizeUsage(payload?.usage);
    const failure=error=>usageKnown?terminalOutcome(error,usage,response.status):error;
    if (!response.ok) {
      throw failure(transportError(`provider_http_${response.status}`, response.status, usage));
    }
    const finishReason = String(payload?.choices?.[0]?.finish_reason || "");
    if (finishReason === "insufficient_system_resource") {
      throw failure(transportError("provider_unavailable", 503, usage));
    }
    if (finishReason !== "stop") {
      throw failure(transportError("provider_finish_rejected", 200, usage));
    }
    if (String(payload?.choices?.[0]?.message?.reasoning_content || "").trim()) {
      throw failure(transportError("provider_thinking_contract_violation", 200, usage));
    }
    let content;
    try { content = extractProviderContent(payload); }
    catch (error) { throw failure(error); }
    if (!usageKnown) throw transportError("provider_usage_unknown", response.status);
    return terminalOutcome(Object.freeze({
      content,
      usage,
      statusCode: response.status,
    }), usage, response.status);
  };
}

export function createQwenSafeTransport(env) {
  return async function qwenSafe(envelope, { signal } = {}) {
    let request;
    try {
      if (typeof env?.AI?.run !== "function") throw transportError("provider_unavailable");
      if (signal?.aborted) throw transportError("provider_timeout");
      request = buildQwenSafeRequest(envelope);
    } catch (error) { throw terminalOutcome(error, normalizeUsage(), null, false); }
    let result;
    try {
      result = await env.AI.run(AI_PARTNER_QWEN_SAFE_MODEL, request);
    } catch (cause) {
      if (signal?.aborted || cause?.name === "AbortError") {
        throw transportError("provider_timeout");
      }
      const status = Number(cause?.statusCode ?? cause?.status);
      throw transportError(
        Number.isInteger(status) ? `provider_http_${status}` : "provider_unavailable",
        Number.isInteger(status) ? status : null,
      );
    }
    // A completed response after local cancellation still has real usage.
    // Runtime decides delivery; discarding this response would discard cost.
    const content =
      typeof result?.choices?.[0]?.message?.content === "string"
        ? result.choices[0].message.content
        : typeof result?.response === "string"
          ? result.response
          : typeof result?.content === "string"
            ? result.content
            : "";
    if (!content.trim() || content.length > MAX_RESPONSE_CHARACTERS) {
      throw terminalOutcome(transportError(
        "provider_empty_response",
        200,
        normalizeUsage(result?.usage),
      ), normalizeUsage(result?.usage), 200, true, reportedUsageKnown(result?.usage),
      {inputTokens:estimatedTokens(request.messages.map(m=>`${m.role}: ${m.content}`).join('\n')),outputTokens:estimatedTokens(content)});
    }
    return terminalOutcome(Object.freeze({
      content: content.trim(),
      usage: normalizeUsage(result?.usage),
      statusCode: 200,
    }), normalizeUsage(result?.usage), 200, true, reportedUsageKnown(result?.usage),
    {inputTokens:estimatedTokens(request.messages.map(m=>`${m.role}: ${m.content}`).join('\n')),outputTokens:estimatedTokens(content)});
  };
}

// Existing public request contract: same Qwen,192 output tokens and the current
// sampling fields. Runtime binds the final user message to trusted prompt.
export function createPublicAiQwenTransport(env) {
  return async request=>{
    try {
      if(typeof env?.AI?.run!=='function') throw transportError('provider_unavailable');
      const keys=Object.keys(request??{}).sort().join(',');
      if(keys!=='max_tokens,messages,repetition_penalty,temperature,top_p' || request.max_tokens!==192 ||
          ![0.4,0.55].includes(request.temperature) || ![0.85,0.9].includes(request.top_p) || request.repetition_penalty!==1.05)
        throw transportError('provider_request_contract_denied');
      normalizeMessages({messages:request.messages});
    } catch(error) {throw terminalOutcome(error,normalizeUsage(),null,false);}
    const result=await env.AI.run(AI_PARTNER_QWEN_SAFE_MODEL,request);
    if(!result || typeof result!=='object') throw transportError('provider_response_invalid');
    const usage=result.usage ?? result.result?.usage;
    return terminalOutcome(result,normalizeUsage(usage),200,true,reportedUsageKnown(usage),
      {inputTokens:estimatedTokens(request.messages.map(m=>`${m.role}: ${m.content}`).join('\n')),
        outputTokens:estimatedTokens(responseContent(result))});
  };
}

export function createAiPartnerProviderTransports(env, options = {}) {
  return Object.freeze({
    deepseekFlash: createDeepSeekFlashTransport(env, options),
    qwenSafe: createQwenSafeTransport(env),
  });
}
