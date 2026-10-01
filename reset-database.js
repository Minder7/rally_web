import "dotenv/config";
import pg from "pg";

if (process.argv[2] !== "--confirm-reset") {
	throw new Error("Pass --confirm-reset to delete Rally users, posts, shares, notifications, and push subscriptions.");
}

const { Pool } = pg;
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

try {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("TRUNCATE TABLE push_subscriptions, notifications, shares, posts, users CASCADE");
		await client.query("COMMIT");
		console.log("Rally users, posts, shares, notifications, and push subscriptions were cleared.");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
} finally {
	await pool.end();
}