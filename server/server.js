// StepWise Publish API — Multi-User
// Receives HTML from the extension and saves it permanently
// Each user gets their own folder and index page
// Port: 3600

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// === CONFIG ===
const PORT = 3600;
const GUIDES_DIR = "/home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise";
const BASE_URL = "https://app.heychatmate.com/stepwise";
const SECRET = crypto.randomBytes(32).toString("hex"); // Generated on first run, saved to config

// Load or create config
const CONFIG_FILE = path.join(__dirname, "publish-config.json");
let config;
if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} else {
  config = { secret: SECRET };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  fs.chmodSync(CONFIG_FILE, "600");
  console.log("\n========================================");
  console.log("  STEPWISE PUBLISH API - FIRST RUN");
  console.log("========================================");
  console.log("Your admin secret key (save this!):");
  console.log(config.secret);
  console.log("========================================\n");
}

// === USERS CONFIG ===
const USERS_FILE = path.join(__dirname, "users.json");

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  }
  return { users: {} };
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), "utf8");
  fs.chmodSync(USERS_FILE, "600");
}

// Authenticate by API key — returns { userId, user } or null
function authenticateUser(req) {
  var auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) return null;
  var apiKey = auth.replace("Bearer ", "");

  // Check if it's the admin key (backward compat)
  if (apiKey === config.secret) {
    return { userId: "_admin", user: { name: "Admin", isAdmin: true } };
  }

  // Look up in users.json
  var data = loadUsers();
  for (var uid in data.users) {
    if (data.users[uid].apiKey === apiKey && data.users[uid].active) {
      return { userId: uid, user: data.users[uid] };
    }
  }
  return null;
}

// Make sure guides folder exists
if (!fs.existsSync(GUIDES_DIR)) {
  fs.mkdirSync(GUIDES_DIR, { recursive: true });
}

// Simple slug generator
function makeSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80) || ("guide-" + Date.now());
}

// Auto-generate per-user index.html listing their guides with delete capability
function rebuildUserIndex(userId) {
  var userDir = path.join(GUIDES_DIR, userId);
  if (!fs.existsSync(userDir)) return;

  // Look up user's name from users.json
  var usersData = loadUsers();
  var userName = "";
  if (usersData.users[userId] && usersData.users[userId].name) {
    userName = usersData.users[userId].name;
  }

  var files = fs.readdirSync(userDir).filter(function(f) {
    return f.endsWith(".html") && f !== "index.html";
  });

  var guides = files.map(function(f) {
    var stats = fs.statSync(path.join(userDir, f));
    var content = "";
    try { content = fs.readFileSync(path.join(userDir, f), "utf8"); } catch(e) {}
    var titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    var displayTitle = titleMatch ? titleMatch[1] : f.replace(".html", "").replace(/-/g, " ");
    var stepCount = (content.match(/class="step-card"/g) || content.match(/class="step"/g) || []).length;
    return {
      fileName: f,
      slug: f.replace(".html", ""),
      title: displayTitle,
      steps: stepCount,
      size: stats.size,
      date: stats.mtime
    };
  });

  guides.sort(function(a, b) { return b.date - a.date; });

  // Load videos
  var videosFile = path.join(userDir, "videos.json");
  var videos = [];
  if (fs.existsSync(videosFile)) {
    try { videos = JSON.parse(fs.readFileSync(videosFile, "utf8")); } catch(e) {}
  }
  videos.sort(function(a, b) { return new Date(b.savedAt) - new Date(a.savedAt); });

  var pageTitle = userName ? userName + "'s StepWise Guides" : "StepWise Guides";

  var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>' + pageTitle.replace(/</g, "&lt;") + '</title>\n<style>\n' +
    '* { margin: 0; padding: 0; box-sizing: border-box; }\n' +
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }\n' +
    '.header { background: linear-gradient(135deg, #1e293b, #0f172a); border-bottom: 1px solid #334155; padding: 40px 20px; text-align: center; }\n' +
    '.header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }\n' +
    '.header h1 em { background: linear-gradient(135deg, #f59e0b, #d97706); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-style: normal; }\n' +
    '.header .user-name { font-size: 20px; font-weight: 600; color: #f59e0b; margin-bottom: 4px; }\n' +
    '.header p { color: #94a3b8; font-size: 14px; }\n' +
    '.container { max-width: 800px; margin: 0 auto; padding: 30px 20px; }\n' +
    '.top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }\n' +
    '.count { font-size: 13px; color: #64748b; }\n' +
    '.manage-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 8px 16px; border-radius: 8px; font-size: 12px; cursor: pointer; transition: all 0.2s; }\n' +
    '.manage-btn:hover { border-color: #f59e0b; color: #f59e0b; }\n' +
    '.manage-btn.active { border-color: #ef4444; color: #ef4444; }\n' +
    '.guide-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }\n' +
    '.guide-card { flex: 1; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; transition: all 0.2s; cursor: pointer; text-decoration: none; display: block; }\n' +
    '.guide-card:hover { border-color: #f59e0b; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(245,158,11,0.1); }\n' +
    '.guide-title { font-size: 17px; font-weight: 600; color: #f1f5f9; margin-bottom: 6px; }\n' +
    '.guide-meta { font-size: 12px; color: #64748b; display: flex; gap: 16px; flex-wrap: wrap; }\n' +
    '.guide-meta i { display: flex; align-items: center; gap: 4px; font-style: normal; }\n' +
    '.del-btn { display: none; background: #1e293b; border: 1px solid #ef4444; color: #ef4444; width: 42px; height: 42px; border-radius: 10px; cursor: pointer; font-size: 18px; transition: all 0.2s; flex-shrink: 0; }\n' +
    '.del-btn:hover { background: #ef4444; color: #fff; }\n' +
    '.managing .del-btn { display: flex; align-items: center; justify-content: center; }\n' +
    '.empty { text-align: center; padding: 60px 20px; color: #475569; }\n' +
    '.empty p { font-size: 15px; }\n' +
    '.footer { text-align: center; padding: 30px; color: #334155; font-size: 11px; }\n' +
    '.toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 12px 24px; border-radius: 10px; font-size: 13px; display: none; z-index: 999; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }\n' +
    '.section-divider { margin: 40px 0 20px; padding-top: 20px; border-top: 1px solid #334155; }\n' +
    '.section-label { font-size: 13px; color: #64748b; margin-bottom: 14px; }\n' +
    '.video-card { flex: 1; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; transition: all 0.2s; cursor: pointer; text-decoration: none; display: block; }\n' +
    '.video-card:hover { border-color: #6366f1; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(99,102,241,0.1); }\n' +
    '</style>\n</head>\n<body>\n' +
    '<div class="header">' + (userName ? '<div class="user-name">' + userName.replace(/</g, "&lt;") + '\'s</div>' : '') + '<h1><em>StepWise</em> Guides</h1><p>Step-by-step tutorials and documentation</p></div>\n' +
    '<div class="container" id="container">\n';

  if (guides.length === 0 && videos.length === 0) {
    html += '<div class="empty"><p>No guides or videos published yet.</p></div>\n';
  } else {
    // Top bar with counts and manage button
    var countParts = [];
    if (guides.length > 0) countParts.push(guides.length + ' guide' + (guides.length === 1 ? '' : 's'));
    if (videos.length > 0) countParts.push(videos.length + ' video' + (videos.length === 1 ? '' : 's'));
    html += '<div class="top-bar"><div class="count">' + countParts.join(', ') + ' published</div>' +
      '<button class="manage-btn" id="manageBtn" onclick="toggleManage()">Manage</button></div>\n';

    // Guides section
    guides.forEach(function(g) {
      var dateStr = g.date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
      var sizeKB = Math.round(g.size / 1024);
      html += '<div class="guide-row">\n' +
        '<a class="guide-card" href="' + g.fileName + '">\n' +
        '  <div class="guide-title">' + g.title.replace(/</g, "&lt;") + '</div>\n' +
        '  <div class="guide-meta">\n' +
        '    <i>&#x1F4C5; ' + dateStr + '</i>\n' +
        (g.steps > 0 ? '    <i>&#x1F4CB; ' + g.steps + ' steps</i>\n' : '') +
        '    <i>&#x1F4E6; ' + sizeKB + ' KB</i>\n' +
        '  </div>\n' +
        '</a>\n' +
        '<button class="del-btn" onclick="deleteGuide(\'' + g.slug + '\', this)" title="Delete">&#x1F5D1;</button>\n' +
        '</div>\n';
    });

    // Videos section
    if (videos.length > 0) {
      if (guides.length > 0) {
        html += '<div class="section-divider"></div>\n';
      }
      html += '<div class="section-label">&#x1F3AC; Videos</div>\n';
      videos.forEach(function(v) {
        var dateStr = new Date(v.savedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
        html += '<div class="guide-row">\n' +
          '<a class="video-card" href="' + v.ghlUrl.replace(/"/g, '&quot;') + '" target="_blank">\n' +
          '  <div class="guide-title">' + (v.title || "Untitled Video").replace(/</g, "&lt;") + '</div>\n' +
          '  <div class="guide-meta">\n' +
          '    <i>&#x1F4C5; ' + dateStr + '</i>\n' +
          '    <i>&#x1F3AC; MP4 Video</i>\n' +
          '  </div>\n' +
          '</a>\n' +
          '<button class="del-btn" onclick="deleteVideo(\'' + v.id + '\', this)" title="Delete">&#x1F5D1;</button>\n' +
          '</div>\n';
      });
    }
  }

  html += '</div>\n<div class="toast" id="toast"></div>\n<div class="footer">Powered by StepWise</div>\n';

  // Add JavaScript for manage/delete
  html += '<script>\n' +
    'var apiUrl = "https://app.heychatmate.com/stepwise-api";\n' +
    'var secretKey = "";\n' +
    'var managing = false;\n\n' +
    'function showToast(msg) {\n' +
    '  var t = document.getElementById("toast");\n' +
    '  t.textContent = msg; t.style.display = "block";\n' +
    '  setTimeout(function() { t.style.display = "none"; }, 3000);\n' +
    '}\n\n' +
    'function toggleManage() {\n' +
    '  var btn = document.getElementById("manageBtn");\n' +
    '  var container = document.getElementById("container");\n' +
    '  if (!managing) {\n' +
    '    var key = prompt("Enter your API key:");\n' +
    '    if (!key) return;\n' +
    '    secretKey = key.trim();\n' +
    '    // Verify key with a list call\n' +
    '    fetch(apiUrl + "/list", { headers: { "Authorization": "Bearer " + secretKey } })\n' +
    '      .then(function(r) { return r.json(); })\n' +
    '      .then(function(d) {\n' +
    '        if (d.success) {\n' +
    '          managing = true;\n' +
    '          container.classList.add("managing");\n' +
    '          btn.textContent = "Done";\n' +
    '          btn.classList.add("active");\n' +
    '          showToast("Manage mode ON — click the red buttons to delete");\n' +
    '        } else { showToast("Invalid key"); secretKey = ""; }\n' +
    '      }).catch(function() { showToast("Could not connect to server"); });\n' +
    '  } else {\n' +
    '    managing = false;\n' +
    '    container.classList.remove("managing");\n' +
    '    btn.textContent = "Manage";\n' +
    '    btn.classList.remove("active");\n' +
    '  }\n' +
    '}\n\n' +
    'function deleteGuide(slug, btn) {\n' +
    '  if (!confirm("Delete this guide permanently?")) return;\n' +
    '  btn.textContent = "...";\n' +
    '  fetch(apiUrl + "/delete/" + slug, {\n' +
    '    method: "DELETE",\n' +
    '    headers: { "Authorization": "Bearer " + secretKey }\n' +
    '  }).then(function(r) { return r.json(); })\n' +
    '    .then(function(d) {\n' +
    '      if (d.success) {\n' +
    '        btn.closest(".guide-row").style.display = "none";\n' +
    '        showToast("Guide deleted!");\n' +
    '      } else { showToast("Delete failed: " + (d.error || "unknown")); btn.textContent = "\\u{1F5D1}"; }\n' +
    '    }).catch(function(e) { showToast("Error: " + e.message); btn.textContent = "\\u{1F5D1}"; });\n' +
    '}\n\n' +
    'function deleteVideo(videoId, btn) {\n' +
    '  if (!confirm("Delete this video link permanently?")) return;\n' +
    '  btn.textContent = "...";\n' +
    '  fetch(apiUrl + "/delete-video/" + videoId, {\n' +
    '    method: "DELETE",\n' +
    '    headers: { "Authorization": "Bearer " + secretKey }\n' +
    '  }).then(function(r) { return r.json(); })\n' +
    '    .then(function(d) {\n' +
    '      if (d.success) {\n' +
    '        btn.closest(".guide-row").style.display = "none";\n' +
    '        showToast("Video link deleted!");\n' +
    '      } else { showToast("Delete failed: " + (d.error || "unknown")); btn.textContent = "\\u{1F5D1}"; }\n' +
    '    }).catch(function(e) { showToast("Error: " + e.message); btn.textContent = "\\u{1F5D1}"; });\n' +
    '}\n' +
    '</script>\n';

  html += '</body>\n</html>';

  fs.writeFileSync(path.join(userDir, "index.html"), html, "utf8");
  fs.chmodSync(path.join(userDir, "index.html"), "644");
  console.log("[INDEX] Rebuilt " + userId + " with " + guides.length + " guides, " + videos.length + " videos");
}

// Read full request body
function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on("data", function(chunk) { chunks.push(chunk); });
    req.on("end", function() { resolve(Buffer.concat(chunks).toString()); });
    req.on("error", reject);
  });
}

// CORS headers
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

var server = http.createServer(async function(req, res) {
  setCORS(res);

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // === HEALTH CHECK ===
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "stepwise-publish" }));
    return;
  }

  // === ME: Get current user info from API key ===
  if (req.method === "GET" && req.url === "/me") {
    var authResult = authenticateUser(req);
    if (!authResult) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      userId: authResult.userId,
      name: authResult.user.name || "Admin",
      indexUrl: BASE_URL + "/" + authResult.userId + "/"
    }));
    return;
  }

  // === REGISTER: Create a new user (admin only) ===
  if (req.method === "POST" && req.url === "/register") {
    try {
      var auth = req.headers["authorization"] || "";
      if (auth !== "Bearer " + config.secret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Admin only" }));
        return;
      }

      var body = await readBody(req);
      var data = JSON.parse(body);

      if (!data.name) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Name is required" }));
        return;
      }

      var userId = "user_" + crypto.randomBytes(4).toString("hex");
      var apiKey = "sk_live_" + crypto.randomBytes(24).toString("hex");

      var users = loadUsers();
      users.users[userId] = {
        apiKey: apiKey,
        name: data.name,
        email: data.email || "",
        createdAt: new Date().toISOString(),
        active: true
      };
      saveUsers(users);

      // Create user's guides directory
      var userDir = path.join(GUIDES_DIR, userId);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      // Build their initial (empty) index
      rebuildUserIndex(userId);

      console.log("[REGISTER] New user: " + userId + " (" + data.name + ")");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        userId: userId,
        apiKey: apiKey,
        indexUrl: BASE_URL + "/" + userId + "/",
        message: "Give this API key to the customer"
      }));
    } catch(err) {
      console.error("[ERROR]", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // === PUBLISH: Save HTML guide (user-scoped) ===
  if (req.method === "POST" && req.url === "/publish") {
    try {
      var authResult = authenticateUser(req);
      if (!authResult) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
        return;
      }

      var userId = authResult.userId;
      var body = await readBody(req);
      var data = JSON.parse(body);

      if (!data.html || !data.title) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing html or title" }));
        return;
      }

      // Use user-specific directory
      var userDir = path.join(GUIDES_DIR, userId);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      var slug = data.slug || makeSlug(data.title);
      var fileName = slug + ".html";
      var filePath = path.join(userDir, fileName);

      // If file already exists, add a number
      if (fs.existsSync(filePath) && !data.overwrite) {
        var counter = 2;
        while (fs.existsSync(path.join(userDir, slug + "-" + counter + ".html"))) {
          counter++;
        }
        fileName = slug + "-" + counter + ".html";
        filePath = path.join(userDir, fileName);
        slug = slug + "-" + counter;
      }

      fs.writeFileSync(filePath, data.html, "utf8");
      fs.chmodSync(filePath, "644");

      // Rebuild this user's index page
      rebuildUserIndex(userId);

      var url = BASE_URL + "/" + userId + "/" + fileName;
      console.log("[PUBLISH] " + userId + "/" + fileName + " (" + Math.round(data.html.length / 1024) + " KB)");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        url: url,
        slug: slug,
        fileName: fileName
      }));

    } catch(err) {
      console.error("[ERROR]", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // === DELETE: Remove a guide (user-scoped) ===
  if (req.method === "DELETE" && req.url.startsWith("/delete/")) {
    var authResult = authenticateUser(req);
    if (!authResult) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
      return;
    }

    var userId = authResult.userId;
    var slugToDelete = req.url.replace("/delete/", "");
    var userDir = path.join(GUIDES_DIR, userId);
    var fileToDelete = path.join(userDir, slugToDelete + ".html");

    if (!fs.existsSync(fileToDelete)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Guide not found" }));
      return;
    }

    fs.unlinkSync(fileToDelete);
    console.log("[DELETE] " + userId + "/" + slugToDelete + ".html");

    // Rebuild this user's index page
    rebuildUserIndex(userId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // === SAVE VIDEO: Store a video GHL link (user-scoped) ===
  if (req.method === "POST" && req.url === "/save-video") {
    try {
      var authResult = authenticateUser(req);
      if (!authResult) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
        return;
      }

      var userId = authResult.userId;
      var body = await readBody(req);
      var data = JSON.parse(body);

      if (!data.ghlUrl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing ghlUrl" }));
        return;
      }

      var userDir = path.join(GUIDES_DIR, userId);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      var videosFile = path.join(userDir, "videos.json");
      var videos = [];
      if (fs.existsSync(videosFile)) {
        try { videos = JSON.parse(fs.readFileSync(videosFile, "utf8")); } catch(e) {}
      }

      var videoId = "vid_" + Date.now();
      videos.push({
        id: videoId,
        title: data.title || "Untitled Video",
        ghlUrl: data.ghlUrl,
        savedAt: new Date().toISOString()
      });

      fs.writeFileSync(videosFile, JSON.stringify(videos, null, 2), "utf8");
      fs.chmodSync(videosFile, "644");

      rebuildUserIndex(userId);

      console.log("[VIDEO] " + userId + " saved video: " + videoId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, videoId: videoId }));
    } catch(err) {
      console.error("[ERROR]", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // === DELETE VIDEO: Remove a video link (user-scoped) ===
  if (req.method === "DELETE" && req.url.startsWith("/delete-video/")) {
    var authResult = authenticateUser(req);
    if (!authResult) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
      return;
    }

    var userId = authResult.userId;
    var videoId = req.url.replace("/delete-video/", "");
    var userDir = path.join(GUIDES_DIR, userId);
    var videosFile = path.join(userDir, "videos.json");

    if (!fs.existsSync(videosFile)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Video not found" }));
      return;
    }

    var videos = [];
    try { videos = JSON.parse(fs.readFileSync(videosFile, "utf8")); } catch(e) {}

    var originalLen = videos.length;
    videos = videos.filter(function(v) { return v.id !== videoId; });

    if (videos.length === originalLen) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Video not found" }));
      return;
    }

    fs.writeFileSync(videosFile, JSON.stringify(videos, null, 2), "utf8");
    console.log("[VIDEO] " + userId + " deleted video: " + videoId);

    rebuildUserIndex(userId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // === LIST: Show user's published guides (user-scoped) ===
  if (req.method === "GET" && req.url === "/list") {
    var authResult = authenticateUser(req);
    if (!authResult) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
      return;
    }

    var userId = authResult.userId;
    var userDir = path.join(GUIDES_DIR, userId);

    if (!fs.existsSync(userDir)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, guides: [] }));
      return;
    }

    var files = fs.readdirSync(userDir).filter(function(f) {
      return f.endsWith(".html") && f !== "index.html";
    });
    var guides = files.map(function(f) {
      var stats = fs.statSync(path.join(userDir, f));
      return {
        fileName: f,
        slug: f.replace(".html", ""),
        url: BASE_URL + "/" + userId + "/" + f,
        size: stats.size,
        publishedAt: stats.mtime.toISOString()
      };
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, guides: guides }));
    return;
  }

  // === ADMIN: List all users (admin only) ===
  if (req.method === "GET" && req.url === "/admin/users") {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    var users = loadUsers();
    var userList = [];
    for (var uid in users.users) {
      var userDir = path.join(GUIDES_DIR, uid);
      var guideCount = 0;
      if (fs.existsSync(userDir)) {
        guideCount = fs.readdirSync(userDir).filter(function(f) {
          return f.endsWith(".html") && f !== "index.html";
        }).length;
      }
      userList.push({
        userId: uid,
        name: users.users[uid].name,
        email: users.users[uid].email,
        apiKey: users.users[uid].apiKey,
        active: users.users[uid].active,
        guideCount: guideCount,
        createdAt: users.users[uid].createdAt
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, users: userList }));
    return;
  }

  // === ADMIN: Deactivate a user (admin only) ===
  if (req.method === "DELETE" && req.url.startsWith("/admin/users/")) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    var targetUserId = req.url.replace("/admin/users/", "");
    var users = loadUsers();
    if (!users.users[targetUserId]) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "User not found" }));
      return;
    }

    users.users[targetUserId].active = false;
    saveUsers(users);

    console.log("[ADMIN] Deactivated user: " + targetUserId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "User deactivated" }));
    return;
  }

  // === ADMIN: Reactivate a user (admin only) ===
  if (req.method === "PUT" && req.url.startsWith("/admin/users/")) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    var targetUserId = req.url.replace("/admin/users/", "");
    var users = loadUsers();
    if (!users.users[targetUserId]) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "User not found" }));
      return;
    }

    users.users[targetUserId].active = true;
    saveUsers(users);

    console.log("[ADMIN] Reactivated user: " + targetUserId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "User reactivated" }));
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("StepWise Publish API running on port " + PORT);
  console.log("Guides folder: " + GUIDES_DIR);
  console.log("Public URL: " + BASE_URL);
});
