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
│   ├── downloads.html      ← Extension downloads page (hosted at /stepwise/downloads/)
│   ├── deploy-downloads.sh ← Script to zip extension and upload to server
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

## Extension Downloads Page

All extension versions are hosted as zip files at:
- **URL:** https://app.heychatmate.com/stepwise/downloads/
- **Server path:** /home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise/downloads/
- **Page source:** `server/downloads.html` (deployed as `index.html`)
- **Deploy script:** `server/deploy-downloads.sh`

### Releasing a New Version — MANDATORY CHECKLIST

**IMPORTANT: Every time extension code is modified, ALL of these steps MUST be completed before the task is considered done. Do NOT skip any step. Do NOT wait for the user to remind you.**

When ANY file in `extension/` is changed:
1. **Bump version** in `extension/manifest.json` (increment minor for features, patch for fixes)
2. **Update `server/downloads.html`** — add a new version card at the top with the changes, move "LATEST" badge from old version
3. **Update the "Current Versions" list below** in this file
4. Run: `bash server/deploy-downloads.sh v1.X.0` (zips extension and uploads)
5. Commit and push all changes including `server/downloads.html` and this file

**This is not optional.** The downloads page is how users get the extension. If it's not updated, users won't get the new features.

### Current Versions
- **v3.0.0** (May 1, 2026) — Annotation editor overhaul: real Gaussian blur in the editor (matches export), blur boxes are now selectable + intensity-editable after creation, default blur 3px, step number badge color preserved through edits/deletes, annotation positions stable across save/reload at any window size (coords stored in natural-image pixel space, file format bumped to 1.5)
- **v2.4.6** (Apr 24, 2026) — Cloud projects stay fully editable after save/reload; published HTML embeds raw project data so Import from Published Guide restores editable annotations
- **v2.4.5** (Apr 23, 2026) — Build-pipeline fix (every prior zip from v2.2.0 to v2.4.4 actually contained v2.2.0 code due to a stale subfolder); version label now auto-reads from manifest; recording bug on GHL fixed
- **v2.4.4** (Mar 20, 2026) — Patch bump for Chrome Web Store submission
- **v2.4.3** (Mar 20, 2026) — Major annotation UX overhaul: callout click-to-place flow, step numbers with arrows, in-place move/resize for all tools, smart step numbering with auto re-number, editable step labels
- **v2.2.0** (Feb 25, 2026) — Fix click capture on GHL workflow pages (early script loading + service worker restart recovery)
- **v2.1.0** (Feb 25, 2026) — Iframe support: captures clicks inside iframes (GoHighLevel workflows, embedded editors)
- **v2.0.0** (Feb 18, 2026) — Save to Cloud (auto-saves on publish), Load from Cloud, Import from Published Guide
- **v1.9.0** (Feb 18, 2026) — URLs in step descriptions and page URLs are now clickable links in published guides
- **v1.8.0** (Feb 18, 2026) — Voice auto-dictation ON by default, popup version display fixed
- **v1.7.0** (Feb 17, 2026) — Dubai time on dates, guide links open in new tab, hide Upgrade to Pro for Pro users
- **v1.6.0** (Feb 17, 2026) — Fix: loading new project no longer overwrites previously published guides
- **v1.5.0** (Feb 17, 2026) — Video generation uses server-provided OpenAI key (no user setup needed)
- **v1.4.0** (Feb 17, 2026) — Add Video to Guide button, publish updates same guide instead of creating duplicates
- **v1.3.0** (Feb 16, 2026) — API key login in popup, account card with My Guides & Log Out
- **v1.2.0** (Feb 16, 2026) — WarriorPlus upgrade link, GHL email, WP webhook fix
- **v1.1.0** (Feb 15, 2026) — Upgrade to Pro link, OpenAI API proxy
- **v1.0.0** (Feb 14, 2026) — Initial release

## Payment & Email Integration

### Payment Platform: WarriorPlus
- **Product ID:** wso_wp73d1
- **IPN URL:** https://app.heychatmate.com/stepwise-api/webhooks/warriorplus
- **Upgrade URL in extension:** https://stepwise.heychatmate.com/stepwise (set in `UPGRADE_URL` variable in both `popup.js` and `editor.js`)

### Transactional Email: GoHighLevel (GHL)
Welcome emails are sent via GHL workflow (not SMTP). The flow:
1. Customer buys on WarriorPlus → IPN hits `/webhooks/warriorplus`
2. Server creates account + API key
3. Server POSTs to GHL Inbound Webhook URL (configured in `publish-config.json` under `ghl.webhookUrl`)
4. GHL workflow creates contact and sends welcome email with API key

**GHL Webhook URL** is stored in `publish-config.json`:
```json
"ghl": {
  "webhookUrl": "https://services.leadconnectorhq.com/hooks/..."
}
```

**GHL Workflow:** "StepWise Welcome Email 16Feb26" — Inbound Webhook → Create Contact → Send Email

**Email merge fields from webhook:**
- `{{inboundWebhookRequest.email}}` — customer email
- `{{inboundWebhookRequest.name}}` — customer name
- `{{inboundWebhookRequest.apiKey}}` — their API key
- `{{inboundWebhookRequest.guidesUrl}}` — their guides page URL
- `{{inboundWebhookRequest.userId}}` — their user ID

**Fallback:** If `ghl.webhookUrl` is not set in config, falls back to Nodemailer SMTP (currently Brevo, but authentication is broken).

### Webhook Endpoints
| Platform | Endpoint | Format |
|---|---|---|
| Whop | POST /webhooks/whop | JSON |
| WarriorPlus | POST /webhooks/warriorplus | Multipart form-data (WP_ fields) or URL-encoded (WSO_ fields) |
| JVZoo | POST /webhooks/jvzoo | URL-encoded |

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

**ALWAYS:** When ANY file in `extension/` is changed, you MUST also: (1) bump version in `manifest.json`, (2) update `server/downloads.html` with a new version card, (3) update the "Current Versions" list in this file. This is mandatory for every change — do not wait for the user to ask.

**USER SKILL LEVEL:** Beginner. Explain everything simply. Use step-by-step instructions.
