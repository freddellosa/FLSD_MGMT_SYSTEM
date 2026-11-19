import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { remainingReceivable, toCentavos, fromCentavos } from '@/lib/domain/billing';
import { canAllocatePayment } from '@/lib/domain/invoices';

export type PaymentInput = {customerId:string;receivedAt:string;amount:string;reference?:string;method?:string;allocations:Array<{invoiceId:string;amount:string;withheldTax?:string}>};
/** Atomic recording; serializable transaction locks invoices before checking balances. */
export async function recordPayment(input:PaymentInput) {
  const receivedAt=new Date(input.receivedAt);
  if (!Number.isFinite(receivedAt.getTime())) throw new Error('Invalid payment date');
  const total=toCentavos(input.amount);
  if (total<=0n || !input.allocations.length) throw new Error('Payment and allocations required');
  if (new Set(input.allocations.map(a=>a.invoiceId)).size!==input.allocations.length) throw new Error('Duplicate invoice allocation');
  const cashApplied=input.allocations.reduce((s,a)=>s+toCentavos(a.amount),0n);
  if (cashApplied!==total) throw new Error('Payment must equal total cash allocations');
  return db.$transaction(async tx=>{
    const ids=input.allocations.map(a=>a.invoiceId).sort();
    await tx.$queryRaw`SELECT id FROM "OfficialInvoice" WHERE id IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
    const invoices=await tx.officialInvoice.findMany({where:{id:{in:ids}},include:{payments:{include:{payment:true}}}});
    if (invoices.length!==ids.length) throw new Error('Invoice not found');
    for (const allocation of input.allocations) {
      const invoice=invoices.find(i=>i.id===allocation.invoiceId)!;
      if (invoice.customerId!==input.customerId || !canAllocatePayment(invoice.state)) throw new Error('Invoice not eligible for payment');
      const outstanding=remainingReceivable(toCentavos(invoice.grossAmount.plus(invoice.vatAmount).toFixed(2)),invoice.payments.filter(a=>a.payment.state==='RECORDED').map(a=>({amountCentavos:toCentavos(a.amount.toFixed(2)),withheldCentavos:toCentavos(a.withheldTax.toFixed(2))})));
      const cash=toCentavos(allocation.amount), withheld=toCentavos(allocation.withheldTax??'0.00');
      if (cash<0n || withheld<0n || cash+withheld>outstanding) throw new Error('Allocation exceeds outstanding receivable');
    }
    return tx.payment.create({data:{customerId:input.customerId,receivedAt,amount:new Prisma.Decimal(fromCentavos(total)),reference:input.reference?.trim()||null,paymentMethod:input.method?.trim()||null,allocations:{create:input.allocations.map(a=>({invoiceId:a.invoiceId,amount:new Prisma.Decimal(a.amount),withheldTax:new Prisma.Decimal(a.withheldTax??'0.00')}))}},include:{allocations:true}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
export async function listPayments() {return db.payment.findMany({include:{customer:{select:{name:true}},allocations:true},orderBy:{receivedAt:'desc'},take:100});}
