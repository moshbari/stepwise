const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "ghl-config.json");
let ghlConfig = null;

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log("[GHL] No ghl-config.json found. GHL upload disabled.");
      return false;
    }
    ghlConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    console.log("[GHL] Config loaded. Location:", ghlConfig.locationId);
    console.log("[GHL] Target folder:", ghlConfig.folderName);
    return true;
  } catch (err) {
    console.error("[GHL] Error loading config:", err.message);
    return false;
  }
}

loadConfig();

function curlGHL(method, endpoint, extraArgs) {
  const url = "https://services.leadconnectorhq.com" + endpoint;
  let cmd = 'curl -s -X ' + method + ' "' + url + '"';
  cmd += ' -H "Authorization: Bearer ' + ghlConfig.token + '"';
  cmd += ' -H "Version: 2021-07-28"';
  if (extraArgs) cmd += ' ' + extraArgs;
  console.log("[GHL] curl:", method, endpoint);
  const result = execSync(cmd, { encoding: "utf8", timeout: 60000 });
  try { return JSON.parse(result); } catch(e) { return { raw: result }; }
}

function findFolderId(folderName) {
  try {
    console.log("[GHL] Searching for folder:", folderName);
    const data = curlGHL("GET",
      "/medias/files?altId=" + ghlConfig.locationId + "&altType=location&type=folder&sortBy=createdAt&sortOrder=desc&limit=100"
    );
    const items = data.files || [];
    console.log("[GHL] Found", items.length, "folders");
    for (const item of items) {
      if (item.name === folderName) {
        const fid = item._id || item.id;
        console.log("[GHL] ✅ Matched folder:", folderName, "ID:", fid);
        return fid;
      }
    }
    console.log("[GHL] Folder not found.");
    return null;
  } catch (err) {
    console.error("[GHL] Folder search error:", err.message);
    return null;
  }
}

function uploadFile(filePath, fileName, folderId) {
  console.log("[GHL] Uploading:", fileName, folderId ? "(to folder " + folderId + ")" : "(to root)");
  let formArgs = '-F "file=@' + filePath + ';type=video/mp4"'
    + ' -F "hosted=false"'
    + ' -F "name=' + fileName + '"'
    + ' -F "altId=' + ghlConfig.locationId + '"'
    + ' -F "altType=location"';
  if (folderId) {
    formArgs += ' -F "parentId=' + folderId + '"';
  }
  const data = curlGHL("POST", "/medias/upload-file", formArgs);
  console.log("[GHL] Upload response:", JSON.stringify(data).substring(0, 500));
  return data;
}

async function uploadToGHL(filePath, fileName, downloadUrl) {
  if (!ghlConfig) { console.log("[GHL] Not configured."); return null; }
  try {
    console.log("[GHL] === Starting upload for:", fileName, "===");
    const folderId = findFolderId(ghlConfig.folderName);
    const result = uploadFile(filePath, fileName, folderId);
    const fileId = result.fileId || result.id || null;
    const ghlUrl = result.url || null;
    console.log("[GHL] ✅ Done! File ID:", fileId, "| URL:", ghlUrl, "| Folder:", folderId || "root");
    return { success: true, url: ghlUrl, fileId: fileId, folderId: folderId };
  } catch (err) {
    console.error("[GHL] ❌ Failed:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { uploadToGHL, reloadConfig: loadConfig, findFolderId };
