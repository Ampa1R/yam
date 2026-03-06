import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./client";

const POST_MIGRATION_INDEXES = [
	`CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm ON users USING gin (display_name gin_trgm_ops)`,
	`CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING gin (username gin_trgm_ops)`,
];

async function main() {
	console.log("Running migrations...");
	await migrate(db, { migrationsFolder: "./drizzle" });

	console.log("Applying post-migration indexes...");
	for (const ddl of POST_MIGRATION_INDEXES) {
		await db.execute(sql.raw(ddl));
	}

	console.log("Migrations complete.");
	process.exit(0);
}

main().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
