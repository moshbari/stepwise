#!/bin/bash
# Deploy StepWise Downloads Page
# Run from the stepwise project root: bash server/deploy-downloads.sh
# Usage: bash server/deploy-downloads.sh [version]
# Example: bash server/deploy-downloads.sh v1.2.0

set -e

VERSION="${1:-v1.2.0}"
REMOTE="root@109.205.182.135"
REMOTE_DIR="/home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise/downloads"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== StepWise Extension Deploy ==="
echo "Version: $VERSION"
echo ""

# 1. Create zip of the extension
echo "[1/4] Zipping extension..."
cd "$PROJECT_DIR"
ZIP_NAME="stepwise-extension-${VERSION}.zip"
rm -f "$ZIP_NAME"
cd extension
zip -r "../$ZIP_NAME" . -x "*.DS_Store" -x "__MACOSX/*"
cd ..
ZIP_SIZE=$(du -h "$ZIP_NAME" | cut -f1)
echo "  Created: $ZIP_NAME ($ZIP_SIZE)"

# 2. Create downloads directory on server
echo "[2/4] Creating remote directory..."
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"

# 3. Upload zip and HTML page
echo "[3/4] Uploading files..."
scp "$ZIP_NAME" "$REMOTE:$REMOTE_DIR/$ZIP_NAME"
scp server/downloads.html "$REMOTE:$REMOTE_DIR/index.html"
echo "  Uploaded: $ZIP_NAME"
echo "  Uploaded: index.html"

# 4. Set permissions
echo "[4/4] Setting permissions..."
ssh "$REMOTE" "chmod 644 $REMOTE_DIR/*.zip $REMOTE_DIR/index.html"

echo ""
echo "=== Done! ==="
echo "Downloads page: https://app.heychatmate.com/stepwise/downloads/"
echo "Direct zip:     https://app.heychatmate.com/stepwise/downloads/$ZIP_NAME"
echo ""
echo "To add older versions, run:"
echo "  git stash"
echo "  git checkout <commit> -- extension/"
echo "  bash server/deploy-downloads.sh v1.0.0"
echo "  git checkout main -- extension/"
echo "  git stash pop"
