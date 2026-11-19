import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
export async function revenueByServiceDate(start:Date,end:Date,includeExcluded=false) {
  if (!(start<end)) throw new Error('Invalid report range');
  const trips=await db.trip.findMany({where:{tripStart:{gte:start,lt:end},...(includeExcluded?{}:{customer:{includeInManagementRevenue:true}})},select:{tripStart:true,chargeAmount:true,customer:{select:{name:true}}}});
  return {basis:'trip service date',tripCount:trips.length,total:trips.reduce((s,t)=>s.plus(t.chargeAmount),new Prisma.Decimal(0)).toFixed(2),byCustomer:Object.entries(trips.reduce<Record<string,Prisma.Decimal>>((acc,t)=>{acc[t.customer.name]=(acc[t.customer.name]??new Prisma.Decimal(0)).plus(t.chargeAmount);return acc;},{})).map(([customer,total])=>({customer,total:total.toFixed(2)}))};
}
export async function invoiceRegister(start:Date,end:Date) {return db.officialInvoice.findMany({where:{invoiceDate:{gte:start,lt:end}},include:{customer:{select:{name:true}},soa:{select:{soaNumber:true}}},orderBy:{invoiceDate:'desc'}});}
export async function collectionRegister(start:Date,end:Date) {return db.payment.findMany({where:{receivedAt:{gte:start,lt:end},state:'RECORDED'},include:{customer:{select:{name:true}}},orderBy:{receivedAt:'desc'}});}
