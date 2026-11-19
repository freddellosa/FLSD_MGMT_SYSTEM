import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {recordCustomerReceiptInTransaction,type CustomerReceiptCommand} from './customer-receipt-transaction';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const today='2026-11-19';
const input:CustomerReceiptCommand={customerId:'customer',key:'single-receipt',actor:{id:'staff',role:'BILLING'},
  receivedCentavos:1001n,receivedDate:today,method:'BANK_TRANSFER',reference:'Fictional receipt',
  allocations:[{invoiceId:'b',cashCentavos:301n,withheldCentavos:0n},{invoiceId:'a',cashCentavos:700n,withheldCentavos:0n}]};
function fixture(){
  const saved={paymentId:'one-payment',operationId:'operation',allocatedCentavos:1001n};
  const receipts=new Map<string,string>();
  const invoices=[{id:'a',customerId:'customer',outstandingCentavos:1000n,eligible:true},
    {id:'b',customerId:'customer',outstandingCentavos:301n,eligible:true}];
  const tx={
    findReceipt:vi.fn(async (key:string,digest:string)=>{
      if(!receipts.has(key))return null;
      if(receipts.get(key)!==digest)throw new Error('Receipt mismatch');
      return saved;
    }),
    lockInvoices:vi.fn<(ids:readonly string[])=>Promise<typeof invoices>>(async()=>invoices),
    appendReceiptAndAllocations:vi.fn(async (command:CustomerReceiptCommand,digest:string)=>{
      receipts.set(command.key,digest);
      return saved;
    }),
  };
  return {invoices,tx,run:(command=input)=>recordCustomerReceiptInTransaction(tx,command,hash,today)};
}
describe('One customer receipt across invoices',()=>{
  it('validates exact partial amounts and replays reordered input without a second append',async()=>{
    const f=fixture();
    await expect(f.run()).resolves.toMatchObject({paymentId:'one-payment',allocatedCentavos:1001n,replayed:false});
    expect(f.tx.lockInvoices).toHaveBeenCalledWith(['a','b']);
    await expect(f.run({...input,allocations:[...input.allocations].reverse()})).resolves.toMatchObject({replayed:true});
    await expect(f.run({...input,method:'GCASH'})).rejects.toThrow('Receipt mismatch');
    expect(f.tx.appendReceiptAndAllocations).toHaveBeenCalledTimes(1);
  });
  it('rejects unresolved remainder, future dates and withholding before effects',async()=>{
    const f=fixture();
    await expect(f.run({...input,receivedCentavos:1002n})).rejects.toThrow('full receipt');
    await expect(f.run({...input,receivedDate:'2026-11-20'})).rejects.toThrow('future');
    await expect(f.run({...input,allocations:[{...input.allocations[0],withheldCentavos:1n}]})).rejects.toThrow('Withholding');
    expect(f.tx.appendReceiptAndAllocations).not.toHaveBeenCalled();
  });
  it('refuses cross-customer and overallocated invoice balances',async()=>{
    const f=fixture();
    f.invoices[0].customerId='other';
    await expect(f.run()).rejects.toThrow('Cross-customer');
    f.invoices[0].customerId=input.customerId;
    f.invoices[0].outstandingCentavos=699n;
    await expect(f.run()).rejects.toThrow('Invoice overallocated');
    expect(f.tx.appendReceiptAndAllocations).not.toHaveBeenCalled();
  });
  it('checks expected balances before writing and binds those balances to replay',async()=>{
    const f=fixture();
    const command={...input,allocations:input.allocations.map(row=>({
      ...row,expectedOutstandingCentavos:row.invoiceId==='a'?1000n:301n,
    }))};
    await expect(f.run({...command,allocations:command.allocations.map(row=>({...row,expectedOutstandingCentavos:1n}))}))
      .rejects.toThrow('balance changed');
    expect(f.tx.appendReceiptAndAllocations).not.toHaveBeenCalled();
    await expect(f.run(command)).resolves.toMatchObject({replayed:false});
    f.invoices[0].outstandingCentavos=300n;
    await expect(f.run(command)).resolves.toMatchObject({replayed:true});
    await expect(f.run({...command,allocations:command.allocations.map(row=>({...row,expectedOutstandingCentavos:1n}))}))
      .rejects.toThrow('Receipt mismatch');
    expect(f.tx.appendReceiptAndAllocations).toHaveBeenCalledTimes(1);
  });
});
