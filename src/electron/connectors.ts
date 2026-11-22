/** Official hosted endpoints; setup metadata shared by the UI and readiness checks. */
export type ConnectorAuth = 'oauth'|'token'|'none';
export interface ConnectorRecipe {id:string;label:string;description:string;category:string;url?:string;auth:ConnectorAuth;methods:ConnectorAuth[];help:string;keyUrl?:string;oauthUrl?:string;note:string;}
export const CONNECTORS:ConnectorRecipe[]=[
 {id:'tavily',label:'Tavily',description:'Search the web and read pages.',category:'Research',url:'https://mcp.tavily.com/mcp/',auth:'oauth',methods:['oauth','token'],help:'https://docs.tavily.com/documentation/mcp',keyUrl:'https://app.tavily.com',note:'Sign in to your Tavily account, or paste an API key or your ready-made MCP link.'},
 {id:'exa',label:'Exa',description:'Find sources, people and code.',category:'Research',url:'https://mcp.exa.ai/mcp',oauthUrl:'https://mcp.exa.ai/mcp?login',auth:'none',methods:['none','oauth','token'],help:'https://exa.ai/mcp',keyUrl:'https://dashboard.exa.ai/api-keys',note:'Basic search works without a key, with service limits. Sign in for your account limits.'},
 {id:'github',label:'GitHub',description:'Work with repositories and issues.',category:'Work',url:'https://api.githubcopilot.com/mcp/',auth:'token',methods:['token'],help:'https://github.com/github/github-mcp-server',keyUrl:'https://github.com/settings/personal-access-tokens',note:'Create a token with access to the repositories you want to use, then paste it here. GitHub currently requires a registered client for browser sign-in.'},
 {id:'notion',label:'Notion',description:'Search and update your workspace.',category:'Work',url:'https://mcp.notion.com/mcp',auth:'oauth',methods:['oauth'],help:'https://developers.notion.com/guides/mcp/get-started-with-mcp',note:'Sign in, then choose the Notion workspace and pages you want to connect.'},
 {id:'linear',label:'Linear',description:'Find and manage issues and projects.',category:'Work',url:'https://mcp.linear.app/mcp',auth:'oauth',methods:['oauth','token'],help:'https://linear.app/docs/mcp',keyUrl:'https://linear.app/settings/api',note:'Sign in to select your workspace, or use a Linear API key.'},
 {id:'context7',label:'Context7',description:'Look up current library documentation.',category:'Development',url:'https://mcp.context7.com/mcp',oauthUrl:'https://mcp.context7.com/mcp/oauth',auth:'none',methods:['none','oauth','token'],help:'https://context7.com/docs/resources/all-clients',keyUrl:'https://context7.com/dashboard',note:'Connect to public documentation, or sign in for your account limits.'},
 {id:'files',label:'Files in a folder',description:'Read and organize a folder you choose.',category:'Local',auth:'none',methods:['none'],help:'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',note:'Choose the folder the assistant may work with. The local connector is installed automatically on first use.'}
];
export function identifyConnector(server:{name?:string;url?:string;command?:string;args?:string[];provider?:string}):ConnectorRecipe|undefined {
 if(server.provider)return CONNECTORS.find(c=>c.id===server.provider);
 let host='';try{host=new URL(server.url??'').hostname;}catch{}
 const known=CONNECTORS.find(c=>c.url&&new URL(c.url).hostname===host);if(known)return known;
 const args=(server.args??[]).join(' ');
 if(/tavily/i.test(args)||/^tavily(?:$|[-_])/i.test(server.name??''))return CONNECTORS[0];
 if(/exa-mcp/i.test(args))return CONNECTORS.find(c=>c.id==='exa');
 if(/server-filesystem/.test(args))return CONNECTORS.find(c=>c.id==='files');
 return undefined;
}
export function splitConnectionUrl(raw:string):{url:string;token?:string;query:Record<string,string>} {
 const url=new URL(raw.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Paste an HTTP or HTTPS MCP link.');
 let token:string|undefined;const query:Record<string,string>={};
 const entries:[string,string][]=[];url.searchParams.forEach((value,key)=>entries.push([key,value]));
 for(const [key,value] of entries){
  if(/(?:key|token|secret|signature|credential|authorization)/i.test(key)){
   if(!value.trim()||/<|>|your[-_ ]?(api|key|token)|\$\{|REPLACE/i.test(value))throw Error('This link contains a placeholder. Paste the complete connection link from your provider.');
   if((url.hostname==='mcp.tavily.com'&&key==='tavilyApiKey')||(url.hostname==='mcp.exa.ai'&&key==='exaApiKey'))token=value;
   else query[key]=value;
   url.searchParams.delete(key);
  }
 }
 return {url:url.toString(),token,query};
}
export const placeholderSecret=(value?:string)=>!value?.trim()||/^(?:YOUR[_ -]|REPLACE|CHANGEME|<|\$\{)/i.test(value.trim());
