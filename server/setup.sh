#!/bin/bash
# StepWise Publish API - Setup Script
# Run this on your VPS: bash setup.sh

echo ""
echo "========================================"
echo "  StepWise Publish API - Setup"
echo "========================================"
echo ""

# Step 1: Install PM2 if not installed
if ! command -v pm2 &> /dev/null; then
    echo "[1/4] Installing PM2..."
    npm install -g pm2
else
    echo "[1/4] PM2 already installed ✓"
fi

# Step 2: Make sure guides folder exists
echo "[2/4] Creating guides folder..."
mkdir -p /home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise

# Step 3: Start the API with PM2
echo "[3/4] Starting Publish API on port 3600..."
pm2 delete stepwise-publish 2>/dev/null
pm2 start server.js --name stepwise-publish
pm2 save

# Step 4: Open firewall port
echo "[4/4] Opening firewall port 3600..."
v-add-firewall-rule ACCEPT 0.0.0.0/0 3600 tcp 2>/dev/null || echo "Firewall rule may already exist"

echo ""
echo "========================================"
echo "  SETUP COMPLETE!"
echo "========================================"
echo ""
echo "Your Publish API is running on port 3600"
echo ""

# Show the secret key
if [ -f "publish-config.json" ]; then
    SECRET=$(python3 -c "import json; print(json.load(open('publish-config.json'))['secret'])")
    echo "Your SECRET KEY (copy this for the extension):"
    echo ""
    echo "  $SECRET"
    echo ""
else
    echo "Config will be created on first run."
    echo "Check: pm2 logs stepwise-publish --lines 10"
fi

echo "Test it: curl http://109.205.182.135:3600/health"
echo "========================================"
echo ""
