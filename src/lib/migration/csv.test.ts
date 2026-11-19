import { describe,expect,it } from 'vitest';
import { parseCsv } from './csv';
describe('CSV preflight parser',()=>{
 it('parses quoted commas and escaped quotes',()=>expect(parseCsv('TripID,Name\r\n1,"A, ""B"""\r\n')).toEqual([{TripID:'1',Name:'A, "B"'}]));
 it('rejects inconsistent column count',()=>expect(()=>parseCsv('A,B\n1')).toThrow(/columns/));
 it('rejects unclosed quote',()=>expect(()=>parseCsv('A\n"bad')).toThrow(/Unclosed/));
 it('rejects duplicate headers',()=>expect(()=>parseCsv('A,A\n1,2')).toThrow(/header/));
});
