import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed,OAuthTokens,OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretStore } from '../store/secrets';
/** Browser-based OAuth with PKCE handled by the MCP SDK and a state-checked loopback callback. */
export class McpOAuth implements OAuthClientProvider {
 private server?:Server;
 private callback='http://127.0.0.1:0/callback';
 private nonce=randomBytes(24).toString('hex');
 private verifier='';
 private pending?:Promise<string>;
 private resolveCode?:(code:string)=>void;
 private rejectCode?:(error:Error)=>void;
 requested=false;
 constructor(private name:string,private secrets:SecretStore,private interactive:boolean,private open:(url:string)=>Promise<void>) {
  this.callback=secrets.get(`oauth:${name}:redirect`)??this.callback;
 }
 get redirectUrl():string {return this.callback;}
 get clientMetadata():OAuthClientMetadata {return {client_name:'Browser Chat',redirect_uris:[this.callback],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'};}
 state():string{return this.nonce;}
 clientInformation():OAuthClientInformationMixed|undefined {return this.read('client');}
 saveClientInformation(value:OAuthClientInformationMixed):void {this.write('client',value);}
 tokens():OAuthTokens|undefined{return this.read('tokens');}
 saveTokens(value:OAuthTokens):void{this.write('tokens',value);}
 saveCodeVerifier(value:string):void{this.verifier=value;}
 codeVerifier():string{if(!this.verifier)throw Error('Sign-in session expired. Try signing in again.');return this.verifier;}
 async redirectToAuthorization(url:URL):Promise<void>{
  if(!this.interactive)throw Error('Sign in to this server from Tools.');
  if(url.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('The authorization page must use HTTPS.');
  this.requested=true;await this.open(url.toString());
 }
 invalidateCredentials(scope:'all'|'client'|'tokens'|'verifier'|'discovery'):void {
  if(scope==='all'||scope==='client')this.secrets.delete(`oauth:${this.name}:client`);
  if(scope==='all'||scope==='tokens')this.secrets.delete(`oauth:${this.name}:tokens`);
  if(scope==='all'||scope==='verifier')this.verifier='';
 }
 async listen():Promise<void>{
  if(!this.interactive)return;
  this.pending=new Promise((resolve,reject)=>{this.resolveCode=resolve;this.rejectCode=reject;});
  // Attach a handler immediately; a callback denial must not create an unhandled rejection.
  void this.pending.catch(()=>{});
  this.server=createServer((req,res)=>{
   const url=new URL(req.url??'/',this.callback);
   if(url.pathname!=='/callback'){res.writeHead(404).end();return;}
   if(url.searchParams.get('state')!==this.nonce){res.writeHead(400).end('Sign-in state did not match. Return to Browser Chat and try again.');return;}
   const code=url.searchParams.get('code');
   if(url.searchParams.has('error')||!code){res.writeHead(400).end('Sign-in was not completed. Return to Browser Chat.');this.rejectCode?.(Error('Sign-in was canceled or denied.'));return;}
   res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>Browser Chat</title><h1>Connected</h1><p>You can close this tab and return to Browser Chat.</p>');this.resolveCode?.(code);
  });
  const listen=(port:number)=>new Promise<void>((resolve,reject)=>{const error=(e:Error)=>reject(e);this.server!.once('error',error);this.server!.listen(port,'127.0.0.1',()=>{this.server!.removeListener('error',error);resolve();});});
  try{await listen(Number(new URL(this.callback).port)||0);}catch{await listen(0);}
  const address=this.server.address();
  if(!address||typeof address==='string')throw Error('Could not start the sign-in callback.');
  const callback=`http://127.0.0.1:${address.port}/callback`;
  if(callback!==this.callback)this.invalidateCredentials('client');
  this.callback=callback;this.secrets.set(`oauth:${this.name}:redirect`,callback);
 }
 async waitCode():Promise<string>{
  if(!this.pending)throw Error('No sign-in session');
  let timer:NodeJS.Timeout;
  try{return await Promise.race([this.pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Sign-in timed out. Try again.')),120000);})]);}
  finally{clearTimeout(timer!);}
 }
 close():void{this.rejectCode?.(Error('Sign-in canceled. You can try again when ready.'));this.rejectCode=undefined;this.interactive=false;this.server?.close();this.server=undefined;this.verifier='';}
 private read(key:string):any{try{return JSON.parse(this.secrets.get(`oauth:${this.name}:${key}`)??'null')??undefined;}catch{return undefined;}}
 private write(key:string,value:unknown):void{this.secrets.set(`oauth:${this.name}:${key}`,JSON.stringify(value));}
}
