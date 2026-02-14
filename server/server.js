// StepWise Publish API
// Receives HTML from the extension and saves it permanently
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
  console.log("Your secret key (save this!):");
  console.log(config.secret);
  console.log("========================================\n");
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

// Auto-generate index.html listing all guides with delete capability
function rebuildIndex() {
  var files = fs.readdirSync(GUIDES_DIR).filter(function(f) {
    return f.endsWith(".html") && f !== "index.html";
  });

  var guides = files.map(function(f) {
    var stats = fs.statSync(path.join(GUIDES_DIR, f));
    var content = "";
    try { content = fs.readFileSync(path.join(GUIDES_DIR, f), "utf8"); } catch(e) {}
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

  var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>StepWise Guides</title>\n<style>\n' +
    '* { margin: 0; padding: 0; box-sizing: border-box; }\n' +
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }\n' +
    '.header { background: linear-gradient(135deg, #1e293b, #0f172a); border-bottom: 1px solid #334155; padding: 40px 20px; text-align: center; }\n' +
    '.header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }\n' +
    '.header h1 em { background: linear-gradient(135deg, #f59e0b, #d97706); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-style: normal; }\n' +
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
    '</style>\n</head>\n<body>\n' +
    '<div class="header"><h1><em>StepWise</em> Guides</h1><p>Step-by-step tutorials and documentation</p></div>\n' +
    '<div class="container" id="container">\n';

  if (guides.length === 0) {
    html += '<div class="empty"><p>No guides published yet.</p></div>\n';
  } else {
    html += '<div class="top-bar"><div class="count">' + guides.length + ' guide' + (guides.length === 1 ? '' : 's') + ' published</div>' +
      '<button class="manage-btn" id="manageBtn" onclick="toggleManage()">Manage</button></div>\n';
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
    '    var key = prompt("Enter your admin secret key:");\n' +
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
    '}\n' +
    '</script>\n';

  html += '</body>\n</html>';

  fs.writeFileSync(path.join(GUIDES_DIR, "index.html"), html, "utf8");
  fs.chmodSync(path.join(GUIDES_DIR, "index.html"), "644");
  console.log("[INDEX] Rebuilt with " + guides.length + " guides");
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
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
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

  // === PUBLISH: Save HTML guide ===
  if (req.method === "POST" && req.url === "/publish") {
    try {
      var auth = req.headers["authorization"] || "";
      if (auth !== "Bearer " + config.secret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid secret key" }));
        return;
      }

      var body = await readBody(req);
      var data = JSON.parse(body);

      if (!data.html || !data.title) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing html or title" }));
        return;
      }

      var slug = data.slug || makeSlug(data.title);
      var fileName = slug + ".html";
      var filePath = path.join(GUIDES_DIR, fileName);

      // If file already exists, add a number
      if (fs.existsSync(filePath) && !data.overwrite) {
        var counter = 2;
        while (fs.existsSync(path.join(GUIDES_DIR, slug + "-" + counter + ".html"))) {
          counter++;
        }
        fileName = slug + "-" + counter + ".html";
        filePath = path.join(GUIDES_DIR, fileName);
        slug = slug + "-" + counter;
      }

      fs.writeFileSync(filePath, data.html, "utf8");
      fs.chmodSync(filePath, "644");

      // Rebuild the index page
      rebuildIndex();

      var url = BASE_URL + "/" + fileName;
      console.log("[PUBLISH] " + fileName + " (" + Math.round(data.html.length / 1024) + " KB)");

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

  // === DELETE: Remove a guide ===
  if (req.method === "DELETE" && req.url.startsWith("/delete/")) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid secret key" }));
      return;
    }

    var slugToDelete = req.url.replace("/delete/", "");
    var fileToDelete = path.join(GUIDES_DIR, slugToDelete + ".html");

    if (!fs.existsSync(fileToDelete)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Guide not found" }));
      return;
    }

    fs.unlinkSync(fileToDelete);
    console.log("[DELETE] " + slugToDelete + ".html");

    // Rebuild the index page
    rebuildIndex();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // === LIST: Show all published guides ===
  if (req.method === "GET" && req.url === "/list") {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid secret key" }));
      return;
    }

    var files = fs.readdirSync(GUIDES_DIR).filter(function(f) { return f.endsWith(".html"); });
    var guides = files.map(function(f) {
      var stats = fs.statSync(path.join(GUIDES_DIR, f));
      return {
        fileName: f,
        slug: f.replace(".html", ""),
        url: BASE_URL + "/" + f,
        size: stats.size,
        publishedAt: stats.mtime.toISOString()
      };
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, guides: guides }));
    return;
  }

  // === HEALTH CHECK ===
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "stepwise-publish" }));
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
  console.log("Index page: " + BASE_URL + "/");
  rebuildIndex();
});
