import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/pg/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://yam:yam_dev@localhost:5432/yam",
	},
});
