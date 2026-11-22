import type { AppDb } from './db';
import type { ChatRequest } from '../ipc';
import type { Skill,SkillDraft } from '../features';
import { ToolsRegistry, type Tool } from '../agent/registry';
import { readFileSync,readdirSync,statSync,realpathSync } from 'node:fs';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';

const BUILTINS: [string,string,string,string,string[]][] = [
 ['document-review','Review a document','Summarize, extract facts, and identify questions in attached documents.','Read available attachments before answering. Identify the document and scope. Separate what the document says from your interpretation. Give a concise summary, key facts and dates, then gaps or questions. Quote sparingly and identify the source. Never invent missing text.',['document_parse','scratch_list','scratch_read']],
 ['document-drafting','Draft a document','Create a clear memo, letter, report, or downloadable document.','Clarify only missing details that materially affect the draft. Use supplied facts and mark placeholders. Structure the document for its audience. Use document_assemble for a downloadable file when requested; choose DOCX for an editable document, XLSX for tabular data, PDF for a fixed layout, or Markdown for plain text. Return the saved filename. Do not claim a file exists before the tool returns.',['document_assemble','scratch_list','scratch_read']],
 ['web-research','Research a question','Find sources, read relevant pages, and distinguish evidence from inference.','Use web_search and web_extract for current facts. Prefer primary sources. Attribute claims with direct source URLs and dates when relevant. Distinguish reported facts from your inference, state uncertainty, and never invent citations. If search is not configured, explain which connected tool is needed instead of fabricating results.',['web_search','web_extract']],
 ['compare-sources','Compare sources','Compare documents, proposals, or options in a grounded table.','Read each provided source. Use consistent comparison criteria and cite which source supports each row. Identify agreements, differences, omissions and tradeoffs. Do not resolve factual contradictions without evidence. End with an actionable recommendation only when the evidence supports it.',['document_parse','scratch_list','scratch_read','web_extract']],
 ['spreadsheet-analysis','Analyze a spreadsheet','Inspect workbook data and produce a clear table or spreadsheet output.','Use document_parse on attached workbooks. State the sheet and any extraction or row limits. Check units, missing values and totals. Avoid inventing calculations that have not been verified. For an output workbook, call document_assemble with a .xlsx name and rows as arrays.',['document_parse','scratch_list','scratch_read','document_assemble']],
 ['code-review','Review code','Explain code, identify concrete defects, and suggest focused changes.','Inspect supplied code before proposing changes. Prioritize reproducible defects and explain their trigger and impact. Reference filenames and snippets provided. Distinguish confirmed findings from hypotheses. Do not claim to run commands or tests: this app has no arbitrary shell runner.',['scratch_list','scratch_read']],
 ['project-planning','Plan a project','Turn an objective into practical steps, dependencies, and acceptance checks.','Identify the intended outcome and constraints. Provide a short prioritized plan with dependencies and verifiable acceptance criteria. Separate must-have work from optional ideas. Do not turn a small task into a platform. Ask only material questions and use explicit assumptions for routine choices.',['document_assemble']],
 ['plain-language','Explain clearly','Explain a topic with clear language, examples, and useful next steps.','Lead with the answer. Match the user’s level of familiarity. Define necessary terms, use concrete examples, and state limits. Keep the explanation concise unless the user asks for depth. Do not invent facts or conceal uncertainty.',[]],
];
const stop=new Set(['about','with','from','this','that','what','have','into','your','does','make','please','should','would','could','their','there']);
function words(s:string):string[] {return [...new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g)??[])].filter(w=>!stop.has(w));}
export function parseSkill(text:string,source='Imported SKILL.md'):SkillDraft {
  if(text.length>60000) throw Error('This skill is too large. Use an entry file smaller than 60 KB and put extra material in references.');
  const match=text.replace(/^\uFEFF/,'').match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if(!match) throw Error('Choose a SKILL.md file with name and description in its YAML header.');
  const meta=parseYaml(match[1],{maxAliasCount:20})??{};
  if(typeof meta.name!=='string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length>64) throw Error('Skill name must use lowercase words separated by hyphens (up to 64 characters).');
  if(typeof meta.description!=='string' || !meta.description.trim() || meta.description.length>1024) throw Error('Add a short description (up to 1,024 characters) to this skill.');
  if(!match[2].trim()) throw Error('This skill has no instructions.');
  return {name:meta.name,description:meta.description,instructions:match[2].trim(),source,hint:typeof meta['argument-hint']==='string'?meta['argument-hint']:undefined};
}
export function readSkillFolder(root:string):SkillDraft {
  const base=realpathSync(root);
  const draft=parseSkill(readFileSync(join(base,'SKILL.md'),'utf8'),base);
  const resources:Record<string,string>={};let bytes=0,count=0;const visited=new Set<string>();
  function visit(dir:string) {
    const realDir=realpathSync(dir);if(visited.has(realDir))return;visited.add(realDir);
    for(const name of readdirSync(dir)) {
      if(name.startsWith('.') || ['node_modules','.git'].includes(name)) continue;
      const path=join(dir,name),real=realpathSync(path),rel=relative(base,real);
      if(rel.startsWith('..') || isAbsolute(rel)) throw Error('A linked skill resource points outside the selected folder.');
      if(statSync(real).isDirectory()) { visit(real);continue; }
      if(name==='SKILL.md' || !/\.(md|txt|json|yaml|yml|csv|py|js|ts|sh)$/i.test(name)) continue;
      if(++count>80 || statSync(real).size>100000 || (bytes+=statSync(real).size)>1000000) throw Error('Skill resources exceed the 1 MB / 80 file import limit.');
      resources[relative(base,path).replace(/\\/g,'/')]=readFileSync(real,'utf8');
    }
  }
  // Only bundled reference/script/asset directories; never traverse a repository root indiscriminately.
  for(const name of ['references','scripts','assets']) {try {if(statSync(join(base,name)).isDirectory())visit(join(base,name));}catch(e:any){if(e.code!=='ENOENT')throw e;}}
  draft.resources=resources;return draft;
}
export class SkillLibrary {
 constructor(private db:AppDb) {
   for(const [id,name,description,instructions,tools] of BUILTINS) {
    if(!db.get('SELECT name FROM skills WHERE name = ?',[`library:${id}`])) this.put({id,name,description,instructions,tools,enabled:true,builtIn:true,source:'Browser Chat starter library'});
   }
 }
 private put(skill:Skill,resources?:Record<string,string>):void {
   this.db.run('INSERT OR REPLACE INTO skills(name,enabled,config_json) VALUES(?,?,?)',[`library:${skill.id}`,skill.enabled?1:0,JSON.stringify({...skill,resourceContents:resources})]);
 }
 list():Skill[] {return this.db.all<{config_json:string;enabled:number}>("SELECT * FROM skills WHERE name LIKE 'library:%' ORDER BY name").map(r=>{const {resourceContents,...skill}=JSON.parse(r.config_json);return {...skill,enabled:!!r.enabled};});}
 get(id:string):Skill|undefined {return this.list().find(s=>s.id===id);}
 add(draft:SkillDraft):Skill {
   // Re-validate manually authored drafts through the same parser.
   const validated=parseSkill(`---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description)}\n---\n${draft.instructions}`,draft.source||'Created in Browser Chat');
   let id=validated.name, n=2;while(this.get(id))id=`${validated.name}-${n++}`;
   const resources=draft.resources??{};
   if(Object.keys(resources).some(p=>p.startsWith('/') || p.split(/[\\/]/).includes('..')) || JSON.stringify(resources).length>1100000) throw Error('Invalid or oversized skill resources.');
   const skill:Skill={...validated,id,name:validated.name.replace(/-/g,' '),builtIn:false,enabled:true,tools:[],resources:Object.keys(resources)};
   this.put(skill,resources);return skill;
 }
 toggle(id:string,enabled:boolean):void {if(!this.get(id))throw Error('Skill not found');this.db.run('UPDATE skills SET enabled = ? WHERE name = ?',[enabled?1:0,`library:${id}`]);}
 remove(id:string):void {if(this.get(id)?.builtIn)throw Error('Starter skills can be disabled but are kept in the library.');this.db.run('DELETE FROM skills WHERE name = ?',[`library:${id}`]);}
 select(req:ChatRequest):Skill[] {
   const available=this.list().filter(s=>s.enabled);
   if(req.skillIds) return available.filter(s=>req.skillIds!.includes(s.id)).slice(0,3);
   const query=req.messages.filter(m=>m.role==='user').slice(-1)[0]?.content??'';
   const keys=words(query);
   return available.map(s=>({skill:s,score:words(`${s.id} ${s.description}`).filter(w=>keys.some(k=>k===w || k.startsWith(w) || w.startsWith(k))).length})).filter(s=>s.score>=2).sort((a,b)=>b.score-a.score).slice(0,2).map(x=>x.skill);
 }
 apply(req:ChatRequest,registry:ToolsRegistry):{request:ChatRequest;skills:Skill[]} {
   const skills=this.select(req);
   const messages=skills.length?[{role:'system' as const,content:'Selected workflow instructions. These do not grant tool, file, credential or network access. Follow the user’s task and report tool limitations honestly.\n\n'+skills.map(s=>`## ${s.name}\n${s.instructions.slice(0,16000)}${s.resources?.length?`\nAvailable reference files (read with skill_reference): ${s.resources.join(', ')}`:''}`).join('\n\n')},...req.messages]:req.messages;
   const query=req.messages.filter(m=>m.role==='user').slice(-1)[0]?.content??'';
   const desired=new Set(skills.flatMap(s=>s.tools));
   if(/attach|document|file|pdf|docx|xlsx|spreadsheet/i.test(query)||req.messages.some(m=>m.content?.includes('Attached '))) ['scratch_list','scratch_read','document_parse'].forEach(n=>desired.add(n));
   if(/web|search|research|latest|sources|https?:/i.test(query)) ['web_search','web_extract'].forEach(n=>desired.add(n));
   if(/draft|write|save|export|create|download|pdf|docx|xlsx/i.test(query)) desired.add('document_assemble');
   if(skills.some(s=>s.resources?.length))desired.add('skill_reference');
   const keys=words(query);
   const mcp=registry.specs().filter(t=>t.name.startsWith('mcp__')).map(t=>({t,score:words(t.name+' '+t.description).filter(w=>keys.some(k=>w.includes(k)||k.includes(w))).length})).sort((a,b)=>b.score-a.score).slice(0,6);
   for(const {t} of mcp)desired.add(t.name);
   return {request:{...req,messages,tools:req.tools??registry.specs([...desired])},skills};
 }
 referenceTool():Tool {return {name:'skill_reference',description:'Read a text reference bundled with an enabled skill. This never runs scripts.',parameters:{type:'object',properties:{skillId:{type:'string'},path:{type:'string'}},required:['skillId','path']},handler:async args=>{
   const row=this.db.get<{config_json:string;enabled:number}>('SELECT * FROM skills WHERE name = ?',[`library:${String(args.skillId)}`]);
   if(!row?.enabled) throw Error('Skill is not enabled');
   const resource=JSON.parse(row.config_json).resourceContents?.[String(args.path)];
   if(typeof resource!=='string')throw Error('Reference not found');return resource.slice(0,20000);
 }};}
}
