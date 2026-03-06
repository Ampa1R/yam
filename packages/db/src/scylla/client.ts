import { Client, mapping, types } from "cassandra-driver";

const contactPoints = (process.env.SCYLLA_HOSTS ?? "localhost:9042").split(",");
const keyspace = process.env.SCYLLA_KEYSPACE ?? "yam";
const isProd = process.env.NODE_ENV === "production";
const consistency = isProd ? types.consistencies.localQuorum : types.consistencies.localOne;

export const scyllaClient = new Client({
	contactPoints,
	localDataCenter: process.env.SCYLLA_DC ?? "datacenter1",
	keyspace,
	pooling: {
		coreConnectionsPerHost: {
			[types.distance.local]: Number(process.env.SCYLLA_POOL_LOCAL) || 2,
			[types.distance.remote]: 1,
		},
	},
	queryOptions: {
		consistency,
		prepare: true,
	},
});

export const scyllaBootstrapClient = new Client({
	contactPoints,
	localDataCenter: process.env.SCYLLA_DC ?? "datacenter1",
	queryOptions: {
		consistency: types.consistencies.localOne,
	},
});

export async function connectScylla(): Promise<void> {
	if (!isProd) {
		await scyllaBootstrapClient.connect();
		await scyllaBootstrapClient.execute(`
			CREATE KEYSPACE IF NOT EXISTS ${keyspace}
			WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
		`);
		await scyllaBootstrapClient.shutdown();
	}
	await scyllaClient.connect();
	console.log("[ScyllaDB] Connected to keyspace:", keyspace);
}

export async function disconnectScylla(): Promise<void> {
	await scyllaClient.shutdown();
	console.log("[ScyllaDB] Disconnected");
}

export { types, mapping };
