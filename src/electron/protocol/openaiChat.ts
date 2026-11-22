/**
 * OpenAI-style adapter: POST /v1/chat/completions with streaming SSE.
 *
 * Covers oMLX (OpenAI mode), LM Studio, and Ollama's OpenAI shim. oMLX
 * abstracts per-family tool-call markup, so we just send standard `tools`
 * and parse the normalized tool_calls array back out.
 */

import { sseData } from "./sse";
import { extractText,extractToolCalls } from "./adapter";
import type { ProtocolAdapter } from "./adapter";
import type { ChatEvent, ChatMessage, ChatRequest, ModelInfo, ToolCallPart } from "../ipc";

export class OpenAIChatAdapter implements ProtocolAdapter {
  readonly kind = "openai";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private get url() {
    return `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => ({}));
    const items: any[] = Array.isArray(data) ? data : data.data ?? [];
    return items.filter((m: any) => !/embed/i.test(m.id ?? "")).map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.context_length,
      maxOutputTokens: m.max_output_tokens,
    }));
  }

  async chat(req: ChatRequest, emit: (e: ChatEvent) => void): Promise<ChatMessage> {
    const body: any = {
      model: req.modelId,
      messages: this.buildMessages(req.messages),
      stream: true,
      ...req.params,
    };
    delete body.timeout;
    // Prefer full schemas from the ToolsRegistry; fall back to legacy
    // bare names (stub schema) for backward compatibility.
    if (req.tools && req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      // Let the model decide whether to call tools.
      if (body.tool_choice === undefined) body.tool_choice = "auto";
    } else if (req.toolNames && req.toolNames.length) {
      body.tools = req.toolNames.map((name) => ({ type: "function", function: toolSchema(name) }));
      if (body.tool_choice === undefined) body.tool_choice = "auto";
    }

    let res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout((req.params?.timeout as number) ?? 120000)]),
    });

    if(!res.ok && res.status===400 && body.tools) {
      const detail=await res.clone().text();
      if(/tool/i.test(detail) && /not support|unsupported|does not|no tool|incompatible|template/i.test(detail)) {
        delete body.tools;delete body.tool_choice;
        const notice='This model cannot use tools. Answer only from the supplied text and state any resulting limitation. Never claim a tool or file operation was performed.';
        body.messages.unshift({role:"system",content:notice});
        emit({type:'status',message:'This model cannot use tools; continuing with the supplied text…'});
        res=await fetch(this.url,{method:'POST',headers:{'content-type':'application/json',...this.authHeaders()},body:JSON.stringify(body),signal:AbortSignal.any([...(req.signal?[req.signal]:[]),AbortSignal.timeout((req.params?.timeout as number)??120000)])});
      }
    }
    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => "");
      throw new Error(`chat failed ${res.status}: ${err.slice(0, 300)}`);
    }

    if(res.headers.get('content-type')?.includes('application/json')) {
      const raw=await res.json();const text=extractText(raw),calls=extractToolCalls(raw);
      if(text)emit({type:'token',text});for(const call of calls)emit({type:'tool_call',call});
      if(!text&&!calls.length)throw Error('The server returned no answer. Try reconnecting or choosing another model.');
      return {role:'assistant',content:text,toolCalls:calls.length?calls:undefined};
    }
    let fullText = "";
    const toolCalls: ToolCallPart[] = [];
    let reasoningReported=false;
    for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        const json = safeParse(data);
        if (json?.error) throw new Error(json.error.message ?? "Backend stream error");
        const delta: any = json?.choices?.[0]?.delta ?? {};
        if ((delta.reasoning_content || delta.reasoning) && !reasoningReported) {reasoningReported=true;emit({type:"status",message:"Model is reasoning…"});}
        if (delta.content) {
          fullText += delta.content;
          emit({ type: "token", text: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // Real backends include `index`; tolerate a missing one by
            // appending so the array actually grows.
            const idx = tc.index ?? (tc.id ? toolCalls.findIndex(t=>t.id === tc.id) : (tc.function?.name ? -1 : toolCalls.length - 1));
            const slot = idx < 0 ? toolCalls.length : idx;
            const existing = toolCalls[slot];
            const merged: ToolCallPart = {
              id: tc.id ?? existing?.id,
              name: tc.function?.name ?? existing?.name ?? "",
              // Accumulate streamed JSON; parse once valid, else keep the raw
              // string. Normalized to an object when complete.
              arguments: mergeArgs(existing?.arguments, tc.function?.arguments ?? ""),
            };
            toolCalls[slot] = merged;
            emit({ type: "tool_call", call: merged });
          }
        }
    }

    if(!fullText.trim()&&!toolCalls.length){
      const error:any=new Error(reasoningReported?'The model used its response allowance while reasoning without finishing an answer. Try a shorter request or another model.':'The server ended the response without an answer. Try again or reconnect.');
      if(reasoningReported)error.code='REASONING_BUDGET';throw error;
    }
    return { role: "assistant", content: fullText, toolCalls: toolCalls.length ? toolCalls : undefined };
  }

  private buildMessages(messages: ChatMessage[]): any[] {
    return messages.map(m=>{
      if (m.role === "tool") return {role:"tool",tool_call_id:m.toolCallId,content:m.content ?? m.toolResult ?? ""};
      const content = m.images?.length ? [ ...(m.content ? [{type:"text",text:m.content}] : []), ...m.images.map(img=>({type:"image_url",image_url:{url:`data:${img.mimeType};base64,${img.data}`}})) ] : (m.content ?? "");
      return {role:m.role,content,...(m.toolCalls?.length ? {tool_calls:m.toolCalls.map(tc=>({id:tc.id,type:"function",function:{name:tc.name,arguments:typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments)}}))} : {})};
    });
  }

  private authHeaders() {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
}

/* ------------------------------ helpers ------------------------------- */

function toolSchema(name: string): { name: string; description: string; parameters: any } {
  return {
    name,
    description: `${name}`,
    parameters: { type: "object", properties: {} },
  };
}

/**
 * Merge a tool-call argument fragment into a single value. Accumulates
 * streamed JSON strings and parses to an object once valid; otherwise keeps
 * the raw (incomplete) string.
 */
function mergeArgs(
  existing: string | Record<string, unknown> | undefined,
  raw: string,
): string | Record<string, unknown> {
  const prev =
    typeof existing === "string"
      ? existing
      : existing && typeof existing === "object"
        ? JSON.stringify(existing)
        : "";
  const combined = prev + raw;
  try {
    return JSON.parse(combined);
  } catch {
    return combined;
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
