import { Client, mapping, types } from "cassandra-driver";

const contactPoints = (process.env.SCYLLA_HOSTS ?? "localhost:9042").split(",");
const keyspace = process.env.SCYLLA_KEYSPACE ?? "yam";

export const scyllaClient = new Client({
	contactPoints,
	localDataCenter: "datacenter1",
	keyspace,
	pooling: {
		coreConnectionsPerHost: {
			[types.distance.local]: 2,
			[types.distance.remote]: 1,
		},
	},
	queryOptions: {
		consistency: types.consistencies.localQuorum,
		prepare: true,
	},
});

export const scyllaBootstrapClient = new Client({
	contactPoints,
	localDataCenter: "datacenter1",
	queryOptions: {
		consistency: types.consistencies.localQuorum,
	},
});

export async function connectScylla(): Promise<void> {
	await scyllaBootstrapClient.connect();
	await scyllaBootstrapClient.execute(`
		CREATE KEYSPACE IF NOT EXISTS ${keyspace}
		WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
	`);
	await scyllaBootstrapClient.shutdown();
	await scyllaClient.connect();
	console.log("[ScyllaDB] Connected to keyspace:", keyspace);
}

export async function disconnectScylla(): Promise<void> {
	await scyllaClient.shutdown();
	console.log("[ScyllaDB] Disconnected");
}

export { types, mapping };
