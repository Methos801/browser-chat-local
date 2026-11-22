import { mkdirSync,writeFileSync,existsSync } from 'node:fs';
import { join,dirname } from 'node:path';
/** Run standard Node MCP packages with the app's bundled runtime; no separate Node installation. */
export function localRunner(userData:string,execPath=process.execPath){
 const bin=join(userData,'tool-runtime');mkdirSync(bin,{recursive:true});
 if(process.platform==='win32')writeFileSync(join(bin,'node.cmd'),`@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\n`);
 else writeFileSync(join(bin,'node'),`#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${execPath.replace(/'/g,"'\\''")}' "$@"\n`,{mode:0o700});
 let npmRoot=dirname(require.resolve('npm/package.json'));
 const resources=(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath;
 const asarResources=npmRoot.match(/^(.*)[\\/]app\.asar[\\/]node_modules[\\/]npm$/)?.[1];
 const bundled=asarResources?join(asarResources,'tool-runtime','npm'):resources?join(resources,'tool-runtime','npm'):'';
 const unpacked=npmRoot.replace(/app\.asar([\\/])/,'app.asar.unpacked$1');
 if(bundled&&existsSync(join(bundled,'node_modules','@npmcli','config')))npmRoot=bundled;
 else if(existsSync(unpacked))npmRoot=unpacked;
 return (command:string,args:string[],env:Record<string,string>)=>{
  if(command!=='npx'&&command!=='node')return {command,args,env,cwd:userData};
  return {command:execPath,args:command==='npx'?[join(npmRoot,'bin','npx-cli.js'),...args]:args,cwd:userData,env:{...env,ELECTRON_RUN_AS_NODE:'1',PATH:bin+(process.platform==='win32'?';':':')+(env.PATH??''),npm_config_cache:join(userData,'mcp-package-cache'),npm_config_update_notifier:'false'}};
 };
}
