// Source-loaded regressions: no build output, real accounts or user data are changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { McpManager } = require('../src/electron/agent/mcp.ts');
const { McpOAuth } = require('../src/electron/services/mcpOAuth.ts');
const { splitConnectionUrl } = require('../src/electron/connectors.ts');
const { ToolsRegistry } = require('../src/electron/agent/registry.ts');
const { buildInternalTools } = require('../src/electron/agent/internalTools.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-chat-easy-setup-'));
let passed = 0, failed = 0;
const vault = () => { const values = new Map(); return { get: k => values.get(k), set: (k,v) => values.set(k,v), delete: k => values.delete(k) }; };
let count = 0;
function fixture(config) { const secrets = vault(), file = path.join(dir, `${count++}.json`); if(config) fs.writeFileSync(file,JSON.stringify(config)); return { secrets, file, manager: new McpManager(file,{secrets}) }; }
const secret = (secrets,name='sample') => JSON.parse(secrets.get(`mcp:${name}`) || '{}');
async function check(name, fn) { try { await fn(); passed++; console.log('PASS '+name); } catch(error) { failed++; console.error('FAIL '+name+'\n  '+error.message); } }
(async () => {
 await check('ready-made links separate API keys from visible URL', () => {
  const parsed=splitConnectionUrl('https://mcp.tavily.com/mcp/?tavilyApiKey=fixture-key');
  assert.equal(parsed.token,'fixture-key'); assert(!parsed.url.includes('fixture-key'));
 });
 await check('missing Tavily key is setup-needed without starting a process', async () => {
  const {manager}=fixture({servers:{tavily:{transport:'stdio',command:'definitely-not-a-command',args:['tavily-mcp']}}});
  assert.equal((await manager.connectAll()).length,0);assert.equal(manager.list()[0].status,'needs-setup');await manager.close();
 });
 await check('changing remote origin discards legacy environment secrets', () => {
  const {manager,secrets}=fixture({servers:{sample:{transport:'http',url:'https://old.example/mcp',env:{API_KEY:'old-env-secret'}}}});
  manager.save({name:'sample',transport:'http',url:'https://new.example/mcp'});
  assert(!JSON.stringify(secret(secrets)).includes('old-env-secret'));
 });
 await check('changing endpoint path discards old token and OAuth registration', () => {
  const {manager,secrets}=fixture();manager.save({name:'sample',transport:'http',url:'https://host.example/team-a/mcp',token:'team-a-secret'});
  secrets.set('oauth:sample:client','{"client_id":"team-a-client"}');secrets.set('oauth:sample:tokens','{"access_token":"team-a-oauth"}');
  manager.save({name:'sample',transport:'http',url:'https://host.example/team-b/mcp'});
  assert.equal(secret(secrets).token,undefined);assert.equal(secrets.get('oauth:sample:client'),undefined);assert.equal(secrets.get('oauth:sample:tokens'),undefined);
 });
 await check('switching to browser sign-in drops stale query credentials', () => {
  const {manager,secrets}=fixture();manager.save({name:'sample',transport:'http',url:'https://host.example/mcp?api_key=old-query-secret'});
  manager.save({name:'sample',transport:'http',url:'https://host.example/mcp',oauth:true});
  assert(!JSON.stringify(secret(secrets)).includes('old-query-secret'));
 });
 await check('loading legacy URL credentials never exposes them in server views', () => {
  const {manager}=fixture({servers:{sample:{transport:'http',url:'https://host.example/mcp?api_key=legacy-url-secret'}}});
  assert(!JSON.stringify(manager.list()).includes('legacy-url-secret'));
 });
 await check('legacy credentials are moved out of the plaintext config', () => {
  const {manager,file}=fixture({servers:{sample:{transport:'http',url:'https://host.example/mcp?api_key=legacy-url-secret',headers:{Authorization:'Bearer legacy-header-secret'},env:{API_KEY:'legacy-env-secret'}}}});
  manager.loadConfig();assert(!/legacy-(url|header|env)-secret/.test(fs.readFileSync(file,'utf8')));
 });
 await check('legacy custom and lowercase authentication headers leave plaintext config', () => {
  const {manager,file}=fixture({servers:{sample:{transport:'http',url:'https://host.example/mcp',headers:{authorization:'Basic fixture-basic', 'x-api-key':'fixture-header-key'}}}});
  manager.loadConfig();assert(!/fixture-basic|fixture-header-key/.test(fs.readFileSync(file,'utf8')));
 });
 await check('same endpoint saves preserve an existing bearer credential', () => {
  const {manager,secrets}=fixture();manager.save({name:'sample',transport:'http',url:'https://host.example/mcp',token:'kept-token'});manager.save({name:'sample',transport:'http',url:'https://host.example/mcp'});assert.equal(secret(secrets).token,'kept-token');
 });
 await check('Tavily local migration never forwards a key to an unrelated endpoint', () => {
  const {manager,secrets}=fixture({servers:{tavily:{transport:'stdio',command:'npx',args:['tavily-mcp'],env:{TAVILY_API_KEY:'private-tavily-key'}}}});
  manager.save({name:'tavily',provider:'tavily',transport:'http',url:'https://unrelated.example/mcp'});
  assert(!JSON.stringify(secret(secrets,'tavily')).includes('private-tavily-key'));
 });
 for(const [toolName,argName] of [['tavily-search','max_results'],['tavily_search','max_results'],['web_search_exa','numResults']])await check('built-in web search routes through connected '+toolName, async () => {
  const registry=new ToolsRegistry();let received;
  registry.register({name:'mcp__search__'+toolName,description:'Search',parameters:{},handler:async args=>{received=args;return 'fixture-source';}});
  const search=buildInternalTools({scratch:{},registry}).find(t=>t.name==='web_search');
  assert.equal(await search.handler({query:'fixture query',max_results:3}),'fixture-source');assert.deepEqual(received,{query:'fixture query',[argName]:3});
 });
 await check('canceling browser sign-in promptly rejects its waiter', async () => {
  const oauth=new McpOAuth('cancel',vault(),true,async()=>{});
  try{await oauth.listen();const pending=oauth.waitCode();oauth.close();await assert.rejects(pending,/cancel/i);}finally{oauth.close();}
 });
 console.log(`\n${passed} easy-setup checks passed; ${failed} failed`);process.exitCode=failed?1:0;
})().finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
