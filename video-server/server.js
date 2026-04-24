// ============================================================
// StepWise Video Generator API
// Receives screenshots + text → generates MP4 video
// Runs on port 3500
// ============================================================

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { uploadToGHL } = require("./ghl-uploader");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync, spawn } = require("child_process");

const app = express();
const PORT = 3500;

// Allow large payloads (screenshots are big)
app.use(express.json({ limit: "200mb" }));
app.use(cors());

// Jobs storage (in memory)
const jobs = {};

// Temp directory for video processing (inside project folder, survives reboots)
const TEMP_DIR = "/opt/stepwise-video/data";
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Load server secret from environment or config (kept for admin use only)
// const SERVER_SECRET = process.env.STEPWISE_SECRET || "";

// Rate limiting: max 5 videos per hour per IP
const rateLimits = {};
function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimits[ip]) rateLimits[ip] = [];
  // Remove entries older than 1 hour
  rateLimits[ip] = rateLimits[ip].filter(t => now - t < 3600000);
  if (rateLimits[ip].length >= 5) return false;
  rateLimits[ip].push(now);
  return true;
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "StepWise Video Generator", version: "1.0.0" });
});

// ============================================================
// GENERATE VIDEO
// ============================================================
app.post("/generate-video", async (req, res) => {
  try {
    const { projectTitle, projectDescription, steps, voice, apiKey } = req.body;

    // --- Auth: Must have an OpenAI API key ---
    if (!apiKey || apiKey.length < 10) {
      return res.status(403).json({ error: "Valid OpenAI API key required. Add your key in StepWise Settings." });
    }

    // --- Rate limit by IP ---
    const clientIP = req.headers["x-forwarded-for"] || req.connection.remoteAddress || "unknown";
    if (!checkRateLimit(clientIP)) {
      return res.status(429).json({ error: "Rate limit: max 5 videos per hour. Try again later." });
    }

    // --- Validation ---
    if (!steps || !steps.length) return res.status(400).json({ error: "No steps provided" });

    // --- Create job ---
    const jobId = uuidv4();
    const jobDir = path.join(TEMP_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    jobs[jobId] = {
      status: "processing",
      progress: 0,
      totalSteps: steps.length,
      currentStep: 0,
      message: "Starting...",
      createdAt: Date.now()
    };

    // Send jobId back immediately so extension can poll progress
    res.json({ jobId });

    // --- Process in background ---
    processVideo(jobId, jobDir, projectTitle, projectDescription, steps, voice || "nova", apiKey);

  } catch (err) {
    console.error("Generate error:", err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// ============================================================
// CHECK PROGRESS
// ============================================================
app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ============================================================
// DOWNLOAD VIDEO
// ============================================================
app.get("/download/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done") return res.status(400).json({ error: "Video not ready yet" });

  const filePath = job.filePath;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  res.download(filePath, job.fileName, (err) => {
    if (err) console.error("Download error:", err);
    // Files stay for 24 hours, cleaned up by the scheduled cleanup
  });
});

// ============================================================
// VIDEO PROCESSING PIPELINE
// ============================================================
async function processVideo(jobId, jobDir, title, description, steps, voice, apiKey) {
  try {
    const clipPaths = [];

    // --- Step 0: Create title card ---
    updateJob(jobId, 0, "Creating title card...");
    const titleClipPath = await createTitleCard(jobDir, title || "StepWise Documentation", description || "");
    clipPaths.push(titleClipPath);

    // --- Step 1-N: Process each step ---
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 1;

      updateJob(jobId, stepNum, "Step " + stepNum + " of " + steps.length + ": Generating voice...");

      // Save screenshot
      const imgPath = path.join(jobDir, "step_" + stepNum + ".png");
      const imgData = step.screenshot.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(imgPath, Buffer.from(imgData, "base64"));

      // Generate TTS audio
      const audioPath = path.join(jobDir, "step_" + stepNum + ".mp3");
      const textToSpeak = step.description || step.title || ("Step " + stepNum);
      await generateTTS(apiKey, textToSpeak, voice, audioPath);

      updateJob(jobId, stepNum, "Step " + stepNum + " of " + steps.length + ": Creating video clip...");

      // Get audio duration
      const duration = getAudioDuration(audioPath);

      // Create video clip for this step
      const clipPath = path.join(jobDir, "clip_" + stepNum + ".mp4");
      await createStepClip(imgPath, audioPath, clipPath, stepNum, step.title || ("Step " + stepNum), textToSpeak, duration);
      clipPaths.push(clipPath);
    }

    // --- Final: Concatenate all clips ---
    updateJob(jobId, steps.length, "Stitching video together...");

    const concatListPath = path.join(jobDir, "concat.txt");
    const concatContent = clipPaths.map(p => "file '" + p + "'").join("\n");
    fs.writeFileSync(concatListPath, concatContent);

    const outputPath = path.join(jobDir, "output.mp4");
    await runFFmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart",
      outputPath
    ]);

    // Safe filename from title
    const safeTitle = (title || "stepwise-video").replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-").substring(0, 50);
    const fileName = safeTitle + ".mp4";

    jobs[jobId] = {
      status: "done",
      progress: 100,
      totalSteps: steps.length,
      currentStep: steps.length,
      message: "Video ready!",
      filePath: outputPath,
      fileName: fileName,
      createdAt: jobs[jobId].createdAt
    };

    console.log("Video done: " + jobId);

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
      });

  } catch (err) {
    console.error("Processing error for job " + jobId + ":", err);
    jobs[jobId] = {
      ...jobs[jobId],
      status: "error",
      message: "Failed: " + err.message
    };
  }
}

// ============================================================
// TITLE CARD (3 seconds, dark background with text)
// ============================================================
async function createTitleCard(jobDir, title, description) {
  const clipPath = path.join(jobDir, "title_card.mp4");
  const duration = 3;

  // Escape special characters for FFmpeg drawtext
  const safeTitle = escapeFFmpegText(title);
  const safeDesc = escapeFFmpegText(description);

  // Build filter: dark background + centered title + description below
  let filter = "color=c=#1E293B:s=1920x1080:d=" + duration;
  filter += ",drawtext=text='" + safeTitle + "':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-40:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  if (description) {
    filter += ",drawtext=text='" + safeDesc + "':fontsize=28:fontcolor=#94a3b8:x=(w-text_w)/2:y=(h-text_h)/2+40:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  }

  // Generate silent audio track (needed for concat to work)
  await runFFmpeg([
    "-f", "lavfi", "-i", filter,
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-t", String(duration),
    "-shortest",
    clipPath
  ]);

  return clipPath;
}

// ============================================================
// STEP CLIP (screenshot + audio + overlays)
// ============================================================
async function createStepClip(imgPath, audioPath, clipPath, stepNum, stepTitle, description, duration) {
  // Escape text for FFmpeg
  const safeStepLabel = escapeFFmpegText("Step " + stepNum);
  const safeDesc = escapeFFmpegText(truncateText(description, 80));

  // Video filter:
  // 1. Scale image to fit 1920x1080 (keep aspect ratio, pad with dark bg)
  // 2. Step number badge in top-left
  // 3. Subtitle bar at bottom
  let vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#1E293B,format=yuv420p";

  // Step number overlay (top-left badge)
  vf += ",drawtext=text='" + safeStepLabel + "':fontsize=32:fontcolor=white:x=30:y=25:box=1:boxcolor=#2563EB@0.85:boxborderw=12:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  // Subtitle bar at bottom
  vf += ",drawtext=text='" + safeDesc + "':fontsize=26:fontcolor=white:x=(w-text_w)/2:y=h-65:box=1:boxcolor=black@0.65:boxborderw=14:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

  await runFFmpeg([
    "-loop", "1",
    "-i", imgPath,
    "-i", audioPath,
    "-c:v", "libx264", "-preset", "fast", "-tune", "stillimage",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-vf", vf,
    "-t", String(duration + 0.5), // Add 0.5s padding after audio ends
    "-pix_fmt", "yuv420p",
    clipPath
  ]);

  return clipPath;
}

// ============================================================
// OPENAI TTS
// ============================================================
function generateTTS(apiKey, text, voice, outputPath) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: "tts-1",
      input: text,
      voice: voice,
      response_format: "mp3"
    });

    const options = {
      hostname: "api.openai.com",
      path: "/v1/audio/speech",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => reject(new Error("TTS API error " + res.statusCode + ": " + body)));
        return;
      }

      const fileStream = fs.createWriteStream(outputPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => {
        fileStream.close();
        resolve(outputPath);
      });
      fileStream.on("error", reject);
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ============================================================
// HELPERS
// ============================================================

function getAudioDuration(audioPath) {
  try {
    const result = execSync(
      'ffprobe -v quiet -show_entries format=duration -of csv=p=0 "' + audioPath + '"',
      { encoding: "utf8" }
    );
    return parseFloat(result.trim()) || 3;
  } catch (e) {
    return 3; // default 3 seconds if probe fails
  }
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args]);
    let stderr = "";

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg exited with code " + code + ": " + stderr.slice(-500)));
    });

    proc.on("error", reject);
  });
}

function escapeFFmpegText(text) {
  if (!text) return "";
  // Escape characters that FFmpeg drawtext treats as special
  return text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "\u2019")  // Replace apostrophe with unicode right single quote
    .replace(/:/g, "\\\\:")
    .replace(/%/g, "%%")
    .replace(/\n/g, " ");
}

function truncateText(text, maxLen) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + "...";
}

function updateJob(jobId, currentStep, message) {
  if (jobs[jobId]) {
    jobs[jobId].currentStep = currentStep;
    jobs[jobId].progress = Math.round((currentStep / jobs[jobId].totalSteps) * 90); // reserve 10% for final concat
    jobs[jobId].message = message;
  }
}

function cleanupJob(jobId) {
  const job = jobs[jobId];
  if (job && job.filePath) {
    const jobDir = path.dirname(job.filePath);
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Cleanup error:", e.message);
    }
  }
  delete jobs[jobId];
}

// Clean up old jobs every 30 minutes (memory-based)
setInterval(() => {
  const now = Date.now();
  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    if (now - job.createdAt > 86400000) { // 24 hours old
      cleanupJob(jobId);
    }
  }
}, 1800000);

// Clean up old folders on disk (survives reboots)
// This runs on startup AND every hour
function cleanupOldFolders() {
  try {
    const folders = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const folder of folders) {
      const folderPath = path.join(TEMP_DIR, folder);
      try {
        const stat = fs.statSync(folderPath);
        if (stat.isDirectory() && (now - stat.mtimeMs > 86400000)) { // older than 24 hours
          fs.rmSync(folderPath, { recursive: true, force: true });
          console.log("Cleaned up old folder: " + folder);
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }
}

// Run cleanup on startup
cleanupOldFolders();
// Run cleanup every hour
setInterval(cleanupOldFolders, 3600000);

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log("=================================");
  console.log("StepWise Video API running!");
  console.log("Port: " + PORT);
  console.log("URL:  http://109.205.182.135:" + PORT);
  console.log("=================================");
});
