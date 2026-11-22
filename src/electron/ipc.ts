import type { ContextInfo,Skill,SkillDraft,McpServerInput,McpServerView,CompactResult } from "./features";
/**
 * Shared IPC contract between the Electron main process and the React renderer.
 *
 * The renderer is presentation-only: it never touches Node, the filesystem,
 * ports, or secrets directly. It calls the typed bridge exposed by the preload
 * (see preload.ts) and subscribes to streamed events.
 */

/* ----------------------------- Domain types ----------------------------- */

/** A configured connection to a model server. */
export interface Connection {
  id: string;
  name: string;
  /** e.g. "http://localhost:8000/v1" (base path already includes /v1). */
  url: string;
  /** Auth scheme the backend spoke when we first connected. */
  protocol: "openai" | "anthropic" | "ollama";
  /** Bearer token, if any (stored server-side; never sent to the renderer). */
  auth?: string;
  /** Models learned from this connection. */
  models: ModelInfo[];
  createdAt: string;
  health?: "saved" | "connected" | "unavailable";
  authConfigured?: boolean;
  credentialsSaved?: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  /** Context window reported by the backend, in tokens (may be unknown). */
  contextWindow?: number;
  /** Output limit reported by the backend, when available. */
  maxOutputTokens?: number;
  /** Whether the backend signals vision / OCR support. */
  vision?: boolean;
  /** Whether the backend signals a native OCR model. */
  ocr?: boolean;
}

/** A single chat message in a conversation. */
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  /** Plain text content (already extracted from files, etc.). */
  content?: string;
  /** Image attachments as {type:"image", data: base64, mimeType}. */
  images?: ImagePart[];
  /** Tool calls emitted by an assistant turn (backend-normalized). */
  toolCalls?: ToolCallPart[];
  /** Results of tool calls (role "tool"). */
  toolResult?: string;
  /** For role "tool": the tool_use id this result answers. */
  toolCallId?: string;
}

export interface ImagePart {
  type: "image";
  /** base64-encoded image bytes. */
  data: string;
  mimeType: string;
}

export interface ToolCallPart {
  id?: string;
  name: string;
  /** Raw arguments as the backend delivered them (string or object). */
  arguments: string | Record<string, unknown>;
}

export type Conversation = {
  id: string;
  connectionId: string;
  modelId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export interface FileMeta {
  name: string;
  size: number;
  type: string;
  mtime: string;
  /** Path under the scratch pad (server-side; safe to expose to UI). */
  path: string;
}

/* --------------------------- Connection state --------------------------- */

export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "connecting"; url: string }
  | { status: "connected"; connection: Connection }
  | { status: "error"; message: string };

/* --------------------------- Chat stream events ------------------------- */

export type ChatEvent =
  | { type: "status"; message: string }
  | { type: "context"; info: ContextInfo }
  | { type: "skills"; skills: {id:string;name:string}[] }
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCallPart }
  | { type: "tool_result"; result: string; toolCallId?: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; message: string };

/* ----------------------------- IPC surface ------------------------------ */

/**
 * The typed bridge the renderer calls. Implemented by the preload via
 * contextBridge; declared here so both sides share one contract.
 */
export interface BrowserChatBridge {
  /* --- Connections --- */
  listConnections(): Promise<Connection[]>;
  connect(connection: Omit<Connection, "id" | "createdAt" | "models" | "protocol">): Promise<ConnectionStatus>;
  removeConnection(id: string): Promise<void>;
  /* --- Models --- */
  listModels(connectionId: string): Promise<ModelInfo[]>;
  /* --- Chat --- */
  listConversations(connectionId?: string): Promise<Conversation[]>;
  createConversation(connectionId: string, modelId: string): Promise<Conversation>;
  loadConversation(conversationId: string): Promise<ChatMessage[]>;
  deleteConversation(conversationId: string): Promise<void>;
  /** Stream a chat turn through a sandbox-compatible callback. */
  streamChat(req: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<void>;
  stopChat(): Promise<void>;
  parseFile(name: string): Promise<string>;
  /* --- Files (scratch pad) --- */
  listFiles(): Promise<FileMeta[]>;
  uploadFile(name: string, mimeType: string, size: number, data: ArrayBuffer): Promise<FileMeta>;
  downloadFile(name: string): Promise<string>;
  deleteFile(name: string): Promise<void>;
  /* --- Machine info (skills) --- */
  machineInfo(): Promise<MachineInfo>;
  getSettings(): Promise<AppSettings>;
  optimizeSettings(connectionId?: string, modelId?: string): Promise<{ settings: AppSettings; summary: string }>;
  saveSettings(settings: AppSettings): Promise<void>;
  listFacts(): Promise<Fact[]>;
  saveFact(text: string): Promise<void>;
  deleteFact(id: number): Promise<void>;
  openConfig(): Promise<void>;
  exportConversation(id: string): Promise<string>;
  renameConversation(id:string,title:string):Promise<void>;
  contextPreview(req:ChatRequest):Promise<ContextInfo>;
  compactConversation(id:string):Promise<CompactResult>;
  clearCompaction(id:string):Promise<void>;
  previewSkillUrl(url:string):Promise<SkillDraft>;
  listSkills():Promise<Skill[]>;
  previewSkill(text:string):Promise<SkillDraft>;
  chooseSkillImport(folder:boolean):Promise<SkillDraft|null>;
  addSkill(draft:SkillDraft):Promise<Skill>;
  toggleSkill(id:string,enabled:boolean):Promise<void>;
  removeSkill(id:string):Promise<void>;
  cancelMcpConnection():Promise<void>;
  listMcpServers():Promise<McpServerView[]>;
  saveMcpServer(input:McpServerInput):Promise<McpServerView[]>;
  toggleMcpServer(name:string,enabled:boolean):Promise<McpServerView[]>;
  removeMcpServer(name:string):Promise<McpServerView[]>;
  reconnectMcpServer(name:string,signIn?:boolean):Promise<McpServerView[]>;
  chooseFolder():Promise<string|null>;
  openScratchFile(name:string):Promise<void>;
  saveScratchFile(name:string):Promise<string|null>;
  openLink(url:string):Promise<void>;
  copyText(text:string):Promise<void>;
  credentialStorage():Promise<{persistent:boolean}>;
}

/** A tool the model may call: name, human description, JSON-schema args. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  connectionId: string;
  modelId: string;
  conversationId?: string;
  messages: ChatMessage[];
  /** Full tool schemas to advertise (takes precedence over toolNames). */
  tools?: ToolSpec[];
  /** Legacy: bare tool names (adapters fall back to a stub schema). */
  toolNames?: string[];
  /** Extra parameters forwarded to the backend (temperature, etc.). */
  params?: Record<string, unknown>;
  /** Main-process only; never sent through IPC. */
  signal?: AbortSignal;
  /** undefined = automatic skill matching; [] = no workflow skills. */
  skillIds?: string[];
  /** Main-process metadata, not sent to the backend. */
  contextCompacted?: boolean;
  maxOutputOverride?:number;
}

export interface MachineInfo {
  os: string;
  ramGB: number;
  chip: string;
  gpuCores: number;
  accelerator: string;
  omlxAvailable: boolean;
  omlxEndpoint: string;
  pythonVersion: string;
  localServers: string[];
  suggestedContextWindow: number;
  suggestedQuant: string;
}

export interface AppSettings {
  automatic: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  maxToolIterations: number;
  timeoutMs: number;
  memoryRecall: boolean;
}
export interface Fact { id: number; text: string; source?: string; created_at: string; }

/** Global bridge type injected onto window by the preload. */
declare global {
  interface Window {
    browserChat: BrowserChatBridge;
  }
}
