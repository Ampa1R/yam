import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL ?? "postgres://yam:yam_dev@localhost:5432/yam";

const queryClient = postgres(connectionString, {
	max: 20,
	idle_timeout: 30,
	connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });
export type Database = typeof db;
