/**
 * Protocol adapter: normalizes the four things backends disagree about so the
 * rest of the app is backend-agnostic.
 *
 *  1. Model listing    — /v1/models + /api/tags → {id, name}
 *  2. Chat request     — {model, messages, tools, params} → backend shape
 *  3. Response shape   — OpenAI {choices:[...]} ↔ Anthropic {type:"message",...}
 *  4. Streaming        — unify SSE chunk formats
 *
 * Backends: oMLX (OpenAI *and* Anthropic), Ollama (OpenAI + Anthropic),
 * LM Studio (OpenAI + Anthropic), raw mlx_lm.server (OpenAI), the Anthropic
 * cloud API (Anthropic). oMLX and LM Studio are covered by the two /v1
 * adapters because they use the same endpoints.
 */

import type { ChatEvent, ChatMessage, ChatRequest, ModelInfo, ToolCallPart } from "../ipc";

export type AdapterKind = "openai" | "anthropic" | "ollama";

export interface ProtocolAdapter {
  /** Stable identifier for this adapter (used in diagnostics). */
  readonly kind: AdapterKind;
  /** List the models the backend exposes. */
  listModels(): Promise<ModelInfo[]>;
  /**
   * Run a single (possibly multi-tool-call) chat turn, streaming events.
   * Returns the final assistant message. The loop calls this repeatedly;
   * it handles one request and streams token / tool_call / tool_result / done.
   */
  chat(req: ChatRequest, emit: (e: ChatEvent) => void): Promise<ChatMessage>;
}

/** Minimal HTTP chat request the adapters build on. */
export interface HttpChatRequest {
  method: string;
  path: string;
  body: unknown;
  apiKey?: string;
  timeoutMs?: number;
}

/* --------------------------- Auto-detection ----------------------------- */

/**
 * Probe a connection and lock in the adapter that best matches it.
 *
 * Strategy:
 *  1. Try /v1/models (OpenAI & Anthropic & oMLX & LM Studio) and
 *     /api/tags (Ollama).
 *  2. The native Anthropic host selects the Messages adapter. Local
 *     OpenAI-compatible /models servers select the OpenAI adapter.
 *  3. Connecting never sends an inference request or loads a model.
 */
export async function detectAdapter(
  baseUrl: string,
  apiKey?: string,
): Promise<{ kind: AdapterKind; models: ModelInfo[] }> {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (new URL(trimmed).hostname === "api.anthropic.com") {
    const data = await safeJson<any>(`${trimmed}/models`,apiKey);
    const models = normalizeModels(data);
    if (!models.length) throw new Error("Anthropic model listing failed. Check the API key and base URL.");
    return {kind:"anthropic",models};
  }

  // Ollama exposes /api/tags (and an OpenAI /v1/chat/completions shim).
  const ollamaTags = await safeJson<any>(`${trimmed.replace(/\/v1$/, "")}/api/tags`, undefined);
  const ollamaModels = Array.isArray(ollamaTags?.models)
    ? ollamaTags.models.map((m: any) => ({ id: m.name, name: m.name }))
    : [];

  // /v1/models (OpenAI / Anthropic / oMLX / LM Studio).
  const v1Models = await safeJson<any>(`${trimmed}/models`, apiKey);
  const v1ModelsList = normalizeModels(v1Models);

  if (v1ModelsList.length === 0 && ollamaModels.length === 0) {
    throw new Error(`connection did not expose any models (${trimmed})`);
  }

  // Listing must not trigger inference or load a large/embedding model.
  // Local dual-protocol servers expose the OpenAI shim; the native
  // Anthropic host is identified above without a generation request.
  if (v1ModelsList.length) return {kind:"openai",models:v1ModelsList};

  return { kind: "ollama", models: ollamaModels };
}

/** Normalize a backend's /v1/models payload into {id, name}. */
function normalizeModels(payload: any): ModelInfo[] {
  if (!payload) return [];
  const data: any[] = Array.isArray(payload) ? payload : payload.data ?? [];
  return data
    .map((m: any) => {
      const id = m.id ?? m.name ?? m.model;
      if (!id) return null;
      const base = String(id).split(":")[0];
      return {
        id: String(id),
        name: m.name ?? m.id ?? m.model ?? base,
        contextWindow: typeof m.context_length === "number" ? m.context_length : undefined,
        maxOutputTokens: typeof m.max_output_tokens === "number" ? m.max_output_tokens : undefined,
        vision: !!m.vision || /vision|vlm|ocr|glm-4v|pixtral|deepseek-ocr/.test(base),
        ocr: /ocr/.test(base),
      } as ModelInfo;
    })
    .filter((m): m is ModelInfo => Boolean(m) && !/embed/i.test(m!.id));
}

async function safeJson<T = any>(
  url: string,
  apiKey: string | undefined,
  override?: { method: string; body: unknown },
): Promise<T> {
  try {
    const res = await fetch(url, {
      method: override?.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "anthropic-version":"2023-06-01" } : {}),
      },
      body: override?.body ? JSON.stringify(override.body) : undefined,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null as unknown as T;
    return (await res.json().catch(() => null)) as unknown as T;
  } catch {
    return null as unknown as T;
  }
}

/** Extract a tool call from a backend response (backend-normalized). */
export function extractToolCalls(raw: any): ToolCallPart[] {
  if (!raw) return [];
  const calls: ToolCallPart[] = [];

  // OpenAI: choices[i].message.tool_calls = [{id, function:{name, arguments}}]
  for (const choice of raw.choices ?? []) {
    for (const tc of choice.message?.tool_calls ?? []) {
      let args: string | Record<string, unknown> = tc.function?.arguments ?? "";
      try {
        if (typeof args === "string" && args.trim()) args = JSON.parse(args);
      } catch {
        /* keep raw string */
      }
      calls.push({ id: tc.id, name: tc.function?.name ?? "", arguments: args });
    }
  }

  // Anthropic: content = [{type:"tool_use", id, name, input}]
  if (!calls.length && Array.isArray(raw.content)) {
    for (const block of raw.content) {
      if (block.type === "tool_use") {
        calls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
      }
    }
  }

  return calls;
}

/** Extract plain text from a backend response (backend-normalized). */
export function extractText(raw: any): string {
  if (!raw) return "";
  // Anthropic: content = [{type:"text", text}]
  if (Array.isArray(raw.content)) {
    return raw.content
      .filter((c: any) => c.type === "text" || c.type === "thinking")
      .map((c: any) => c.text ?? "")
      .join("");
  }
  // OpenAI: choices[i].message.content
  return raw.choices?.[0]?.message?.content ?? "";
}
