const sessionStorageKey = "rally_session_token";
const deviceStorageKey = "rally_device_id";

// هنا تم تعديل الرابط ليقرأ من سيرفر Railway المباشر الخاص بك دائماً لحل مشكلة 404
const apiBase = "https://railway.app".replace(/\/\$/, "");

export const auth = { currentUser: null };
export const database = {};

const authListeners = new Set();
let authRestored = false;
let restorePromise = null;

export const serviceWorkerReady = "serviceWorker" in navigator
	? (async () => {
			const workerUrl = new URL("./service-worker.js", import.meta.url);
			const scopeUrl = new URL(".", import.meta.url).href;
			const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
			for (const registration of registrations) {
				if (registration.scope !== scopeUrl) continue;
				const worker = registration.active || registration.waiting || registration.installing;
				if (!worker?.scriptURL.endsWith("/OneSignalSDKWorker.js") &&
					!worker?.scriptURL.endsWith("/firebase-messaging-sw.js")) continue;
				const oldSubscription = await registration.pushManager.getSubscription().catch(() => null);
				if (oldSubscription) await oldSubscription.unsubscribe().catch(() => false);
				await registration.unregister();
			}
			return navigator.serviceWorker.register(workerUrl, { updateViaCache: "none" });
		})().catch((error) => {
			console.error("Rally service worker registration failed:", error);
			return null;
		})
	: Promise.resolve(null);

const emitAuthState = (user) => {
	auth.currentUser = user;
	authListeners.forEach((listener) => listener(user));
};

const apiRequest = async (path, options = {}) => {
	const headers = new Headers(options.headers || {});
	const token = localStorage.getItem(sessionStorageKey);
	if (token && options.auth !== false) headers.set("Authorization", `Bearer ${token}`);
	if (options.body !== undefined) headers.set("Content-Type", "application/json");
	const response = await fetch(`${apiBase}/api${path}`, {
		method: options.method || "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(result.error || `تعذر الاتصال بالخادم (${response.status}).`);
	return result;
};

const restoreAuthState = async () => {
	if (!localStorage.getItem(sessionStorageKey)) {
		authRestored = true;
		emitAuthState(null);
		return;
	}
	try {
		const profile = await apiRequest("/auth/me");
		authRestored = true;
		emitAuthState({ uid: profile.id, displayName: profile.name });
	} catch (error) {
		localStorage.removeItem(sessionStorageKey);
		authRestored = true;
		emitAuthState(null);
		if (error.message) console.warn("Rally session could not be restored:", error.message);
	}
};

export const onAuthStateChanged = (_auth, listener) => {
	authListeners.add(listener);
	if (!restorePromise) restorePromise = restoreAuthState();
	else if (authRestored) queueMicrotask(() => listener(auth.currentUser));
	return () => authListeners.delete(listener);
};

export const signInAnonymously = async () => {
	let deviceId = localStorage.getItem(deviceStorageKey);
	if (!deviceId) {
		deviceId = crypto.randomUUID();
		localStorage.setItem(deviceStorageKey, deviceId);
	}
	const session = await apiRequest("/auth/session", {
		method: "POST",
		auth: false,
		body: { deviceId, name: "مشارك", level: "مبتدئ" }
	});
	localStorage.setItem(sessionStorageKey, session.token);
	const user = { uid: session.user.id, displayName: session.user.name };
	authRestored = true;
	restorePromise = Promise.resolve();
	emitAuthState(user);
	return { user };
};

export const updateProfile = async (user, profile) => {
	Object.assign(user, profile);
	if (auth.currentUser?.uid === user.uid) auth.currentUser.displayName = profile.displayName;
};

export const signOut = async () => {
	try {
		const registration = await serviceWorkerReady;
		const subscription = await registration?.pushManager.getSubscription();
		if (subscription) {
			await apiRequest("/push/subscriptions", {
				method: "DELETE",
				body: { endpoint: subscription.endpoint }
			});
			await subscription.unsubscribe();
		}
	} catch (error) {
		console.warn("Rally push subscription cleanup failed:", error.message);
	}
	localStorage.removeItem(sessionStorageKey);
	localStorage.removeItem(deviceStorageKey);
	emitAuthState(null);
};

const normalizePath = (path) => String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
export const ref = (_database, path) => ({ path: normalizePath(path) });

export const push = (reference) => ({
	path: `${reference.path}/${crypto.randomUUID()}`
});

export const set = (reference, value) => apiRequest(`/data/${reference.path}`, {
	method: "PUT",
	body: value
});

export const update = (reference, value) => apiRequest(`/data/${reference.path}`, {
	method: "PATCH",
	body: value
});

export const remove = (reference) => apiRequest(`/data/${reference.path}`, { method: "DELETE" });

export const onValue = (reference, callback, onError) => {
	let stopped = false;
	let firstSnapshot = true;
	let previousValue;
	const poll = async () => {
		try {
			const value = await apiRequest(`/data/${reference.path}`);
			if (stopped) return;
			const serialized = JSON.stringify(value);
			if (firstSnapshot || serialized !== previousValue) {
				firstSnapshot = false;
				previousValue = serialized;
				callback({ val: () => value, exists: () => value !== null && value !== undefined });
			}
		} catch (error) {
			if (!stopped) onError?.(error);
		}
	};
	void poll();
	const timer = setInterval(poll, 8000);
	return () => {
		stopped = true;
		clearInterval(timer);
	};
};

const decodeVapidKey = (value) => {
	const padding = "=".repeat((4 - value.length % 4) % 4);
	const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
	const rawData = atob(base64);
	return Uint8Array.from(rawData, (character) => character.charCodeAt(0));
};

export const registerPushSubscription = async () => {
	if (!("Notification" in window) || Notification.permission !== "granted") {
		throw new Error("اسمح بإشعارات Rally من إعدادات المتصفح أولًا.");
	}
	const registration = await serviceWorkerReady;
	if (!registration) throw new Error("هذا المتصفح لا يدعم Service Worker.");
	const { publicKey } = await apiRequest("/push/public-key", { auth: false });
	let subscription = await registration.pushManager.getSubscription();
	if (subscription && localStorage.getItem("rally_vapid_public_key") !== publicKey) {
		await subscription.unsubscribe();
		subscription = null;
	}
	if (!subscription) {
		subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: decodeVapidKey(publicKey)
		});
	}
	localStorage.setItem("rally_vapid_public_key", publicKey);
	await apiRequest("/push/subscriptions", {
		method: "POST",
		body: { subscription: subscription.toJSON() }
	});
	return subscription;
};
 
