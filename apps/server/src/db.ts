import { PrismaClient } from "@prisma/client";

// one per process, each holds its own connection pool
export const prisma = new PrismaClient();
