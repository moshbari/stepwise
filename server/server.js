// StepWise Publish API — SaaS with MariaDB
// Multi-user platform with payment webhooks, email, and admin dashboard
// Port: 3600

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");

// === CONFIG ===
const PORT = 3600;
const GUIDES_DIR = "/home/heychatmate/web/app.heychatmate.com/public_html/public/stepwise";
const BASE_URL = "https://app.heychatmate.com/stepwise";
const SECRET = crypto.randomBytes(32).toString("hex");

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

// === OPENAI PROXY CONFIG ===
var OPENAI_API_KEY = config.openaiApiKey || "";
if (OPENAI_API_KEY) {
  console.log("OpenAI API proxy: ENABLED");
} else {
  console.log("OpenAI API proxy: DISABLED (no openaiApiKey in config)");
}

// === WEBHOOK CONFIG ===
var webhookConfig = config.webhooks || {};
var emailConfig = config.email || {};
var ghlConfig = config.ghl || {};

// === RATE LIMITING (in-memory) ===
var rateLimits = {};
function checkRateLimit(userId, endpoint, maxRequests) {
  var now = Date.now();
  var oneHour = 60 * 60 * 1000;
  if (!rateLimits[userId]) rateLimits[userId] = {};
  if (!rateLimits[userId][endpoint]) rateLimits[userId][endpoint] = [];
  rateLimits[userId][endpoint] = rateLimits[userId][endpoint].filter(function(t) { return now - t < oneHour; });
  if (rateLimits[userId][endpoint].length >= maxRequests) return false;
  rateLimits[userId][endpoint].push(now);
  return true;
}

// === DATABASE CONNECTION POOL ===
var pool = null;

async function initDatabase() {
  var dbConfig = config.database || {};
  pool = mysql.createPool({
    host: dbConfig.host || "localhost",
    user: dbConfig.user || "stepwise_app",
    password: dbConfig.password || "",
    database: dbConfig.database || "stepwise",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  });

  // Test connection
  try {
    var conn = await pool.getConnection();
    console.log("Database: Connected to MariaDB");
    conn.release();
  } catch (err) {
    console.error("Database: Connection FAILED -", err.message);
    console.error("Server will not start without database.");
    process.exit(1);
  }

  // Auto-migrate from users.json if needed
  await migrateFromJson();
}

// Convert ISO date string to MySQL DATETIME format
function toMySQLDate(isoStr) {
  try {
    if (!isoStr) return new Date().toISOString().slice(0, 19).replace("T", " ");
    return new Date(isoStr).toISOString().slice(0, 19).replace("T", " ");
  } catch (e) {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }
}

// === AUTO-MIGRATION FROM users.json ===
async function migrateFromJson() {
  var usersFile = path.join(__dirname, "users.json");
  if (!fs.existsSync(usersFile)) return;

  // Check if users table is empty
  var [rows] = await pool.execute("SELECT COUNT(*) as cnt FROM users");
  if (rows[0].cnt > 0) {
    console.log("[MIGRATE] users table already has data, skipping migration");
    return;
  }

  console.log("[MIGRATE] Found users.json, migrating to MariaDB...");
  var data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
  var count = 0;

  for (var uid in data.users) {
    var u = data.users[uid];
    try {
      await pool.execute(
        "INSERT INTO users (id, api_key, name, email, plan, active, payment_source, payment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [uid, u.apiKey, u.name || "", u.email || "", u.plan || "pro", u.active !== false ? 1 : 0, u.paymentSource || "manual", u.paymentId || "", toMySQLDate(u.createdAt)]
      );
      count++;

      // Migrate videos.json for this user
      var userDir = path.join(GUIDES_DIR, uid);
      var videosFile = path.join(userDir, "videos.json");
      if (fs.existsSync(videosFile)) {
        try {
          var videos = JSON.parse(fs.readFileSync(videosFile, "utf8"));
          for (var v of videos) {
            await pool.execute(
              "INSERT INTO videos (id, user_id, title, ghl_url, created_at) VALUES (?, ?, ?, ?, ?)",
              [v.id, uid, v.title || "Untitled Video", v.ghlUrl, toMySQLDate(v.savedAt)]
            );
          }
          console.log("[MIGRATE] " + uid + ": " + videos.length + " videos migrated");
        } catch (e) {
          console.log("[MIGRATE] " + uid + ": videos.json parse error, skipping");
        }
      }

      // Migrate guide file metadata
      if (fs.existsSync(userDir)) {
        var files = fs.readdirSync(userDir).filter(function(f) {
          return f.endsWith(".html") && f !== "index.html";
        });
        for (var f of files) {
          var filePath = path.join(userDir, f);
          var stats = fs.statSync(filePath);
          var content = "";
          try { content = fs.readFileSync(filePath, "utf8"); } catch(e) {}
          var titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
          var displayTitle = titleMatch ? titleMatch[1] : f.replace(".html", "").replace(/-/g, " ");
          var stepCount = (content.match(/class="step-card"/g) || content.match(/class="step"/g) || []).length;
          var slug = f.replace(".html", "");

          await pool.execute(
            "INSERT IGNORE INTO guides (user_id, slug, title, file_name, file_size, step_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [uid, slug, displayTitle, f, stats.size, stepCount, toMySQLDate(stats.mtime.toISOString())]
          );
        }
        console.log("[MIGRATE] " + uid + ": " + files.length + " guides migrated");
      }
    } catch (e) {
      console.error("[MIGRATE] Error migrating " + uid + ":", e.message);
    }
  }

  console.log("[MIGRATE] Migrated " + count + " users to MariaDB");

  // Rename old file as backup
  fs.renameSync(usersFile, usersFile + ".migrated");
  console.log("[MIGRATE] Renamed users.json → users.json.migrated");
}

// === EMAIL SETUP ===
var emailTransporter = null;
function initEmail() {
  if (ghlConfig.webhookUrl) {
    console.log("Email: GHL webhook mode (" + ghlConfig.webhookUrl.substring(0, 50) + "...)");
    return;
  }
  if (!emailConfig.enabled) {
    console.log("Email: DISABLED");
    return;
  }
  var smtpConfig = {
    host: emailConfig.host || "localhost",
    port: emailConfig.port || 587,
    secure: emailConfig.port === 465,
    tls: { rejectUnauthorized: false }
  };
  if (emailConfig.user && emailConfig.pass) {
    smtpConfig.auth = { user: emailConfig.user, pass: emailConfig.pass };
  }
  emailTransporter = nodemailer.createTransport(smtpConfig);
  console.log("Email: ENABLED via " + smtpConfig.host + ":" + smtpConfig.port);
}

async function sendWelcomeEmail(email, name, apiKey, userId) {
  if (!emailTransporter || !email) return;
  var indexUrl = BASE_URL + "/" + userId + "/";
  var fromAddress = emailConfig.from || "StepWise <noreply@app.heychatmate.com>";

  try {
    await emailTransporter.sendMail({
      from: fromAddress,
      to: email,
      subject: "Welcome to StepWise! Here's your API key",
      html: '<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px 20px;">' +
        '<div style="max-width:600px;margin:0 auto;background:#1e293b;border-radius:16px;padding:40px;border:1px solid #334155;">' +
        '<h1 style="color:#f59e0b;margin:0 0 20px;">Welcome to StepWise!</h1>' +
        '<p>Hi ' + (name || 'there').replace(/</g, '&lt;') + ',</p>' +
        '<p>Your account has been created. Here\'s everything you need to get started:</p>' +
        '<div style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:20px;margin:20px 0;">' +
        '<p style="color:#94a3b8;font-size:12px;margin:0 0 8px;">Your API Key</p>' +
        '<p style="font-family:monospace;font-size:14px;color:#f59e0b;word-break:break-all;margin:0;">' + apiKey + '</p>' +
        '</div>' +
        '<div style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:20px;margin:20px 0;">' +
        '<p style="color:#94a3b8;font-size:12px;margin:0 0 8px;">Your Guides Page</p>' +
        '<p style="margin:0;"><a href="' + indexUrl + '" style="color:#f59e0b;">' + indexUrl + '</a></p>' +
        '</div>' +
        '<h3 style="color:#f1f5f9;margin:24px 0 12px;">Quick Start</h3>' +
        '<ol style="color:#94a3b8;line-height:1.8;">' +
        '<li>Install the StepWise Chrome extension</li>' +
        '<li>Click the StepWise icon → Settings → paste your API key</li>' +
        '<li>Start recording your first workflow!</li>' +
        '</ol>' +
        '<p style="color:#64748b;font-size:12px;margin-top:30px;">If you have any questions, reply to this email.</p>' +
        '</div></body></html>'
    });
    console.log("[EMAIL] Welcome email sent to " + email);
  } catch (err) {
    console.error("[EMAIL] Failed to send to " + email + ":", err.message);
  }
}

// === GHL WEBHOOK TRIGGER ===
async function triggerGHLWebhook(email, name, apiKey, userId) {
  if (!ghlConfig.webhookUrl) return;
  var indexUrl = BASE_URL + "/" + userId + "/";
  var payload = JSON.stringify({
    email: email,
    name: name || "",
    apiKey: apiKey,
    guidesUrl: indexUrl,
    userId: userId
  });

  try {
    await new Promise(function(resolve, reject) {
      var urlObj = new URL(ghlConfig.webhookUrl);
      var options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      };
      var req = https.request(options, function(res) {
        var body = "";
        res.on("data", function(chunk) { body += chunk; });
        res.on("end", function() {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error("GHL responded with " + res.statusCode + ": " + body));
          }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    console.log("[GHL] Webhook triggered for " + email);
  } catch (err) {
    console.error("[GHL] Failed to trigger webhook for " + email + ":", err.message);
  }
}

// === DATABASE HELPER FUNCTIONS ===

// Authenticate by API key — returns { userId, user } or null
async function authenticateUser(req) {
  var auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) return null;
  var apiKey = auth.replace("Bearer ", "");

  // Check if it's the admin key
  if (apiKey === config.secret) {
    return { userId: "_admin", user: { name: "Admin", isAdmin: true } };
  }

  // Look up in database
  try {
    var [rows] = await pool.execute(
      "SELECT id, api_key, name, email, plan, active, payment_source, created_at FROM users WHERE api_key = ? AND active = 1",
      [apiKey]
    );
    if (rows.length === 0) return null;
    var u = rows[0];
    return {
      userId: u.id,
      user: {
        name: u.name,
        email: u.email,
        plan: u.plan,
        apiKey: u.api_key,
        active: true,
        paymentSource: u.payment_source,
        createdAt: u.created_at
      }
    };
  } catch (err) {
    console.error("[AUTH] DB error:", err.message);
    return null;
  }
}

// Get user by email
async function getUserByEmail(email) {
  var [rows] = await pool.execute("SELECT * FROM users WHERE email = ?", [email]);
  return rows.length > 0 ? rows[0] : null;
}

// Get guides for a user from database
async function getUserGuides(userId) {
  var [rows] = await pool.execute(
    "SELECT slug, title, file_name, file_size, step_count, created_at FROM guides WHERE user_id = ? ORDER BY created_at DESC",
    [userId]
  );
  return rows;
}

// Get videos for a user from database
async function getUserVideos(userId) {
  var [rows] = await pool.execute(
    "SELECT id, title, ghl_url, created_at FROM videos WHERE user_id = ? ORDER BY created_at DESC",
    [userId]
  );
  return rows;
}

// Log webhook event
async function logWebhook(source, eventType, email, payload, result) {
  try {
    var payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (payloadStr.length > 10000) payloadStr = payloadStr.substring(0, 10000) + "...(truncated)";
    await pool.execute(
      "INSERT INTO webhook_logs (source, event_type, email, payload, result) VALUES (?, ?, ?, ?, ?)",
      [source, eventType, email || "", payloadStr, result || ""]
    );
  } catch (err) {
    console.error("[WEBHOOK LOG] DB error:", err.message);
  }
}

// === SHARED ACCOUNT CREATION (for payment webhooks) ===
async function createAccountFromWebhook(source, email, name, transactionId) {
  // Check if email already exists
  var existing = await getUserByEmail(email);

  if (existing) {
    if (existing.active) {
      // Already exists and active — idempotent
      console.log("[WEBHOOK] " + source + ": User " + email + " already exists and active");
      return { userId: existing.id, apiKey: existing.api_key, isNew: false };
    } else {
      // Reactivate
      await pool.execute("UPDATE users SET active = 1, payment_source = ?, payment_id = ?, updated_at = NOW() WHERE id = ?",
        [source, transactionId || "", existing.id]);
      console.log("[WEBHOOK] " + source + ": Reactivated user " + existing.id + " (" + email + ")");

      // Rebuild their index
      rebuildUserIndex(existing.id);

      return { userId: existing.id, apiKey: existing.api_key, isNew: false, reactivated: true };
    }
  }

  // Create new user
  var userId = "user_" + crypto.randomBytes(4).toString("hex");
  var apiKey = "sk_live_" + crypto.randomBytes(24).toString("hex");

  await pool.execute(
    "INSERT INTO users (id, api_key, name, email, plan, active, payment_source, payment_id) VALUES (?, ?, ?, ?, 'pro', 1, ?, ?)",
    [userId, apiKey, name || email.split("@")[0], email, source, transactionId || ""]
  );

  // Create user's guides directory
  var userDir = path.join(GUIDES_DIR, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  // Build their initial index
  rebuildUserIndex(userId);

  console.log("[WEBHOOK] " + source + ": Created new user " + userId + " (" + email + ")");

  // Send welcome email (GHL webhook preferred, SMTP fallback)
  if (ghlConfig.webhookUrl) {
    await triggerGHLWebhook(email, name || email.split("@")[0], apiKey, userId);
  } else {
    await sendWelcomeEmail(email, name || email.split("@")[0], apiKey, userId);
  }

  return { userId: userId, apiKey: apiKey, isNew: true };
}

// Deactivate user by email
async function deactivateByEmail(email, source) {
  var user = await getUserByEmail(email);
  if (!user) return false;
  await pool.execute("UPDATE users SET active = 0, updated_at = NOW() WHERE id = ?", [user.id]);
  console.log("[WEBHOOK] " + source + ": Deactivated user " + user.id + " (" + email + ")");
  return true;
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
async function rebuildUserIndex(userId) {
  var userDir = path.join(GUIDES_DIR, userId);
  if (!fs.existsSync(userDir)) return;

  // Look up user's name from database
  var userName = "";
  try {
    var [rows] = await pool.execute("SELECT name FROM users WHERE id = ?", [userId]);
    if (rows.length > 0) userName = rows[0].name;
  } catch (e) {}

  // Get guides from database
  var guides = await getUserGuides(userId);

  // Get videos from database
  var videos = await getUserVideos(userId);

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
      var dateStr = new Date(g.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
      var sizeKB = Math.round((g.file_size || 0) / 1024);
      html += '<div class="guide-row">\n' +
        '<a class="guide-card" href="' + g.file_name + '">\n' +
        '  <div class="guide-title">' + (g.title || "").replace(/</g, "&lt;") + '</div>\n' +
        '  <div class="guide-meta">\n' +
        '    <i>&#x1F4C5; ' + dateStr + '</i>\n' +
        (g.step_count > 0 ? '    <i>&#x1F4CB; ' + g.step_count + ' steps</i>\n' : '') +
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
        var dateStr = new Date(v.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
        html += '<div class="guide-row">\n' +
          '<a class="video-card" href="' + (v.ghl_url || "").replace(/"/g, '&quot;') + '" target="_blank">\n' +
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
    '    fetch(apiUrl + "/list", { headers: { "Authorization": "Bearer " + secretKey } })\n' +
    '      .then(function(r) { return r.json(); })\n' +
    '      .then(function(d) {\n' +
    '        if (d.success) {\n' +
    '          managing = true;\n' +
    '          container.classList.add("managing");\n' +
    '          btn.textContent = "Done";\n' +
    '          btn.classList.add("active");\n' +
    '          showToast("Manage mode ON \\u2014 click the red buttons to delete");\n' +
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

// Read full request body as string
function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on("data", function(chunk) { chunks.push(chunk); });
    req.on("end", function() { resolve(Buffer.concat(chunks).toString()); });
    req.on("error", reject);
  });
}

// Read full request body as raw Buffer
function readRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on("data", function(chunk) { chunks.push(chunk); });
    req.on("end", function() { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

// Parse URL-encoded form body
function parseFormBody(bodyStr) {
  var params = {};
  bodyStr.split("&").forEach(function(pair) {
    var parts = pair.split("=");
    if (parts.length === 2) {
      params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1].replace(/\+/g, " "));
    }
  });
  return params;
}

// CORS headers
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// === WEBHOOK SIGNATURE VERIFICATION ===

function verifyWhopSignature(body, signature) {
  if (!webhookConfig.whop || !webhookConfig.whop.secret) return false;
  if (!signature) return false;
  var hmac = crypto.createHmac("sha256", webhookConfig.whop.secret);
  hmac.update(body);
  var expected = hmac.digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) { return false; }
}

function verifyWarriorPlusSignature(params, bodyStr) {
  if (!webhookConfig.warriorplus || !webhookConfig.warriorplus.secret) return false;
  var securityKey = webhookConfig.warriorplus.secret;
  var sig = params.WSO_SIGNATURE || "";
  // WarriorPlus HMAC-SHA1: hash the full body with the security key
  var hmac = crypto.createHmac("sha1", securityKey);
  hmac.update(bodyStr);
  var expected = hmac.digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (e) { return false; }
}

function verifyJVZooSignature(params) {
  if (!webhookConfig.jvzoo || !webhookConfig.jvzoo.secret) return false;
  var secretKey = webhookConfig.jvzoo.secret;
  var cverify = params.cverify || "";
  // JVZoo: SHA1 hash of secret + "|" + price + "|" + quantity + "|" + product_id
  var hashInput = secretKey + "|" + (params.cprice || "") + "|" + (params.cqty || "1") + "|" + (params.cproditem || "");
  var expected = crypto.createHash("sha1").update(hashInput).digest("hex").substring(0, 8).toUpperCase();
  return cverify.toUpperCase() === expected;
}

// ==========================================
// === HTTP SERVER ===
// ==========================================

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
    var dbOk = false;
    try {
      var conn = await pool.getConnection();
      conn.release();
      dbOk = true;
    } catch (e) {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "stepwise-publish", database: dbOk ? "connected" : "error" }));
    return;
  }

  // === ME: Get current user info from API key ===
  if (req.method === "GET" && req.url === "/me") {
    var authResult = await authenticateUser(req);
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

      await pool.execute(
        "INSERT INTO users (id, api_key, name, email, plan, active, payment_source) VALUES (?, ?, ?, ?, 'pro', 1, 'manual')",
        [userId, apiKey, data.name, data.email || ""]
      );

      // Create user's guides directory
      var userDir = path.join(GUIDES_DIR, userId);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      // Build their initial (empty) index
      await rebuildUserIndex(userId);

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
      var authResult = await authenticateUser(req);
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

      // Extract step count from HTML
      var stepCount = (data.html.match(/class="step-card"/g) || data.html.match(/class="step"/g) || []).length;

      // Upsert guide in database
      await pool.execute(
        "INSERT INTO guides (user_id, slug, title, file_name, file_size, step_count) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = VALUES(title), file_name = VALUES(file_name), file_size = VALUES(file_size), step_count = VALUES(step_count)",
        [userId, slug, data.title, fileName, data.html.length, stepCount]
      );

      // Rebuild this user's index page
      await rebuildUserIndex(userId);

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
    var authResult = await authenticateUser(req);
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

    // Remove from database
    await pool.execute("DELETE FROM guides WHERE user_id = ? AND slug = ?", [userId, slugToDelete]);

    console.log("[DELETE] " + userId + "/" + slugToDelete + ".html");

    // Rebuild this user's index page
    await rebuildUserIndex(userId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // === SAVE VIDEO: Store a video GHL link (user-scoped) ===
  if (req.method === "POST" && req.url === "/save-video") {
    try {
      var authResult = await authenticateUser(req);
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

      var videoId = "vid_" + Date.now();

      await pool.execute(
        "INSERT INTO videos (id, user_id, title, ghl_url) VALUES (?, ?, ?, ?)",
        [videoId, userId, data.title || "Untitled Video", data.ghlUrl]
      );

      await rebuildUserIndex(userId);

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
    var authResult = await authenticateUser(req);
    if (!authResult) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
      return;
    }

    var userId = authResult.userId;
    var videoId = req.url.replace("/delete-video/", "");

    var [result] = await pool.execute("DELETE FROM videos WHERE id = ? AND user_id = ?", [videoId, userId]);

    if (result.affectedRows === 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Video not found" }));
      return;
    }

    console.log("[VIDEO] " + userId + " deleted video: " + videoId);

    await rebuildUserIndex(userId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // === LIST: Show user's published guides (user-scoped) ===
  if (req.method === "GET" && req.url === "/list") {
    var authResult = await authenticateUser(req);
    if (!authResult) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
      return;
    }

    var userId = authResult.userId;
    var guides = await getUserGuides(userId);

    var guideList = guides.map(function(g) {
      return {
        fileName: g.file_name,
        slug: g.slug,
        url: BASE_URL + "/" + userId + "/" + g.file_name,
        size: g.file_size,
        publishedAt: g.created_at
      };
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, guides: guideList }));
    return;
  }

  // ==========================================
  // === PAYMENT WEBHOOKS ===
  // ==========================================

  // === WHOP WEBHOOK ===
  if (req.method === "POST" && req.url === "/webhooks/whop") {
    try {
      var bodyStr = await readBody(req);
      var signature = req.headers["whop-signature"] || req.headers["x-whop-signature"] || "";

      // Verify signature if configured
      if (webhookConfig.whop && webhookConfig.whop.secret) {
        if (!verifyWhopSignature(bodyStr, signature)) {
          console.log("[WHOP] Invalid signature, rejecting");
          await logWebhook("whop", "INVALID_SIGNATURE", "", bodyStr, "Rejected: invalid signature");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Invalid signature" }));
          return;
        }
      }

      var payload = JSON.parse(bodyStr);
      var event = payload.event || payload.action || "";
      var email = "";
      var name = "";
      var transactionId = "";

      // Extract email from Whop payload
      if (payload.data && payload.data.user) {
        email = payload.data.user.email || "";
        name = payload.data.user.username || payload.data.user.name || "";
      }
      if (payload.data && payload.data.id) transactionId = payload.data.id;

      console.log("[WHOP] Event: " + event + ", Email: " + email);

      if (event === "payment.succeeded" || event === "membership.went_valid") {
        if (email) {
          var result = await createAccountFromWebhook("whop", email, name, transactionId);
          await logWebhook("whop", event, email, bodyStr, "Created/found user: " + result.userId + " (isNew: " + result.isNew + ")");
        } else {
          await logWebhook("whop", event, "", bodyStr, "No email in payload");
        }
      } else if (event === "membership.deactivated" || event === "membership.went_invalid") {
        if (email) {
          await deactivateByEmail(email, "whop");
          await logWebhook("whop", event, email, bodyStr, "Deactivated");
        }
      } else {
        await logWebhook("whop", event || "unknown", email, bodyStr, "Ignored event type");
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.error("[WHOP] Error:", err.message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // === WARRIORPLUS WEBHOOK ===
  if (req.method === "POST" && req.url === "/webhooks/warriorplus") {
    try {
      var bodyStr = await readBody(req);
      var params = parseFormBody(bodyStr);

      // Verify signature if configured
      if (webhookConfig.warriorplus && webhookConfig.warriorplus.secret) {
        if (!verifyWarriorPlusSignature(params, bodyStr)) {
          console.log("[WARRIORPLUS] Invalid signature, rejecting");
          await logWebhook("warriorplus", "INVALID_SIGNATURE", "", bodyStr, "Rejected: invalid signature");
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("OK");
          return;
        }
      }

      var action = params.WSO_SALE_ACTION || "";
      var email = params.WSO_CUSTOMER_EMAIL || "";
      var name = params.WSO_CUSTOMER_NAME || "";
      var transactionId = params.WSO_TRANSACTION_ID || "";

      console.log("[WARRIORPLUS] Action: " + action + ", Email: " + email);

      if (action === "SALE") {
        if (email) {
          var result = await createAccountFromWebhook("warriorplus", email, name, transactionId);
          await logWebhook("warriorplus", action, email, bodyStr, "Created/found user: " + result.userId);
        }
      } else if (action === "REFUNDED" || action === "REVERSED") {
        if (email) {
          await deactivateByEmail(email, "warriorplus");
          await logWebhook("warriorplus", action, email, bodyStr, "Deactivated");
        }
      } else {
        await logWebhook("warriorplus", action || "unknown", email, bodyStr, "Ignored action");
      }

      // WarriorPlus expects plain text OK
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    } catch (err) {
      console.error("[WARRIORPLUS] Error:", err.message);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    }
    return;
  }

  // === JVZOO WEBHOOK ===
  if (req.method === "POST" && req.url === "/webhooks/jvzoo") {
    try {
      var bodyStr = await readBody(req);
      var params = parseFormBody(bodyStr);

      // Verify signature if configured
      if (webhookConfig.jvzoo && webhookConfig.jvzoo.secret) {
        if (!verifyJVZooSignature(params)) {
          console.log("[JVZOO] Invalid signature, rejecting");
          await logWebhook("jvzoo", "INVALID_SIGNATURE", "", bodyStr, "Rejected: invalid signature");
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("OK");
          return;
        }
      }

      var txnType = params.ctransaction || "";
      var email = params.ccustemail || "";
      var name = params.ccustname || "";
      var transactionId = params.ctransreceipt || "";

      console.log("[JVZOO] Transaction: " + txnType + ", Email: " + email);

      if (txnType === "SALE") {
        if (email) {
          var result = await createAccountFromWebhook("jvzoo", email, name, transactionId);
          await logWebhook("jvzoo", txnType, email, bodyStr, "Created/found user: " + result.userId);
        }
      } else if (txnType === "RFND" || txnType === "CGBK" || txnType === "CANCEL-REBILL") {
        if (email) {
          await deactivateByEmail(email, "jvzoo");
          await logWebhook("jvzoo", txnType, email, bodyStr, "Deactivated");
        }
      } else {
        await logWebhook("jvzoo", txnType || "unknown", email, bodyStr, "Ignored transaction type");
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    } catch (err) {
      console.error("[JVZOO] Error:", err.message);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    }
    return;
  }

  // ==========================================
  // === ADMIN ENDPOINTS ===
  // ==========================================

  // === ADMIN: List all users ===
  if (req.method === "GET" && req.url === "/admin/users") {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    try {
      var [users] = await pool.execute(
        "SELECT u.id, u.api_key, u.name, u.email, u.plan, u.active, u.payment_source, u.payment_id, u.created_at, " +
        "(SELECT COUNT(*) FROM guides g WHERE g.user_id = u.id) as guide_count " +
        "FROM users u ORDER BY u.created_at DESC"
      );

      var userList = users.map(function(u) {
        return {
          userId: u.id,
          name: u.name,
          email: u.email,
          apiKey: u.api_key,
          active: u.active === 1,
          plan: u.plan,
          paymentSource: u.payment_source,
          paymentId: u.payment_id,
          guideCount: u.guide_count,
          createdAt: u.created_at
        };
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, users: userList }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // === ADMIN: Deactivate a user ===
  if (req.method === "DELETE" && req.url.startsWith("/admin/users/")) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    var targetUserId = req.url.replace("/admin/users/", "");

    var [result] = await pool.execute("UPDATE users SET active = 0 WHERE id = ?", [targetUserId]);
    if (result.affectedRows === 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "User not found" }));
      return;
    }

    console.log("[ADMIN] Deactivated user: " + targetUserId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "User deactivated" }));
    return;
  }

  // === ADMIN: Reactivate a user ===
  if (req.method === "PUT" && req.url.startsWith("/admin/users/")) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    var targetUserId = req.url.replace("/admin/users/", "");

    var [result] = await pool.execute("UPDATE users SET active = 1 WHERE id = ?", [targetUserId]);
    if (result.affectedRows === 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "User not found" }));
      return;
    }

    console.log("[ADMIN] Reactivated user: " + targetUserId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "User reactivated" }));
    return;
  }

  // === ADMIN: Test webhook (simulate payment) ===
  if (req.method === "POST" && req.url === "/admin/test-webhook") {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    try {
      var body = await readBody(req);
      var data = JSON.parse(body);
      var email = data.email;
      var name = data.name || "";
      var source = data.source || "test";

      if (!email) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Email is required" }));
        return;
      }

      var result = await createAccountFromWebhook(source, email, name, "test_" + Date.now());
      await logWebhook(source, "TEST_SALE", email, body, "Test: " + result.userId + " (isNew: " + result.isNew + ")");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        userId: result.userId,
        apiKey: result.apiKey,
        isNew: result.isNew,
        indexUrl: BASE_URL + "/" + result.userId + "/"
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // === ADMIN: Webhook logs ===
  if (req.method === "GET" && req.url.startsWith("/admin/webhook-logs")) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    try {
      var [logs] = await pool.execute(
        "SELECT id, source, event_type, email, result, created_at FROM webhook_logs ORDER BY created_at DESC LIMIT 100"
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, logs: logs }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // === ADMIN: Stats ===
  if (req.method === "GET" && req.url === "/admin/stats") {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + config.secret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Admin only" }));
      return;
    }

    try {
      var [totalUsers] = await pool.execute("SELECT COUNT(*) as cnt FROM users");
      var [activeUsers] = await pool.execute("SELECT COUNT(*) as cnt FROM users WHERE active = 1");
      var [totalGuides] = await pool.execute("SELECT COUNT(*) as cnt FROM guides");
      var [totalVideos] = await pool.execute("SELECT COUNT(*) as cnt FROM videos");
      var [bySource] = await pool.execute("SELECT payment_source, COUNT(*) as cnt FROM users GROUP BY payment_source");

      var sourceBreakdown = {};
      bySource.forEach(function(r) { sourceBreakdown[r.payment_source] = r.cnt; });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        stats: {
          totalUsers: totalUsers[0].cnt,
          activeUsers: activeUsers[0].cnt,
          totalGuides: totalGuides[0].cnt,
          totalVideos: totalVideos[0].cnt,
          bySource: sourceBreakdown
        }
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ==========================================
  // === OPENAI PROXY ENDPOINTS ===
  // ==========================================

  // === OPENAI PROXY: Whisper Transcription ===
  if (req.method === "POST" && req.url === "/api/transcribe") {
    if (!OPENAI_API_KEY) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "AI proxy not configured" }));
      return;
    }
    var authResult = await authenticateUser(req);
    if (!authResult) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
      return;
    }
    if (!checkRateLimit(authResult.userId, "transcribe", 20)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Rate limit exceeded. Max 20 transcriptions per hour." }));
      return;
    }
    try {
      var rawBody = await readRawBody(req);
      var contentType = req.headers["content-type"] || "";
      var openaiRes = await new Promise(function(resolve, reject) {
        var openaiReq = https.request({
          hostname: "api.openai.com",
          path: "/v1/audio/transcriptions",
          method: "POST",
          headers: {
            "Authorization": "Bearer " + OPENAI_API_KEY,
            "Content-Type": contentType,
            "Content-Length": rawBody.length
          }
        }, function(r) {
          var chunks = [];
          r.on("data", function(c) { chunks.push(c); });
          r.on("end", function() { resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }); });
        });
        openaiReq.on("error", reject);
        openaiReq.write(rawBody);
        openaiReq.end();
      });
      res.writeHead(openaiRes.status, { "Content-Type": "application/json" });
      res.end(openaiRes.body);
    } catch (err) {
      console.log("[PROXY] Transcribe error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Transcription proxy failed: " + err.message }));
    }
    return;
  }

  // === OPENAI PROXY: Text-to-Speech ===
  if (req.method === "POST" && req.url === "/api/tts") {
    if (!OPENAI_API_KEY) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "AI proxy not configured" }));
      return;
    }
    var authResult = await authenticateUser(req);
    if (!authResult) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid API key" }));
      return;
    }
    if (!checkRateLimit(authResult.userId, "tts", 30)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Rate limit exceeded. Max 30 TTS requests per hour." }));
      return;
    }
    try {
      var body = await readBody(req);
      var data = JSON.parse(body);
      var ttsPayload = JSON.stringify({
        model: "tts-1",
        input: (data.text || "").trim(),
        voice: data.voice || "nova",
        response_format: "mp3"
      });
      var openaiRes = await new Promise(function(resolve, reject) {
        var openaiReq = https.request({
          hostname: "api.openai.com",
          path: "/v1/audio/speech",
          method: "POST",
          headers: {
            "Authorization": "Bearer " + OPENAI_API_KEY,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(ttsPayload)
          }
        }, function(r) {
          var chunks = [];
          r.on("data", function(c) { chunks.push(c); });
          r.on("end", function() {
            var buf = Buffer.concat(chunks);
            if (r.statusCode === 200) {
              resolve({ status: 200, body: JSON.stringify({ success: true, audioBase64: buf.toString("base64") }) });
            } else {
              resolve({ status: r.statusCode, body: buf.toString() });
            }
          });
        });
        openaiReq.on("error", reject);
        openaiReq.write(ttsPayload);
        openaiReq.end();
      });
      res.writeHead(openaiRes.status, { "Content-Type": "application/json" });
      res.end(openaiRes.body);
    } catch (err) {
      console.log("[PROXY] TTS error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "TTS proxy failed: " + err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ==========================================
// === STARTUP ===
// ==========================================

async function startServer() {
  await initDatabase();
  initEmail();

  server.listen(PORT, "0.0.0.0", function() {
    console.log("StepWise Publish API running on port " + PORT);
    console.log("Guides folder: " + GUIDES_DIR);
    console.log("Public URL: " + BASE_URL);
    console.log("Webhook endpoints:");
    console.log("  Whop:        POST /webhooks/whop");
    console.log("  WarriorPlus: POST /webhooks/warriorplus");
    console.log("  JVZoo:       POST /webhooks/jvzoo");
  });
}

startServer().catch(function(err) {
  console.error("FATAL: Failed to start server:", err.message);
  process.exit(1);
});
