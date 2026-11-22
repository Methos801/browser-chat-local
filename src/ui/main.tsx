import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SkillsPanel,McpPanel,ContextPanel,FilesPanel,Sheet } from "./productPanels";
import type { ContextInfo } from "../electron/features";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  BrowserChatBridge,
  ChatEvent,
  ChatMessage,
  Connection,
  Conversation,
  FileMeta,
  ModelInfo,
  MachineInfo,
  AppSettings,
  Fact,
} from "../electron/ipc";

const api = (window as unknown as { browserChat: BrowserChatBridge }).browserChat;

/* ----------------------------- types ------------------------------ */

type LocalMessage = ChatMessage & { id: string };

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ----------------------------- App -------------------------------- */

function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Array<{ name: string; type: string; data: ArrayBuffer }>>([]);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [machine, setMachine] = useState<MachineInfo | null>(null);
  const [showSettings,setShowSettings] = useState(false);
  const [settingsSection,setSettingsSection] = useState<"General"|"Memory"|"Tools">("General");
  const [showSkills,setShowSkills] = useState(false),[showFiles,setShowFiles]=useState(false),[showContext,setShowContext]=useState(false);
  const [contextInfo,setContextInfo]=useState<ContextInfo|null>(null),[contextVersion,setContextVersion]=useState(0);
  const [skillIds,setSkillIds]=useState<string[]|undefined>(()=>{try{const saved=localStorage.getItem('browserChat.skills');return saved?JSON.parse(saved):undefined;}catch{return undefined;}});
  const [activeSkills,setActiveSkills]=useState<{id:string;name:string}[]>([]);
  const [activity,setActivity]=useState<string[]>([]);
  const [lastError,setLastError]=useState(false);
  const [elapsed,setElapsed]=useState(0);



  useEffect(()=>{if(skillIds===undefined)localStorage.removeItem('browserChat.skills');else localStorage.setItem('browserChat.skills',JSON.stringify(skillIds));},[skillIds]);
  useEffect(()=>{if(!streaming)return;setElapsed(0);const started=Date.now();const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-started)/1000)),1000);return()=>clearInterval(timer);},[streaming]);
  useEffect(()=>{
    if(!activeId||!modelId||streaming)return;
    let active=true;
    const timer=setTimeout(()=>{
      const previewMessages:ChatMessage[]=[...messages];
      if(input.trim()||attachments.length)previewMessages.push({role:'user',content:input,images:attachments.filter(a=>a.type.startsWith('image/')).map(a=>({type:'image',mimeType:a.type,data:''}))});
      void api.contextPreview({connectionId:activeId,modelId,conversationId:convId??undefined,messages:previewMessages,skillIds}).then(info=>{if(active)setContextInfo(info);}).catch(()=>{});
    },200);
    return()=>{active=false;clearTimeout(timer);};
  },[activeId,modelId,convId,messages,input,attachments,skillIds,streaming,contextVersion]);

  /* --- boot --- */
  useEffect(() => {
    void (async () => {
      const saved = await api.listConnections();
      setConnections(saved);
      setActiveId(saved[0]?.id ?? null);
      setFiles(await api.listFiles());
      const m = await api.machineInfo();
      setMachine(m);
    })();
  }, []);

  /* --- when active connection changes: fetch its models --- */
  useEffect(() => {
    if (!activeId) return;
    let active = true;
    void (async () => {
      try {
        const ms = await api.listModels(activeId);
        if (active) {
          setModels(ms);
          setConnections(await api.listConnections());
          if (!ms.length) setStatus("No models available. Check the server and reconnect if authentication is required.");
          setModelId((prev) => (ms.some((x) => x.id === prev) ? prev : ms[0]?.id ?? ""));
        }
      } catch {
        if (active) { setModels([]); setStatus("Server unavailable. Check that it is running and reconnect if authentication is required."); }
      }
    })();
    return () => {
      active = false;
    };
  }, [activeId]);

  useEffect(()=> { refreshConversations(); },[activeId]);

  function refreshConversations() {
    void (async () => {
      setConversations(await api.listConversations(activeId ?? undefined));
    })();
  }

  /* --- connect a connection --- */
  async function doConnect(conn: Omit<Connection, "id" | "createdAt" | "models" | "protocol">) {
    const res = await api.connect(conn);
    if (res.status === "connected") {
      setActiveId(res.connection.id);
      setModels(res.connection.models);
      setModelId(previous=>res.connection.models.some(m=>m.id === previous) ? previous : res.connection.models[0]?.id ?? "");
      const saved = await api.listConnections();
      setConnections(saved);
      setActiveId(res.connection.id);
      refreshConversations();
    } else {
      setStatus(`Connect failed: ${res.status === "error" ? res.message : res.status}`);
    }
  }

  /* --- send a message (streaming) --- */
  async function handleSend(retry=false) {
    if (!activeId || !modelId || streaming) return;
    const text = input.trim();
    if (!retry && !text && attachments.length === 0) return;
    const lastUser=messages.map(m=>m.role).lastIndexOf("user");
    if(retry&&lastUser<0)return;
    const baseMessages=retry?messages.slice(0,lastUser):messages;

    const userMsg: LocalMessage = retry?messages[lastUser]:{
      id: uid(),
      role: "user",
      content: text || undefined,
      images: attachments.filter(a=>a.type.startsWith("image/")).map((a) => ({ type: "image", data: b64(a.data), mimeType: a.type })),
    };
    setStreaming(true);setLastError(false);setStatus("Preparing your request…");setActivity([]);
    try {
      for (const file of (retry?[]:attachments).filter(a=>!a.type.startsWith("image/"))) {
        const saved = await api.uploadFile(file.name,file.type,file.data.byteLength,file.data);
        setStatus(`Reading ${file.name}…`);
        const text = await api.parseFile(saved.name);
        const count=Math.max(1,attachments.filter(a=>!a.type.startsWith('image/')).length);
        const excerptLimit=Math.max(800,Math.min(16000,Math.floor((contextInfo?.limitTokens??8192)*0.75/count)));
        userMsg.content=(userMsg.content??'')+`\n\nAttached ${file.name}${text.length>excerptLimit?` (excerpt: first ${excerptLimit} of ${text.length} extracted characters; the full file is available through the document tool)` : ''}:\n${text.slice(0,excerptLimit)}`;
      }
    } catch (err) { setStatus((err as Error).message); setStreaming(false); return; }
    setMessages([...baseMessages,userMsg]);
    setInput("");
    setAttachments([]);
    setStreaming(true);


    let currentId = convId;
    try {
      if (!currentId) {
        const conv = await api.createConversation(activeId,modelId);
        currentId = conv.id;
        setConvId(conv.id);
      }
    } catch (err) { setStatus((err as Error).message); setStreaming(false); return; }
    const request = {
      connectionId: activeId!,
      modelId,
      conversationId: currentId,
      messages: [...baseMessages, userMsg] as ChatMessage[],
      skillIds,
    };

    try {
      await api.streamChat(request,onEvent);
      const stored = await api.loadConversation(currentId!);
      setMessages(stored.map(m=>({...m,id:uid()})));
      refreshConversations();
      setFiles(await api.listFiles());
    } catch (err) {
      onEvent({ type: "error", message: (err as Error).message });
    } finally {
      setStreaming(false);
    }
  }

  function onEvent(ev: ChatEvent) {
    switch (ev.type) {
      case "context":setContextInfo(ev.info);break;
      case "skills":setActiveSkills(ev.skills);break;
      case "status":
        setActivity(previous=>previous[previous.length-1]===ev.message?previous:[...previous.slice(-9),ev.message]);
        setStatus(ev.message);
        break;
      case "token":
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            const copy = [...prev];
            copy[copy.length - 1] = { ...last, content: (last.content ?? "") + ev.text };
            return copy;
          }
          return [...prev, { role: "assistant", content: ev.text, id: uid() }];
        });
        break;
      case "tool_call":
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const existing = last?.toolCalls?.find((t) => t.id === ev.call.id);
          if (existing) {
            const copy = [...prev];
            copy[copy.length - 1] = {
              ...last,
              toolCalls: last.toolCalls!.map((t) =>
                t.id === ev.call.id ? { ...t, arguments: ev.call.arguments } : t,
              ),
            };
            return copy;
          }
          return [...prev, { role: "assistant", toolCalls: [ev.call], id: uid() }];
        });
        break;
      case "tool_result":
        setMessages((prev) => [...prev, { role: "tool", toolResult: ev.result, content: ev.result, toolCallId:ev.toolCallId, id: uid() }]);
        break;
      case "done":
        setStatus("Ready");
        refreshConversations();
        break;
      case "error":
        setLastError(true);
        setStatus(ev.message);
        break;
    }
  }

  /* --- file handling --- */
  async function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files;
    if (!picked) return;
    for (const f of Array.from(picked)) {
      const buf = await f.arrayBuffer();
      setAttachments((prev) => [...prev, { name: f.name, type: f.type || "application/octet-stream", data: buf }]);
    }
    e.target.value = "";
  }

  async function onUploadAttached(name: string) {
    const att = attachments.find((a) => a.name === name);
    if (!att) return;
    const meta = await api.uploadFile(att.name, att.type, att.data.byteLength, att.data);
    setFiles(await api.listFiles());
    setAttachments((prev) => prev.filter((a) => a.name !== name));
    void meta;
  }

  async function newConversation() {
    if (!activeId || !modelId || streaming) return;
    const conv = await api.createConversation(activeId, modelId);
    setConvId(conv.id);
    setMessages([]);
    refreshConversations();
  }

  return (
    <div className={`app ${streaming ? "is-streaming" : ""}`}>
      <Sidebar
        connections={connections}
        activeId={activeId}
        onSelect={(id) => {
          if (streaming) return;
          setActiveId(id);
          setConvId(null);
          setMessages([]);
        }}
        onConnect={doConnect}
        onRemove={async (id) => {
          await api.removeConnection(id);
          const saved = await api.listConnections();
      setConnections(saved);
      setActiveId(saved[0]?.id ?? null);
          if (activeId === id) setActiveId(null);
        }}
        files={files}
        onFileDelete={async (name) => {
          await api.deleteFile(name);
          setFiles(await api.listFiles());
        }}
        onUploadAttached={onUploadAttached}
        attachments={attachments}
        machine={machine}
        conversations={conversations}
        selectedConv={convId}
        onSelectConv={(c) => {
          if (streaming) return;
          setConvId(c.id);
          setModelId(c.modelId);
          void api.loadConversation(c.id).then(ms=>setMessages(ms.map(m=>({...m,id:uid()}))));
        }}
        onRefreshConversations={refreshConversations}
        onSettings={()=>{setSettingsSection("General");setShowSettings(true);}}
        onTools={()=>{setSettingsSection("Tools");setShowSettings(true);}}
        onSkills={()=>setShowSkills(true)}
        onFiles={()=>setShowFiles(true)}
        onRenameConversation={async(id,title)=>{await api.renameConversation(id,title);refreshConversations();}}
        onDeleteConversation={id=>{void api.deleteConversation(id).then(()=>{if (convId === id) {setConvId(null);setMessages([]);}refreshConversations();});}}
        onExport={()=> { if (convId) void api.exportConversation(convId).then(p=>setStatus(`Exported to ${p}`)); }}
        streaming={streaming}
        onNewConversation={newConversation}
      />
      {showSkills && <SkillsPanel selected={skillIds} onUse={setSkillIds} onClose={()=>setShowSkills(false)}/>}
      {showFiles && <FilesPanel onClose={()=>setShowFiles(false)}/>}
      {showContext && <ContextPanel info={contextInfo} conversationId={convId} onChanged={()=>setContextVersion(n=>n+1)} onClose={()=>setShowContext(false)}/>}
      {showSettings && settingsSection === "Tools" && <Sheet title="Connectors" onClose={()=>{void api.cancelMcpConnection();setShowSettings(false);}}><McpPanel/></Sheet>}
      {showSettings && settingsSection !== "Tools" && <SettingsPanel initialSection={settingsSection} connectionId={activeId ?? undefined} modelId={modelId} onClose={()=>setShowSettings(false)} />}
      <Main
        activeId={activeId}
        models={models}
        modelId={modelId}
        onModelChange={id=>{if (!streaming) {setModelId(id);setConvId(null);setMessages([]);}}}
        messages={messages}
        input={input}
        onInput={setInput}
        onSend={()=>void handleSend()}
        onRetry={()=>void handleSend(true)}
        lastError={lastError}
        contextInfo={contextInfo}
        onContext={()=>setShowContext(true)}
        onSkills={()=>setShowSkills(true)}
        skillLabel={skillIds===undefined?'Auto':skillIds.length?`${skillIds.length} selected`:'Off'}
        activeSkills={activeSkills.map(s=>s.name)}
        activity={activity}
        elapsed={elapsed}
        onFilePick={onFilePick}
        attachments={attachments}
        onClearAttachment={(name) => setAttachments((p) => p.filter((a) => a.name !== name))}
        streaming={streaming}
        status={status}
        onRefreshConversations={refreshConversations}
      />
    </div>
  );
}

function SettingsPanel({onClose,connectionId,modelId,initialSection="General"}:{onClose:()=>void;connectionId?:string;modelId?:string;initialSection?:"General"|"Memory"}) {
  const [settings,setSettings] = useState<AppSettings | null>(null);
  const [facts,setFacts] = useState<Fact[]>([]);
  const [note,setNote] = useState("");
  const [feedback,setFeedback] = useState("");
  const [advanced,setAdvanced] = useState(false);
  const [optimizing,setOptimizing] = useState(false);
  const [section,setSection] = useState<"General" | "Memory">(initialSection);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(()=>{
    void api.getSettings().then(setSettings).catch(e=>setFeedback(e.message));
    void api.listFacts().then(setFacts).catch(e=>setFeedback(e.message));
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,textarea") ?? []);
        const first = nodes[0], last = nodes[nodes.length-1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown",key);
    return ()=>{document.removeEventListener("keydown",key);previous?.focus();};
  },[]);

  async function save() {
    try { if (settings) await api.saveSettings(settings); setFeedback("Saved"); }
    catch(e) { setFeedback((e as Error).message); }
  }
  async function optimize() {
    setOptimizing(true);
    try {
      const result = await api.optimizeSettings(connectionId,modelId);
      setSettings(result.settings);
      setFeedback(result.summary);
      setAdvanced(false);
    } catch(e) { setFeedback((e as Error).message); }
    finally { setOptimizing(false); }
  }

  return <div className="settings-overlay" onClick={onClose}>
    <div ref={panel} onClick={e=>e.stopPropagation()} className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-title"><h2>Settings & memory</h2><button onClick={onClose}>Close</button></div>
      <nav className="settings-sections" aria-label="Settings sections">
        {(["General","Memory"] as const).map(name=><button key={name} aria-pressed={section === name} onClick={()=>{setSection(name);setFeedback("");}}>{name}</button>)}
      </nav>
      {settings && section === "General" && <>
        <div className="automatic-settings">
          <span className="eyebrow">{settings.automatic ? "AUTOMATIC · RECOMMENDED" : "CUSTOM SETTINGS"}</span>
          <h3>{settings.automatic ? "Ready to chat. No tuning needed." : "You're using manual limits."}</h3>
          <p>Room for skills, search results and longer answers, adjusted for your computer and the selected model. Automatic mode adapts as you switch models.</p>
          <button className="primary" disabled={optimizing} onClick={()=>void optimize()}>{optimizing ? "Optimizing…" : "Optimize automatically"}</button>
        </div>
        <button className="link advanced-toggle" aria-expanded={advanced} onClick={()=>setAdvanced(s=>!s)}>{advanced ? "Hide advanced settings" : "Advanced settings"}</button>
        {advanced && <>
          <p>Changing a limit switches to manual mode. Use Optimize automatically to return to the recommended settings.</p>
          <p>Context includes both your input and the reserved output. Automatic mode can reduce the output reserve to fit a large search result.</p>
          <div className="settings-grid">
            {([["contextTokens","Context tokens"],["maxOutputTokens","Output tokens"],["maxToolIterations","Tool iterations"],["timeoutMs","Timeout (ms)"]] as const).map(([key,label])=>
              <label key={key} className="field">{label}<input aria-label={label} type="number" value={settings[key]} onChange={e=>setSettings({...settings,automatic:false,[key]:Number(e.target.value)})}/></label>)}
          </div>
          <button onClick={()=>void save()}>Save settings</button>
        </>}
      </>}
      {settings && section === "Memory" && <>
        <h3>Remember what matters.</h3>
        <p>Only facts you save here are remembered. Matching facts are included as background context.</p>
        <label><input type="checkbox" checked={settings.memoryRecall} onChange={e=>setSettings({...settings,memoryRecall:e.target.checked})}/> Recall relevant saved memory</label>
        <p><button onClick={()=>void save()}>Save memory preference</button></p>
        <label className="field" htmlFor="new-memory">New memory</label>
        <textarea id="new-memory" aria-label="New memory" value={note} onChange={e=>setNote(e.target.value)} placeholder="For example: I prefer concise answers."/>
        <button disabled={!note.trim()} onClick={()=>void api.saveFact(note).then(async()=>{setFacts(await api.listFacts());setNote("");setFeedback("Memory saved");}).catch(e=>setFeedback(e.message))}>Remember</button>
        {facts.length === 0 && <p>No saved memories yet.</p>}
        {facts.map(f=><p key={f.id} className="saved-fact">{f.text} <button onClick={()=>void api.deleteFact(f.id).then(async()=>setFacts(await api.listFacts()))}>Forget</button></p>)}
      </>}
      <p role="status" className="settings-feedback">{feedback}</p>
    </div>
  </div>;
}

/* --------------------------- Sidebar ------------------------------ */

function Sidebar(props: {
  connections: Connection[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onConnect: (c: Omit<Connection, "id" | "createdAt" | "models" | "protocol">) => void;
  onRemove: (id: string) => void;
  files: FileMeta[];
  onFileDelete: (name: string) => void;
  onUploadAttached: (name: string) => Promise<void>;
  attachments: Array<{ name: string; type: string; data: ArrayBuffer }>;
  machine: MachineInfo | null;
  conversations: Conversation[];
  selectedConv: string | null;
  onSelectConv: (c: Conversation) => void;
  onNewConversation: () => void;
  onRefreshConversations: () => void;
  onSettings: () => void;
  onTools: () => void;
  onSkills: () => void;
  onFiles: () => void;
  onRenameConversation:(id:string,title:string)=>Promise<void>;
  onDeleteConversation: (id: string) => void;
  onExport: () => void;
  streaming: boolean;
}) {
  const { connections, activeId, onSelect, onConnect, onRemove, files, onFileDelete, attachments, machine, conversations, selectedConv, onSelectConv, onNewConversation } = props;
  const [historyQuery,setHistoryQuery]=useState("");
  const [renaming,setRenaming]=useState<string|null>(null),[newTitle,setNewTitle]=useState("");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="dot" />
        <div>Browser Chat<span className="brand-caption">Your model workspace</span></div>
      </div>

      <div className="section">
        <div className="row-flex">
          <h3 style={{ marginBottom: 0 }}>Connections</h3>
          <button className="link right" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "hide" : "+ add"}
          </button>
        </div>

        {showForm && (
          <div style={{ marginTop: 8 }}>
            <p className="setup-note">Model settings are automatic. Choose your server to get started.</p>
            <div className="connection-presets">
              {[["LM Studio","http://localhost:1234/v1"],["oMLX","http://localhost:8000/v1"],["Ollama","http://localhost:11434/v1"],["Anthropic","https://api.anthropic.com/v1"]].map(([label,base])=><button key={label} onClick={()=>{setName(label);setUrl(base);}}>{label}</button>)}
            </div>
            <label className="field" htmlFor="connection-name">Name</label>
            <input id="connection-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="oMLX local" />
            <label className="field" htmlFor="connection-url">Base URL</label>
            <input id="connection-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8000/v1" />
            <label className="field" htmlFor="connection-key">API key (optional)</label>
            <input id="connection-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="—" type="password" />
            <button
              className="primary"
              onClick={() => {
                if (!url) return;
                onConnect({ name: name || url, url, auth: key || undefined });
                setName("");
                setUrl("");
                setKey("");
                setShowForm(false);
              }}
            >
              Connect server
            </button>
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          {connections.length === 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>No connections.</span>}
          {connections.map((c) => (
            <div key={c.id} className={`conn ${activeId === c.id ? "active" : ""}`} onClick={() => onSelect(c.id)}>
              <span className={`status-dot ${c.models.length ? "ok" : "idle"}`} title={c.protocol} />
              <div className="conn-body">
                <div className="conn-name">{c.name}</div>
                <div className="conn-url">{c.url} · {c.models.length} {c.models.length === 1 ? 'model' : 'models'}</div>
              </div>
              <button className="icon danger" onClick={(e) => { e.stopPropagation(); onRemove(c.id); }} title="delete">
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="section" style={{ flex: 1, overflowY: "auto", pointerEvents:props.streaming ? "none" : undefined }}>
        <div className="row-flex">
          <h3 style={{ marginBottom: 0 }}>History</h3>
          <button className="link right" onClick={onNewConversation} disabled={!activeId}>+ new</button>
        </div>
        <div style={{ marginTop: 8 }}>
          <input aria-label="Search history" className="history-search" placeholder="Search history…" value={historyQuery} onChange={e=>setHistoryQuery(e.target.value)}/>
          {conversations.length === 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>No conversations yet.</span>}
          {conversations.filter(c=>c.title.toLowerCase().includes(historyQuery.toLowerCase())).map((c) => (
            <div key={c.id} className={`history-item ${selectedConv === c.id ? "active" : ""}`} style={selectedConv === c.id ? { background: "var(--panel-2)" } : undefined} onClick={() => onSelectConv(c)}>
              {renaming===c.id?<input aria-label="Conversation title" autoFocus value={newTitle} onClick={e=>e.stopPropagation()} onChange={e=>setNewTitle(e.target.value)} onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter')void props.onRenameConversation(c.id,newTitle).then(()=>setRenaming(null));if(e.key==='Escape')setRenaming(null);}}/>:<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>}
              <button className="icon rename-chat" aria-label={`Rename ${c.title}`} title="Rename" onClick={e=>{e.stopPropagation();if(renaming===c.id){void props.onRenameConversation(c.id,newTitle).then(()=>setRenaming(null));}else{setRenaming(c.id);setNewTitle(c.title);}}}>{renaming===c.id?'Save':'Edit'}</button>
              <button className="icon danger" onClick={(e) => { e.stopPropagation(); props.onDeleteConversation(c.id); }} title="delete">
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="section workspace-actions">
        <button onClick={props.onSkills}>Skills</button>
        <button onClick={props.onTools}>Tools & MCP</button>
        <button onClick={props.onFiles}>Files & outputs ({files.length})</button>
        <button onClick={props.onSettings}>Settings & memory</button>
        <button onClick={props.onExport} disabled={!selectedConv}>Export chat</button>
      </div>
      <div className="section" style={{ fontSize: 11, color: "var(--muted)" }}>
        {machine && (
          <div>
            {machine.os === "darwin" ? "macOS" : machine.os} · {machine.chip ?? ""}
          </div>
        )}
        <div>{files.length} files in scratch pad</div>
      </div>
    </aside>
  );
}

/* ----------------------------- Main ------------------------------- */

function Main(props: {
  activeId: string | null;
  models: ModelInfo[];
  modelId: string;
  onModelChange: (id: string) => void;
  messages: LocalMessage[];
  input: string;
  onInput: (s: string) => void;
  onSend: () => void;
  onRetry: () => void;
  lastError:boolean;
  contextInfo:ContextInfo|null;
  onContext:()=>void;
  onSkills:()=>void;
  skillLabel:string;
  activeSkills:string[];
  activity:string[];
  elapsed:number;
  onFilePick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  attachments: Array<{ name: string; type: string; data: ArrayBuffer }>;
  onClearAttachment: (name: string) => void;
  streaming: boolean;
  status: string;
  onRefreshConversations: () => void;
}) {
  const { models, modelId, onModelChange, messages, input, onInput, onSend, onFilePick, attachments, onClearAttachment, streaming, status } = props;
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <main className="main">
      <div className="status-line" aria-live="polite">
        <select aria-label="Model" value={modelId} disabled={streaming || !props.activeId} onChange={e=>onModelChange(e.target.value)}>
          {!models.length && <option value="">Choose a model</option>}
          {models.map(m=><option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
        </select>
        {!props.activeId ? (
          <span className="connection-hint">Add a server to get started</span>
        ) : (
          <span>{props.models.length === 0 ? "No models available" : `Connected · ${props.models.length} ${props.models.length === 1 ? 'model' : 'models'}`}</span>
        )}
        <button className="context-meter" aria-label="Conversation context" onClick={props.onContext} disabled={!props.activeId}>
          <span>Context {props.contextInfo?`~${Math.round(props.contextInfo.usedTokens/100)/10}k / ${Math.round(props.contextInfo.limitTokens/100)/10}k`:'—'}</span>
          <progress max={100} value={props.contextInfo?.percent??0}/>
        </button>
        <button className="skill-picker" onClick={props.onSkills}>Skills · {props.skillLabel}</button>
        {streaming && <span className="spinner" style={{ marginLeft: 8 }} />}
        {status && <span className="stream-status">{status}</span>}
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <div className="welcome">
              <span className="eyebrow">BROWSER CHAT / WORKSPACE</span>
              <h1>{props.activeId ? "What are we working on?" : "Start with your model."}</h1>
              <p>{props.activeId ? "Ask a question, attach a document, or work through an idea. Your conversations are saved on this device." : "Connect a local server or an API, choose a model, and make room for your next idea."}</p>
              <div className="welcome-details">
                <div><span>01</span><strong>Connect</strong><p>LM Studio, oMLX, Ollama, or Anthropic.</p></div>
                <div><span>02</span><strong>Work</strong><p>Chat, read documents, and use tools.</p></div>
                <div><span>03</span><strong>Keep</strong><p>Saved history, memory, and exports.</p></div>
              </div>
              <div className="welcome-note">History stays on this device. Messages go to the server you choose.</div>
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {streaming&&<div className="activity-card" role="status"><div className="activity-heading"><span className="spinner"/><strong>{status||'Processing your request…'}</strong><span>{props.elapsed}s</span></div>{props.activeSkills.length>0&&<p>Skills: {props.activeSkills.join(', ')}</p>}<details><summary>Activity</summary>{props.activity.map((entry,i)=><p key={i}>{entry}</p>)}</details></div>}
        {!streaming&&messages.some(m=>m.role==='user')&&<div className="chat-actions"><button onClick={props.onRetry}>{props.lastError?'Retry response':'Regenerate response'}</button>{props.activeSkills.length>0&&<span>Skills used: {props.activeSkills.join(', ')}</span>}</div>}
        <div ref={tailRef} />
      </div>

      <div className="composer">
        {attachments.length > 0 && (
          <div className="row-flex" style={{ marginBottom: 6 }}>
            {attachments.map((a) => (
              <span key={a.name} className="attachment">
                {a.name} ({Math.round(a.data.byteLength / 1024)} KB)
                <button className="icon" onClick={() => onClearAttachment(a.name)}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="row">
          <textarea
            aria-label="Message"
            className="textarea"
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={props.activeId ? "Message…" : "Connect a first server to begin"}
            rows={1}
            disabled={!props.activeId || streaming}
          />
          <label className="button attach-button" title="Attach a file or image">
            Attach
            <input type="file" multiple hidden onChange={onFilePick} />
          </label>
          {streaming && <button onClick={()=>void api.stopChat()}>Stop</button>}
          <button className="primary" onClick={onSend} disabled={!props.activeId || !modelId || streaming || (!input.trim() && !attachments.length)}>
            Send
          </button>
        </div>
      </div>
    </main>
  );
}

/* -------------------------- Message view -------------------------- */

function MessageView({ message }: { message: LocalMessage }) {
  if (message.role === "user") {
    return (
      <div className="msg user">
        <div className="avatar">U</div>
        <div className="body">
          {message.content && <div>{message.content}</div>}
          {(message.images ?? []).map((img, i) => (
            <img key={i} src={`data:${img.mimeType};base64,${img.data}`} style={{ maxWidth: 260, borderRadius: 8, marginTop: 8 }} />
          ))}
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    const text=message.toolResult ?? message.content ?? "";
    let output:{name:string;size:number}|null=null;
    try{const parsed=JSON.parse(text);if(typeof parsed.name==='string'&&typeof parsed.size==='number'&&typeof parsed.path==='string')output=parsed;}catch{}
    return <div className="msg tool-message"><div className="body">{output?<div className="created-file"><strong>Created {output.name}</strong><span>{Math.max(1,Math.round(output.size/1024))} KB</span><button onClick={()=>void api.openScratchFile(output!.name)}>Open</button><button onClick={()=>void api.saveScratchFile(output!.name)}>Save a copy</button></div>:<details><summary>Tool result</summary><div className="toolresult">{text}</div></details>}</div></div>;
  }

  // assistant
  return (
    <div className="msg assistant">
      <div className="avatar">AI</div>
      <div className="body">
        {message.content && <div className="markdown">{formatText(message.content)}</div>}
        {message.content&&<button className="link copy-message" onClick={()=>void api.copyText(message.content!)}>Copy</button>}
        {(message.toolCalls ?? []).map((tc, i) => (
          <details key={i} className="toolcall">
            <summary className="tc-head">Tool · {tc.name.replace(/^mcp__/, "").replace(/__/g," · ").replace(/_/g," ")}</summary>
            <div style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "pre-wrap" }}>
              {typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments, null, 2)}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------ utils ----------------------------- */

function formatText(text: string) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{a:({href,children})=><a href={href} onClick={e=>{e.preventDefault();if(href)void api.openLink(href);}}>{children}</a>,img:({alt})=><span>{alt??'Image reference'}</span>}}>{text}</ReactMarkdown>;
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* ----------------------------- mount ------------------------------ */

createRoot(document.getElementById("root")!).render(<App />);
