// ============================================================
// StepWise - Background Service Worker
// Injects content script into ALL tabs on recording start
// ============================================================

var isRecording = false;
var steps = [];
var stepCounter = 0;
var lastCaptureTime = 0;
var voiceEnabled = false;
var cachedApiKey = "";

// --- Encryption (must match popup.js) ---
var ENCRYPT_KEY = "StepWise_2024_SecureKey";
function decryptKey(encoded) {
  if (!encoded) return "";
  try {
    var decoded = atob(encoded);
    var result = [];
    for (var i = 0; i < decoded.length; i++) {
      result.push(decoded.charCodeAt(i) ^ ENCRYPT_KEY.charCodeAt(i % ENCRYPT_KEY.length));
    }
    return String.fromCharCode.apply(null, result);
  } catch (e) { return ""; }
}

function loadApiKey() {
  chrome.storage.local.get(["encryptedApiKey"], function(result) {
    cachedApiKey = decryptKey(result.encryptedApiKey || "");
  });
}
loadApiKey();

// Load voice state
chrome.storage.local.get(["voiceEnabled"], function(result) {
  voiceEnabled = result.voiceEnabled || false;
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  switch (message.action) {
    case "START_RECORDING":
      steps = [];
      stepCounter = 0;
      chrome.storage.local.set({ steps: [] });
      beginRecording(sendResponse);
      return true;
    case "CONTINUE_RECORDING":
      beginRecording(sendResponse);
      return true;
    case "STOP_RECORDING":
      stopRecording(sendResponse);
      return true;
    case "GET_STATUS":
      sendResponse({ isRecording: isRecording, stepCount: steps.length, voiceEnabled: voiceEnabled });
      return true;
    case "CLICK_DETECTED":
      if (isRecording) {
        var now = Date.now();
        if (now - lastCaptureTime < 500) {
          sendResponse({ success: false, error: "debounced" });
          return true;
        }
        lastCaptureTime = now;
        captureStep(message.data, sender.tab, sendResponse);
        return true;
      }
      break;
    case "GET_STEPS":
      sendResponse({ steps: steps });
      return true;
    case "CLEAR_STEPS":
      steps = []; stepCounter = 0;
      chrome.storage.local.set({ steps: [] });
      sendResponse({ success: true });
      return true;
    case "DELETE_STEP":
      steps = steps.filter(function(s) { return s.id !== message.stepId; });
      chrome.storage.local.set({ steps: steps });
      sendResponse({ steps: steps });
      return true;
    case "API_KEY_UPDATED":
      loadApiKey();
      sendResponse({ success: true });
      return true;
    case "VOICE_STATE_CHANGED":
      voiceEnabled = message.enabled;
      sendResponse({ success: true });
      return true;
    case "WHISPER_TRANSCRIBE":
      whisperTranscribe(message.audioBase64, message.stepId, sendResponse);
      return true;
    case "TTS_SPEAK":
      ttsSpeak(message.text, message.voice || "nova", sendResponse);
      return true;
    case "GET_API_KEY":
      chrome.storage.local.get(["encryptedApiKey"], function(result) {
        if (result.encryptedApiKey) {
          var key = decryptKey(result.encryptedApiKey);
          sendResponse({ success: true, apiKey: key });
        } else {
          sendResponse({ success: false, error: "No API key saved" });
        }
      });
      return true;
  }
});

// --- Whisper Transcription ---

async function whisperTranscribe(audioBase64, stepId, sendResponse) {
  console.log("StepWise Whisper: Called with stepId:", stepId, "audioBase64 length:", audioBase64 ? audioBase64.length : 0);
  
  if (!cachedApiKey) {
    loadApiKey();
    // Wait a moment for key to load
    await new Promise(function(r) { setTimeout(r, 200); });
  }

  if (!cachedApiKey) {
    console.log("StepWise Whisper: ❌ No API key");
    sendResponse({ success: false, error: "No API key. Go to StepWise Settings to add your OpenAI key." });
    return;
  }

  try {
    // Convert base64 to blob
    var byteString = atob(audioBase64.split(",")[1] || audioBase64);
    var ab = new ArrayBuffer(byteString.length);
    var ia = new Uint8Array(ab);
    for (var i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
    var blob = new Blob([ab], { type: "audio/webm" });
    console.log("StepWise Whisper: Blob created, size:", blob.size);

    // Build form data
    var formData = new FormData();
    formData.append("file", blob, "recording.webm");
    formData.append("model", "whisper-1");
    formData.append("language", "en");

    console.log("StepWise Whisper: Calling OpenAI Whisper API...");
    var response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + cachedApiKey },
      body: formData
    });

    if (!response.ok) {
      var errText = await response.text();
      console.log("StepWise Whisper: ❌ API error:", response.status, errText);
      sendResponse({ success: false, error: "Whisper API error: " + response.status + " " + errText });
      return;
    }

    var result = await response.json();
    var text = (result.text || "").trim();
    console.log("StepWise Whisper: ✅ Transcribed:", text);

    // If stepId provided, update the step's description
    if (stepId && text) {
      var step = steps.find(function(s) { return s.id === stepId; });
      if (step) {
        step.description = step.description ? step.description + " " + text : text;
        chrome.storage.local.set({ steps: steps });
        console.log("StepWise Whisper: ✅ Updated step", stepId, "description to:", step.description);
      } else {
        console.log("StepWise Whisper: ❌ Step not found:", stepId, "Available steps:", steps.map(function(s) { return s.id; }));
      }
    }

    sendResponse({ success: true, text: text });
  } catch (err) {
    console.log("StepWise Whisper: ❌ Error:", err.message);
    sendResponse({ success: false, error: "Transcription failed: " + err.message });
  }
}

// --- Text-to-Speech (OpenAI TTS) ---

async function ttsSpeak(text, voice, sendResponse) {
  if (!cachedApiKey) {
    loadApiKey();
    await new Promise(function(r) { setTimeout(r, 200); });
  }

  if (!cachedApiKey) {
    sendResponse({ success: false, error: "No API key. Go to StepWise Settings to add your OpenAI key." });
    return;
  }

  if (!text || !text.trim()) {
    sendResponse({ success: false, error: "No text to speak." });
    return;
  }

  try {
    var response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + cachedApiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text.trim(),
        voice: voice || "nova",
        response_format: "mp3"
      })
    });

    if (!response.ok) {
      var errText = await response.text();
      sendResponse({ success: false, error: "TTS API error: " + response.status + " " + errText });
      return;
    }

    var arrayBuffer = await response.arrayBuffer();
    var bytes = new Uint8Array(arrayBuffer);
    var binary = "";
    var chunkSize = 8192;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    var base64 = btoa(binary);
    var audioDataUrl = "data:audio/mp3;base64," + base64;

    sendResponse({ success: true, audioDataUrl: audioDataUrl });
  } catch (err) {
    sendResponse({ success: false, error: "TTS failed: " + err.message });
  }
}

async function beginRecording(sendResponse) {
  isRecording = true;
  stepCounter = steps.length;
  chrome.storage.local.set({ isRecording: true });

  // Inject content script into ALL open tabs
  await injectIntoAllTabs();

  // Notify all tabs that recording started
  chrome.tabs.query({}, function(tabs) {
    tabs.forEach(function(tab) {
      chrome.tabs.sendMessage(tab.id, { action: "RECORDING_STARTED" }).catch(function() {});
    });
  });

  chrome.action.setBadgeText({ text: steps.length > 0 ? String(steps.length) : "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  sendResponse({ success: true, stepCount: steps.length });
}

async function injectIntoAllTabs() {
  try {
    var tabs = await chrome.tabs.query({});
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      // Skip chrome://, chrome-extension://, about:, edge://, etc.
      if (!tab.url || !tab.url.match(/^https?:\/\//)) continue;

      try {
        // Check if content script is already injected
        await chrome.tabs.sendMessage(tab.id, { action: "CHECK_RECORDING" });
        // If we get here, script is already injected — no need to re-inject
      } catch (e) {
        // Script not injected yet — inject it
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
          });
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ["content.css"]
          });
        } catch (injectErr) {
          // Some tabs can't be injected (e.g. Chrome Web Store) — skip
          console.log("Cannot inject into tab:", tab.url, injectErr.message);
        }
      }
    }
  } catch (err) {
    console.error("Error injecting into tabs:", err);
  }
}

function stopRecording(sendResponse) {
  isRecording = false;
  chrome.storage.local.set({ isRecording: false });

  chrome.tabs.query({}, function(tabs) {
    tabs.forEach(function(tab) {
      chrome.tabs.sendMessage(tab.id, { action: "RECORDING_STOPPED" }).catch(function() {});
    });
  });

  chrome.action.setBadgeText({ text: steps.length > 0 ? String(steps.length) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
  sendResponse({ success: true, steps: steps });
}

async function captureStep(clickData, tab, sendResponse) {
  try {
    await new Promise(function(resolve) { setTimeout(resolve, 150); });

    var screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png", quality: 92
    });

    stepCounter++;

    var step = {
      id: "step_" + Date.now() + "_" + stepCounter,
      number: stepCounter,
      title: generateStepTitle(clickData),
      description: "",
      screenshot: screenshotDataUrl,
      url: tab.url,
      pageTitle: tab.title,
      element: {
        tag: clickData.tag, text: clickData.text, id: clickData.id,
        className: clickData.className, type: clickData.type,
        placeholder: clickData.placeholder, href: clickData.href,
        ariaLabel: clickData.ariaLabel, xpath: clickData.xpath
      },
      clickPosition: {
        x: clickData.x, y: clickData.y,
        viewportX: clickData.viewportX, viewportY: clickData.viewportY
      },
      annotations: [],
      timestamp: new Date().toISOString()
    };

    steps.push(step);
    chrome.storage.local.set({ steps: steps });

    chrome.action.setBadgeText({ text: String(steps.length) });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });

    chrome.tabs.sendMessage(tab.id, {
      action: "STEP_CAPTURED", stepNumber: stepCounter
    }).catch(function() {});

    sendResponse({ success: true, step: step });
  } catch (err) {
    console.error("Screenshot capture failed:", err);
    sendResponse({ success: false, error: err.message });
  }
}

function generateStepTitle(clickData) {
  var tag = (clickData.tag || "").toLowerCase();
  var text = (clickData.text || "").trim().substring(0, 60);
  var placeholder = clickData.placeholder;
  var ariaLabel = clickData.ariaLabel;
  var type = clickData.type;

  if (tag === "button" || (tag === "input" && type === "submit")) return 'Click "' + (text || ariaLabel || "button") + '"';
  if (tag === "a") return 'Click "' + (text || ariaLabel || "link") + '"';
  if (tag === "input" || tag === "textarea") return "Click on " + (placeholder || ariaLabel || clickData.id || "field");
  if (tag === "select") return 'Open "' + (ariaLabel || clickData.id || "dropdown") + '"';
  if (text) return 'Click "' + text.substring(0, 40) + (text.length > 40 ? "..." : "") + '"';
  return "Click on " + (tag || "element");
}

// Also inject into any NEW tabs opened during recording
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (!isRecording) return;
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !tab.url.match(/^https?:\/\//)) return;

  // Inject and notify
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ["content.js"]
  }).then(function() {
    return chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ["content.css"]
    });
  }).then(function() {
    chrome.tabs.sendMessage(tabId, { action: "RECORDING_STARTED" }).catch(function() {});
  }).catch(function() {});
});

// Restore state on service worker restart
chrome.storage.local.get(["isRecording", "steps"], function(result) {
  if (result.steps) { steps = result.steps; stepCounter = steps.length; }
  if (result.isRecording) {
    isRecording = true;
    chrome.action.setBadgeText({ text: steps.length > 0 ? String(steps.length) : "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    // Re-inject into all tabs on service worker restart
    injectIntoAllTabs().then(function() {
      chrome.tabs.query({}, function(tabs) {
        tabs.forEach(function(tab) {
          chrome.tabs.sendMessage(tab.id, { action: "RECORDING_STARTED" }).catch(function() {});
        });
      });
    });
  }
});
