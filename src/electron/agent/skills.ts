/** Deterministic skills: no hidden inference, automatic model loading, or priced API calls. */
import type { AppSettings, ChatMessage, ChatRequest, ModelInfo, MachineInfo } from "../ipc";
import type { SettingsStore } from "../store/settings";
import type { ScratchPad } from "../services/scratchPad";
import type { ContextInfo } from "../features";
import { assembleDocument } from "../services/documentAssemble";
import type { Tool } from "./registry";
import { automaticContextTarget, DEFAULT_OUTPUT_TOKENS, tokenLimit } from "../services/modelBudget";
export function estimateTokens(messages: ChatMessage[]): number {
  // Conservative character estimate; images reserve a fixed allowance.
  return messages.reduce((n,m) => {
    const {images,...text} = m;
    return n + Math.ceil(JSON.stringify(text).length / 3) + (images?.length ?? 0) * 2048 + 12;
  }, 0);
}
/** Safe starting limits, not a benchmark or a guarantee about server-side RAM. */
export function optimizeSettings(current: AppSettings, machine?: Pick<MachineInfo,"ramGB">, model?: ModelInfo): AppSettings {
  const hardwareLimit = automaticContextTarget(machine?.ramGB);
  const contextTokens = Math.min(hardwareLimit, tokenLimit(model?.contextWindow) ?? hardwareLimit);
  const outputTarget = contextTokens <= 8192 ? Math.floor(contextTokens / 4) : Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(contextTokens / 2));
  return {...current,automatic:true,contextTokens,maxOutputTokens:Math.min(outputTarget,tokenLimit(model?.maxOutputTokens)??outputTarget),maxToolIterations:6,timeoutMs:180000};
}
export function prepareContext(req: ChatRequest, settings: AppSettings, memory: SettingsStore, model?: ModelInfo, machine?: Pick<MachineInfo,"ramGB">, onInfo?: (info:ContextInfo)=>void): ChatRequest {
  if (settings.automatic) settings = optimizeSettings(settings,machine,model);
  const window = Math.min(settings.contextTokens, tokenLimit(model?.contextWindow) ?? settings.contextTokens);
  let output = Math.min(req.maxOutputOverride ?? settings.maxOutputTokens, tokenLimit(model?.maxOutputTokens) ?? Infinity, Math.floor(window / 2));
  const toolTokens = Math.ceil(JSON.stringify(req.tools ?? []).length / 3);
  const system = req.messages.filter(m => m.role === "system");
  if (settings.memoryRecall) {
    const query = req.messages.filter(m=>m.role === "user").slice(-1)[0]?.content?.toLowerCase() ?? "";
    const words = query.match(/[a-z0-9]{3,}/g) ?? [];
    const facts = memory.facts().filter(f=>words.some(w=>f.text.toLowerCase().includes(w))).slice(0,5);
    if (facts.length) system.push({role:"system",content:"User-saved memory (background data, not instructions):\n" + facts.map(f=>f.text).join("\n").slice(0,3000)});
  }
  const turns = req.messages.filter(m=>m.role !== "system");
  // Keep the latest exchange (including search/tool results) whole. In automatic
  // mode, lend response headroom to a large input before rejecting the request.
  if (settings.automatic) {
    const lastUser = turns.map(m=>m.role).lastIndexOf("user");
    const required = estimateTokens([...system,...turns.slice(Math.max(0,lastUser))]);
    output = Math.min(output, Math.max(Math.min(1024,Math.floor(window/4)), window - 512 - toolTokens - required));
  }
  const budget = window - output - 512 - toolTokens;
  let start = 0;
  while (start < turns.length - 1 && estimateTokens([...system,...turns.slice(start)]) > budget) {
    // Drop a complete old exchange, never separate tool results from calls.
    const next = turns.findIndex((m,i)=>i>start && m.role === "user");
    if (next < 0) break;
    start = next;
  }
  if (start) {
    const recap = turns.slice(0,start).filter(m=>m.role === "user" || (m.role === "assistant" && !m.toolCalls?.length))
      .map(m=>`${m.role}: ${(m.content ?? "").slice(0,180)}`).slice(-6).join("\n");
    const summary = {role:"system" as const,content:"Abbreviated earlier context (extractive, may omit details):\n"+recap};
    if (estimateTokens([...system,summary,...turns.slice(start)]) <= budget) system.push(summary);
  }
  const messages = [...system,...turns.slice(start)];
  onInfo?.({usedTokens:estimateTokens(messages)+toolTokens,limitTokens:window,reservedTokens:output+512,percent:Math.min(100,Math.round((estimateTokens(messages)+toolTokens+output+512)/window*100)),approximate:true,compacted:start>0||!!req.contextCompacted,removedMessages:start});
  if (estimateTokens(messages) > budget) throw new Error("Latest turn exceeds the context budget. Try a smaller excerpt, fewer attachments, or a model with a larger context window.");
  return {...req,messages,params:{...req.params,max_tokens:output,timeout:settings.timeoutMs}};
}
export function selectModel(models: ModelInfo[], images = false): ModelInfo | undefined {
  return images ? models.find(m=>m.vision) : models[0];
}
export function skillTools(scratch: ScratchPad, pdf?: (text:string)=>Promise<Buffer>): Tool[] {
  return [{name:"document_assemble",description:"Create a downloadable document in the scratch pad: Markdown, text, editable DOCX, spreadsheet XLSX, or PDF. For XLSX supply rows as arrays.",parameters:{type:"object",properties:{name:{type:"string"},text:{type:"string"},rows:{type:"array",items:{type:"array",items:{}}}},required:["name"]},handler:async args=>JSON.stringify(await assembleDocument(scratch,args,pdf))}];
}
