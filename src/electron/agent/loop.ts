/**
 * The bounded tool loop, extracted from ConnectionManager (Phase 2).
 *
 * One turn per iteration: ask the adapter, and if the model emitted tool
 * calls, run each through the ToolsRegistry, append the assistant tool-call
 * turn + the tool results once, and loop. Bounds keep small models from
 * looping away; a final iteration without tool calls ends the turn.
 */

import type { ProtocolAdapter } from "../protocol/adapter";
import type { ChatEvent, ChatMessage, ChatRequest } from "../ipc";
import type { ToolsRegistry } from "./registry";

export interface ToolLoopOptions {
  /** Max model turns (adapter.chat calls) for this chat turn. */
  maxIterations?: number;
  /** Subset of registered tools to advertise; defaults to all registered. */
  toolNames?: string[];
  onMessage?: (m: ChatMessage) => void;
  prepare?: (req: ChatRequest) => ChatRequest;
  automaticRecovery?:boolean;
}

export async function runToolLoop(
  adapter: ProtocolAdapter,
  request: ChatRequest,
  registry: ToolsRegistry,
  emit: (e: ChatEvent) => void,
  opts: ToolLoopOptions = {},
): Promise<ChatMessage> {
  const maxIter = opts.maxIterations ?? 6;
  const tools = request.tools ?? registry.specs(request.toolNames ?? opts.toolNames);

  let messages: ChatMessage[] = [...request.messages];
  let last: ChatMessage = { role: "assistant", content: "" };

  for (let i = 0; i <= maxIter; i++) {
    request.signal?.throwIfAborted();
    emit({ type: "status", message: i ? "Checking tool results…" : "Processing your request…" });
    // Clone messages so the loop can append tool results; advertise the
    // registry's real schemas (req.tools takes precedence over toolNames).
    const round: ChatRequest = {
      ...request,
      messages: [...messages],
      tools: tools.length ? tools : undefined,
      toolNames: tools.length ? undefined : request.toolNames,
    };
    let prepared = opts.prepare?.(round) ?? round;
    // One retry only, before any streamed output or tool side effects.
    let visible = false;
    let writing=false;
    const forward = (event: ChatEvent) => { if(event.type === "token" && !writing){writing=true;emit({type:"status",message:"Writing a response…"});} if (event.type === "token" || event.type === "tool_call") visible = true; emit(event); };
    try { last = await adapter.chat(prepared, forward); }
    catch (err: any) {
      if(!visible && !request.signal?.aborted && opts.automaticRecovery && err?.code==='REASONING_BUDGET') {
        const expanded=opts.prepare?.({...round,maxOutputOverride:Number(prepared.params?.max_tokens??512)*2});
        if(!expanded || Number(expanded.params?.max_tokens)<=Number(prepared.params?.max_tokens))throw err;
        prepared=expanded;emit({type:'status',message:'Giving the model more room to finish its answer…'});
      }else if (visible || request.signal?.aborted || !/fetch failed|ECONNRESET|chat failed (429|502|503|504)/.test(err?.message ?? "")) throw err;
      if(err?.code!=="REASONING_BUDGET")emit({type:"status",message:"Connection interrupted; retrying once…"});
      last = await adapter.chat(prepared, forward);
    }

    const calls = last.toolCalls;
    if (!calls || !calls.length) { opts.onMessage?.(last); return last; }
    if (i === maxIter) throw new Error("Tool iteration budget reached. No further tools were executed; increase the limit in Settings or narrow the task.");
    for (const call of calls) call.id ??= genId();
    opts.onMessage?.(last);

    // Resolve every call in this turn, then append the assistant tool-call
    // message ONCE followed by all tool results. (Re-appending the assistant
    // message per call produced duplicate tool_calls on real backends.)
    const results: ChatMessage[] = [];
    for (const call of calls) {
      request.signal?.throwIfAborted();
      emit({type:"status",message:`Using ${call.name.replace(/^mcp__/, "").replace(/__/g," · ").replace(/_/g," ")}…`});
      let result: string;
      try {
        result = await registry.handle(call.name, normalizeArgs(call.arguments));
      } catch (err: any) {
        result = `tool "${call.name}" errored: ${err?.message ?? err}`;
      }
      emit({ type: "tool_result", result, toolCallId: call.id });
      const message: ChatMessage = { role: "tool", toolCallId: call.id, content: result, toolResult: result };
      results.push(message);
      opts.onMessage?.(message);
    }
    messages = [
      ...messages,
      { role: "assistant", content: last.content, toolCalls: calls },
      ...results,
    ];
  }

  return last;
}

/* ------------------------------ helpers ------------------------------- */

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

function genId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}
