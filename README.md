# Commonroom

A small, server-backed community forum built with Node.js, Express, SQLite, and plain JavaScript. Rooms start empty: accounts and conversations are created by the people who use the app.

## Run locally

Use Node.js 22.5 or newer. Install dependencies and start the server:

```sh
npm install
npm start
```

Open <http://localhost:4173>. Run the API integration tests with `npm test`.

Only the account named `admin` can become an administrator. Locally, the first `admin` signup claims the role. On a public deployment, the first `admin` signup also needs the one-time `ADMIN_SETUP_KEY` from your hosting settings. Set this key before opening registration. Admins can review recent posts, remove posts, and suspend or restore accounts from the admin desk.

## What is stored

SQLite data, uploaded media, and a generated session-signing key are saved in `data/`. This folder is created when the server starts and should be backed up and kept private. Set `COMMONROOM_DATA_DIR` to store it elsewhere, `PORT` to change the listening port, and `SESSION_SECRET` to provide a stable session key. Uploaded images and videos are limited to 12 MB; profile photos are limited to 5 MB.

## Publish on Render

The included `render.yaml` configures a Node service, HTTPS at Render's assigned address, a health check, and a persistent disk for the SQLite database and uploaded media. The Starter service and persistent disk are paid resources; review Render's current pricing before creating them.

1. Push this project to a GitHub repository and create a Blueprint in Render from that repository.
2. Review the plan and disk size. Provide a long, unique `ADMIN_SETUP_KEY` when Render prompts for it. Render generates `SESSION_SECRET` for you.
3. Create the service and wait for `/api/health` to pass. Open the Render URL.
4. Register the username `admin` with your `ADMIN_SETUP_KEY`. Use a different, strong account password. This is the only administrator account.

Do not commit `.env` or share deployment secrets in chat. The account/password login uses server-side salted password hashes; `ADMIN_SETUP_KEY` is only for the initial public admin signup. If you later attach a custom domain, configure it in Render and update its DNS records as instructed there.
