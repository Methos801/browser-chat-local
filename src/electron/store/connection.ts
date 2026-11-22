/**
 * ConnectionManager: the app's connection registry.
 *
 *  - connect() auto-detects the backend dialect and locks an adapter.
 *  - streamChat() runs the bounded, backend-agnostic tool loop (agent/loop.ts)
 *    against that adapter, routing tool calls through a ToolsRegistry.
 *
 * This is transport-only in Phase 0 — persistence (SQLite) is layered on in
 * Phase 3 via the store. The manager is intentionally free of UI concerns.
 */

import type { AppDb } from "./db";
import { selectModel, prepareContext, estimateTokens, optimizeSettings } from "../agent/skills";
import { DEFAULT_SETTINGS, type SettingsStore } from "./settings";
import type { SkillLibrary } from "./skillLibrary";
import type { ContextStore } from "./context";
import type { SecretStore } from "./secrets";
import type { ContextInfo } from "../features";
import { detectAdapter } from "../protocol/adapter";
import { OpenAIChatAdapter } from "../protocol/openaiChat";
import { AnthropicAdapter } from "../protocol/anthropic";
import { runToolLoop } from "../agent/loop";
import { ToolsRegistry } from "../agent/registry";
import type { AdapterKind } from "../protocol/adapter";
import type { ProtocolAdapter } from "../protocol/adapter";
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  Connection,
  ConnectionStatus,
  ModelInfo,
  MachineInfo,
} from "../ipc";

/** A connection as supplied by the UI: everything except server-derived fields. */
export type NewConnection = Omit<Connection, "id" | "createdAt" | "models" | "protocol"> &
  Partial<Pick<Connection, "id" | "protocol">>;

export interface ConnectionManagerOptions {
  /** The tools the model may call (internal + MCP). Optional: none if absent. */
  registry?: ToolsRegistry;
  /** Max tool-loop iterations (small models loop away). */
  maxIterations?: number;
  db?: AppDb;
  settings?: SettingsStore;
  machine?: MachineInfo;
  library?: SkillLibrary;
  context?: ContextStore;
  secrets?: SecretStore;
}

export class ConnectionManager {
  private connections = new Map<string, Connection>();
  private adapters = new Map<string, ProtocolAdapter>();

  constructor(private opts: ConnectionManagerOptions = {}) {
    for (const row of opts.db?.all<{id:string;name:string;url:string;protocol:AdapterKind;models_json:string;created_at:string}>("SELECT * FROM connections") ?? []) {
      const conn: Connection = {id:row.id,name:row.name,url:row.url,protocol:row.protocol,models:JSON.parse(row.models_json),createdAt:row.created_at,health:"saved"};
      this.connections.set(conn.id,conn);
      this.adapters.set(conn.id,this.buildAdapter(conn.protocol,conn.url,opts.secrets?.get(`model:${conn.id}`)));
    }
  }

  async listConnections(): Promise<Connection[]> {
    return [...this.connections.values()].map(({auth,...safe})=>({...safe,authConfigured:!!(auth||this.opts.secrets?.get(`model:${safe.id}`)),credentialsSaved:!!this.opts.secrets?.persistent}));
  }

  async connect(input: NewConnection): Promise<ConnectionStatus> {
    try {
    const suppliedUrl = /:\/\//.test(input.url) ? input.url : `http://${input.url}`;
    const parsed = new URL(suppliedUrl);
    if (!["http:","https:"].includes(parsed.protocol)) throw new Error("Use an HTTP or HTTPS model server URL");
    const url = suppliedUrl.replace(/\/$/, "") + (parsed.pathname === "/" ? "/v1" : "");
      emitConnecting(url);
      const id=input.id??sanitizeId(input.name+" "+url);
      const auth=input.auth??this.opts.secrets?.get(`model:${id}`);
      const { kind, models } = await detectAdapter(url, auth);
      const adapter = this.buildAdapter(kind, url, auth);

      const connection: Connection = {
        ...input,
        id,
        auth,
        health:"connected",
        url,
        protocol: kind,
        models,
        createdAt: new Date().toISOString(),
      };
      if(auth)this.opts.secrets?.set(`model:${id}`,auth);
      this.connections.set(connection.id, connection);
      this.adapters.set(connection.id, adapter);
      this.opts.db?.run("INSERT OR REPLACE INTO connections (id,name,url,protocol,auth,models_json,created_at) VALUES (?,?,?,?,NULL,?,?)", [connection.id,connection.name,url,kind,JSON.stringify(models),connection.createdAt]);
      const {auth:privateAuth,...safe} = connection;
      return { status: "connected", connection: safe };
    } catch (err: any) {
      return { status: "error", message: err?.message ?? String(err) };
    }
  }

  async removeConnection(id: string): Promise<void> {
    this.opts.secrets?.delete(`model:${id}`);
    this.connections.delete(id);
    this.adapters.delete(id);
    this.opts.db?.run("DELETE FROM connections WHERE id = ?",[id]);
  }

  async listModels(connectionId: string): Promise<ModelInfo[]> {
    const conn = this.connections.get(connectionId);
    if (conn) {
      try {const models = await this.adapters.get(connectionId)!.listModels();
      conn.models = models;conn.health=models.length?"connected":"unavailable";return models;}
      catch(error){conn.health="unavailable";throw error;}
    }
    return [];
  }

  /** Run a chat turn through the bounded tool loop (agent/loop.ts). */
  async streamChat(req: ChatRequest, emit: (e: ChatEvent) => void, onMessage?: (m: ChatMessage) => void): Promise<ChatMessage> {
    const conn = this.connections.get(req.connectionId);
    const adapter = this.adapters.get(req.connectionId);
    if (!conn || !adapter) {
      throw new Error(`no active connection: ${req.connectionId}`);
    }
    if (!req.modelId) {
      const selected = selectModel(conn.models,req.messages.some(m=>!!m.images?.length));
      if (!selected) throw new Error("Choose an available model for this message");
      req = {...req,modelId:selected.id};
    }
    const registry = this.opts.registry ?? new ToolsRegistry();
    emit({type:"status",message:"Preparing your request…"});
    if(this.opts.context && req.conversationId && req.messages.filter(m=>m.role==='user').length>1) {
      const preview=this.previewContext(req);
      if(preview.compacted || preview.percent>=85) {
        emit({type:"status",message:"Compacting earlier context; full history is kept…"});
        await this.opts.context.compact(req,messages=>this.summarize({...req,messages}));
      }
    }
    let contextual=this.opts.context?.apply(req)??req;
    if(this.opts.library){const applied=this.opts.library.apply(contextual,registry);contextual=applied.request;emit({type:"skills",skills:applied.skills.map(s=>({id:s.id,name:s.name}))});}
    return runToolLoop(adapter, contextual, registry, emit, {
      maxIterations: this.opts.settings?.get().maxToolIterations ?? this.opts.maxIterations ?? 6,
      onMessage,
      automaticRecovery:this.opts.settings?.get().automatic,
      prepare: this.opts.settings ? round => prepareContext(round,this.opts.settings!.get(),this.opts.settings!,conn.models.find(m=>m.id === req.modelId),this.opts.machine,info=>emit({type:"context",info})) : undefined,
    });
  }

  previewContext(req:ChatRequest):ContextInfo {
    let contextual=this.opts.context?.apply(req)??req;
    if(this.opts.library)contextual=this.opts.library.apply(contextual,this.opts.registry??new ToolsRegistry()).request;
    const model=this.connections.get(req.connectionId)?.models.find(m=>m.id===req.modelId);
    let info:ContextInfo|undefined;
    try {prepareContext(contextual,this.opts.settings?.get()??DEFAULT_SETTINGS,this.opts.settings??({facts:()=>[]} as any),model,this.opts.machine,value=>{info=value;});}
    catch(error){if(!info)throw error;}
    if(contextual.contextCompacted)info!.summary=contextual.messages.find(m=>m.content?.startsWith("Earlier conversation summary"))?.content?.split("\n").slice(1).join("\n");
    return info!;
  }

  async summarize(req:ChatRequest):Promise<string> {
    const adapter=this.adapters.get(req.connectionId);
    if(!adapter)throw Error('Reconnect the model server to compact.');
    const model=this.connections.get(req.connectionId)?.models.find(m=>m.id===req.modelId);
    const config=optimizeSettings(this.opts.settings?.get()??DEFAULT_SETTINGS,this.opts.machine,model);
    const cap=Math.max(1200,Math.floor(config.contextTokens*1.3));
    const messages=req.messages.map(m=>({...m,content:m.content?.slice(-cap)}));
    const result=await adapter.chat({...req,messages,tools:[],toolNames:[],params:{max_tokens:Math.min(768,Math.floor(config.contextTokens/4)),timeout:60000}},()=>{});
    return result.content??'';
  }

  private buildAdapter(kind: AdapterKind, url: string, apiKey?: string): ProtocolAdapter {
    switch (kind) {
      case "anthropic":
        return new AnthropicAdapter(url, apiKey ?? "");
      case "openai":
      default:
        return new OpenAIChatAdapter(url, apiKey);
    }
  }
}

/* ------------------------------ helpers ------------------------------- */

function emitConnecting(url: string) {
  // No-op: status is surfaced by the caller via emit().
  void url;
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "conn";
}
