import { PrismaClient } from "@prisma/client";
const holder = globalThis as unknown as { flsdPrisma?: PrismaClient };
export const db = holder.flsdPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") holder.flsdPrisma = db;
