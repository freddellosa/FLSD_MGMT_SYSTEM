/** Minimal dependency-free OOXML workbook for local demo exports.
 * ZIP uses the standard uncompressed (STORE) format. Text is always inlineStr:
 * user-entered formula-like text never becomes a spreadsheet formula.
 */
import { fromCentavos } from '../domain/billing';
import { tripColumns, type TripRegisterRow } from '../demo/trip-register';
const encoder=new TextEncoder();
const xml=(s:string)=>s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
function textCell(ref:string,value:string,style=0) {return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;}
function crc32(bytes:Uint8Array):number {
 let crc=0xffffffff;
 for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 return (crc^0xffffffff)>>>0;
}
function zipStore(files:ReadonlyArray<{name:string;content:string}>):Uint8Array<ArrayBuffer> {
 const entries=files.map(file=>({name:encoder.encode(file.name),data:encoder.encode(file.content)}));
 const localSize=entries.reduce((n,f)=>n+30+f.name.length+f.data.length,0);
 const centralSize=entries.reduce((n,f)=>n+46+f.name.length,0);
 if(localSize+centralSize>0xffffffff-22)throw new Error('Export exceeds workbook size limit');
 const bytes=new Uint8Array(localSize+centralSize+22);const view=new DataView(bytes.buffer);let local=0;let central=localSize;
 for(const file of entries){
  const checksum=crc32(file.data);view.setUint32(local,0x04034b50,true);view.setUint16(local+4,20,true);view.setUint16(local+6,0x0800,true);view.setUint16(local+12,33,true);
  view.setUint32(local+14,checksum,true);view.setUint32(local+18,file.data.length,true);view.setUint32(local+22,file.data.length,true);view.setUint16(local+26,file.name.length,true);
  bytes.set(file.name,local+30);bytes.set(file.data,local+30+file.name.length);
  view.setUint32(central,0x02014b50,true);view.setUint16(central+4,20,true);view.setUint16(central+6,20,true);view.setUint16(central+8,0x0800,true);view.setUint16(central+14,33,true);
  view.setUint32(central+16,checksum,true);view.setUint32(central+20,file.data.length,true);view.setUint32(central+24,file.data.length,true);view.setUint16(central+28,file.name.length,true);view.setUint32(central+42,local,true);bytes.set(file.name,central+46);
  local+=30+file.name.length+file.data.length;central+=46+file.name.length;
 }
 view.setUint32(central,0x06054b50,true);view.setUint16(central+8,entries.length,true);view.setUint16(central+10,entries.length,true);view.setUint32(central+12,centralSize,true);view.setUint32(central+16,localSize,true);
 return bytes;
}
const prolog='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const main='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
/** Only explicitly selected rows should reach this function. No data is uploaded. */
export function createTripsWorkbook(rows:readonly TripRegisterRow[]):Uint8Array<ArrayBuffer> {
 if(!rows.length)throw new Error('Select at least one trip to export');
 if(rows.length>10000)throw new Error('Select up to 10,000 trips per browser export');
 const seen=new Set<string>();
 for(const row of rows){if(seen.has(row.id))throw new Error('Duplicate selected trip');seen.add(row.id);if(row.amount<0n)throw new Error('Invalid trip amount');}
 const letters=['A','B','C','D','E','F','G','H'];
 const header=`<row r="1">${tripColumns.map((col,i)=>textCell(`${letters[i]}1`,col.label,1)).join('')}</row>`;
 const data=rows.map((row,i)=>{
  const r=i+2;const fields=[row.id,row.date,row.passenger,row.itinerary,row.chargeLocation,row.workflow,row.settlement];
  const cells=fields.map((value,col)=>textCell(`${letters[col]}${r}`,value)).join('');
  // Excel supports 15 significant digits. Larger monetary values stay exact text.
  const amount=fromCentavos(row.amount);
  const money=row.amount.toString().length<=15?`<c r="H${r}" s="2"><v>${amount}</v></c>`:textCell(`H${r}`,amount);
  return `<row r="${r}">${cells}${money}</row>`;
 }).join('');
 const sheet=prolog+`<worksheet xmlns="${main}"><dimension ref="A1:H${rows.length+1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="16" customWidth="1"/><col min="3" max="3" width="28" customWidth="1"/><col min="4" max="4" width="70" customWidth="1"/><col min="5" max="5" width="24" customWidth="1"/><col min="6" max="7" width="22" customWidth="1"/><col min="8" max="8" width="20" customWidth="1"/></cols><sheetData>${header}${data}</sheetData><autoFilter ref="A1:H${rows.length+1}"/></worksheet>`;
 const notes=['FLSD DEMONSTRATION EXPORT — NOT REAL POSTED RECORDS','Session-only demonstration trips, including any local WTS imports. No database or live financial posting.','Amount is PHP. Tax review pending means the amount is not an approved settlement total.','Settlement status follows the current demo role; Restricted means financial status is not exposed.','Amounts exceeding Excel’s 15-significant-digit precision are exported as exact text.','Only selected trips are exported, in the current register sort order.','Passenger and itinerary text is preserved in full. Cells are text, never executable formulas.'];
 const noteSheet=prolog+`<worksheet xmlns="${main}"><cols><col min="1" max="1" width="120" customWidth="1"/></cols><sheetData>${notes.map((note,i)=>`<row r="${i+1}">${textCell(`A${i+1}`,note,i===0?1:0)}</row>`).join('')}</sheetData></worksheet>`;
 return zipStore([
 {name:'[Content_Types].xml',content:prolog+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'},
 {name:'_rels/.rels',content:prolog+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
 {name:'xl/workbook.xml',content:prolog+`<workbook xmlns="${main}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Trips (DEMO)" sheetId="1" r:id="rId1"/><sheet name="Export notes" sheetId="2" r:id="rId2"/></sheets></workbook>`},
 {name:'xl/_rels/workbook.xml.rels',content:prolog+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'},
 {name:'xl/styles.xml',content:prolog+`<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`},
 {name:'xl/worksheets/sheet1.xml',content:sheet},{name:'xl/worksheets/sheet2.xml',content:noteSheet},
 ]);
}

