/** Browser-local XLSX reader: only the visible WTS worksheet, no uploads or formula execution. */
import { mapWtsRows, normalizedHeader, wtsHeaders, wtsMoney, type WtsSourceRow } from '../domain/wts-import';
const decoder=new TextDecoder();
const MAX_ENTRY=8*1024*1024;
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
async function zipEntries(bytes:Uint8Array):Promise<Map<string,()=>Promise<string>>> {
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let end=-1;for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(view.getUint32(p,true)===0x06054b50){end=p;break;}
 if(end<0)throw new Error('Not a supported XLSX ZIP file');
 const count=view.getUint16(end+10,true);let position=view.getUint32(end+16,true),expanded=0;
 if(count>1000||view.getUint16(end+4,true)||view.getUint16(end+6,true))throw new Error('Unsupported workbook ZIP layout');
 const result=new Map<string,()=>Promise<string>>();
 for(let i=0;i<count;i++){
  if(position+46>bytes.length||view.getUint32(position,true)!==0x02014b50)throw new Error('Invalid workbook directory');
  const flags=view.getUint16(position+8,true),method=view.getUint16(position+10,true),checksum=view.getUint32(position+16,true),compressed=view.getUint32(position+20,true),size=view.getUint32(position+24,true);
  const nameSize=view.getUint16(position+28,true),extra=view.getUint16(position+30,true),comment=view.getUint16(position+32,true),offset=view.getUint32(position+42,true);
  const name=decoder.decode(bytes.subarray(position+46,position+46+nameSize));
  expanded+=size;
  if(size>MAX_ENTRY||expanded>30*1024*1024||(flags&1)||![0,8].includes(method)||name.includes('..')||name.startsWith('/')||result.has(name))throw new Error('Unsafe or unsupported workbook entry');
  result.set(name,async()=>{
   if(offset+30>bytes.length||view.getUint32(offset,true)!==0x04034b50)throw new Error('Invalid workbook entry');
   const start=offset+30+view.getUint16(offset+26,true)+view.getUint16(offset+28,true);
   if(start+compressed>bytes.length)throw new Error('Truncated workbook entry');
   const data=bytes.slice(start,start+compressed);
   let output:Uint8Array=data;
   if(method===8){
    const reader=new Blob([data.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts:Uint8Array[]=[];let total=0;
    try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>size||total>MAX_ENTRY)throw new Error('Workbook expansion limit exceeded');parts.push(part.value);}}finally{await reader.cancel();}
    output=new Uint8Array(total);let at=0;for(const part of parts){output.set(part,at);at+=part.length;}
   }
   if(output.length!==size)throw new Error('Workbook entry length mismatch');
   if(crc32(output)!==checksum)throw new Error('Workbook entry checksum mismatch; choose an uncorrupted workbook');
   return decoder.decode(output);
  });
  position+=46+nameSize+extra+comment;
 }
 return result;
}
function xml(text:string):Document {
 if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('Workbook XML entities are not supported');
 const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error('Invalid workbook XML');return doc;
}
const elements=(root:Document|Element,tag:string)=>Array.from(root.getElementsByTagNameNS('*',tag));
export async function readWtsWorkbook(file:File) {
 if(!file.name.toLowerCase().endsWith('.xlsx')||file.size>10*1024*1024)throw new Error('Choose an .xlsx workbook no larger than 10 MB');
 const bytes=new Uint8Array(await file.arrayBuffer()),entries=await zipEntries(bytes);
 async function read(name:string){const entry=entries.get(name);if(!entry)throw new Error('Required worksheet data is missing');return xml(await entry());}
 const workbook=await read('xl/workbook.xml'),rels=await read('xl/_rels/workbook.xml.rels');
 if(elements(workbook,'workbookPr')[0]?.getAttribute('date1904')==='1')throw new Error('1904 date workbooks are not supported');
 const sheet=elements(workbook,'sheet').find(s=>s.getAttribute('name')?.trim().toUpperCase()==='WTS'&&!['hidden','veryHidden'].includes(s.getAttribute('state')??''));
 if(!sheet)throw new Error('A visible Accenture WTS worksheet is required');
 const rid=sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
 const relation=elements(rels,'Relationship').find(r=>r.getAttribute('Id')===rid);
 const target=relation?.getAttribute('Target')??'';
 if(!relation||relation.getAttribute('TargetMode')==='External'||target.includes('..')||!/^\/?(?:xl\/)?worksheets\/[\w.-]+\.xml$/.test(target))throw new Error('Unsupported WTS worksheet relationship');
 const path=target.startsWith('/')?target.slice(1):target.startsWith('xl/')?target:`xl/${target}`;
 const strings=entries.has('xl/sharedStrings.xml')?elements(await read('xl/sharedStrings.xml'),'si').map(si=>elements(si,'t').map(t=>t.textContent??'').join('')):[];
 const sheetDocument=await read(path);
 const footerRows=new Set(elements(sheetDocument,'row').filter(row=>{
  const cells=elements(row,'c');return cells.length===1&&/^BI\d+$/.test(cells[0].getAttribute('r')??'')&&/^SUM\(BI\d+:BI\d+\)$/i.test(elements(cells[0],'f')[0]?.textContent??'');
 }).map(row=>Number(row.getAttribute('r'))));
 const rows:WtsSourceRow[]=elements(sheetDocument,'row').map(row=>({row:Number(row.getAttribute('r')),cells:Object.fromEntries(elements(row,'c').map(cell=>{
  const key=(cell.getAttribute('r')??'').replace(/\d/g,''),type=cell.getAttribute('t'),value=elements(cell,'v')[0]?.textContent??'';
  if(type==='e')return [key,'#CELL_ERROR'];
  return [key,type==='s'?strings[Number(value)]??'':type==='inlineStr'?elements(cell,'t').map(t=>t.textContent??'').join(''):value];
 }))}));
 const header=rows.find(row=>normalizedHeader(row.cells.J??'')===normalizedHeader(wtsHeaders.J)&&normalizedHeader(row.cells.BI??'')===normalizedHeader(wtsHeaders.BI));
 if(!header)throw new Error('Accenture WTS headers were not found');
 for(const [column,label] of Object.entries(wtsHeaders))if(normalizedHeader(header.cells[column]??'')!==normalizedHeader(label))throw new Error(`Unexpected WTS header in column ${column}: expected ${label}`);
 // Footer is identified by its TOTAL label, never imported as another trip.
 const data:WtsSourceRow[]=[];
 for(const row of rows.filter(r=>r.row>header.row)){
  if(!Object.values(row.cells).some(v=>v.trim()))continue;
  if(footerRows.has(row.row))continue;
  if(!row.cells.J&&Object.values(row.cells).some(v=>/^\s*(?:grand\s+)?total\b/i.test(v)))continue;
  data.push(row);
 }
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
 const sourceRows=data.map(r=>({row:r.row,cells:Object.fromEntries(Object.keys(wtsHeaders).map(key=>[key,r.cells[key]??'']))}));
 const preview=mapWtsRows(sourceRows);
 if(preview.every(r=>!r.errors.length))for(const footer of rows.filter(r=>footerRows.has(r.row))){
  if(wtsMoney(footer.cells.BI)!==preview.reduce((n,r)=>n+r.trip!.amount,0n))throw new Error('Workbook footer does not reconcile to imported trip totals');
 }
 return {digest,sourceRows,rows:preview};
}
