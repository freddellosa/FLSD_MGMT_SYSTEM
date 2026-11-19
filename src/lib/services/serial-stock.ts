import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { parseSerialRange } from '@/lib/domain/serial-stock';
/** Call from authenticated BILLING/ADMIN/OWNER routes; no public mutation endpoints. */
export async function registerSerialBatch(start: string, end: string) {
  const range = parseSerialRange(start,end);
  return db.$transaction(async tx => {
    // Advisory lock serializes batch creation, preventing overlapping registrations.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(6748321)`;
    const overlapping = await tx.invoiceSerialBatch.findFirst({where:{deletedAt:null,startSerial:{lte:range.end},endSerial:{gte:range.start}}});
    if (overlapping) throw new Error('Serial stock overlaps an existing active batch');
    return tx.invoiceSerialBatch.create({data:{startSerial:range.start,endSerial:range.end}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
export async function serialStockSummary() {
  const batches = await db.invoiceSerialBatch.findMany({where:{deletedAt:null},orderBy:{startSerial:'asc'}});
  return Promise.all(batches.map(async batch => {
    // Lexicographic serial comparisons cannot safely count mixed-width serials.
    // Return registered capacity only until numeric stock query is implemented.
    return {id:batch.id,start:String(batch.startSerial),end:String(batch.endSerial),capacity:String(batch.endSerial-batch.startSerial+1n),usedEstimate:null as number|null,warning:'Numeric used-serial count pending; do not use for stock alerts'};
  }));
}
