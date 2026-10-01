import "dotenv/config";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

try {
	const result = await pool.query(`
		SELECT
			(SELECT COUNT(*) FROM users)::integer AS users,
			(SELECT COUNT(*) FROM posts)::integer AS posts,
			(SELECT COUNT(*) FROM shares)::integer AS shares,
			(SELECT COUNT(*) FROM notifications)::integer AS notifications,
			(SELECT COUNT(*) FROM push_subscriptions)::integer AS push_subscriptions
	`);
	console.log(JSON.stringify(result.rows[0]));
} finally {
	await pool.end();
}