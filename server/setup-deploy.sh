#!/bin/bash
# Setup script for the deploy webhook
# Run this on the VPS after cloning the repo

echo "=== StepWise Deploy Webhook Setup ==="

# Create deploy directory
mkdir -p /root/stepwise-deploy
cp server/deploy-webhook.js /root/stepwise-deploy/deploy-webhook.js

# Install PM2 if not present
if ! command -v pm2 &> /dev/null; then
  echo "Installing PM2..."
  npm install -g pm2
fi

# Check if already running
if pm2 describe stepwise-deploy > /dev/null 2>&1; then
  echo "Restarting existing deploy webhook..."
  pm2 restart stepwise-deploy
else
  echo "Starting deploy webhook..."
  cd /root/stepwise-deploy
  pm2 start deploy-webhook.js --name stepwise-deploy
  pm2 save
fi

# Open firewall port
echo "Opening port 3601..."
v-add-firewall-rule ACCEPT 0.0.0.0/0 3601 tcp 2>/dev/null || true

# Show the webhook secret
echo ""
echo "=== SETUP COMPLETE ==="
echo ""
if [ -f /root/stepwise-deploy/deploy-config.json ]; then
  echo "Webhook secret:"
  cat /root/stepwise-deploy/deploy-config.json | grep webhookSecret
  echo ""
  echo "Add this secret to your GitHub repo webhook settings."
fi
echo ""
echo "GitHub Webhook URL: https://app.heychatmate.com/stepwise-deploy/webhook"
echo "Content type: application/json"
echo "Events: Just the push event"
