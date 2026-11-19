import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { toCentavos, fromCentavos } from "@/lib/domain/billing";
export type NewTrip = { customerId:string; tripStart:string; tripEnd?:string; chargeAmount:string; passengerName?:string; origin?:string; destination?:string; vehicleId?:string; driverId?:string; legacyTripId?:string };
/** Requires authenticated OPERATIONS/BILLING/ADMIN/OWNER caller. */
export async function createTrip(input:NewTrip) {
 const date = new Date(input.tripStart);
 if (!Number.isFinite(date.getTime())) throw new Error("Invalid trip date");
 const cents=toCentavos(input.chargeAmount);
 if (cents<0n) throw new Error("Negative charges require adjustment workflow");
 const end=input.tripEnd?new Date(input.tripEnd):null;
 if (end && (!Number.isFinite(end.getTime()) || end<date)) throw new Error("Invalid trip end");
 return db.trip.create({data:{customerId:input.customerId,tripStart:date,tripEnd:end,chargeAmount:new Prisma.Decimal(fromCentavos(cents)),passengerName:input.passengerName?.trim()||null,origin:input.origin?.trim()||null,destination:input.destination?.trim()||null,vehicleId:input.vehicleId||null,driverId:input.driverId||null,legacyTripId:input.legacyTripId||null}});
}
export async function listTrips(customerId?:string) {
 return db.trip.findMany({where:customerId?{customerId}:undefined,include:{customer:{select:{name:true}},soaItems:{select:{soaId:true}}},orderBy:{tripStart:"desc"},take:100});
}
