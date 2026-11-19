export const modules = [
 { title: "Trips", description: "Trip registry and dispatch records", icon: "route" },
 { title: "Statements of Account", description: "Group trips and prepare SOAs", icon: "file" },
 { title: "Official Invoices", description: "BIR serials, printing, and cancellations", icon: "receipt" },
 { title: "Collections", description: "Payments, allocations, and receivables", icon: "wallet" },
 { title: "Master Records", description: "Customers, vehicles, drivers, and staff", icon: "users" },
 { title: "Reports", description: "Trip revenue, invoicing, and collections", icon: "chart" },
] as const;
export function moduleCount() { return modules.length; }
