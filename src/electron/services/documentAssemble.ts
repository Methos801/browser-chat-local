import JSZip from 'jszip';
import { Workbook } from 'exceljs';
import { extname } from 'node:path';
import type { ScratchPad } from './scratchPad';
import type { FileMeta } from '../ipc';
export const escapeXml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export async function assembleDocument(scratch:ScratchPad,args:Record<string,unknown>,pdf?:(text:string)=>Promise<Buffer>):Promise<FileMeta>{
 const name=typeof args.name==='string'?args.name:'';
 const text=typeof args.text==='string'?args.text:'';
 const ext=extname(name).toLowerCase();
 if(!name||!['.md','.txt','.docx','.xlsx','.pdf'].includes(ext))throw Error('Choose a .md, .txt, .docx, .xlsx, or .pdf output filename.');
 if(text.length>150000)throw Error('Document text exceeds the 150,000 character limit.');
 let data:Buffer,mime:string;
 if(ext==='.xlsx'){
  const rows=Array.isArray(args.rows)?args.rows:text.split('\n').map(line=>line.split('\t'));
  if(rows.length>2000||rows.some(r=>!Array.isArray(r)||r.length>50))throw Error('Use at most 2,000 rows and 50 columns.');
  const book=new Workbook(),sheet=book.addWorksheet('Data');
  for(const row of rows)sheet.addRow((row as unknown[]).map(v=>typeof v==='number'&&Number.isFinite(v)?v:typeof v==='boolean'?v:String(v??'')));
  sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).font={bold:true};
  sheet.columns.forEach(c=>{c.width=24;});
  data=Buffer.from(await book.xlsx.writeBuffer());mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
 }else if(ext==='.docx'){
  const zip=new JSZip();
  zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml','<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr><w:pPr><w:spacing w:after="160"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>');
  const paragraphs=text.split(/\r?\n/).map(line=>`<w:p>${/^#{1,3} /.test(line)?'<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>':''}<w:r><w:t xml:space="preserve">${escapeXml(line.replace(/^#{1,3} /,''))}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml',`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:bottom="1080" w:left="1080" w:right="1080"/></w:sectPr></w:body></w:document>`);
  data=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
 }else if(ext==='.pdf'){
  if(!pdf)throw Error('PDF export is available in the desktop app.');data=await pdf(text);mime='application/pdf';
 }else{data=Buffer.from(text,'utf8');mime=ext==='.md'?'text/markdown':'text/plain';}
 return scratch.save(name,mime,Uint8Array.from(data).buffer);
}
