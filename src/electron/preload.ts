/**
 * Preload bridge: exposes a minimal, typed IPC API to the renderer.
 *
 * The renderer never touches Node, the filesystem, ports, or secrets. It
 * calls the bridge and subscribes to streamed events.
 *
 * Request/response channels -> ipcRenderer.invoke.
 * Streaming channels -> webContents.send on `stream:<id>`.
 */

import { contextBridge, ipcRenderer } from "electron";
import type {
  BrowserChatBridge,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  Connection,
  ConnectionStatus,
  Conversation,
  FileMeta,
  MachineInfo,
  ModelInfo,
} from "./ipc";

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function streamChat(req: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<void> {
  // contextBridge cannot clone an AsyncGenerator. Functions and Promises are supported.
  const streamId = `stream_${genId()}`;
  let handler: (_e: unknown, event: ChatEvent) => void;
  try {
    await new Promise<void>((resolve,reject)=>{
      handler = (_e,event)=>{
        onEvent(event);
        if (event.type === "done" || event.type === "error") resolve();
      };
      ipcRenderer.on(`stream:${streamId}`,handler);
      void ipcRenderer.invoke("openStream",streamId,req).catch(reject);
    });
  } finally {
    ipcRenderer.removeAllListeners(`stream:${streamId}`);
    await ipcRenderer.invoke("closeStream",streamId).catch(()=>{});
  }
}

const bridge: BrowserChatBridge = {
  listConnections: () => ipcRenderer.invoke("listConnections"),
  connect: (c) => ipcRenderer.invoke("connect", c),
  removeConnection: (id) => ipcRenderer.invoke("removeConnection", id),

  listModels: (connectionId) => ipcRenderer.invoke("listModels", connectionId),

  listConversations: (connectionId?) => ipcRenderer.invoke("listConversations", connectionId),
  createConversation: (connectionId, modelId) =>
    ipcRenderer.invoke("createConversation", connectionId, modelId),
  loadConversation: (conversationId) => ipcRenderer.invoke("loadConversation", conversationId),
  deleteConversation: (conversationId) => ipcRenderer.invoke("deleteConversation", conversationId),

  streamChat,
  stopChat: () => ipcRenderer.invoke("stopChat"),
  parseFile: name => ipcRenderer.invoke("parseFile",name),

  listFiles: () => ipcRenderer.invoke("listFiles"),
  uploadFile: (name, mimeType, size, data) =>
    ipcRenderer.invoke("uploadFile", name, mimeType, size, data),
  downloadFile: (name) => ipcRenderer.invoke("downloadFile", name),
  deleteFile: (name) => ipcRenderer.invoke("deleteFile", name),

  machineInfo: () => ipcRenderer.invoke("machineInfo"),
  getSettings: () => ipcRenderer.invoke("getSettings"),
  optimizeSettings: (id,model) => ipcRenderer.invoke("optimizeSettings",id,model),
  saveSettings: value => ipcRenderer.invoke("saveSettings",value),
  listFacts: () => ipcRenderer.invoke("listFacts"),
  saveFact: text => ipcRenderer.invoke("saveFact",text),
  deleteFact: id => ipcRenderer.invoke("deleteFact",id),
  openConfig: () => ipcRenderer.invoke("openConfig"),
  exportConversation: id => ipcRenderer.invoke("exportConversation",id),
  renameConversation: (...args: any[]) => ipcRenderer.invoke("renameConversation",...args),
  contextPreview: (...args: any[]) => ipcRenderer.invoke("contextPreview",...args),
  compactConversation: (...args: any[]) => ipcRenderer.invoke("compactConversation",...args),
  clearCompaction: (...args: any[]) => ipcRenderer.invoke("clearCompaction",...args),
  previewSkillUrl: (url:string) => ipcRenderer.invoke("previewSkillUrl",url),
  listSkills: (...args: any[]) => ipcRenderer.invoke("listSkills",...args),
  previewSkill: (...args: any[]) => ipcRenderer.invoke("previewSkill",...args),
  chooseSkillImport: (...args: any[]) => ipcRenderer.invoke("chooseSkillImport",...args),
  addSkill: (...args: any[]) => ipcRenderer.invoke("addSkill",...args),
  toggleSkill: (...args: any[]) => ipcRenderer.invoke("toggleSkill",...args),
  removeSkill: (...args: any[]) => ipcRenderer.invoke("removeSkill",...args),
  cancelMcpConnection: () => ipcRenderer.invoke("cancelMcpConnection"),
  listMcpServers: (...args: any[]) => ipcRenderer.invoke("listMcpServers",...args),
  saveMcpServer: (...args: any[]) => ipcRenderer.invoke("saveMcpServer",...args),
  toggleMcpServer: (...args: any[]) => ipcRenderer.invoke("toggleMcpServer",...args),
  removeMcpServer: (...args: any[]) => ipcRenderer.invoke("removeMcpServer",...args),
  reconnectMcpServer: (...args: any[]) => ipcRenderer.invoke("reconnectMcpServer",...args),
  chooseFolder: (...args: any[]) => ipcRenderer.invoke("chooseFolder",...args),
  openScratchFile: (...args: any[]) => ipcRenderer.invoke("openScratchFile",...args),
  saveScratchFile: (...args: any[]) => ipcRenderer.invoke("saveScratchFile",...args),
  openLink: url=>ipcRenderer.invoke("openLink",url),
  copyText: text=>ipcRenderer.invoke("copyText",text),
  credentialStorage: (...args: any[]) => ipcRenderer.invoke("credentialStorage",...args),
};

contextBridge.exposeInMainWorld("browserChat", bridge);
