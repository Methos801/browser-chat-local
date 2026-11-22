const assert = require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const http = require('node:http');
const {AppDb} = require('../dist/store/db');
const {ConversationStore} = require('../dist/store/conversations');
const {SettingsStore,DEFAULT_SETTINGS} = require('../dist/store/settings');
const {ConnectionManager} = require('../dist/store/connection');
const {ToolsRegistry} = require('../dist/agent/registry');
const {runToolLoop} = require('../dist/agent/loop');
const {prepareContext,estimateTokens,selectModel,skillTools,optimizeSettings} = require('../dist/agent/skills');
const {ScratchPad} = require('../dist/services/scratchPad');
const {AnthropicAdapter} = require('../dist/protocol/anthropic');
let passed=0;
function check(name,fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
(async()=>{
 const dir = mkdtempSync(join(tmpdir(),'browser-chat-phase3-'));
 const path = join(dir,'chat.sqlite');
 let db;
 const bodies=[];
 const server=http.createServer(async(req,res)=>{
  if(req.url.endsWith('/models')) {res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'mock-local',context_length:8192}]}));return;}
  let raw=''; for await(const c of req) raw+=c;
  const body=raw ? JSON.parse(raw) : {}; bodies.push(body);
  if(req.url.endsWith('/messages')) {
   res.writeHead(200,{'content-type':'text/event-stream'});
   const frames = body.messages.some(m=>m.content?.some(c=>c.type==='tool_result'))
    ? [{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Tool complete'}}]
    : [{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call_a',name:'add',input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"a":4'}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:',"b":5}'}}];
   const wire=frames.map(x=>`event: update\r\ndata: ${JSON.stringify(x)}\r\n\r\n`).join('');
   // Deliberately split the JSON inside an SSE frame.
   res.write(wire.slice(0,27));setTimeout(()=>res.end(wire.slice(27)),5);return;
  }
  if(body.stream===false) {res.end(JSON.stringify({choices:[{message:{content:'pong'}}]}));return;}
  if(req.url.endsWith('/chat/completions')) {
   res.writeHead(200,{'content-type':'text/event-stream'});
   if(body.messages.some(m=>m.content==='wait')) { res.write(': waiting\n\n');return; }
   const wire='data: '+JSON.stringify({choices:[{delta:{content:'Hello persisted'}}]})+'\n\ndata: [DONE]\n\n';
   res.write(wire.slice(0,19));setTimeout(()=>res.end(wire.slice(19)),5);return;
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/v1`;
 try {
  db=await new AppDb(path).open();
  const history=new ConversationStore(db),settings=new SettingsStore(db);
  const mgr=new ConnectionManager({db,settings});
  const connected=await mgr.connect({name:'Auto ID',url:url.replace('http://',''),auth:'test-secret'});
  check('bare host:port connects with a usable generated ID',()=>assert.equal(connected.status,'connected'));
  const id=connected.connection.id;
  check('IPC-facing connections redact authentication',()=>assert.equal(JSON.stringify(connected).includes('test-secret')||JSON.stringify(db.all('SELECT auth FROM connections')).includes('test-secret'),false));
  const events=[];
  const conv=history.create(id,'mock-local');
  history.replaceMessages(conv.id,[{role:'user',content:'Remember this conversation'}]);
  const answer=await mgr.streamChat({connectionId:id,modelId:'mock-local',messages:history.load(conv.id)},e=>events.push(e),m=>history.append(conv.id,m));
  check('fragmented OpenAI SSE returns complete text',()=>assert.equal(answer.content,'Hello persisted'));
  check('first message supplies history title',()=>assert.equal(history.get(conv.id).title,'Remember this conversation'));
  settings.remember('My favorite color is cobalt');
  const prefs={...settings.get(),automatic:false,contextTokens:8192,maxOutputTokens:512};settings.save(prefs);
  check('settings reject invalid output budget',()=>assert.throws(()=>settings.save({...prefs,maxOutputTokens:8192})));
  const many=Array.from({length:40},(_,i)=>({role:i%2 ? 'assistant':'user',content:`turn ${i}: `+'content '.repeat(90)}));
  const slim=prepareContext({connectionId:id,modelId:'mock-local',messages:[{role:'system',content:'Keep this instruction'},...many]},prefs,settings);
  check('context slimming keeps system instruction and latest exchange within budget',()=>{assert.equal(slim.messages[0].content,'Keep this instruction');assert.equal(slim.messages.at(-1).content,many.at(-1).content);assert(estimateTokens(slim.messages)<8192-512);assert(slim.messages.length<many.length);});
  const recall=prepareContext({connectionId:id,modelId:'mock-local',messages:[{role:'user',content:'favorite color?'}]},prefs,settings);
  check('memory recall includes relevant saved facts',()=>assert(recall.messages.some(m=>m.content.includes('cobalt'))));
  check('oversize latest message fails clearly without dropping it',()=>assert.throws(()=>prepareContext({connectionId:id,modelId:'mock-local',messages:[{role:'user',content:'x'.repeat(50000)}]},prefs,settings),/context budget/));
  const lowRam=optimizeSettings(prefs,{ramGB:8},{id:'small',contextWindow:32768});
  const modelCap=optimizeSettings(prefs,{ramGB:96},{id:'limited',contextWindow:4096});
  check('automatic tuning respects low RAM and reported model context limits',()=>{assert.equal(lowRam.contextTokens,8192);assert.equal(modelCap.contextTokens,4096);assert.equal(modelCap.automatic,true);assert.equal(modelCap.memoryRecall,prefs.memoryRecall);});
  const autoReq={connectionId:id,modelId:'adaptive',messages:[{role:'user',content:'hello'}]};
  const small=prepareContext(autoReq,{...prefs,automatic:true},settings,{id:'adaptive',contextWindow:4096},{ramGB:48});
  const large=prepareContext(autoReq,{...prefs,automatic:true},settings,{id:'adaptive',contextWindow:32768},{ramGB:48});
  check('automatic mode adapts effective output limits when models change',()=>{assert.equal(small.params.max_tokens,1024);assert.equal(large.params.max_tokens,16384);});
  check('new defaults reserve 40K total context and up to 16K output',()=>{assert.equal(DEFAULT_SETTINGS.contextTokens,40960);assert.equal(DEFAULT_SETTINGS.maxOutputTokens,16384);});
  check('automatic settings use 32K on 16GB and 40K on 24GB or larger machines',()=>{for(const ramGB of [16,24,48,96]){const tuned=optimizeSettings(prefs,{ramGB},{id:'large',contextWindow:131072});assert.equal(tuned.contextTokens,ramGB<24?32768:40960);assert.equal(tuned.maxOutputTokens,16384);}});
  check('reported output caps and invalid model metadata are handled',()=>{assert.equal(optimizeSettings(prefs,{ramGB:48},{id:'capped',contextWindow:65536,maxOutputTokens:4096}).maxOutputTokens,4096);const unknown=optimizeSettings(prefs,{ramGB:48},{id:'unknown',contextWindow:NaN,maxOutputTokens:-1});assert.equal(unknown.contextTokens,40960);assert.equal(unknown.maxOutputTokens,16384);});
  check('32K context with 16K output can be saved and manual settings stay unchanged',()=>{settings.save({...prefs,contextTokens:32768,maxOutputTokens:16384});assert.equal(settings.get().maxOutputTokens,16384);settings.save(prefs);assert.equal(settings.get().contextTokens,8192);});
  const searchText='Source text '.repeat(6500);
  const searchReq={...autoReq,messages:[{role:'system',content:'Skill instructions '.repeat(650)},{role:'user',content:'Find and compare sources'},{role:'assistant',toolCalls:[{id:'search',name:'web_search',arguments:{}}]},{role:'tool',toolCallId:'search',content:searchText}],tools:[{name:'web_search',description:'Search sources',parameters:{type:'object'}}]};
  let searchInfo;const searchPrepared=prepareContext(searchReq,{...prefs,automatic:true},settings,{id:'search',contextWindow:65536},{ramGB:48},value=>{searchInfo=value;});
  check('large search results and skill instructions fit by borrowing output reserve',()=>{assert.equal(searchPrepared.messages.at(-1).content,searchText);assert.equal(searchPrepared.messages.length,searchReq.messages.length);assert(searchPrepared.params.max_tokens>=1024&&searchPrepared.params.max_tokens<16384);assert(searchInfo.usedTokens+searchInfo.reservedTokens<=searchInfo.limitTokens);});
  check('existing automatic settings adopt larger budgets without a data reset',()=>{const ready=prepareContext(autoReq,{...prefs,automatic:true,contextTokens:8192,maxOutputTokens:1024},settings,undefined,{ramGB:48});assert.equal(ready.params.max_tokens,16384);});
  check('tool requests still respect small reported model limits',()=>{let info;prepareContext({...autoReq,tools:searchReq.tools},{...prefs,automatic:true},settings,{id:'small',contextWindow:2048},{ramGB:48},value=>{info=value;});assert.equal(info.limitTokens,2048);assert(info.usedTokens+info.reservedTokens<=2048);});
  check('image budgeting excludes base64 text from the text-token estimate',()=>assert(estimateTokens([{role:'user',content:'Describe this',images:[{type:'image',mimeType:'image/png',data:'a'.repeat(100000)}]}])<3000));
  check('model selector chooses a vision model only when requested',()=>assert.equal(selectModel([{id:'text'},{id:'vision',vision:true}],true).id,'vision'));
  const scratch=new ScratchPad(dir);
  const tool=skillTools(scratch)[0];const output=JSON.parse(await tool.handler({name:'result.md',text:'# Result\nBuilt locally.'}));
  check('document assembly writes a usable scratch artifact',()=>assert.match(readFileSync(output.path,'utf8'),/Built locally/));
  const reg=new ToolsRegistry();let calls=0;
  reg.register({name:'add',description:'Add numbers',parameters:{type:'object'},handler:async args=>{calls++;return String(args.a+args.b);}});
  const transcript=[];
  const result=await runToolLoop(new AnthropicAdapter(url,''),{connectionId:id,modelId:'mock-local',messages:[{role:'user',content:'Old question'},{role:'assistant',content:'Old reply'},{role:'user',content:'Add 4 and 5'}]},reg,()=>{},{onMessage:m=>transcript.push(m)});
  check('Anthropic JSON deltas execute the tool with complete arguments',()=>{assert.equal(calls,1);assert.equal(result.content,'Tool complete');assert.equal(transcript[1].content,'9');});
  const wire=bodies.filter(b=>b.messages?.some(m=>m.content?.some?.(c=>c.type==='tool_result'))).at(-1);
  check('Anthropic preserves chronology and sends tool results as user content',()=>{assert.deepEqual(wire.messages.slice(0,3).map(m=>m.role),['user','assistant','user']);assert.equal(wire.messages.at(-1).role,'user');assert.equal(wire.messages.at(-1).content[0].content,'9');assert.equal(wire.max_tokens,1024);});
  let sideEffects=0;
  const endless={kind:'openai',chat:async()=>({role:'assistant',toolCalls:[{id:'loop',name:'side',arguments:{}}]})};
  const bounded=new ToolsRegistry(); bounded.register({name:'side',description:'side',parameters:{},handler:async()=>String(++sideEffects)});
  await assert.rejects(()=>runToolLoop(endless,{connectionId:id,modelId:'x',messages:[]},bounded,()=>{},{maxIterations:1}),/budget reached/);
  check('tool budget stops without executing a final unanswerable tool',()=>assert.equal(sideEffects,1));
  const ctrl=new AbortController();
  const waiting=mgr.streamChat({connectionId:id,modelId:'mock-local',messages:[{role:'user',content:'wait'}],signal:ctrl.signal},()=>{});
  setTimeout(()=>ctrl.abort(),30);
  await assert.rejects(()=>waiting);
  check('Stop aborts an in-flight model stream',()=>assert(ctrl.signal.aborted));
  const before=history.load(conv.id);await db.close();
  db=await new AppDb(path).open();
  const restored=new ConversationStore(db),savedSettings=new SettingsStore(db),savedMgr=new ConnectionManager({db});
  check('conversation and complete messages survive database reopen',()=>{assert.deepEqual(restored.load(conv.id),before);assert.equal(restored.list().length,1);});
  check('settings and facts survive database reopen',()=>{assert.equal(savedSettings.get().maxOutputTokens,512);assert.equal(savedSettings.facts()[0].text,'My favorite color is cobalt');});
  const saved=await savedMgr.listConnections();
  check('connections survive restart without storing raw API keys',()=>{assert.equal(saved[0].id,id);assert.equal(db.get('SELECT auth FROM connections').auth,null);});
  check('transaction rollback preserves previous state',()=>{assert.throws(()=>db.transaction(()=>{db.run('DELETE FROM conversations');throw Error('rollback');}));assert.equal(restored.list().length,1);});
  restored.delete(conv.id);savedSettings.forget(savedSettings.facts()[0].id);
  check('history and fact deletion remove corresponding rows',()=>{assert.equal(restored.load(conv.id).length,0);assert.equal(savedSettings.facts().length,0);});
  console.log(`\n${passed} Phase 3 checks passed`);
 } finally { await db?.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true}); }
})().catch(err=>{console.error(err);process.exitCode=1;});
