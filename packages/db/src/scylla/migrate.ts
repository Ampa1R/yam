import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scyllaBootstrapClient } from "./client";

export async function migrateScylla(): Promise<void> {
	const keyspace = process.env.SCYLLA_KEYSPACE ?? "yam";
	const _contactPoints = (process.env.SCYLLA_HOSTS ?? "localhost:9042").split(",");

	const client = scyllaBootstrapClient;
	await client.connect();

	await client.execute(`
		CREATE KEYSPACE IF NOT EXISTS ${keyspace}
		WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
	`);

	const schemaPath = resolve(import.meta.dir, "schema.cql");
	const schemaCql = readFileSync(schemaPath, "utf-8");

	const statements = schemaCql
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !s.startsWith("--"));

	for (const stmt of statements) {
		await client.execute(stmt);
	}

	await client.shutdown();
	console.log("[ScyllaDB] Schema migration complete");
}

if (import.meta.main) {
	migrateScylla()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error("ScyllaDB migration failed:", err);
			process.exit(1);
		});
}
