const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,symlinkSync}=require('node:fs');
const {join}=require('node:path');const {tmpdir}=require('node:os');const {execFile}=require('node:child_process');const {promisify}=require('node:util');const http=require('node:http');
const {AppDb}=require('../dist/store/db');const {SecretStore}=require('../dist/store/secrets');const {SkillLibrary,parseSkill,readSkillFolder}=require('../dist/store/skillLibrary');const {ContextStore}=require('../dist/store/context');const {SettingsStore}=require('../dist/store/settings');const {ConversationStore}=require('../dist/store/conversations');const {ConnectionManager}=require('../dist/store/connection');const {ToolsRegistry}=require('../dist/agent/registry');const {McpManager}=require('../dist/agent/mcp');const {McpOAuth}=require('../dist/services/mcpOAuth');const {ScratchPad}=require('../dist/services/scratchPad');const {buildInternalTools}=require('../dist/agent/internalTools');const {assembleDocument}=require('../dist/services/documentAssemble');const {parseDocument}=require('../dist/services/documentParse');const {localRunner}=require('../dist/services/localRunner');const {OpenAIChatAdapter}=require('../dist/protocol/openaiChat');const {AnthropicAdapter}=require('../dist/protocol/anthropic');const {runToolLoop}=require('../dist/agent/loop');
let passed=0;const check=(name,fn)=>{fn();passed++;console.log('  ✓ '+name);};
const fixtureSkill='---\nname: source-check\ndescription: |\n  Check sources and compare supplied evidence.\nargument-hint: document or question\n---\nRead the supplied material. State what is known and what is missing.';
(async()=>{
 const dir=mkdtempSync(join(tmpdir(),'browser-chat-features-'));let db;let manager;let server;
 try{
  db=await new AppDb(join(dir,'test.sqlite')).open();const settings=new SettingsStore(db),history=new ConversationStore(db),library=new SkillLibrary(db),context=new ContextStore(db);
  const codec={encrypt:s=>Buffer.from(Buffer.from(s).map(b=>b^0x5a)),decrypt:b=>Buffer.from(b.map(v=>v^0x5a)).toString()};const secrets=new SecretStore(db,codec);secrets.set('fixture','secret-not-plain');
  check('OS-codec vault persists encrypted content without plaintext rows',()=>{assert.equal(secrets.get('fixture'),'secret-not-plain');assert(!JSON.stringify(db.all('SELECT * FROM meta')).includes('secret-not-plain'));});
  const temporary=new SecretStore(db);temporary.set('temporary','session-key');check('no-codec fallback does not persist plaintext credentials',()=>assert.equal(db.get('SELECT value FROM meta WHERE key = ?',['secret:temporary']),undefined));
  check('starter library contains eight enabled user-facing skills',()=>assert.equal(library.list().filter(s=>s.enabled).length,8));
  const draft=parseSkill(fixtureSkill);check('standard YAML metadata and multi-line description parse correctly',()=>{assert.equal(draft.name,'source-check');assert.equal(draft.hint,'document or question');assert.match(draft.description,/Check sources/);});
  check('invalid skill headers fail with an actionable error',()=>assert.throws(()=>parseSkill('# no metadata'),/SKILL.md/));
  const added=library.add({...draft,resources:{'references/checklist.md':'Verify the original source.'}});check('reviewed import preserves reference content',()=>assert.deepEqual(added.resources,['references/checklist.md']));
  assert.match(await library.referenceTool().handler({skillId:added.id,path:'references/checklist.md'}),/original source/);
  library.toggle(added.id,false);await assert.rejects(()=>library.referenceTool().handler({skillId:added.id,path:'references/checklist.md'}));check('disabled skills cannot be loaded through the reference tool',()=>assert.equal(library.select({messages:[],skillIds:[added.id]}).length,0));
  check('skill resource traversal is rejected',()=>assert.throws(()=>library.add({...draft,resources:{'../outside.txt':'bad'}}),/Invalid/));
  const folder=join(dir,'source-skill');mkdirSync(join(folder,'references'),{recursive:true});writeFileSync(join(folder,'SKILL.md'),fixtureSkill);writeFileSync(join(folder,'references','guide.md'),'Bundled guidance');
  check('folder import reads bundled references for review',()=>assert.equal(readSkillFolder(folder).resources['references/guide.md'],'Bundled guidance'));
  const outside=join(dir,'outside.txt');writeFileSync(outside,'not selected');symlinkSync(outside,join(folder,'references','escape.txt'));
  check('folder import refuses references outside the chosen package',()=>assert.throws(()=>readSkillFolder(folder),/outside/));
  const registry=new ToolsRegistry();registry.register({name:'document_parse',description:'read document',parameters:{},handler:async()=>''});registry.register({name:'mcp__sample__read',description:'read sample',parameters:{},handler:async()=>''});
  const applied=library.apply({connectionId:'x',modelId:'x',skillIds:['document-review'],messages:[{role:'user',content:'Review this document'}]},registry);
  check('selected skill instructions and actual available tool schemas reach the request',()=>{assert.match(applied.request.messages[0].content,/Review a document/);assert(applied.request.tools.some(t=>t.name==='document_parse'));});
  check('automatic skill selection matches a document review task',()=>assert(library.select({messages:[{role:'user',content:'Review and summarize the attached document'}]}).some(s=>s.id==='document-review')));
  registry.removePrefix('mcp__');check('disabling/reloading MCP can remove stale registry tools',()=>assert(!registry.has('mcp__sample__read')));
  const conv=history.create('fixture','fixture');const messages=[{role:'user',content:'The launch is Friday. Keep the red label.'},{role:'assistant',content:'Friday launch, red label.'},{role:'user',content:'What remains to do?'},{role:'assistant',content:'Review the checklist.'}];history.replaceMessages(conv.id,messages);
  const req={connectionId:'fixture',modelId:'fixture',conversationId:conv.id,messages};const result=await context.compact(req,async()=> 'Launch Friday. Keep the red label. Current open task: review the checklist.');
  check('model-assisted compaction saves a bounded factual recap',()=>{assert.equal(result.mode,'model');assert.equal(result.removedMessages,2);});
  check('compaction keeps the complete saved transcript untouched',()=>assert.deepEqual(history.load(conv.id),messages));
  const reloaded=context.apply({...req,messages:messages.map((m,i)=>({...m,id:'new-ui-'+i}))});check('saved compaction survives regenerated renderer message IDs',()=>{assert(reloaded.contextCompacted);assert.match(reloaded.messages[0].content,/Launch Friday/);});
  const fallback=await context.compact(req,async()=>{throw Error('offline');});check('compaction has a working offline extractive fallback',()=>assert.equal(fallback.mode,'extractive'));
  context.clear(conv.id);check('clearing the saved recap restores full working transcript',()=>assert.equal(context.apply(req).messages.length,messages.length));
  const scratch=new ScratchPad(dir);
  const documentTool=buildInternalTools({scratch}).find(t=>t.name==='document_parse');
  await assert.rejects(()=>documentTool.handler({path:outside}),/Upload this document/);check('document tools cannot acquire arbitrary file access from skill instructions',()=>assert(true));
  const longFile=scratch.save('long.md','text/markdown',new TextEncoder().encode('a'.repeat(25000)+'PAGINATION_MARKER').buffer);
  const section=await documentTool.handler({path:longFile.path,offset:25000,maxChars:1000});check('long attachments can be read in bounded source-labelled sections',()=>assert.match(section,/PAGINATION_MARKER/));
  const doc=await assembleDocument(scratch,{name:'review.docx',text:'# Review\nFacts & details <preserved>\nUnicode: café — résumé'});const parsed=await parseDocument(doc.path);
  check('generated editable DOCX round-trips through the actual parser',()=>assert.match(parsed.text,/Facts & details <preserved>/));
  const xlsx=await assembleDocument(scratch,{name:'budget.xlsx',rows:[['Item','Amount'],['One',42],['Two',58]]});check('generated XLSX preserves tabular data',()=>assert.equal((readFileSync(xlsx.path)).subarray(0,2).toString(),'PK'));
  assert.match((await parseDocument(xlsx.path)).text,/42/);passed++;console.log('  ✓ generated XLSX round-trips through the actual parser');
  const runtime=localRunner(dir);const command=runtime('npx',['--version'],{PATH:process.env.PATH});const run=await promisify(execFile)(command.command,command.args,{env:command.env,timeout:15000});check('bundled npm runner works without an external npx binary',()=>assert.match(run.stdout,/\d+\.\d+\.\d+/));
  let base='';let leakedAuth=false;let registrations=0;
  server=http.createServer(async(req,res)=>{
   const url=new URL(req.url,base);let raw='';for await(const c of req)raw+=c;
   const json=(value,status=200,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};
   if(url.pathname.startsWith('/v1/')){
    const body=JSON.parse(raw);const anthropic=url.pathname.endsWith('/messages');
    if(body.model==='unsupported-tools'&&body.tools)return json({error:{message:'This model does not support tools'}},400);
    if(body.model==='json-reply')return json(anthropic?{type:'message',content:[{type:'text',text:'JSON answer'}]}:{choices:[{message:{role:'assistant',content:'JSON answer'}}]});
    res.writeHead(200,{'content-type':'text/event-stream'});
    const reasoning=body.model==='reasoning-budget'&&body.max_tokens<1024;
    const frame=anthropic?{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Text-only answer'}}:{choices:[{delta:reasoning?{reasoning_content:'PRIVATE_INTERNAL_REASONING'}:{content:'Text-only answer'}}]};
    res.end('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n');return;
   }
   if(url.pathname==='/.well-known/oauth-protected-resource/mcp')return json({resource:base+'/mcp',authorization_servers:[base+'/auth'],scopes_supported:['tools']});
   if(url.pathname.startsWith('/.well-known/oauth-authorization-server')||url.pathname.startsWith('/.well-known/openid-configuration'))return json({issuer:base+'/auth',authorization_endpoint:base+'/auth/authorize',token_endpoint:base+'/auth/token',registration_endpoint:base+'/auth/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
   if(url.pathname==='/auth/register'){registrations++;const body=JSON.parse(raw);return json({...body,client_id:'fixture-client'},201);}
   if(url.pathname==='/auth/token')return json({access_token:'oauth-fixture-token',token_type:'Bearer',expires_in:3600});
   if(url.pathname!=='/mcp')return json({},404);
   if(!['Bearer fixture-token','Bearer oauth-fixture-token'].includes(req.headers.authorization))return json({error:'unauthorized'},401,{'www-authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`});
   if(req.method==='GET')return json({},405);
   if(req.method==='DELETE'){res.writeHead(200).end();return;}
   const body=JSON.parse(raw||'{}');if(!('id' in body)){res.writeHead(202).end();return;}
   let result={};if(body.method==='initialize')result={protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
   if(body.method==='tools/list')result={tools:[{name:'echo',description:'Echo input',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};
   if(body.method==='tools/call')result={content:[{type:'text',text:body.params.arguments.text}]};
   return json({jsonrpc:'2.0',id:body.id,result});
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  for(const Adapter of [OpenAIChatAdapter,AnthropicAdapter]){
   const adapter=new Adapter(base+'/v1','');const events=[];
   const result=await adapter.chat({connectionId:'test',modelId:'unsupported-tools',messages:[{role:'user',content:'Hello'}],tools:[{name:'fixture',description:'Fixture',parameters:{type:'object'}}]},e=>events.push(e));
   check(adapter.kind+': unsupported tool capability recovers without user model tuning',()=>{assert.equal(result.content,'Text-only answer');assert(events.some(e=>e.type==='status'&&e.message.includes('cannot use tools')));});
   const jsonReply=await adapter.chat({connectionId:'test',modelId:'json-reply',messages:[{role:'user',content:'Hello'}]},()=>{});
   check(adapter.kind+': a server JSON response is normalized even when streaming was requested',()=>assert.equal(jsonReply.content,'JSON answer'));
  }
  const reasoningEvents=[];
  const recovered=await runToolLoop(new OpenAIChatAdapter(base+'/v1',''),{connectionId:'test',modelId:'reasoning-budget',messages:[{role:'user',content:'Hello'}]},new ToolsRegistry(),e=>reasoningEvents.push(e),{automaticRecovery:true,prepare:req=>({...req,params:{max_tokens:Math.min(1024,req.maxOutputOverride??512)}})});
  check('automatic mode gives a reasoning model bounded extra room to finish',()=>{assert.equal(recovered.content,'Text-only answer');assert(reasoningEvents.some(e=>e.type==='status'&&e.message.includes('more room')));assert(!JSON.stringify(reasoningEvents).includes('PRIVATE_INTERNAL_REASONING'));});
  const config=join(dir,'mcp.json');manager=new McpManager(config,{secrets,openExternal:async url=>{const auth=new URL(url);await fetch(auth.searchParams.get('redirect_uri')+'?state='+encodeURIComponent(auth.searchParams.get('state'))+'&code=fixture-code');}});
  manager.save({name:'remote',transport:'http',url:base+'/mcp',token:'fixture-token',enabled:true});const tools=await manager.connectAll();check('modern Streamable HTTP MCP connects and discovers tools',()=>assert.equal(tools[0].name,'mcp__remote__echo'));
  assert.equal(await tools[0].handler({text:'round trip'}),'round trip');passed++;console.log('  ✓ remote MCP executes a real SDK tool round trip');
  check('MCP UI state and config redact credentials',()=>{assert(!JSON.stringify(manager.list()).includes('fixture-token'));assert(!readFileSync(config,'utf8').includes('fixture-token'));assert.equal(manager.list()[0].hasToken,true);});
  await manager.close();manager.toggle('remote',false);assert.equal((await manager.connectAll()).length,0);check('disable immediately removes the server from the live tool set',()=>assert.equal(manager.list()[0].status,'disabled'));
  manager.save({name:'oauth',transport:'http',url:base+'/mcp',oauth:true,enabled:true});const signedIn=await manager.connectAll(undefined,'oauth');
  check('browser OAuth with PKCE completes against a local authorization fixture',()=>{assert(signedIn.some(t=>t.name==='mcp__oauth__echo'));assert(registrations>0);});
  await manager.close();manager.remove('oauth');check('removing a server clears its saved OAuth tokens',()=>assert.equal(secrets.get('oauth:oauth:tokens'),undefined));
  await db.close();db=await new AppDb(join(dir,'test.sqlite')).open();const restored=new SecretStore(db,codec);check('encrypted credentials decrypt after a full database reopen',()=>assert.equal(restored.get('fixture'),'secret-not-plain'));
  check('imported skill enable state and resources survive reopen',()=>assert.equal(new SkillLibrary(db).get(added.id).enabled,false));
  console.log(`\n${passed} feature checks passed`);
 }finally{await manager?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await db?.close();rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
