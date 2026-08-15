import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The prisma CLI loads .env for `migrate`, but that is a separate process --
// the server it then starts inherits nothing. Prisma's client sometimes picks
// .env up on its own and sometimes doesn't, which is worse than never: it
// worked here and failed from a fresh clone of the same commit.
//
// So load it explicitly. process.loadEnvFile is built into node 22, which is
// what engines already requires, so this costs no dependency. Real environment
// variables win -- loadEnvFile does not overwrite what is already set, which is
// what we want in production where the platform injects DATABASE_URL directly.
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export function requireEnv(name: string): string {
  const value = process.env[name];
  // fail here with a sentence someone can act on, rather than 200 lines of
  // prisma validation error at the first query
  if (!value) throw new Error(`${name} is not set. Copy apps/server/.env.example to apps/server/.env`);
  return value;
}
