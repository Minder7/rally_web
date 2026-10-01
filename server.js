import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import pg from "pg";
import webPush from "web-push";

const { Pool } = pg;
const app = express();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET;
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

if (!process.env.DATABASE_URL || !jwtSecret) {
	throw new Error("DATABASE_URL and JWT_SECRET must be configured before starting Rally.");
}

const allowedOrigins = new Set([
	process.env.FRONTEND_ORIGIN,
	process.env.RENDER_EXTERNAL_URL,
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"http://localhost:5500",
	"http://127.0.0.1:5500"
].filter(Boolean).map((origin) => origin.replace(/\/$/, "")));

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
const vapidConfigured = Boolean(vapidPublicKey && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (vapidConfigured) {
	webPush.setVapidDetails(
		process.env.VAPID_SUBJECT,
		vapidPublicKey,
		process.env.VAPID_PRIVATE_KEY
	);
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({
	origin(origin, callback) {
		if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
		return callback(null, false);
	}
}));
app.use(express.json({ limit: "64kb", strict: false }));

const asyncRoute = (handler) => (request, response, next) => {
	Promise.resolve(handler(request, response, next)).catch(next);
};

const requireSession = (request, response, next) => {
	const authorization = request.get("authorization") || "";
	const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
	if (!token) return response.status(401).json({ error: "سجّل الدخول أولًا." });

	try {
		request.userId = jwt.verify(token, jwtSecret).sub;
		next();
	} catch {
		response.status(401).json({ error: "انتهت الجلسة. سجّل الدخول مرة أخرى." });
	}
};

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
const cleanText = (value, maxLength) => String(value ?? "").trim().slice(0, maxLength);

const serializePost = (row) => ({
	id: row.id,
	ownerUid: row.ownerUid,
	ownerName: row.ownerName,
	location: row.location,
	date: row.date,
	startTime: row.startTime,
	endTime: row.endTime,
	time: row.time,
	warmup: row.warmup,
	route: row.route,
	distance: row.distance,
	finish: row.finish,
	createdAt: Number(row.createdAt)
});

const loadPosts = async () => {
	const result = await pool.query(`
		SELECT p.id::text AS id, p.owner_id::text AS "ownerUid", u.name AS "ownerName",
			p.location, p.meetup_date::text AS date,
			to_char(p.start_time, 'HH24:MI') AS "startTime",
			to_char(p.end_time, 'HH24:MI') AS "endTime",
			p.warmup, p.route, p.distance, p.finish,
			(EXTRACT(EPOCH FROM p.created_at) * 1000)::bigint AS "createdAt"
		FROM posts p
		JOIN users u ON u.id = p.owner_id
		ORDER BY p.created_at DESC
	`);
	return Object.fromEntries(result.rows.map((row) => [row.id, serializePost(row)]));
};

const loadShares = async () => {
	const result = await pool.query("SELECT post_id::text AS post_id, participant_id::text AS participant_id FROM shares");
	const shares = {};
	for (const row of result.rows) {
		shares[row.post_id] ||= {};
		shares[row.post_id][row.participant_id] = true;
	}
	return shares;
};

const loadNotifications = async (userId) => {
	const result = await pool.query(`
		SELECT n.id::text AS id, n.title, n.message, n.post_id::text AS "postId",
			n.owner_id::text AS "ownerUid", n.actor_id::text AS "actorUid",
			a.name AS "actorName", n.read,
			(EXTRACT(EPOCH FROM n.created_at) * 1000)::bigint AS "createdAt"
		FROM notifications n
		JOIN users a ON a.id = n.actor_id
		WHERE n.owner_id = $1
		ORDER BY n.created_at DESC
	`, [userId]);
	return Object.fromEntries(result.rows.map((row) => [row.id, { ...row, createdAt: Number(row.createdAt) }]));
};

const sendPushToOwner = async (ownerId, title, body) => {
	if (!vapidConfigured) return { configured: false, subscriptions: 0, sent: 0, failed: 0 };
	const result = await pool.query(
		"SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = $1",
		[ownerId]
	);
	let sent = 0;
	let failed = 0;
	const expiredEndpoints = [];
	const payload = JSON.stringify({
		title,
		body,
		url: "/",
		icon: "/assets/icons/rally-icon-192.png"
	});

	await Promise.all(result.rows.map(async (row) => {
		try {
			await webPush.sendNotification(row.subscription, payload, { TTL: 60 * 60 });
			sent += 1;
		} catch (error) {
			failed += 1;
			if (error.statusCode === 404 || error.statusCode === 410) expiredEndpoints.push(row.endpoint);
			else console.error("Web Push delivery failed:", error.statusCode || error.message);
		}
	}));

	if (expiredEndpoints.length) {
		await pool.query("DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])", [expiredEndpoints]);
	}
	return { configured: true, subscriptions: result.rowCount, sent, failed };
};

app.get("/api/health", asyncRoute(async (_request, response) => {
	await pool.query("SELECT 1");
	response.json({ ok: true, pushConfigured: vapidConfigured });
}));

app.post("/api/auth/session", asyncRoute(async (request, response) => {
	const deviceId = String(request.body?.deviceId || "");
	const name = cleanText(request.body?.name, 20);
	const level = cleanText(request.body?.level, 20) || "مبتدئ";
	if (!isUuid(deviceId)) return response.status(400).json({ error: "معرّف الجهاز غير صالح." });
	if (!name) return response.status(400).json({ error: "اكتب اسمك." });
	if (!["مبتدئ", "متوسط", "صعب"].includes(level)) return response.status(400).json({ error: "مستوى الجري غير صالح." });

	const result = await pool.query(`
		INSERT INTO users (device_id, name, level)
		VALUES ($1, $2, $3)
		ON CONFLICT (device_id) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level
		RETURNING id::text AS id, name, level
	`, [deviceId, name, level]);
	const user = result.rows[0];
	const token = jwt.sign({ sub: user.id }, jwtSecret, { expiresIn: "180d" });
	response.json({ token, user });
}));

app.get("/api/auth/me", requireSession, asyncRoute(async (request, response) => {
	const result = await pool.query(
		"SELECT id::text AS id, name, level FROM users WHERE id = $1",
		[request.userId]
	);
	if (!result.rowCount) return response.status(401).json({ error: "الحساب غير موجود." });
	response.json(result.rows[0]);
}));

app.get("/api/push/public-key", (_request, response) => {
	if (!vapidConfigured) return response.status(503).json({ error: "إعداد Web Push غير مكتمل." });
	response.json({ publicKey: vapidPublicKey });
});

app.post("/api/push/subscriptions", requireSession, asyncRoute(async (request, response) => {
	const subscription = request.body?.subscription;
	if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
		return response.status(400).json({ error: "اشتراك Push غير صالح." });
	}
	await pool.query(`
		INSERT INTO push_subscriptions (endpoint, user_id, subscription)
		VALUES ($1, $2, $3::jsonb)
		ON CONFLICT (endpoint) DO UPDATE
		SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription, updated_at = NOW()
	`, [subscription.endpoint, request.userId, JSON.stringify(subscription)]);
	response.json({ ok: true });
}));

app.delete("/api/push/subscriptions", requireSession, asyncRoute(async (request, response) => {
	const endpoint = String(request.body?.endpoint || "");
	if (endpoint) await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2", [endpoint, request.userId]);
	else await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [request.userId]);
	response.json({ ok: true });
}));

app.use("/api/data", requireSession, asyncRoute(async (request, response) => {
	const parts = request.path.split("/").filter(Boolean).map(decodeURIComponent);
	const [collection, firstId, secondId, thirdId] = parts;
	const method = request.method;
	const body = request.body || {};

	if (collection === "posts" && method === "GET" && !firstId) {
		return response.json(await loadPosts());
	}
	if (collection === "postShares" && method === "GET" && !firstId) {
		return response.json(await loadShares());
	}
	if (collection === "users" && firstId && method === "GET") {
		if (firstId !== request.userId) return response.status(403).json({ error: "غير مسموح." });
		const result = await pool.query(
			"SELECT name, level, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS \"createdAt\" FROM users WHERE id = $1",
			[request.userId]
		);
		return response.json(result.rows[0] || null);
	}
	if (collection === "users" && firstId && ["PUT", "PATCH"].includes(method)) {
		if (firstId !== request.userId) return response.status(403).json({ error: "غير مسموح." });
		const name = cleanText(body.name, 20);
		const level = cleanText(body.level, 20) || "مبتدئ";
		if (!name || !["مبتدئ", "متوسط", "صعب"].includes(level)) return response.status(400).json({ error: "بيانات الحساب غير صالحة." });
		await pool.query("UPDATE users SET name = $1, level = $2 WHERE id = $3", [name, level, request.userId]);
		return response.json({ ok: true });
	}

	if (collection === "posts" && firstId) {
		if (method === "GET") {
			const posts = await loadPosts();
			return response.json(posts[firstId] || null);
		}
		if (method === "DELETE") {
			const result = await pool.query("DELETE FROM posts WHERE id = $1 AND owner_id = $2", [firstId, request.userId]);
			if (!result.rowCount) return response.status(404).json({ error: "التجمع غير موجود أو لا تملكه." });
			return response.json({ ok: true });
		}
		if (["PUT", "PATCH"].includes(method)) {
			const location = cleanText(body.location, 100);
			const meetupDate = String(body.date || "");
			const startTime = String(body.startTime || "");
			const endTime = String(body.endTime || "");
			const distance = Number(body.distance);
			if (!location || !/^\d{4}-\d{2}-\d{2}$/.test(meetupDate) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime || !Number.isInteger(distance) || distance < 1 || distance > 100) {
				return response.status(400).json({ error: "بيانات التجمع غير مكتملة أو غير صالحة." });
			}
			const result = await pool.query(`
				INSERT INTO posts (id, owner_id, location, meetup_date, start_time, end_time, warmup, route, distance, finish)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				ON CONFLICT (id) DO UPDATE SET
					location = EXCLUDED.location, meetup_date = EXCLUDED.meetup_date,
					start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
					warmup = EXCLUDED.warmup, route = EXCLUDED.route,
					distance = EXCLUDED.distance, finish = EXCLUDED.finish
				WHERE posts.owner_id = EXCLUDED.owner_id
				RETURNING id
			`, [firstId, request.userId, location, meetupDate, startTime, endTime,
				cleanText(body.warmup || "جلسة تسخين وتمدد", 240),
				cleanText(body.route || "مسار حر", 240), distance,
				cleanText(body.finish || "استراحة جماعية", 160)]);
			if (!result.rowCount) return response.status(403).json({ error: "لا يمكنك تعديل تجمع شخص آخر." });
			const posts = await loadPosts();
			return response.json(posts[firstId]);
		}
	}

	if (collection === "postShares" && firstId && secondId) {
		if (secondId !== request.userId) return response.status(403).json({ error: "غير مسموح." });
		if (method === "GET") {
			const result = await pool.query("SELECT 1 FROM shares WHERE post_id = $1 AND participant_id = $2", [firstId, request.userId]);
			return response.json(result.rowCount ? true : null);
		}
		if (method === "DELETE") {
			await pool.query("DELETE FROM shares WHERE post_id = $1 AND participant_id = $2", [firstId, request.userId]);
			return response.json({ ok: true });
		}
		if (method === "PUT" && body === true) {
			const postResult = await pool.query(
				"SELECT p.owner_id::text AS owner_id, p.location, u.name AS owner_name FROM posts p JOIN users u ON u.id = p.owner_id WHERE p.id = $1",
				[firstId]
			);
			if (!postResult.rowCount) return response.status(404).json({ error: "التجمع غير موجود." });
			const post = postResult.rows[0];
			if (post.owner_id === request.userId) return response.status(400).json({ error: "لا يمكنك مشاركة تجمعك." });
			const shareResult = await pool.query(
				"INSERT INTO shares (post_id, participant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING post_id",
				[firstId, request.userId]
			);
			let push = { configured: vapidConfigured, subscriptions: 0, sent: 0, failed: 0 };
			if (shareResult.rowCount) {
				const participant = await pool.query("SELECT name FROM users WHERE id = $1", [request.userId]);
				const actorName = participant.rows[0]?.name || "مشارك جديد";
				const message = `${actorName} شارك في تجمعك: ${post.location}`;
				await pool.query(`
					INSERT INTO notifications (owner_id, actor_id, post_id, title, message)
					VALUES ($1, $2, $3, $4, $5)
					ON CONFLICT (owner_id, actor_id, post_id)
					DO UPDATE SET title = EXCLUDED.title, message = EXCLUDED.message, read = FALSE, created_at = NOW()
				`, [post.owner_id, request.userId, firstId, "مشارك جديد في تجمعك", message]);
				push = await sendPushToOwner(post.owner_id, "مشارك جديد في تجمعك", message);
			}
			return response.json({ ok: true, push });
		}
	}

	if (collection === "notifications" && firstId) {
		const validShareNotification = method === "PUT" && secondId &&
			body.ownerUid === firstId && body.actorUid === request.userId;
		if (firstId !== request.userId && !validShareNotification) {
			return response.status(403).json({ error: "غير مسموح." });
		}
		if (!secondId && method === "GET") return response.json(await loadNotifications(request.userId));
		if (secondId && thirdId === "read" && method === "PUT" && body === true) {
			await pool.query("UPDATE notifications SET read = TRUE WHERE id = $1 AND owner_id = $2", [secondId, request.userId]);
			return response.json({ ok: true });
		}
		if (secondId && method === "GET") {
			const notifications = await loadNotifications(request.userId);
			return response.json(notifications[secondId] || null);
		}
		if (secondId && method === "PUT") {
			if (body.ownerUid !== firstId || body.actorUid !== request.userId || !isUuid(body.postId)) {
				return response.status(400).json({ error: "بيانات الإشعار غير صالحة." });
			}
			const share = await pool.query(`
				SELECT p.location, actor.name AS actor_name
				FROM shares s
				JOIN posts p ON p.id = s.post_id AND p.owner_id = $2
				JOIN users actor ON actor.id = s.participant_id
				WHERE s.post_id = $1 AND s.participant_id = $3
			`, [body.postId, firstId, request.userId]);
			if (!share.rowCount) return response.status(403).json({ error: "لا توجد مشاركة صالحة لهذا الإشعار." });
			const message = `${share.rows[0].actor_name} شارك في تجمعك: ${share.rows[0].location}`;
			await pool.query(`
				INSERT INTO notifications (id, owner_id, actor_id, post_id, title, message, read)
				VALUES ($1, $2, $3, $4, $5, $6, FALSE)
				ON CONFLICT (owner_id, actor_id, post_id)
				DO UPDATE SET title = EXCLUDED.title, message = EXCLUDED.message, read = FALSE
			`, [secondId, firstId, request.userId, body.postId, "مشارك جديد في تجمعك", message]);
			return response.json({ ok: true });
		}
		if (secondId && method === "PATCH") {
			await pool.query("UPDATE notifications SET read = TRUE WHERE id = $1 AND owner_id = $2", [secondId, request.userId]);
			return response.json({ ok: true });
		}
		if (secondId && method === "DELETE") {
			await pool.query("DELETE FROM notifications WHERE id = $1 AND owner_id = $2", [secondId, request.userId]);
			return response.json({ ok: true });
		}
	}

	return response.status(404).json({ error: "مسار البيانات غير موجود." });
}));

app.use((request, response, next) => {
	if (/^\/(backend|functions|\.git)(\/|$)/.test(request.path) || /^\/(firebase\.json|database\.rules\.json|README\.md|package\.json)$/.test(request.path)) {
		return response.sendStatus(404);
	}
	next();
});

app.use(express.static(projectRoot, { dotfiles: "deny", index: "index.html", fallthrough: true }));

app.use((error, _request, response, _next) => {
	console.error(error);
	if (response.headersSent) return;
	response.status(error.status || 500).json({ error: error.status ? error.message : "حدث خطأ في الخادم." });
});

const start = async () => {
	const schema = await fs.readFile(path.join(projectRoot, "backend", "schema.sql"), "utf8");
	await pool.query(schema);
	app.listen(port, () => console.log(`Rally API listening on port ${port}`));
};

start().catch((error) => {
	console.error("Rally backend failed to start:", error);
	process.exitCode = 1;
});