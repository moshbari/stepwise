#!/usr/bin/env node
// =============================================================
// Patches server.js to add GoHighLevel auto-upload support
// v2 — targets exact code patterns in the live server
// =============================================================

const fs = require("fs");
const path = require("path");

const SERVER_PATH = "/opt/stepwise-video/server.js";
const BACKUP_PATH = "/opt/stepwise-video/server.js.backup";

console.log("=== GHL Upload Patch v2 ===\n");

// Step 1: Read
if (!fs.existsSync(SERVER_PATH)) {
  console.error("ERROR: server.js not found at", SERVER_PATH);
  process.exit(1);
}

let code = fs.readFileSync(SERVER_PATH, "utf8");

// Step 2: Backup
fs.writeFileSync(BACKUP_PATH, code);
console.log("✅ Backed up server.js");

// Step 3: Check if already patched
if (code.includes("ghl-uploader")) {
  console.log("⚠️  Already patched! Skipping.");
  process.exit(0);
}

// Step 4: Add require statement at the top
// Find the line with require("uuid") and add after it
const uuidLine = code.indexOf('require("uuid")');
if (uuidLine === -1) {
  console.error("❌ Could not find uuid require. Unexpected server.js format.");
  process.exit(1);
}
const uuidLineEnd = code.indexOf("\n", uuidLine);
code = code.substring(0, uuidLineEnd + 1) +
  'const { uploadToGHL } = require("./ghl-uploader");\n' +
  code.substring(uuidLineEnd + 1);
console.log("✅ Added GHL require statement");

// Step 5: Add GHL upload after video completion
// Target: console.log("Video done: " + jobId);
const TARGET = 'console.log("Video done: " + jobId);';
const targetIdx = code.indexOf(TARGET);

if (targetIdx === -1) {
  console.error("❌ Could not find 'Video done' log line.");
  fs.writeFileSync(SERVER_PATH, fs.readFileSync(BACKUP_PATH, "utf8"));
  console.log("✅ Restored from backup");
  process.exit(1);
}

const insertIdx = targetIdx + TARGET.length;

const ghlCode = `

    // --- Auto-upload to GoHighLevel Media Library ---
    const downloadUrl = "http://109.205.182.135:3500/download/" + jobId;
    uploadToGHL(outputPath, fileName, downloadUrl)
      .then(function(ghlResult) {
        if (ghlResult && ghlResult.success) {
          jobs[jobId].ghlUrl = ghlResult.url;
          jobs[jobId].ghlFileId = ghlResult.fileId;
          console.log("[GHL] Video saved to GHL:", ghlResult.url);
        } else if (ghlResult) {
          jobs[jobId].ghlError = ghlResult.error;
          console.log("[GHL] Upload issue:", ghlResult.error);
        }
      })
      .catch(function(err) {
        console.error("[GHL] Upload error:", err.message);
        jobs[jobId].ghlError = err.message;
      });`;

code = code.substring(0, insertIdx) + ghlCode + code.substring(insertIdx);
console.log("✅ Added GHL upload after video completion");

// Step 6: No need to patch status endpoint!
// Your status endpoint does res.json(job) which returns ALL properties
// So ghlUrl and ghlError will be included automatically
console.log("✅ Status endpoint already returns all job properties (no patch needed)");

// Step 7: Write
fs.writeFileSync(SERVER_PATH, code);
console.log("✅ Patched server.js written");
console.log("\n=== Patch complete! ===\n");
