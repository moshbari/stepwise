# StepWise — Complete Project Reference

> Drop this file into any AI chat to give it full context about this project.

## What Is StepWise?

StepWise is a Chrome extension that automates step-by-step documentation. It captures screenshots with click highlights, provides annotation tools, and exports to PDF/HTML. Published HTML guides are hosted permanently on a VPS server.

## Repo Structure

```
stepwise/
├── extension/          ← Chrome extension (loads in chrome://extensions)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── content.css
│   ├── popup.html
│   ├── popup.js
│   ├── editor.html
│   ├── editor.js
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── server/             ← VPS server code (auto-deploys on push)
│   ├── server.js           ← Publish API (port 3600)
│   ├── deploy-webhook.js   ← Auto-deploy webhook (port 3601)
│   └── setup.sh            ← First-time server setup script
├── .gitignore
└── CLAUDE-INSTRUCTIONS.md  ← This file
```

## Server Details

| Setting | Value |
|---|---|
| **VPS Provider** | Contabo |
| **IP Address** | 109.205.182.135 |
| **OS** | Ubuntu 24.04 LTS |
| **Control Panel** | HestiaCP v1.9.4 |
| **SSH** | `ssh root@109.205.182.135` |
| **HestiaCP User** | heychatmate |
| **Main Domain** | heychatmate.com (hosted on GoHighLevel, NOT this VPS) |
| **App Domain** | app.heychatmate.com (hosted on THIS VPS) |
| **Web Root** | /home/heychatmate/web/app.heychatmate.com/public_html/public |
| **Node.js** | v20.19.4 |
| **Process Manager** | PM2 |

## Running Services on VPS

| Service | Port | PM2 Name | Location |
|---|---|---|---|
| **Publish API** | 3600 | stepwise-publish | /root/stepwise-publish/ |
| **Deploy Webhook** | 3601 | stepwise-deploy | /root/stepwise-deploy/ |
| **Video Generator** | 3500 | stepwise-video | /root/stepwise-video/ |

## Nginx Proxy Routes (HTTPS)

All API traffic goes through Nginx reverse proxy so it's accessible over HTTPS:

| Public URL | Proxies To |
|---|---|
| https://app.heychatmate.com/stepwise-api/* | http://127.0.0.1:3600/* |
| https://app.heychatmate.com/stepwise-deploy/* | http://127.0.0.1:3601/* |

Nginx custom config location:
```
/home/heychatmate/conf/web/app.heychatmate.com/nginx.ssl.conf_custom
```

## Multi-User System

StepWise uses per-user API keys. Each user gets their own folder and index page.

### How It Works
- Admin creates users via `POST /register` (protected by admin secret from `publish-config.json`)
- Each user gets a unique API key (`sk_live_...`) and userId (`user_xxxxxxxx`)
- Guides are saved to `/stepwise/{userId}/guide.html`
- Each user has their own index page at `/stepwise/{userId}/`
- Users can only see/delete their own guides
- The admin secret from `publish-config.json` still works (maps to userId `_admin`)

### User Data
Stored in `/root/stepwise-publish/users.json` (gitignored, chmod 600):
```json
{
  "users": {
    "user_a1b2c3d4": {
      "apiKey": "sk_live_abc123...",
      "name": "John Smith",
      "email": "john@example.com",
      "createdAt": "2026-02-14T10:00:00.000Z",
      "active": true
    }
  }
}
```

### Admin Workflow
```bash
# Create a customer
curl -X POST https://app.heychatmate.com/stepwise-api/register \
  -H "Authorization: Bearer ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name": "John Smith", "email": "john@example.com"}'

# List all customers
curl https://app.heychatmate.com/stepwise-api/admin/users \
  -H "Authorization: Bearer ADMIN_SECRET"

# Deactivate a customer (guides stay online, can't publish/delete)
curl -X DELETE https://app.heychatmate.com/stepwise-api/admin/users/user_a1b2c3d4 \
  -H "Authorization: Bearer ADMIN_SECRET"
```

## Published Guides

Guides are saved as static HTML files in per-user folders:
- **Server path:** /home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise/{userId}/
- **Public URL:** https://app.heychatmate.com/stepwise/{userId}/guide-slug.html
- **User index page:** https://app.heychatmate.com/stepwise/{userId}/ (auto-generated, shows only that user's guides)

## GitHub → Server Auto-Deploy

When code is pushed to the `main` branch on GitHub:
1. GitHub sends a webhook to `https://app.heychatmate.com/stepwise-deploy/webhook`
2. The deploy-webhook.js receives it, verifies the signature
3. Runs `git pull origin main` in `/root/stepwise-repo/`
4. Copies `server/server.js` to `/root/stepwise-publish/server.js`
5. Runs `pm2 restart stepwise-publish`
6. The publish API is now running the latest code

**Important:** The deploy only handles `server/` files. Extension changes don't need server deployment — the user just does `git pull` on their Mac and refreshes Chrome.

## Extension Architecture

### How Recording Works
1. User clicks StepWise icon → popup.html opens
2. User clicks "Start Recording" → content.js injects into the page
3. Every click is captured as a step (screenshot + click coordinates + URL)
4. Red circle highlights appear at click positions
5. User clicks "Stop" → editor.html opens with all captured steps

### How the Editor Works
- Steps shown in a sidebar with screenshots
- Annotation tools: circles, rectangles, arrows, pen, eraser, blur boxes, callouts, serial numbers
- Brand settings: company name, logo, primary/accent colors (saved to chrome.storage)
- Export options: PDF (print dialog), HTML (download), Publish (permanent link)

### How Publishing Works
1. User clicks "Publish — Get Link" in editor
2. Extension sends POST to https://app.heychatmate.com/stepwise-api/publish with Bearer API key
3. Server identifies user from API key, saves HTML file to /stepwise/{userId}/ folder
4. Server rebuilds that user's index page
5. Returns permanent URL (includes userId in path) to extension
6. URL saved to publish history in chrome.storage

### Key Files

**manifest.json** — Chrome extension manifest (Manifest V3). Permissions: activeTab, storage, scripting, tabs.

**background.js** — Service worker. Listens for extension icon clicks, manages recording state, opens editor when recording stops.

**content.js** — Injected into web pages during recording. Captures clicks, takes screenshots, highlights click positions.

**content.css** — Styles for the recording overlay and click highlights.

**popup.html / popup.js** — Small popup when clicking the extension icon. Start/stop recording buttons.

**editor.html** — Main editor UI. Step list sidebar, annotation canvas, brand settings panel, export buttons.

**editor.js** — All editor logic (~2900 lines). Annotation tools, HTML generation, publish function, brand management. This is the biggest and most complex file.

## Server API Endpoints

### Publish API (port 3600)

**POST /register** — Create a new user (admin only)
- Header: `Authorization: Bearer <admin-secret>`
- Body: `{ "name": "John Smith", "email": "john@example.com" }`
- Returns: `{ "success": true, "userId": "user_xxx", "apiKey": "sk_live_xxx", "indexUrl": "..." }`

**POST /publish** — Save a new guide (user-scoped)
- Header: `Authorization: Bearer <user-api-key>` (or admin secret)
- Body: `{ "html": "<full html>", "title": "Guide Title", "slug": "optional-slug" }`
- Returns: `{ "success": true, "url": "https://.../stepwise/{userId}/guide.html", "slug": "guide-slug" }`

**DELETE /delete/:slug** — Delete a guide (user-scoped, only own guides)
- Header: `Authorization: Bearer <user-api-key>` (or admin secret)
- Returns: `{ "success": true }`

**GET /list** — List published guides (user-scoped, only own guides)
- Header: `Authorization: Bearer <user-api-key>` (or admin secret)
- Returns: `{ "success": true, "guides": [...] }`

**GET /admin/users** — List all registered users (admin only)
- Header: `Authorization: Bearer <admin-secret>`
- Returns: `{ "success": true, "users": [...] }`

**DELETE /admin/users/:userId** — Deactivate a user (admin only)
- Header: `Authorization: Bearer <admin-secret>`
- Returns: `{ "success": true, "message": "User deactivated" }`

**GET /health** — Health check
- Returns: `{ "status": "ok", "service": "stepwise-publish" }`

### Deploy Webhook (port 3601)

**POST /webhook** — GitHub webhook endpoint
- Verified with X-Hub-Signature-256 header

**POST /deploy** — Manual deploy trigger
- Header: `Authorization: Bearer <webhook-secret>`

**GET /health** — Health check

## Config Files (NOT in Git)

These are sensitive files on the server. They are gitignored:

| File | Location | Contains |
|---|---|---|
| publish-config.json | /root/stepwise-publish/ | Admin secret key |
| deploy-config.json | /root/stepwise-deploy/ | Webhook secret |
| users.json | /root/stepwise-publish/ | User accounts and API keys |

## Port Map — What's Safe to Use

**DO NOT TOUCH:** 21, 22, 25, 53, 80, 110, 143, 443, 465, 587, 783, 993, 995, 3306, 8080, 8083, 8084, 8443

**CURRENTLY IN USE:** 3500 (video API), 3600 (publish API), 3601 (deploy webhook)

**SAFE FOR NEW SERVICES:** 3001-3499, 3602-3999, 4000-4999, 5000-5999, 7000-7999, 9000-9999

## Brand Defaults

| Setting | Value |
|---|---|
| Company Name | Ultimate Online Mastery |
| Primary Color | #d4a017 |
| Accent Color | #8b6914 |
| Logo | Embedded base64 PNG in editor.js (line 8, DEFAULT_LOGO variable) |

Brand settings are saved in chrome.storage.local under key `savedBrandSettings`. They persist across sessions and are loaded on editor startup.

## GHL (GoHighLevel) Media API

There's also a video generation feature that uploads to GHL. Reference:
- API uses curl via child_process.execSync (Node.js fetch does NOT work)
- Files must include `parentId` during upload to land in folders
- Folder IDs use `_id` field, not `id`
- Full reference in GHL-Media-API-Reference.docx

## Common Tasks

### Adding a new annotation tool
Edit `editor.js`. Tools are defined in the annotation section. Each tool has: an activate function, mouse event handlers (mousedown/mousemove/mouseup on the canvas), and a render function.

### Changing the HTML template for published guides
Edit the `generateHTMLContent()` function in `editor.js` (around line 2426). This builds the full HTML string with inline CSS.

### Adding a new API endpoint
Edit `server/server.js`. Add a new route in the `http.createServer` callback. Follow the existing pattern for auth checking and JSON responses.

### Rebuilding a user's index page
Each user's index page auto-rebuilds on every publish/delete. If you need to force it, restart the publish API: `pm2 restart stepwise-publish`

### Creating a new customer account
Use the admin secret to call `/register`: `curl -X POST https://app.heychatmate.com/stepwise-api/register -H "Authorization: Bearer ADMIN_SECRET" -H "Content-Type: application/json" -d '{"name": "Customer Name", "email": "email@example.com"}'`

## Instructions for AI Assistants

**DO:** Work in this GitHub repo. Push changes to `main` for server auto-deploy.

**DO:** Keep all extension code in `/extension/` and all server code in `/server/`.

**DO:** Test server changes by checking PM2 logs: `pm2 logs stepwise-publish --lines 20`

**DO:** Use ports 3602-3999 or 4000-9999 for any new services.

**DO:** Add new Nginx proxy routes to `/home/heychatmate/conf/web/app.heychatmate.com/nginx.ssl.conf_custom`

**DON'T:** Put secrets (API keys, passwords) in the repo. Use config JSON files that are gitignored.

**DON'T:** Modify HestiaCP, Nginx, or Apache configs unless specifically asked.

**DON'T:** Touch the video generator service (port 3500) unless asked.

**DON'T:** Change the publish-config.json admin secret key — it's used for admin operations.

**DON'T:** Modify users.json manually — use the `/register` and `/admin/users` API endpoints.

**USER SKILL LEVEL:** Beginner. Explain everything simply. Use step-by-step instructions.
