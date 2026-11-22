/**
 * Electron main process — owns all logic:
 *  - HTTP to model servers (via the ConnectionManager + protocol adapters)
 *  - The bounded tool loop
 *  - File I/O (scratch pad) & machine-info probing
 *
 * The renderer never touches Node / fs / ports / secrets.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, clipboard } from "electron";
import { existsSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { AppDb } from "./store/db";
import { ConversationStore } from "./store/conversations";
import { SecretStore } from "./store/secrets";
import { SkillLibrary,parseSkill,readSkillFolder } from "./store/skillLibrary";
import { localRunner } from "./services/localRunner";
import { ContextStore } from "./store/context";
import { escapeXml } from "./services/documentAssemble";
import { SettingsStore } from "./store/settings";
import { parseDocument } from "./services/documentParse";
import { optimizeSettings, skillTools } from "./agent/skills";
import { join } from "node:path";
import { ConnectionManager } from "./store/connection";
import { ScratchPad } from "./services/scratchPad";
import { probeMachineInfo } from "./services/machineInfo";
import { ToolsRegistry } from "./agent/registry";
import { buildInternalTools } from "./agent/internalTools";
import { McpManager } from "./agent/mcp";
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  Connection,
  Conversation,
  FileMeta,
  MachineInfo,
} from "./ipc";

// __dirname is provided by Node in the CommonJS main process.
const UI_DIR = join(__dirname, "..", "src", "ui");

// Per-stream abort controllers, hoisted so runStream() can reach them.
const streams = new Map<string, AbortController>();

// MCP clients, closed at app quit.
let mcp: McpManager | null = null;
let db: AppDb;
let history: ConversationStore;
let settings: SettingsStore;
let configPath: string;
let machine: MachineInfo;
let secrets: SecretStore;
let library: SkillLibrary;
let context: ContextStore;
let registry: ToolsRegistry;
let mcpChanging=false;
let startupMcp:Promise<void>=Promise.resolve();
const busyConversations = new Set<string>();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#0d0d0d",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(join(UI_DIR, "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; streams.forEach(c=>c.abort()); });
}

/* --------------------------- IPC wiring ------------------------------ */

function registerIpc(mgr: ConnectionManager, scratch: ScratchPad) {
  const editable = () => {if(streams.size || busyConversations.size)throw Error("Finish or stop the active response before changing tools or context.");};
  const reloadTools = async (name:string,change:()=>void,interactiveName?:string) => {
    editable();if(mcpChanging)throw Error("A tool connection is already being updated.");mcpChanging=true;
    try{await startupMcp;change();await mcp!.disconnect(name);registry.removePrefix(`mcp__${name}__`);for(const tool of await mcp!.connectAll(undefined,interactiveName,name))registry.register(tool);await db.flush();return mcp!.list();}
    finally{mcpChanging=false;}
  };
  ipcMain.handle('listMcpServers',()=>mcp!.list());
  ipcMain.handle('saveMcpServer',(_e,input)=>reloadTools(input.name,()=>mcp!.save(input),input.oauth?input.name:undefined));
  ipcMain.handle('toggleMcpServer',(_e,name,enabled)=>reloadTools(name,()=>mcp!.toggle(name,enabled),enabled?name:undefined));
  ipcMain.handle('removeMcpServer',(_e,name)=>reloadTools(name,()=>mcp!.remove(name)));
  ipcMain.handle('reconnectMcpServer',(_e,name,signIn)=>reloadTools(name,()=>{},signIn?name:undefined));
  ipcMain.handle('cancelMcpConnection',()=>mcp!.cancelSignIn());
  ipcMain.handle('copyText',(_e,text:string)=>clipboard.writeText(text));
  ipcMain.handle('openLink',(_e,url:string)=>{if(!['http:','https:'].includes(new URL(url).protocol))throw Error('Only web links can be opened.');return shell.openExternal(url);});
  ipcMain.handle('credentialStorage',()=>({persistent:secrets.persistent}));
  ipcMain.handle('listSkills',()=>library.list());
  ipcMain.handle('previewSkillUrl',async(_e,raw:string)=>{
    let url=new URL(raw.trim());
    if(url.protocol!=='https:'||url.username||url.password)throw Error('Paste an HTTPS link to a public SKILL.md file.');
    if(url.hostname==='github.com'&&url.pathname.includes('/blob/'))url=new URL('https://raw.githubusercontent.com/'+url.pathname.slice(1).replace('/blob/','/'));
    const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
    if(response.url&&new URL(response.url).protocol!=='https:')throw Error('The skill link must stay on HTTPS.');
    if(!response.ok)throw Error(`Could not read this skill (${response.status}). Use a public file link, or import the downloaded file.`);
    const reader=response.body?.getReader();if(!reader)throw Error('The skill link returned an empty file.');
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>60000)throw Error('This file is too large. Paste a link to SKILL.md itself.');chunks.push(value);}}finally{await reader.cancel();}
    return parseSkill(Buffer.concat(chunks).toString('utf8'),url.toString());
  });
  ipcMain.handle('previewSkill',(_e,text:string)=>parseSkill(text));
  ipcMain.handle('chooseSkillImport',async(_e,folder:boolean)=>{
    const selected=await dialog.showOpenDialog(mainWindow!,{title:folder?'Choose a skill folder':'Choose SKILL.md',properties:[folder?'openDirectory':'openFile'],...(!folder?{filters:[{name:'Skill instructions',extensions:['md']}]}:{})});
    if(selected.canceled)return null;const path=selected.filePaths[0];
    return folder?readSkillFolder(path):parseSkill(readFileSync(path,'utf8'),path);
  });
  ipcMain.handle('addSkill',(_e,draft)=>{editable();return library.add(draft);});
  ipcMain.handle('toggleSkill',(_e,id,enabled)=>{editable();library.toggle(id,enabled);});
  ipcMain.handle('removeSkill',(_e,id)=>{editable();library.remove(id);});
  ipcMain.handle('contextPreview',(_e,req)=>mgr.previewContext(req));
  ipcMain.handle('compactConversation',async(_e,id:string)=>{
    editable();const conv=history.get(id);if(!conv)throw Error('Conversation not found');busyConversations.add(id);
    try{const req={connectionId:conv.connectionId,modelId:conv.modelId,conversationId:id,messages:history.load(id)};return await context.compact(req,messages=>mgr.summarize({...req,messages}));}
    finally{busyConversations.delete(id);}
  });
  ipcMain.handle('clearCompaction',(_e,id:string)=>{editable();context.clear(id);});
  ipcMain.handle('renameConversation',(_e,id:string,title:string)=>history.rename(id,title));
  ipcMain.handle('chooseFolder',async()=>{const chosen=await dialog.showOpenDialog(mainWindow!,{properties:['openDirectory']});return chosen.canceled?null:chosen.filePaths[0];});
  const fileByName=(name:string)=>{const file=scratch.list().find(f=>f.name===name);if(!file)throw Error('Scratch file not found');return file;};
  ipcMain.handle('openScratchFile',async(_e,name:string)=>{const message=await shell.openPath(fileByName(name).path);if(message)throw Error(message);});
  ipcMain.handle('saveScratchFile',async(_e,name:string)=>{const file=fileByName(name);const chosen=await dialog.showSaveDialog(mainWindow!,{defaultPath:file.name});if(chosen.canceled||!chosen.filePath)return null;copyFileSync(file.path,chosen.filePath);return chosen.filePath;});
  // --- Connections ---
  ipcMain.handle("listConnections", () => mgr.listConnections());
  ipcMain.handle(
    "connect",
    (_e, input: Omit<Connection, "id" | "createdAt" | "models">) => mgr.connect(input),
  );
  ipcMain.handle("removeConnection", (_e, id: string) => mgr.removeConnection(id));

  // --- Models ---
  ipcMain.handle("listModels", (_e, connectionId: string) => mgr.listModels(connectionId));

  ipcMain.handle("listConversations", (_e, id?: string) => history.list(id));
  ipcMain.handle("createConversation", (_e, id: string, model: string) => history.create(id,model));
  ipcMain.handle("loadConversation", (_e, id: string) => history.load(id));
  ipcMain.handle("deleteConversation", (_e, id: string) => { if (busyConversations.has(id)) throw new Error("Wait for the active response before deleting"); history.delete(id);context.clear(id); });
  ipcMain.handle("getSettings", () => settings.get());
  ipcMain.handle("optimizeSettings", async (_e, connectionId?: string, modelId?: string) => {
    const conn = (await mgr.listConnections()).find(c=>c.id === connectionId);
    const model = conn?.models.find(m=>m.id === modelId);
    const optimized = optimizeSettings(settings.get(),machine,model);
    settings.save(optimized);
    await db.flush();
    return {settings:optimized,summary:`Automatic settings are ready${model ? ` for ${model.name ?? model.id}` : ""}: ${(optimized.contextTokens/1024).toFixed(0)}K context, up to ${(optimized.maxOutputTokens/1024).toFixed(0)}K output. They adapt when you switch models. ${model?.contextWindow ? "Respects the server-reported model limit." : "The server did not report its context limit; its loaded context may need to be increased."}`};
  });
  ipcMain.handle("saveSettings", (_e, value) => settings.save(value));
  ipcMain.handle("listFacts", () => settings.facts());
  ipcMain.handle("saveFact", (_e, text: string) => settings.remember(text));
  ipcMain.handle("deleteFact", (_e, id: number) => settings.forget(id));
  ipcMain.handle("openConfig", () => shell.openPath(configPath));
  ipcMain.handle("exportConversation", (_e, id: string) => {
    const conv = history.get(id);
    if (!conv) throw new Error("Conversation not found");
    const text = `# ${conv.title}\n\n` + history.load(id).map(m=>`## ${m.role}\n\n${m.content ?? m.toolResult ?? ""}\n${m.toolCalls ? JSON.stringify(m.toolCalls,null,2) : ""}`).join("\n\n");
    const bytes = new TextEncoder().encode(text);
    const output = scratch.save(`${conv.id}.md`,"text/markdown",bytes.buffer as ArrayBuffer);
    return output.path;
  });

  // --- Streaming chat ---
  ipcMain.handle(
    "openStream",
    (_e, streamId: string, req: ChatRequest): void => {
      if (!/^stream_[a-z0-9]+$/.test(streamId) || streams.has(streamId)) throw new Error("Invalid stream ID");
      streams.set(streamId, new AbortController());
      void runStream(streamId, req, mgr);

    },
  );
  ipcMain.handle("closeStream", (_e, streamId: string) => {
    streams.get(streamId)?.abort();
    streams.delete(streamId);
  });

  ipcMain.handle("stopChat", () => streams.forEach(c=>c.abort()));
  ipcMain.handle("parseFile", async (_e, name: string) => {
    const file = scratch.list().find(f=>f.name === name);
    if (!file) throw new Error("Scratch file not found");
    return (await parseDocument(file.path,file.type)).text;
  });
  // --- Scratch pad ---
  ipcMain.handle("listFiles", () => scratch.list());
  ipcMain.handle(
    "uploadFile",
    (_e, name: string, mimeType: string, size: number, data: ArrayBuffer): FileMeta => {
      return scratch.save(name, mimeType, data);
    },
  );
  ipcMain.handle("downloadFile", async (_e, url: string): Promise<string> => {
    const meta = await scratch.fetchToScratch(url);
    return meta;
  });
  ipcMain.handle("deleteFile", (_e, name: string) => scratch.delete(name));

  // --- Machine info (machine_info skill) ---
  ipcMain.handle("machineInfo", () => machine);
}

async function runStream(
  streamId: string,
  req: ChatRequest,
  mgr: ConnectionManager,
): Promise<void> {
  const controller = streams.get(streamId);
  if (!controller || !mainWindow) {
    streams.delete(streamId);
    return;
  }
  const send = (event: ChatEvent) => mainWindow?.webContents.send(`stream:${streamId}`, event);

  try {
    if (mcpChanging) throw new Error("Wait for the tool connection to finish, then send again.");
    if (!req.conversationId) throw new Error("Create a conversation before sending");
    const conv = history.get(req.conversationId);
    if (!conv || conv.connectionId !== req.connectionId) throw new Error("Conversation does not match this connection");
    if (busyConversations.has(conv.id)) throw new Error("This conversation already has an active response");
    busyConversations.add(conv.id);
    try {
      history.replaceMessages(conv.id, req.messages);
      const final = await mgr.streamChat({...req, signal:controller.signal}, send, message=>history.append(conv.id,message));
      await db.flush();
      send({type:"done",message:final});
    } finally { busyConversations.delete(conv.id); }
  } catch (err: any) {
    send({ type: "error", message: err?.message ?? String(err) });
  } finally {
    streams.delete(streamId);
  }
}

async function renderPdf(text:string):Promise<Buffer> {
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  try{
    const load=new Function('specifier','return import(specifier)') as (specifier:string)=>Promise<any>;
    const [{default:Markdown},{default:gfm}]=await Promise.all([load('react-markdown'),load('remark-gfm')]);
    const content=renderToStaticMarkup(createElement(Markdown,{remarkPlugins:[gfm],skipHtml:true,components:{img:()=>null},children:text}));
    const html='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>@page{size:Letter;margin:20mm}body{font:11pt system-ui;line-height:1.55;color:#171717;overflow-wrap:anywhere}h1{font-size:22pt;line-height:1.2;margin:0 0 16pt}h2{font-size:16pt}h1,h2,h3{break-after:avoid}pre{white-space:pre-wrap;font:9pt/1.5 monospace;background:#f4f4f4;padding:10pt}table{border-collapse:collapse;width:100%;font-size:10pt}td,th{border:1px solid #ccc;padding:6pt;text-align:left}th{background:#f4f4f4}blockquote{border-left:2pt solid #bbb;margin-left:0;padding-left:12pt;color:#555}a{color:#315777}</style><body>'+content+'</body>';

    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    return await window.webContents.printToPDF({printBackground:true,preferCSSPageSize:true});
  }finally{window.destroy();}
}

/* --------------------------- lifecycle ------------------------------- */

/**
 * Phase 0: on Apple Silicon macOS, best-effort auto-offer the local oMLX
 * connection so the user needn't hand-type host:port. If oMLX isn't running,
 * connect() fails silently and the "+ add" form (with the oMLX placeholder)
 * still lets them add it manually.
 */
async function maybeOfferOmx(mgr: ConnectionManager): Promise<void> {
  if (process.platform !== "darwin") return;
  let info: MachineInfo;
  try {
    info = machine;
  } catch {
    return;
  }
  if (!info.omlxAvailable || !info.omlxEndpoint) return;
  try {
    await mgr.connect({ id: "omlx_local", name: "oMLX local", url: info.omlxEndpoint });
  } catch {
    /* oMLX not running yet — the user can add it manually */
  }
}

app.whenReady().then(async () => {
  machine = await probeMachineInfo();
  db = await new AppDb(join(app.getPath("userData"),"browser-chat.sqlite")).open();
  history = new ConversationStore(db);
  settings = new SettingsStore(db);
  const encrypted=safeStorage.isEncryptionAvailable() && (process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');
  secrets=new SecretStore(db,encrypted?{encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)}:undefined);
  library=new SkillLibrary(db);
  context=new ContextStore(db);
  const scratch = new ScratchPad(app.getPath("userData"));

  // Tools the model can call: internal tools plus whatever local MCP
  // servers are enabled in mcp.config.json (failed servers are skipped).
  registry = new ToolsRegistry();
  for (const tool of [...buildInternalTools({ scratch,registry }),...skillTools(scratch,renderPdf)]) registry.register(tool);
  registry.register(library.referenceTool());
  registry.register({name:"machine_info",description:"Read the host computer's detected memory, chip and local-server capabilities.",parameters:{type:"object",properties:{}},handler:async()=>JSON.stringify(machine)});

  configPath = process.env.BROWSER_CHAT_MCP_CONFIG ?? join(app.getPath("userData"),"mcp.config.json");
  if (!existsSync(configPath)) {
    const template = join(app.getAppPath(),"mcp.config.json");
    if (existsSync(template)) copyFileSync(template,configPath);
    else writeFileSync(configPath,'{"servers":{}}');
  }
  mcp = new McpManager(configPath,{secrets,openExternal:url=>shell.openExternal(url),runner:localRunner(app.getPath("userData"))});
  mcp.loadConfig();

  const maxIterations = mcp.getConfig()?.max_tool_calls ?? 6;
  const mgr = new ConnectionManager({ maxIterations, registry, db, settings, machine, secrets, library, context });
  registerIpc(mgr, scratch);
  if ((await mgr.listConnections()).length === 0) await maybeOfferOmx(mgr);
  createWindow();
  startupMcp=mcp.connectAll(msg=>console.log(`[mcp] ${msg}`)).then(tools=>{for(const tool of tools)registry.register(tool);}).catch(err=>console.error("Tool startup:",err.message));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err=>{dialog.showErrorBox("Browser Chat could not start",`${err?.message ?? err}\nYour existing data has not been reset.`);app.quit();});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  streams.forEach((c) => c.abort());
  streams.clear();
  void Promise.all([db?.close(),mcp?.close()]).finally(()=>app.quit());
});
