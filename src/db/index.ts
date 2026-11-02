import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@src/db/schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

export const db = drizzle(postgres(connectionString, { prepare: false, max: 20, idle_timeout: 30 }), { schema });

export { schema };
