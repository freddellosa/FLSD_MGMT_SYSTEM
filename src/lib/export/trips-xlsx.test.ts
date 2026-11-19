import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createTripsWorkbook } from './trips-xlsx';
import type { TripRegisterRow } from '../demo/trip-register';
function files(bytes:Uint8Array) {
 const result=new Map<string,string>();const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const decoder=new TextDecoder();let p=0;
 while(view.getUint32(p,true)===0x04034b50){expect(view.getUint16(p+8,true)).toBe(0);const size=view.getUint32(p+18,true),nameLength=view.getUint16(p+26,true),extra=view.getUint16(p+28,true);const name=decoder.decode(bytes.slice(p+30,p+30+nameLength));const start=p+30+nameLength+extra;expect(view.getUint32(p+14,true)).toBe(crc32(bytes.subarray(start,start+size)));result.set(name,decoder.decode(bytes.slice(start,start+size)));p=start+size;}
 expect(view.getUint32(p,true)).toBe(0x02014b50);expect(view.getUint32(bytes.length-22,true)).toBe(0x06054b50);expect(view.getUint16(bytes.length-12,true)).toBe(result.size);
 return result;
}
const row:TripRegisterRow={id:'TRIP-001',date:'2026-11-15',passenger:'Guest A\nGuest B',itinerary:'Manila → Tagaytay & return',chargeLocation:'DEMO-SITE',workflow:'Direct pay',settlement:'Unpaid',amount:123456n};
describe('Selected trips Excel workbook',()=>{
 it('creates an OOXML workbook with data, styles, relationships and clear demo notes',()=>{const f=files(createTripsWorkbook([row]));expect(f.size).toBe(7);expect(f.get('xl/workbook.xml')).toContain('Trips (DEMO)');expect(f.get('xl/worksheets/sheet2.xml')).toContain('NOT REAL POSTED RECORDS');expect(f.get('[Content_Types].xml')).toContain('spreadsheetml.sheet.main+xml');});
 it('exports only supplied rows, in supplied order, with exactly eight columns',()=>{const f=files(createTripsWorkbook([{...row,id:'TRIP-B'},row]));const sheet=f.get('xl/worksheets/sheet1.xml')!;expect(sheet).toContain('A1:H3');expect(sheet.indexOf('TRIP-B')).toBeLessThan(sheet.indexOf('TRIP-001'));expect(sheet.match(/<row /g)).toHaveLength(3);expect(sheet.match(/<c /g)).toHaveLength(24);expect(sheet).not.toContain('Total trip hours');});
 it('keeps exact numeric money and two-decimal formatting',()=>{const f=files(createTripsWorkbook([row]));expect(f.get('xl/worksheets/sheet1.xml')).toContain('<c r="H2" s="2"><v>1234.56</v></c>');expect(f.get('xl/styles.xml')).toContain('numFmtId="4"');});
 it('retains amounts beyond Excel numeric precision as exact text',()=>{const f=files(createTripsWorkbook([{...row,amount:999999999999999999n}]));expect(f.get('xl/worksheets/sheet1.xml')).toContain('<c r="H2" t="inlineStr" s="0"><is><t xml:space="preserve">9999999999999999.99</t>');});
 it('escapes XML, preserves Unicode and line breaks, and never emits formulas',()=>{const f=files(createTripsWorkbook([{...row,passenger:'=HYPERLINK("bad")\u0000',itinerary:'<A> & B\n→ C'}]));const sheet=f.get('xl/worksheets/sheet1.xml')!;expect(sheet).toContain('=HYPERLINK(&quot;bad&quot;)');expect(sheet).toContain('&lt;A&gt; &amp; B\n→ C');expect(sheet).not.toContain('<f>');expect(sheet).not.toContain('\u0000');});
 it('preserves role-masked status',()=>expect(files(createTripsWorkbook([{...row,settlement:'Restricted'}])).get('xl/worksheets/sheet1.xml')).toContain('Restricted'));
 it('rejects empty, duplicate, negative or excessively large exports',()=>{expect(()=>createTripsWorkbook([])).toThrow('Select');expect(()=>createTripsWorkbook([row,row])).toThrow('Duplicate');expect(()=>createTripsWorkbook([{...row,amount:-1n}])).toThrow('amount');expect(()=>createTripsWorkbook(Array.from({length:10001},(_,i)=>({...row,id:String(i)})))).toThrow('10,000');});
});


