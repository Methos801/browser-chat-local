import { readFileSync,writeFileSync,renameSync,mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from './registry';
import type { McpServerInput,McpServerView } from '../features';
import type { SecretStore } from '../store/secrets';
import { identifyConnector,splitConnectionUrl,placeholderSecret } from '../connectors';
import { McpOAuth } from '../services/mcpOAuth';
export interface McpServerConfig {
 transport:'stdio'|'sse'|'http';command?:string;args?:string[];url?:string;
 env?:Record<string,string>;headers?:Record<string,string>;enabled?:boolean;timeout?:number;oauth?:boolean;provider?:string;
}
export interface McpConfig {servers:Record<string,McpServerConfig>;max_tool_calls?:number;default_timeout?:number;}
export class McpManager {
 private config:McpConfig|null=null;
 private live=new Map<string,Client>();
 private pending=new Set<Client>();
 private authorizing=new Set<McpOAuth>();
 private generation=0;
 private views=new Map<string,McpServerView>();
 constructor(private readonly configPath:string,private options:{secrets?:SecretStore;openExternal?:(url:string)=>Promise<void>;runner?:(command:string,args:string[],env:Record<string,string>)=>{command:string;args:string[];env:Record<string,string>;cwd?:string}}={}){}
 getConfig():McpConfig|null{return this.config;}
 loadConfig():McpConfig|null {
  try {const parsed=JSON.parse(readFileSync(this.configPath,'utf8'));this.config=parsed&&typeof parsed.servers==='object'&&!Array.isArray(parsed.servers)&&parsed.servers?parsed:null;}
  catch{this.config=null;}
  // Import credentials from older config files into the existing vault before showing a row.
  let migrated=false;
  if(this.options.secrets)for(const [name,server] of Object.entries(this.config?.servers??{})){
   if(!server||typeof server!=='object')continue;
   const secret=this.secret(name);
   try{if(server.url){const parsed=splitConnectionUrl(server.url);if(parsed.url!==server.url){secret.query={...secret.query,...parsed.query};if(parsed.token){secret.token=parsed.token;server.oauth=false;}server.url=parsed.url;migrated=true;}}}catch{}
   if(server.env&&Object.keys(server.env).length){secret.env={...server.env,...secret.env};delete server.env;migrated=true;}
   if(server.headers&&Object.keys(server.headers).length){secret.headers={...server.headers,...secret.headers};delete server.headers;migrated=true;}
   if(migrated)this.options.secrets.set(`mcp:${name}`,JSON.stringify(secret));
  }
  if(migrated)this.write();return this.config;
 }
 list():McpServerView[]{
  const cfg=this.config??this.loadConfig();
  return Object.entries(cfg?.servers??{}).map(([name,server])=>this.views.get(name)??this.view(name,server));
 }
 save(input:McpServerInput):void {
  if(!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(input.name))throw Error('Use a short server name with letters, numbers, hyphens or underscores.');
  if(!['stdio','http','sse'].includes(input.transport))throw Error('Choose a supported connection type.');
  if(input.transport==='stdio'&&(!input.command?.trim()||input.command.length>1000))throw Error('Choose a local server command.');
  if(input.transport!=='stdio'){
   const url=new URL(input.url??'');
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Use an HTTP(S) endpoint without credentials in the URL.');
  }
  if(input.args&&(!Array.isArray(input.args)||input.args.some(a=>typeof a!=='string'||a.length>4000)))throw Error('Invalid server arguments.');
  const cfg=this.config??this.loadConfig()??{servers:{}};
  const prior=cfg.servers[input.name];
  let secret=this.secret(input.name);
  const parsed=input.transport!=='stdio'?splitConnectionUrl(input.url!):undefined;
  if(parsed)input={...input,url:parsed.url,token:parsed.token??input.token,oauth:parsed.token||Object.keys(parsed.query).length?false:input.oauth};
  const sameEndpoint=!!prior&&prior.transport===input.transport&&(input.transport==='stdio'?(prior.command===input.command&&JSON.stringify(prior.args??[])===JSON.stringify(input.args??[])):prior.url===input.url);
  const changedMode=!!prior&&!!prior.oauth!==!!input.oauth;
  const migratedTavily=input.provider==='tavily'&&identifyConnector({name:input.name,...prior})?.id==='tavily'&&prior?.transport==='stdio'&&input.transport==='http'&&new URL(input.url!).origin==='https://mcp.tavily.com'&&!input.oauth?secret.env?.TAVILY_API_KEY??prior?.env?.TAVILY_API_KEY:undefined;
  if(prior&&(!sameEndpoint||changedMode)){
   secret={};for(const part of ['tokens','client','redirect'])this.options.secrets?.delete(`oauth:${input.name}:${part}`);
  }
  if(parsed)secret.query={...secret.query,...parsed.query};
  if(input.transport==='stdio'&&sameEndpoint&&prior?.env)secret.env={...prior.env,...secret.env};
  if(input.env)secret.env={...secret.env,...input.env};
  if(input.token?.trim()){secret.token=input.token.trim();for(const key of Object.keys(secret.headers??{}))if(/authorization|api[-_]?key/i.test(key))delete secret.headers![key];}
  else if(migratedTavily&&!placeholderSecret(migratedTavily))secret.token=migratedTavily;
  if(input.oauth){delete secret.token;delete secret.query;}
  if((Object.keys(secret.env??{}).length||Object.keys(secret.query??{}).length||secret.token)&&!this.options.secrets)throw Error('Credential storage is not available.');
  this.options.secrets?.set(`mcp:${input.name}`,JSON.stringify(secret));
  cfg.servers[input.name]={transport:input.transport,command:input.command,args:input.args??[],url:input.url,enabled:input.enabled!==false,timeout:Math.min(120,Math.max(5,input.timeout??30)),oauth:!!input.oauth,provider:input.provider};
  this.config=cfg;this.write();this.views.delete(input.name);
 }
 remove(name:string):void {
  const cfg=this.config??this.loadConfig();if(!cfg)return;
  delete cfg.servers[name];this.views.delete(name);this.options.secrets?.delete(`mcp:${name}`);
  for(const part of ['tokens','client','redirect'])this.options.secrets?.delete(`oauth:${name}:${part}`);
  this.write();
 }
 toggle(name:string,enabled:boolean):void{const server=this.config?.servers[name];if(!server)throw Error('Server not found');server.enabled=enabled;this.views.delete(name);this.write();}
 async connectAll(onStatus?:(message:string)=>void,interactiveName?:string,onlyName?:string):Promise<Tool[]> {
  const cfg=this.loadConfig()??this.config;if(!cfg){onStatus?.('No tools configured');return [];}
  const all:Tool[]=[];const generation=this.generation;
  for(const [name,server] of Object.entries(cfg.servers)){
   if(generation!==this.generation)break;
   if(onlyName&&name!==onlyName)continue;
   const view=this.view(name,server);this.views.set(name,view);
   if(!server||server.enabled===false){view.status='disabled';view.message='Disabled';onStatus?.(`skip "${name}" (disabled)`);continue;}
   if(view.needsSetup){view.status='needs-setup';onStatus?.(`${name}: setup needed`);continue;}
   const timeoutMs=(server.timeout??cfg.default_timeout??30)*1000;
   view.status="connecting";view.message="Connecting…";
   let client=new Client({name:'browser-chat',version:'0.2.0'});
   this.pending.add(client);
   let provider:McpOAuth|undefined;
   try{
    if(server.oauth&&this.options.secrets){provider=new McpOAuth(name,this.options.secrets,name===interactiveName,this.options.openExternal??(async()=>{throw Error('Browser sign-in is unavailable');}));this.authorizing.add(provider);await provider.listen();}
    let transport=this.transport(name,server,provider);
    try{await withTimeout(client.connect(transport),timeoutMs,`connect to ${name}`);}
    catch(error){
     if(!provider?.requested||!(transport instanceof StreamableHTTPClientTransport))throw error;
     view.status='sign-in';view.message='Complete sign-in in your browser';
     const code=await provider.waitCode();await transport.finishAuth(code);
     await client.close().catch(()=>{});this.pending.delete(client);client=new Client({name:'browser-chat',version:'0.2.0'});this.pending.add(client);transport=this.transport(name,server,provider);
     await withTimeout(client.connect(transport),timeoutMs,`connect to ${name}`);
    }
    const listed=await withTimeout(client.listTools(undefined,{timeout:timeoutMs}),timeoutMs,`list tools from ${name}`);
    this.live.set(name,client);view.status='connected';view.tools=listed.tools.map(t=>({name:t.name,description:t.description??t.name}));view.message=`Connected · ${listed.tools.length} tools`;
    client.onclose=()=>{if(this.views.get(name)===view){view.status='unavailable';view.message='Disconnected. Choose Reconnect.';}};
    for(const tool of listed.tools)all.push(this.wrapTool(name,client,timeoutMs,tool));
    onStatus?.(`${name}: connected — ${listed.tools.length} tool(s)`);
   }catch(error:any){await client.close().catch(()=>{});view.status=(provider?.requested||/401|403|sign.in|unauthorized/i.test(String(error?.message)))?'sign-in':'unavailable';view.message=this.safeError(name,error);onStatus?.(`${name}: unavailable — ${view.message}`);}
   finally{this.pending.delete(client);provider?.close();if(provider)this.authorizing.delete(provider);}
  }
  return all;
 }
 cancelSignIn():void{for(const provider of this.authorizing)provider.close();}
 async disconnect(name:string):Promise<void>{await this.live.get(name)?.close().catch(()=>{});this.live.delete(name);}
 async close():Promise<void>{this.generation++;this.cancelSignIn();await Promise.all([...new Set([...this.live.values(),...this.pending])].map(c=>c.close().catch(()=>{})));this.live.clear();this.pending.clear();}
 private write():void{mkdirSync(dirname(this.configPath),{recursive:true});const temp=this.configPath+'.tmp';writeFileSync(temp,JSON.stringify(this.config,null,2),{mode:0o600});renameSync(temp,this.configPath);}
 private secret(name:string):{env?:Record<string,string>;token?:string;query?:Record<string,string>;headers?:Record<string,string>}{try{return JSON.parse(this.options.secrets?.get(`mcp:${name}`)??'{}');}catch{return {};}}
 private view(name:string,server:McpServerConfig):McpServerView {
  const secret=this.secret(name),recipe=identifyConnector({name,...server});
  const missingLocalKey=recipe?.id==='tavily'&&server.transport==='stdio'&&placeholderSecret(secret.env?.TAVILY_API_KEY??server.env?.TAVILY_API_KEY);
  const missingRemoteKey=server.transport!=='stdio'&&!server.oauth&&['tavily','github'].includes(recipe?.id??'')&&placeholderSecret(secret.token)&&!Object.keys({...server.headers,...secret.headers}).some(k=>/authorization|api[-_]?key/i.test(k))&&!/[?&](tavilyApiKey|token)=/.test(server.url??'');
  const missingEnv=Object.values({...server.env,...secret.env}).some(placeholderSecret);
  const needsSetup=missingLocalKey||missingRemoteKey||missingEnv||(!server.url&&server.transport!=='stdio')||(!server.command&&server.transport==='stdio');
  return {name,provider:recipe?.id,needsSetup,transport:server.transport,url:server.url,command:server.command,args:server.args??[],enabled:server.enabled!==false,timeout:server.timeout??30,status:needsSetup?'needs-setup':server.enabled===false?'disabled':'saved',message:needsSetup?'Finish setup to connect. Choose a sign-in method or add the missing details.':server.enabled===false?'Disabled':'Ready to connect',tools:[],secretNames:[...new Set([...Object.keys(server.env??{}),...Object.keys(secret.env??{})])],hasToken:!!Object.keys(secret.headers??{}).length||!!secret.token||!!Object.keys(secret.query??{}).length,oauth:!!server.oauth};
 }
 private safeError(name:string,error:any):string{let message=String(error?.message??error).slice(0,500);const secret=this.secret(name);for(const value of [...Object.values(secret.env??{}),...Object.values(secret.query??{}),...Object.values(secret.headers??{}),secret.token])if(value)message=message.split(value).join('[hidden]');return message;}
 private transport(name:string,server:McpServerConfig,provider?:McpOAuth){
  const secret=this.secret(name);const remoteUrl=server.url?new URL(server.url):undefined;for(const [key,value] of Object.entries(secret.query??{}))remoteUrl?.searchParams.set(key,value);const headers={...server.headers,...secret.headers,...(!server.oauth&&secret.token?{Authorization:`Bearer ${secret.token}`}:{})};
  if(server.transport==='http')return new StreamableHTTPClientTransport(remoteUrl!,{authProvider:provider,requestInit:{headers}});
  if(server.transport==='sse')return new SSEClientTransport(remoteUrl!,{requestInit:{headers}});
  if(!server.command)throw Error('Local server command is missing.');
  const runtime=this.options.runner?.(server.command,server.args??[],fullEnv({...server.env,...secret.env}))??{command:server.command,args:server.args??[],env:fullEnv({...server.env,...secret.env})};
  const transport=new StdioClientTransport({...runtime,stderr:'pipe'});
  transport.stderr?.on('data',()=>{});return transport;
 }
 private wrapTool(name:string,client:Client,timeout:number,tool:{name:string;description?:string;inputSchema?:unknown}):Tool{
  return {name:`mcp__${name}__${tool.name}`,description:`[MCP:${name}] ${tool.description??tool.name}`,parameters:tool.inputSchema&&typeof tool.inputSchema==='object'?tool.inputSchema as Record<string,unknown>:{type:'object',properties:{}},handler:async args=>{
   const result=await client.callTool({name:tool.name,arguments:args},undefined,{timeout}) as {content?:unknown;isError?:boolean};return flattenContent(result.content,result.isError).slice(0,20000);
  }};
 }
}

/* ------------------------------ helpers ------------------------------- */

/** process.env values are `string | undefined`; the transport wants plain strings. */
function fullEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...(extra ?? {}) };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Flatten an MCP CallToolResult content array into one text blob. */
function flattenContent(content: unknown, isError?: boolean): string {
  if (!Array.isArray(content) || content.length === 0) return "(no output)";
  const parts = (content as any[]).map((c) => {
    if (c?.type === "text") return c.text ?? "";
    if (c?.type === "image") return "[image]";
    if (c?.type === "resource") {
      const r = c.resource ?? {};
      return typeof r.text === "string" ? r.text : `[resource ${r.uri ?? "unknown"}]`;
    }
    return JSON.stringify(c);
  });
  const text = parts.join("\n");
  return isError ? `MCP tool reported an error:\n${text}` : text;
}
