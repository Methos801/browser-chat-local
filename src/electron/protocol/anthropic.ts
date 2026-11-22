/**
 * Anthropic-style adapter: POST /v1/messages with streaming SSE.
 *
 * Covers the Anthropic cloud API, oMLX (Anthropic mode), and LM Studio.
 * Tool calls arrive as content blocks {type:"tool_use", id, name, input};
 * results are sent back as {type:"tool_result", ...}.
 */

import { sseData } from "./sse";
import { extractText,extractToolCalls } from "./adapter";
import type { ProtocolAdapter } from "./adapter";
import type { ChatEvent, ChatMessage, ChatRequest, ModelInfo, ToolCallPart } from "../ipc";

export class AnthropicAdapter implements ProtocolAdapter {
  readonly kind = "anthropic";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private get url() {
    return `${this.baseUrl.replace(/\/$/, "")}/messages`;
  }

  async listModels(): Promise<ModelInfo[]> {
    // Anthropic exposes models at /models (or /v1/models).
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => ({}));
    const items: any[] = data.data ?? [];
    return items.filter((m: any) => !/embed/i.test(m.id ?? "")).map((m: any) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.context }));
  }

  async chat(req: ChatRequest, emit: (e: ChatEvent) => void): Promise<ChatMessage> {
    const body: any = {
      model: req.modelId,
      messages: this.buildMessages(req.messages),
      system: this.buildSystem(req.messages),
      stream: true,
      max_tokens: 1024,
      ...req.params,
    };
    delete body.timeout;
    // Prefer full schemas from the ToolsRegistry; fall back to legacy
    // bare names (stub schema) for backward compatibility.
    if (req.tools && req.tools.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    } else if (req.toolNames && req.toolNames.length) {
      body.tools = req.toolNames.map((name) => ({ name, description: name, input_schema: { type: "object", properties: {} } }));
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
        body.system=(body.system??"")+"\n"+notice;
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
    const blockCalls = new Map<number, number>();
    const inputs = new Map<number, string>();
    for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        const json = safeParse(data);
        if (!json) continue;
        if (json.type === "error") throw new Error(json.error?.message ?? "Backend stream error");

        if (json.type === "content_block_delta") {
          const delta = json.delta ?? {};
          if (delta.type === "thinking_delta" && !reasoningReported){reasoningReported=true;emit({type:"status",message:"Model is reasoning…"});}
          if (delta.type === "text_delta" && delta.text) {
            fullText += delta.text;
            emit({ type: "token", text: delta.text });
          }
          if (delta.type === "input_json_delta") {
            const slot = blockCalls.get(json.index);
            if (slot !== undefined) {
              const raw = (inputs.get(json.index) ?? "") + (delta.partial_json ?? "");
              inputs.set(json.index,raw);
              toolCalls[slot].arguments = raw;
              emit({type:"tool_call",call:{...toolCalls[slot]}});
            }
          }
        } else if (json.type === "content_block_start") {
          const block = json.content_block;
          if (block?.type === "tool_use") {
            blockCalls.set(json.index,toolCalls.length);
            toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? "" });
            emit({ type: "tool_call", call: { id: block.id, name: block.name, arguments: block.input ?? {} } });
          }
        } else if (json.type === "message") {
          // Final message: capture any trailing tool_use not streamed.
          for (const block of json.content ?? []) {
            if (block.type === "tool_use" && !toolCalls.some((t) => t.id === block.id)) {
              toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
            }
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
    const out: any[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      const role = m.role === "tool" ? "user" : m.role;
      const content: any[] = [];
      if (m.role === "tool") content.push({type:"tool_result",tool_use_id:m.toolCallId,content:m.content ?? m.toolResult ?? ""});
      else {
        if (m.content) content.push({type:"text",text:m.content});
        for (const img of m.images ?? []) content.push({type:"image",source:{type:"base64",media_type:img.mimeType,data:img.data}});
        for (const tc of m.toolCalls ?? []) content.push({type:"tool_use",id:tc.id,name:tc.name,input:normalizeArgs(tc.arguments)});
      }
      if (!content.length) continue;
      const prev = out[out.length-1];
      if (prev?.role === role) prev.content.push(...content);
      else out.push({role,content});
    }
    return out;
  }

  private buildSystem(messages: ChatMessage[]): string {
    return messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n");
  }

  private authHeaders() {
    return { "x-api-key": this.apiKey, authorization: `Bearer ${this.apiKey}`, "anthropic-version": "2023-06-01" };
  }
}

/* ------------------------------ helpers ------------------------------- */

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeArgs(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return args ?? {};
}

function genId() {
  return `tooluse_${Math.random().toString(36).slice(2, 10)}`;
}
