// StepWise Auto-Deploy Webhook
// Listens for GitHub webhook pings and auto-pulls + restarts
// Port: 3601

const http = require("http");
const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = 3601;
const REPO_DIR = "/root/stepwise-repo";
const CONFIG_FILE = path.join(__dirname, "deploy-config.json");

// Load or create config
let config;
if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} else {
  config = { webhookSecret: crypto.randomBytes(20).toString("hex") };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  fs.chmodSync(CONFIG_FILE, "600");
  console.log("\n========================================");
  console.log("  DEPLOY WEBHOOK - FIRST RUN");
  console.log("========================================");
  console.log("Your webhook secret:");
  console.log(config.webhookSecret);
  console.log("========================================\n");
  console.log("Add this as the 'Secret' in GitHub Webhook settings.");
}

function verifySignature(payload, signature) {
  if (!signature) return false;
  var hmac = crypto.createHmac("sha256", config.webhookSecret);
  hmac.update(payload);
  var expected = "sha256=" + hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on("data", function(chunk) { chunks.push(chunk); });
    req.on("end", function() { resolve(Buffer.concat(chunks).toString()); });
    req.on("error", reject);
  });
}

function deploy() {
  try {
    console.log("[DEPLOY] Starting...");

    // Pull latest from GitHub
    console.log("[DEPLOY] Pulling from GitHub...");
    execSync("cd " + REPO_DIR + " && git pull origin main", { encoding: "utf8", timeout: 30000 });

    // Copy server files to working directory
    console.log("[DEPLOY] Copying server files...");
    execSync("cp " + REPO_DIR + "/server/server.js /root/stepwise-publish/server.js", { encoding: "utf8" });
    execSync("cp " + REPO_DIR + "/server/package.json /root/stepwise-publish/package.json", { encoding: "utf8" });

    // Install/update dependencies
    console.log("[DEPLOY] Installing dependencies...");
    execSync("cd /root/stepwise-publish && npm install --production", { encoding: "utf8", timeout: 60000 });

    // Copy admin dashboard and privacy policy to public folder
    console.log("[DEPLOY] Copying admin dashboard and privacy policy...");
    execSync("cp " + REPO_DIR + "/server/admin.html /home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise/admin.html", { encoding: "utf8" });
    execSync("cp " + REPO_DIR + "/server/privacy.html /home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise/privacy.html", { encoding: "utf8" });

    // Build fresh extension zip + copy downloads.html
    // Reads version from manifest.json so zip filename always matches.
    // Zips from repo ROOT — not from any stale subfolder.
    try {
      console.log("[DEPLOY] Building extension zip...");
      var manifest = JSON.parse(fs.readFileSync(REPO_DIR + "/manifest.json", "utf8"));
      var zipVersion = "v" + manifest.version;
      var zipName = "stepwise-extension-" + zipVersion + ".zip";
      var downloadsDir = "/home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise/downloads";
      execSync("mkdir -p " + downloadsDir, { encoding: "utf8" });
      var fileList = "manifest.json background.js content.js content.css editor.html editor.js popup.html popup.js icons/";
      execSync("cd " + REPO_DIR + " && rm -f '" + downloadsDir + "/" + zipName + "' && zip -r '" + downloadsDir + "/" + zipName + "' " + fileList + " -x '*.DS_Store' -x '__MACOSX/*'", { encoding: "utf8", timeout: 30000 });
      execSync("cp " + REPO_DIR + "/server/downloads.html " + downloadsDir + "/index.html", { encoding: "utf8" });
      console.log("[DEPLOY] Extension zip built: " + zipName);
    } catch(zipErr) {
      console.error("[DEPLOY] Zip step failed (non-fatal):", zipErr.message);
    }

    // Restart the publish API
    console.log("[DEPLOY] Restarting stepwise-publish...");
    execSync("pm2 restart stepwise-publish", { encoding: "utf8" });

    // Restart self so future pushes pick up any webhook code changes.
    // Delayed via detached process so the current deploy() can return cleanly.
    console.log("[DEPLOY] Scheduling self-restart...");
    try {
      const { spawn } = require("child_process");
      const child = spawn("sh", ["-c", "sleep 3 && pm2 restart stepwise-deploy"], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    } catch(e) {
      console.error("[DEPLOY] Self-restart schedule failed:", e.message);
    }

    console.log("[DEPLOY] Done!");
    return { success: true, message: "Deployed successfully" };
  } catch(err) {
    console.error("[DEPLOY] Error:", err.message);
    return { success: false, message: err.message };
  }
}

var server = http.createServer(async function(req, res) {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "stepwise-deploy" }));
    return;
  }

  // Manual deploy trigger (with secret in header)
  if (req.method === "POST" && req.url === "/deploy") {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.webhookSecret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid secret" }));
      return;
    }
    var result = deploy();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // GitHub webhook
  if (req.method === "POST" && req.url === "/webhook") {
    var body = await readBody(req);
    var signature = req.headers["x-hub-signature-256"];

    // Verify GitHub signature
    if (!verifySignature(body, signature)) {
      console.log("[WEBHOOK] Invalid signature, rejecting");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    var payload = JSON.parse(body);

    // Only deploy on pushes to main branch
    if (payload.ref === "refs/heads/main") {
      console.log("[WEBHOOK] Push to main detected, deploying...");
      var result = deploy();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else {
      console.log("[WEBHOOK] Push to " + payload.ref + ", ignoring");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Not main branch, skipping" }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("Deploy webhook running on port " + PORT);
  console.log("GitHub webhook URL: https://app.heychatmate.com/stepwise-deploy/webhook");
  console.log("Manual deploy URL: POST https://app.heychatmate.com/stepwise-deploy/deploy");
});
