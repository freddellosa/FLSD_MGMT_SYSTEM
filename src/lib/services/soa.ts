import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { assertSoaEligible, toCentavos, fromCentavos } from "@/lib/domain/billing";
/** Concurrency-safe SOA creation. Requires authenticated BILLING/ADMIN/OWNER caller. */
export async function createSoa(input:{customerId:string;tripIds:string[];poNumber?:string}) {
 if (!input.tripIds.length || new Set(input.tripIds).size !== input.tripIds.length) throw new Error("Invalid trip selection");
 return db.$transaction(async tx => {
   // Locks selected trips in deterministic order; blocks simultaneous SOA assignments.
   const ids=[...input.tripIds].sort();
   await tx.$queryRaw`SELECT id FROM "Trip" WHERE id IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
   const trips=await tx.trip.findMany({where:{id:{in:ids}},include:{soaItems:{select:{soaId:true,soa:{select:{status:true}}}}}});
   if (trips.length !== ids.length) throw new Error("One or more selected trips were not found");
   const charges=trips.map(t=>({tripId:t.id,customerId:t.customerId,amountCentavos:toCentavos(t.chargeAmount.toFixed(2)),soaId:t.soaItems.some(item=>item.soa.status!=="CANCELLED")?"assigned":null}));
   assertSoaEligible(charges,{customerId:input.customerId,tripIds:ids});
   const sequence=await tx.$queryRaw<Array<{nextval:bigint}>>`SELECT nextval('flsd_soa_number_seq') AS nextval`;
   const soaNumber=`SOA-${String(sequence[0].nextval).padStart(7,"0")}`;
   return tx.statementOfAccount.create({data:{soaNumber,customerId:input.customerId,poNumber:input.poNumber?.trim()||null,items:{create:trips.map(t=>({tripId:t.id,amountAtBilling:new Prisma.Decimal(fromCentavos(toCentavos(t.chargeAmount.toFixed(2))))}))}},include:{items:true}});
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
export async function listSoas() {return db.statementOfAccount.findMany({include:{customer:{select:{name:true}},_count:{select:{items:true}}},orderBy:{createdAt:"desc"},take:100});}
