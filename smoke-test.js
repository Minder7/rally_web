import "dotenv/config";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const apiBase = process.env.RALLY_TEST_API || "http://127.0.0.1:3000";
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});
const deviceIds = [crypto.randomUUID(), crypto.randomUUID()];
const postId = crypto.randomUUID();

const request = async (path, { token, method = "GET", body } = {}) => {
	const response = await fetch(`${apiBase}/api${path}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body === undefined ? {} : { "Content-Type": "application/json" })
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const responseText = await response.text();
	let result;
	try {
		result = responseText ? JSON.parse(responseText) : {};
	} catch {
		throw new Error(`API returned non-JSON data for ${path}: ${responseText.slice(0, 80)}`);
	}
	if (!response.ok) throw new Error(result.error || `API request failed (${response.status}).`);
	return result;
};

let passed = false;
try {
	const health = await request("/health");
	if (!health.ok || !health.pushConfigured) throw new Error("Health check or VAPID configuration failed.");

	const owner = await request("/auth/session", {
		method: "POST",
		body: { deviceId: deviceIds[0], name: "اختبار Rally", level: "مبتدئ" }
	});
	const participant = await request("/auth/session", {
		method: "POST",
		body: { deviceId: deviceIds[1], name: "مشارك اختبار", level: "متوسط" }
	});

	await request(`/data/posts/${postId}`, {
		method: "PUT",
		token: owner.token,
		body: {
			location: "ميدان الاختبار",
			date: "2026-12-31",
			startTime: "07:00",
			endTime: "07:30",
			distance: 5,
			warmup: "تسخين",
			route: "المسار",
			finish: "الختام"
		}
	});

	const share = await request(`/data/postShares/${postId}/${participant.user.id}`, {
		method: "PUT",
		token: participant.token,
		body: true
	});
	const notifications = await request(`/data/notifications/${owner.user.id}`, { token: owner.token });
	const receivedNotification = Object.values(notifications).some((notification) => notification.postId === postId);
	if (!receivedNotification) throw new Error("The share notification was not saved for the post owner.");
	if (!share.push.configured) throw new Error("Web Push is not configured.");

	passed = true;
	console.log(`Smoke test passed. Push subscriptions found: ${share.push.subscriptions}.`);
} finally {
	try {
		await pool.query("DELETE FROM users WHERE device_id = ANY($1::uuid[])", [deviceIds]);
	} catch (error) {
		console.error("Could not remove temporary smoke-test users:", error.message);
		passed = false;
	}
	await pool.end();
}

if (!passed) process.exitCode = 1;