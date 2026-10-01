import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import webPush from "web-push";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(projectRoot, ".env");
if (!fs.existsSync(envPath)) throw new Error("Copy .env.example to .env and set DATABASE_URL first.");

const current = dotenv.parse(fs.readFileSync(envPath));
if (!current.DATABASE_URL || current.DATABASE_URL.includes("replace-with")) {
	throw new Error("Set DATABASE_URL in .env before preparing local push keys.");
}

const vapidKeys = current.VAPID_PRIVATE_KEY && !current.VAPID_PRIVATE_KEY.includes("generate-on-first-run")
	? { publicKey: current.VAPID_PUBLIC_KEY, privateKey: current.VAPID_PRIVATE_KEY }
	: webPush.generateVAPIDKeys();

const updated = {
	...current,
	JWT_SECRET: current.JWT_SECRET && !current.JWT_SECRET.includes("generate-on-first-run")
		? current.JWT_SECRET
		: crypto.randomBytes(48).toString("base64url"),
	VAPID_PUBLIC_KEY: vapidKeys.publicKey,
	VAPID_PRIVATE_KEY: vapidKeys.privateKey,
	VAPID_SUBJECT: current.VAPID_SUBJECT || "mailto:rally@example.com",
	PORT: current.PORT || "3000"
};

const keyOrder = ["DATABASE_URL", "JWT_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "PORT"];
fs.writeFileSync(envPath, `${keyOrder.map((key) => `${key}=${updated[key]}`).join("\n")}\n`, { mode: 0o600 });
console.log("Local JWT and VAPID keys are ready in the ignored .env file. No keys were printed.");