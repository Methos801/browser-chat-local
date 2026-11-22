/** Exercise the real Electron window + preload + React composer against a mock backend. */
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,writeFileSync,rmSync,mkdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');
const http=require('node:http');
const dir=mkdtempSync(join(tmpdir(),'browser-chat-desktop-'));
app.setPath('userData',dir);
process.env.BROWSER_CHAT_MCP_CONFIG=join(dir,'mcp.json');
writeFileSync(process.env.BROWSER_CHAT_MCP_CONFIG,'{"servers":{}}');
let passed=0;
const check=(name,test)=>{assert(test,name);passed++;console.log('  ✓ '+name);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer(async(req,res)=>{
 if(req.url.endsWith('/models'))return res.end(JSON.stringify({data:[{id:'desktop-mock',name:'Desktop mock'}]}));
 if(req.url.endsWith('/api/tags')){res.statusCode=404;return res.end('{}');}
 let raw='';for await(const c of req)raw+=c;
 const b=JSON.parse(raw);
 if(!b.stream)return res.end(JSON.stringify({choices:[{message:{content:'pong'}}]}));
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.end('data: '+JSON.stringify({choices:[{delta:{content:'Desktop end-to-end reply'}}]})+'\n\ndata: [DONE]\n\n');
});
const deadline=setTimeout(()=>{console.error('Desktop test timed out');app.exit(1);},45000);
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const windowPromise=new Promise(r=>app.once('browser-window-created',(_e,w)=>r(w)));
 require(process.env.BROWSER_CHAT_SMOKE_MAIN ? resolve(process.env.BROWSER_CHAT_SMOKE_MAIN) : '../dist/main.js');
 const win=await windowPromise;
 const js=code=>win.webContents.executeJavaScript(code,true);
 const artifacts=join(__dirname,'..','artifacts');mkdirSync(artifacts,{recursive:true});
 const capture=async name=>writeFileSync(join(artifacts,name),(await win.webContents.capturePage()).toPNG());
 win.webContents.on('console-message',(_e,...args)=>console.log('[renderer]',...args));
 if(win.webContents.isLoading())await new Promise(r=>win.webContents.once('did-finish-load',r));
 await delay(400);
 await capture('01-start.png');
 check('real window loads the renderer and preload',await js('!!window.browserChat && !!document.querySelector(".app")'));
 const url=`http://127.0.0.1:${server.address().port}/v1`;
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='+ add').click()`);await delay(50);
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='LM Studio').click()`);await delay(50);
 await js(`document.getElementById('connection-name').focus();document.getElementById('connection-name').select()`);
 await win.webContents.insertText('Desktop test');
 await js(`document.getElementById('connection-url').focus();document.getElementById('connection-url').select()`);
 await win.webContents.insertText(url);await delay(50);
 await capture('02-connect.png');
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Connect server').click()`);
 for(let i=0;i<30;i++){if(await js('document.querySelector(".conn-name")?.innerText === "Desktop test"'))break;await delay(100);}
 check('connection preset and form connect through context-isolated IPC',await js('document.querySelector(".conn-name")?.innerText === "Desktop test"'));
 win.webContents.reload();await new Promise(r=>win.webContents.once('did-finish-load',r));
 for(let i=0;i<50;i++){if(await js('!!document.querySelector("select")?.value'))break;await delay(100);}
 check('saved connection and model populate on reload',await js('document.querySelector("select").value === "desktop-mock"'));
 await js(`document.querySelector('textarea').focus()`);
 await win.webContents.insertText('Desktop persistence question');
 await delay(50);
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Send').click()`);
 for(let i=0;i<60;i++){if(await js('document.body.innerText.includes("Desktop end-to-end reply") && !document.querySelector(".spinner")'))break;await delay(100);}
 await capture('03-chat.png');

 check('composer receives completion and exits streaming',await js('document.body.innerText.includes("Desktop end-to-end reply") && !document.querySelector(".spinner")'));
 const conversations=await js('window.browserChat.listConversations()');
 check('first send automatically creates titled history',conversations.length===1&&conversations[0].title==='Desktop persistence question');
 const messages=await js(`window.browserChat.loadConversation(${JSON.stringify(conversations[0].id)})`);
 check('both user prompt and final reply persist through IPC',messages.length===2&&messages[1].content==='Desktop end-to-end reply');
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Settings & memory').click()`);await delay(100);
 await capture('04-settings.png');
 check('settings open in automatic mode without numeric setup',await js('document.querySelector("[role=dialog]").innerText.includes("Ready to chat") && !document.querySelector("[role=dialog] input[type=number]")'));
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Optimize automatically').click()`);
 for(let i=0;i<30;i++){if(await js('document.querySelector("[role=status]")?.innerText.includes("Automatic settings are ready")'))break;await delay(100);}
 check('Optimize automatically saves an adaptive configuration',await js('window.browserChat.getSettings().then(s=>s.automatic && s.contextTokens >= 2048 && s.maxOutputTokens < s.contextTokens/2)'));
 await capture('04-settings.png');
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Advanced settings').click()`);await delay(50);
 check('manual limits remain available behind Advanced',await js('!!document.querySelector("[role=dialog] input[type=number]")'));
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Hide advanced settings').click()`);
 await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Close').click()`);
 const output=await js(`window.browserChat.exportConversation(${JSON.stringify(conversations[0].id)})`);
 check('history export creates a Markdown document',output.endsWith('.md'));
 writeFileSync(join(artifacts,process.env.BROWSER_CHAT_SMOKE_MAIN?'packaged-desktop.png':'desktop.png'),(await win.webContents.capturePage()).toPNG());
 win.setSize(720,600);await delay(150);
 await capture('05-narrow.png');
 check('narrow desktop layout has no horizontal overflow',await js('document.documentElement.scrollWidth <= window.innerWidth'));
 console.log(`\n${passed} desktop checks passed`);
 clearTimeout(deadline);server.closeAllConnections();server.close();
 app.quit();
})().catch(err=>{console.error(err);clearTimeout(deadline);server.close();app.exit(1);});
app.on('quit',()=>{try{rmSync(dir,{recursive:true,force:true});}catch{}});
