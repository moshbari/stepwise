# StepWise GitHub Setup Guide

Follow these steps IN ORDER to get everything managed through GitHub.

## Step 1: Create the GitHub Repo

1. Go to https://github.com/new
2. Name it: `stepwise` (or whatever you prefer)
3. Set it to **Private**
4. Do NOT add a README (we already have files)
5. Click "Create repository"
6. Copy the repo URL — it'll look like: `https://github.com/YOUR-USERNAME/stepwise.git`

## Step 2: Push This Code to GitHub (from your Mac)

Open Terminal on your Mac and run these commands one at a time:

```bash
# Go to your Downloads (or wherever you unzipped the repo folder)
cd ~/Downloads/stepwise-repo

# Initialize git
git init
git add .
git commit -m "Initial commit: StepWise extension + server"

# Connect to your GitHub repo (replace YOUR-USERNAME)
git remote add origin https://github.com/YOUR-USERNAME/stepwise.git

# Push
git branch -M main
git push -u origin main
```

If it asks for a password, you need a GitHub Personal Access Token:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Give it `repo` access
4. Copy the token and use it as the password

## Step 3: Clone the Repo on Your VPS

SSH into your server:
```bash
ssh root@109.205.182.135
```

Then run:
```bash
# Install git if needed
apt install -y git

# Clone your repo (replace YOUR-USERNAME)
cd /root
git clone https://github.com/YOUR-USERNAME/stepwise.git stepwise-repo

# Set up git credentials so it can pull automatically
cd stepwise-repo
git config credential.helper store
git pull  
# Enter username + token once, it'll remember
```

## Step 4: Set Up the Deploy Webhook on VPS

Still on the VPS:
```bash
cd /root/stepwise-repo
bash server/setup-deploy.sh
```

This will:
- Start the deploy webhook on port 3601
- Show you a **webhook secret** — SAVE IT

## Step 5: Add Nginx Proxy for Deploy Webhook

Still on the VPS, update the Nginx config to add the deploy route:
```bash
cat > /home/heychatmate/conf/web/app.heychatmate.com/nginx.ssl.conf_custom << 'EOF'
location /stepwise-api/ {
    proxy_pass http://127.0.0.1:3600/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location /stepwise-deploy/ {
    proxy_pass http://127.0.0.1:3601/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
EOF

systemctl restart nginx
```

Test it:
```bash
curl -s https://app.heychatmate.com/stepwise-deploy/health
```
Should return: `{"status":"ok","service":"stepwise-deploy"}`

## Step 6: Set Up GitHub Webhook

1. Go to your GitHub repo → Settings → Webhooks → Add webhook
2. **Payload URL:** `https://app.heychatmate.com/stepwise-deploy/webhook`
3. **Content type:** application/json
4. **Secret:** paste the webhook secret from Step 4
5. **Events:** Just the push event
6. Click "Add webhook"

## Step 7: Test the Auto-Deploy

On your Mac, make a tiny change and push:
```bash
cd ~/Downloads/stepwise-repo
echo "# test" >> README.md
git add . && git commit -m "Test deploy" && git push
```

Then check on the VPS:
```bash
pm2 logs stepwise-deploy --lines 10
```

You should see: `[DEPLOY] Push to main detected, deploying...`

## Step 8: Load Extension from the Repo Folder

1. On your Mac, move the repo to a permanent location:
```bash
mv ~/Downloads/stepwise-repo ~/stepwise
```
2. In Chrome, go to `chrome://extensions`
3. Remove the old StepWise extension
4. Click "Load unpacked"
5. Select the `~/stepwise/extension` folder
6. Done!

Now when you pull updates:
```bash
cd ~/stepwise && git pull
```
Then just click the refresh button on chrome://extensions.

## Done! Here's Your New Workflow:

### When Claude Code makes changes:
1. Claude pushes to GitHub
2. Server files auto-deploy (webhook pulls + restarts PM2)
3. You do `git pull` on your Mac + refresh Chrome for extension changes

### When you want to edit manually:
1. Edit files in `~/stepwise/`
2. `git add . && git commit -m "description" && git push`
3. Server auto-deploys, extension updates with a Chrome refresh
