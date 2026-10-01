self.addEventListener("push", (event) => {
	let payload = {};
	try {
		payload = event.data?.json() || {};
	} catch {
		payload = { body: event.data?.text() || "لديك تحديث جديد على Rally." };
	}

	const title = payload.title || "Rally";
	const options = {
		body: payload.body || "لديك تحديث جديد على Rally.",
		icon: payload.icon || "/assets/icons/rally-icon-192.png",
		badge: "/assets/icons/rally-icon-192.png",
		data: { url: payload.url || "/" }
	};
	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		const existing = windows.find((client) => client.url.startsWith(self.location.origin));
		if (existing) {
			await existing.navigate(targetUrl);
			return existing.focus();
		}
		return self.clients.openWindow(targetUrl);
	})());
});
