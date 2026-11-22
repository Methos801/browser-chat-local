const {execFileSync}=require('node:child_process');const {readFileSync,readdirSync,existsSync,writeFileSync,statSync}=require('node:fs');const {join,dirname}=require('node:path');
const npm=join(dirname(require.resolve('npm/package.json')),'bin','npm-cli.js');
let paths;try{paths=execFileSync(process.execPath,[npm,'ls','--omit=dev','--all','--parseable'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim().split('\n');}catch(e){paths=String(e.stdout??'').trim().split('\n');if(paths.length<2)throw e;}
let text='Browser Chat — third-party notices\n\nThese notices preserve the distributed dependencies’ copyright and license texts. JSZip is used under its MIT alternative. npm is distributed unmodified under Artistic-2.0. External MCP servers are installed only when configured and retain their own package notices.\n';
const seen=new Set();
for(const path of paths){if(!path.includes('node_modules'))continue;const metaPath=join(path,'package.json');if(!existsSync(metaPath))continue;const meta=JSON.parse(readFileSync(metaPath));const key=meta.name+'@'+meta.version;if(seen.has(key))continue;seen.add(key);text+='\n\n'+'='.repeat(72)+'\n'+key+'\nDeclared license: '+(typeof meta.license==='string'?meta.license:JSON.stringify(meta.license??'See package notice'))+'\n';
 const notices=readdirSync(path).filter(n=>/^(licen[cs]e|copying|copyright|notice)(\.|$|-)/i.test(n)&&statSync(join(path,n)).isFile());
 for(const name of notices)text+='\n--- '+name+' ---\n'+readFileSync(join(path,name),'utf8')+'\n';
 if(!notices.length)text+='\nNo separate top-level license file found; package metadata and original source notices are retained in the distribution.\n';
}
writeFileSync('THIRD_PARTY_NOTICES.txt',text);console.log('Preserved license notices for '+seen.size+' production dependencies.');
