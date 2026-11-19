import {describe,it,expect} from 'vitest';
import {invoiceTotals,validateSerial,canAllocatePayment,canReplaceInvoice} from './invoices';
describe('invoice rules',()=>{
 it('sums amounts in exact centavos',()=>expect(invoiceTotals([{amount:'0.10'},{amount:'0.20'}]).gross).toBe('0.30'));
 it('rejects negative amounts',()=>expect(()=>invoiceTotals([{amount:'-1.00'}])).toThrow());
 it('rejects tax withholding exceeding invoice total',()=>expect(()=>invoiceTotals([{amount:'1.00'}],'0.00','2.00')).toThrow());
 it('validates official serial',()=>{expect(validateSerial(' 0000123 ')).toBe('0000123');expect(()=>validateSerial('AB12')).toThrow()});
 it('restricts payments to printed invoices',()=>{expect(canAllocatePayment('DRAFT')).toBe(false);expect(canAllocatePayment('PRINTED')).toBe(true)});
 it('restricts replacements to cancelled/spoiled',()=>{expect(canReplaceInvoice('SPOILED')).toBe(true);expect(canReplaceInvoice('PRINTED')).toBe(false)});
});
