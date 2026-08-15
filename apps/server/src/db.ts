// imported first on purpose -- it loads .env, and PrismaClient reads
// DATABASE_URL the moment it is constructed
import { requireEnv } from "./env.js";
import { PrismaClient } from "@prisma/client";

// one per process, each holds its own connection pool
export const prisma = new PrismaClient({
  datasources: { db: { url: requireEnv("DATABASE_URL") } },
});
