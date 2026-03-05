import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL ?? "postgres://yam:yam_dev@localhost:5432/yam";

const queryClient = postgres(connectionString, {
	max: Number(process.env.PG_POOL_SIZE) || 20,
	idle_timeout: Number(process.env.PG_IDLE_TIMEOUT) || 30,
	connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT) || 10,
});

export const db = drizzle(queryClient, { schema });
export type Database = typeof db;
