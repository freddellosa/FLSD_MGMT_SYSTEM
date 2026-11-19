import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { invoiceTotals, validateSerial, canReplaceInvoice } from '@/lib/domain/invoices';

/** Draft creation never consumes an official serial. Authorize BILLING/ADMIN/OWNER at route boundary. */
export async function createInvoiceDraft(soaId: string) {
  return db.$transaction(async tx => {
    const soa = await tx.statementOfAccount.findUnique({where:{id:soaId},include:{items:true,invoices:true}});
    if (!soa || soa.status === 'CANCELLED') throw new Error('SOA unavailable');
    if (soa.invoices.some(i=>!['CANCELLED','SPOILED'].includes(i.state))) throw new Error('Active invoice already exists');
    const amounts = invoiceTotals(soa.items.map(i=>({amount:i.amountAtBilling.toFixed(2)})));
    return tx.officialInvoice.create({data:{soaId,customerId:soa.customerId,grossAmount:new Prisma.Decimal(amounts.gross),vatAmount:new Prisma.Decimal(amounts.vat),withholdingAmount:new Prisma.Decimal(amounts.withholding)}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
/** Reserve serial and mark print pending. Physical printing and confirmation are deliberately separate. */
export async function reserveInvoiceSerial(invoiceId:string, serialInput:string) {
  const serial = validateSerial(serialInput);
  return db.$transaction(async tx=>{
    const rows = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "OfficialInvoice" WHERE id=${invoiceId}::uuid FOR UPDATE`;
    if (!rows.length) throw new Error('Invoice not found');
    const invoice = await tx.officialInvoice.findUniqueOrThrow({where:{id:invoiceId}});
    if (invoice.state !== 'DRAFT' || invoice.serialNumber) throw new Error('Invoice is no longer an unnumbered draft');
    const serialValue = BigInt(serial);
    const batch = await tx.invoiceSerialBatch.findFirst({where:{deletedAt:null,startSerial:{lte:serialValue},endSerial:{gte:serialValue}}});
    if (!batch) throw new Error('Serial is outside registered stock');
    return tx.officialInvoice.update({where:{id:invoiceId},data:{serialNumber:serial,state:'PRINT_PENDING'}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
export async function confirmInvoicePrinted(invoiceId:string) {
  return db.officialInvoice.updateMany({where:{id:invoiceId,state:'PRINT_PENDING'},data:{state:'PRINTED',printedAt:new Date(),invoiceDate:new Date()}});
}
export async function cancelOrSpoilInvoice(invoiceId:string, state:'CANCELLED'|'SPOILED', reason:string) {
  if (reason.trim().length<5) throw new Error('A meaningful cancellation/spoilage reason is required');
  return db.$transaction(async tx=>{
    const invoice=await tx.officialInvoice.findUniqueOrThrow({where:{id:invoiceId},include:{payments:true}});
    if (invoice.payments.length) throw new Error('Cannot cancel invoice with payment allocations');
    if (!['PRINT_PENDING','PRINTED'].includes(invoice.state)) throw new Error('Invoice is not eligible for cancellation');
    return tx.officialInvoice.update({where:{id:invoiceId},data:{state,cancellationReason:reason.trim(),cancelledAt:new Date()}});
  });
}
export async function replaceCancelledInvoice(invoiceId:string) {
  const old=await db.officialInvoice.findUniqueOrThrow({where:{id:invoiceId}});
  if (!canReplaceInvoice(old.state)) throw new Error('Original invoice is not cancelled or spoiled');
  const draft=await createInvoiceDraft(old.soaId);
  return db.officialInvoice.update({where:{id:draft.id},data:{replacedInvoiceId:old.id}});
}
export async function listInvoices() { return db.officialInvoice.findMany({include:{customer:{select:{name:true}},soa:{select:{soaNumber:true}}},orderBy:{createdAt:'desc'},take:100}); }
