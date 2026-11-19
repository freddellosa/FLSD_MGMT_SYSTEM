import { db } from "@/lib/db";
import { normalizeCustomerName } from "@/lib/domain/billing";
/** Call only from an authenticated, role-authorized server handler. */
export async function createCustomer(input: { name: string; tin?: string; billingAddress?: string; includeInManagementRevenue?: boolean }) {
 const name = input.name.trim();
 const normalizedName = normalizeCustomerName(name);
 return db.customer.create({data:{name,normalizedName,tin:input.tin?.trim()||null,billingAddress:input.billingAddress?.trim()||null,includeInManagementRevenue:input.includeInManagementRevenue??true}});
}
export async function listCustomers() {return db.customer.findMany({orderBy:{name:"asc"},take:500});}
export async function createVehicle(input:{plateNumber:string;description:string}) {
 const plateNumber=input.plateNumber.trim().toUpperCase();
 if (!/^[A-Z0-9 -]{3,20}$/.test(plateNumber) || !input.description.trim()) throw new Error("Invalid vehicle");
 return db.vehicle.create({data:{plateNumber,description:input.description.trim()}});
}
export async function createDriver(input:{name:string;employeeCode?:string}) {
 if (!input.name.trim()) throw new Error("Driver name is required");
 return db.driver.create({data:{name:input.name.trim(),employeeCode:input.employeeCode?.trim()||null}});
}
