# Rally Full-Stack MVP

Rally keeps its existing Arabic interface, posts, profile, themes, in-app notifications, sharing, and install prompt. The new backend uses Node.js, Express, and PostgreSQL. Web Push uses the browser Push API, a VAPID key pair, and `service-worker.js`; Firebase and OneSignal are not used by the new app.

## Clean Start

The new database schema creates empty tables on first server start. Existing Firebase records are not imported and are no longer read by Rally. They remain in the old Firebase project until its owner deletes them there; this workspace does not have permission to erase that cloud project.

## Local Setup

1. Install Node.js 20 or newer and create a free PostgreSQL database, for example on Neon. Copy its SSL connection string.
2. From the project root, run `npm install`.
3. Copy `.env.example` to `.env` and set `DATABASE_URL` and a long random `JWT_SECRET`.
4. Run `npm run generate-vapid`. Put the generated public and private keys in `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Set `VAPID_SUBJECT` to a contact address such as `mailto:you@example.com`.
5. Run `npm start` and open `http://localhost:3000`. The server creates the empty schema automatically.

Never commit `.env` or put the VAPID private key in `index.html`.

## Free Hosting

Connect this repository to Render and create a Blueprint from `render.yaml`. Add the Neon `DATABASE_URL` and generated VAPID values when Render asks for them. Render serves both the static site and API from the same HTTPS origin, so the service worker and API share an origin. GitHub Pages can host static files only; it cannot run this backend. Render's free web service may sleep when idle, so its first request after inactivity can be delayed.

The app prompts users to allow notifications. The owner must subscribe on the same browser/device used to create the post; the current MVP identity is device-scoped and has no password-based account recovery. A new device or cleared browser storage creates a new identity.

## Push Flow

When a participant shares a post, the API validates the session, records the share, saves an in-app notification, and sends a Web Push message to the post owner's saved subscriptions. The service worker displays the notification while the page is closed. Delivery requires HTTPS, a valid VAPID key pair, an opted-in browser subscription, and a browser/device that supports Web Push.
