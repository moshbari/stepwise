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

  // Layout constants. 120px side padding on a 1920px frame leaves 1680px of
  // usable width — generous enough to feel airy without looking empty.
  const FRAME_W = 1920;
  const SIDE_PADDING = 120;
  const MAX_TEXT_W = FRAME_W - (SIDE_PADDING * 2); // 1680

  // Fit the title: word-wrap up to 3 lines, shrink font if still overflowing.
  // Base fontsize 64 for a bolder, more-confident title look.
  const titleFit = wrapTextForDrawtext(
    title || "StepWise Documentation",
    64,
    MAX_TEXT_W,
    { bold: true, maxLines: 3, minFontSize: 36 }
  );

  // Write the text to files and use FFmpeg's `textfile=` option so we never
  // have to escape user-supplied characters inside the filter-graph string.
  // (Inlining `text='...'` with an escape function has historically broken on
  // certain combinations of `'`, `:`, `=` — producing the "Both text and text
  // file provided" error. `textfile=` sidesteps that entire class of bugs.)
  const titlePath = path.join(jobDir, "title_card_title.txt");
  fs.writeFileSync(titlePath, sanitizeForTextfile(titleFit.text));

  let filter = "color=c=#1E293B:s=" + FRAME_W + "x1080:d=" + duration;

  // Title: positioned so its bottom sits 30px above the vertical centre when
  // there's a description (stacked layout), otherwise classic centered.
  // text_h here is per-filter — it measures the title's own rendered height,
  // which may span multiple lines thanks to wrapping above.
  const titleY = description ? "h/2-text_h-30" : "(h-text_h)/2";
  filter += ",drawtext=textfile=" + escapeFilterPath(titlePath) +
    ":fontsize=" + titleFit.fontSize +
    ":fontcolor=white" +
    ":line_spacing=14" +
    ":text_align=C" +  // per-line horizontal centering (FFmpeg 6+)
    ":x=(w-text_w)/2" +
    ":y=" + titleY +
    ":fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  if (description) {
    // Description: smaller, lighter colour, sits 30px below the vertical
    // centre. Wrapped up to 2 lines, shrunk if long.
    const descFit = wrapTextForDrawtext(
      description,
      30,
      MAX_TEXT_W,
      { bold: false, maxLines: 2, minFontSize: 22 }
    );
    const descPath = path.join(jobDir, "title_card_desc.txt");
    fs.writeFileSync(descPath, sanitizeForTextfile(descFit.text));

    filter += ",drawtext=textfile=" + escapeFilterPath(descPath) +
      ":fontsize=" + descFit.fontSize +
      ":fontcolor=#94a3b8" +
      ":line_spacing=10" +
      ":text_align=C" +
      ":x=(w-text_w)/2" +
      ":y=h/2+30" +
      ":fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
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
  const jobDir = path.dirname(clipPath);

  // Fit subtitle inside a bounded width (so the dark box doesn't stretch
  // edge-to-edge), wrapping to 2 lines if needed. Allow up to ~180 chars of
  // narration to appear as subtitle before further shrinking kicks in.
  const SUBTITLE_MAX_W = 1500;   // 210px clear space on each side of a 1920 frame
  const subtitleFit = wrapTextForDrawtext(
    truncateText(description, 180),
    26,
    SUBTITLE_MAX_W,
    { bold: false, maxLines: 2, minFontSize: 20 }
  );

  // Write label + subtitle text to .txt files and feed them to FFmpeg via
  // `textfile=`. This avoids escaping user-supplied content inside the
  // filter-graph string, which is what was producing the
  // "Both text and text file provided" error on arbitrary descriptions.
  const labelPath = path.join(jobDir, "step_" + stepNum + "_label.txt");
  const descPath  = path.join(jobDir, "step_" + stepNum + "_desc.txt");
  fs.writeFileSync(labelPath, sanitizeForTextfile("Step " + stepNum));
  fs.writeFileSync(descPath,  sanitizeForTextfile(subtitleFit.text));

  // Video filter:
  // 1. Scale image to fit 1920x1080 (keep aspect ratio, pad with dark bg)
  // 2. Step number badge in top-left
  // 3. Subtitle bar at bottom
  let vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#1E293B,format=yuv420p";

  // Step number overlay (top-left badge)
  vf += ",drawtext=textfile=" + escapeFilterPath(labelPath) + ":fontsize=32:fontcolor=white:x=30:y=25:box=1:boxcolor=#2563EB@0.85:boxborderw=12:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  // Subtitle bar at bottom — y=h-text_h-50 anchors the bottom of the text
  // 50px from the frame edge regardless of how many lines the subtitle
  // wrapped into, so a 1-line or 2-line subtitle both look properly seated.
  vf += ",drawtext=textfile=" + escapeFilterPath(descPath) +
    ":fontsize=" + subtitleFit.fontSize +
    ":fontcolor=white" +
    ":line_spacing=8" +
    ":text_align=C" +
    ":x=(w-text_w)/2" +
    ":y=h-text_h-50" +
    ":box=1:boxcolor=black@0.65:boxborderw=14" +
    ":fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

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

// Clean up text that will be written to a textfile and rendered by drawtext.
// drawtext reads the file raw, so the only things we need to worry about are
// control characters and percent-expansion (%{...}).
function sanitizeForTextfile(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\r\n\t]+/g, " ")   // collapse newlines/tabs to spaces
    .replace(/%/g, "%%")           // disable drawtext's %{...} expansion
    .replace(/[\x00-\x1F\x7F]/g, "") // strip remaining control chars
    .trim();
}

// Escape a filesystem path for inclusion in an FFmpeg filter-graph option
// value. We only need to escape characters that terminate option parsing:
// `:` (option separator), `\` (escape char), and `'` (quote). This is the
// same escape recommended in FFmpeg docs for `textfile=` and `fontfile=`.
function escapeFilterPath(p) {
  return String(p)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:");
}

// Word-wrap text so it fits within a given pixel width when rendered by
// FFmpeg drawtext. Drawtext doesn't wrap on its own, so long titles would
// otherwise overflow the frame. The algorithm is:
//   1. At the current fontsize, estimate how many chars fit per line
//      (using a conservative char-width ratio for the chosen weight).
//   2. Word-wrap into lines.
//   3. If that produces more than maxLines, shrink the fontsize by 10% and
//      retry, down to minFontSize.
// Returns { text, fontSize } — text may contain "\n" for multi-line.
function wrapTextForDrawtext(text, fontSize, maxWidthPx, opts) {
  opts = opts || {};
  // Conservative char-width estimates for DejaVu Sans. Bold is wider.
  const charWidthRatio = opts.bold ? 0.60 : 0.55;
  const maxLines = opts.maxLines || 2;
  const minFontSize = opts.minFontSize || 28;

  if (!text) return { text: "", fontSize };

  let currentFontSize = fontSize;
  while (currentFontSize >= minFontSize) {
    const charWidth = currentFontSize * charWidthRatio;
    const maxCharsPerLine = Math.max(8, Math.floor(maxWidthPx / charWidth));

    // Single-line fits at this size — done.
    if (text.length <= maxCharsPerLine) {
      return { text, fontSize: currentFontSize };
    }

    // Greedy word-wrap.
    const words = text.split(/\s+/).filter(function(w) { return w.length > 0; });
    const lines = [];
    let current = "";
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const candidate = current ? current + " " + w : w;
      if (candidate.length > maxCharsPerLine && current) {
        lines.push(current);
        current = w;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);

    // If a single word is longer than the line limit (unusual), we'll still
    // accept it — shrinking further won't help. Otherwise fit check.
    const longest = lines.reduce(function(m, l) { return Math.max(m, l.length); }, 0);
    if (lines.length <= maxLines && longest <= maxCharsPerLine) {
      return { text: lines.join("\n"), fontSize: currentFontSize };
    }

    // Too many lines or some line still overflows — shrink font and retry.
    currentFontSize = Math.floor(currentFontSize * 0.9);
  }

  // Fallback: wrap at minFontSize and accept whatever lines we get.
  const charWidth = minFontSize * charWidthRatio;
  const maxCharsPerLine = Math.max(8, Math.floor(maxWidthPx / charWidth));
  const words = text.split(/\s+/).filter(function(w) { return w.length > 0; });
  const lines = [];
  let current = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidate = current ? current + " " + w : w;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return { text: lines.join("\n"), fontSize: minFontSize };
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
