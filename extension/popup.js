// ============================================================
// StepWise - Popup (v1.2 - Voice Narration + Settings)
// ============================================================

var currentState = { isRecording: false, steps: [] };
var voiceEnabled = false;

// --- Simple encryption for API key ---
var ENCRYPT_KEY = "StepWise_2024_SecureKey";

function encryptKey(text) {
  if (!text) return "";
  var result = [];
  for (var i = 0; i < text.length; i++) {
    result.push(text.charCodeAt(i) ^ ENCRYPT_KEY.charCodeAt(i % ENCRYPT_KEY.length));
  }
  return btoa(String.fromCharCode.apply(null, result));
}

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

// --- Init ---
document.addEventListener("DOMContentLoaded", function() {
  document.getElementById("startFreshBtn").addEventListener("click", startFresh);
  document.getElementById("stopBtn").addEventListener("click", stopRecording);
  document.getElementById("continueBtn").addEventListener("click", continueRecording);
  document.getElementById("newRecordBtn").addEventListener("click", startFresh);
  document.getElementById("exportBtn").addEventListener("click", openEditor);
  document.getElementById("downloadJsonBtn").addEventListener("click", downloadJSON);
  document.getElementById("clearBtn").addEventListener("click", clearAll);

  // My Guides + Log Out links
  document.getElementById("myGuidesLink").addEventListener("click", openMyGuides);
  document.getElementById("logoutLink").addEventListener("click", logoutAccount);

  // Settings
  document.getElementById("settingsLink").addEventListener("click", openSettings);
  document.getElementById("settingsBackBtn").addEventListener("click", closeSettings);
  document.getElementById("keyToggleBtn").addEventListener("click", toggleKeyVisibility);
  document.getElementById("apiKeyInput").addEventListener("change", saveApiKey);
  document.getElementById("apiKeyInput").addEventListener("blur", saveApiKey);

  // Voice toggles
  document.getElementById("voiceToggle").addEventListener("click", toggleVoice);
  document.getElementById("voiceToggleSettings").addEventListener("click", toggleVoice);

  loadSettings();
  updateAccountLinks();
  refreshState();
});

// --- Settings Panel ---
function openSettings() {
  document.getElementById("main").style.display = "none";
  document.getElementById("settingsPanel").classList.add("visible");
}

function closeSettings() {
  document.getElementById("settingsPanel").classList.remove("visible");
  document.getElementById("main").style.display = "block";
}

function loadSettings() {
  chrome.storage.local.get(["encryptedApiKey", "voiceEnabled"], function(result) {
    var hasKey = result.encryptedApiKey && result.encryptedApiKey.length > 0;
    var keyStatus = document.getElementById("keyStatus");
    if (hasKey) {
      keyStatus.textContent = "\u2713 API key saved";
      keyStatus.className = "key-status saved";
      var decrypted = decryptKey(result.encryptedApiKey);
      if (decrypted) {
        document.getElementById("apiKeyInput").value = decrypted;
        document.getElementById("apiKeyInput").type = "password";
      }
    } else {
      keyStatus.textContent = "\u26a0 No API key saved";
      keyStatus.className = "key-status empty";
    }
    voiceEnabled = result.voiceEnabled !== undefined ? result.voiceEnabled : (hasKey ? true : false);
    updateVoiceToggles();
    // If API key exists and voice was auto-enabled, save it so content.js picks it up
    if (hasKey && result.voiceEnabled === undefined) {
      chrome.storage.local.set({ voiceEnabled: true });
    }
  });
}

function saveApiKey() {
  var key = document.getElementById("apiKeyInput").value.trim();
  var keyStatus = document.getElementById("keyStatus");
  if (key && key.startsWith("sk-")) {
    var encrypted = encryptKey(key);
    chrome.storage.local.set({ encryptedApiKey: encrypted, voiceEnabled: true }, function() {
      keyStatus.textContent = "\u2713 API key saved securely";
      keyStatus.className = "key-status saved";
      voiceEnabled = true;
      updateVoiceToggles();
      chrome.runtime.sendMessage({ action: "API_KEY_UPDATED" });
    });
  } else if (key === "") {
    chrome.storage.local.remove("encryptedApiKey", function() {
      keyStatus.textContent = "\u26a0 No API key saved";
      keyStatus.className = "key-status empty";
    });
  } else {
    keyStatus.textContent = "\u26a0 Key should start with sk-";
    keyStatus.className = "key-status empty";
  }
}

function toggleKeyVisibility() {
  var input = document.getElementById("apiKeyInput");
  input.type = input.type === "password" ? "text" : "password";
}

function toggleVoice() {
  voiceEnabled = !voiceEnabled;
  chrome.storage.local.set({ voiceEnabled: voiceEnabled });
  updateVoiceToggles();
  chrome.runtime.sendMessage({ action: "VOICE_STATE_CHANGED", enabled: voiceEnabled });
  chrome.tabs.query({}, function(tabs) {
    tabs.forEach(function(tab) {
      chrome.tabs.sendMessage(tab.id, { action: "VOICE_STATE_CHANGED", enabled: voiceEnabled }).catch(function() {});
    });
  });
}

function updateVoiceToggles() {
  ["voiceToggle", "voiceToggleSettings"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle("active", voiceEnabled);
  });
}

// --- Account Links (My Guides + Log Out) ---
function updateAccountLinks() {
  chrome.storage.local.get(["publishSecret", "userIndexUrl"], function(result) {
    var loggedIn = result.publishSecret && result.publishSecret.length > 0;
    var hasUrl = loggedIn && result.userIndexUrl;
    var guidesLink = document.getElementById("myGuidesLink");
    var logoutLink = document.getElementById("logoutLink");
    if (guidesLink) guidesLink.style.display = hasUrl ? "inline" : "none";
    if (logoutLink) logoutLink.style.display = loggedIn ? "inline" : "none";
  });
}

function logoutAccount() {
  if (!confirm("Log out of StepWise?\nYou\u2019ll need to re-enter your API key to use publishing and editing features.")) return;
  chrome.storage.local.remove(["publishSecret", "userIndexUrl", "userName"], function() {
    updateAccountLinks();
  });
}

function openMyGuides() {
  chrome.storage.local.get(["userIndexUrl"], function(result) {
    if (result.userIndexUrl) {
      chrome.tabs.create({ url: result.userIndexUrl });
    } else {
      // Try to fetch it
      chrome.storage.local.get(["publishSecret"], function(r2) {
        if (!r2.publishSecret) return;
        fetch("https://app.heychatmate.com/stepwise-api/me", {
          headers: { "Authorization": "Bearer " + r2.publishSecret }
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.success && data.indexUrl) {
            chrome.storage.local.set({ userIndexUrl: data.indexUrl });
            chrome.tabs.create({ url: data.indexUrl });
          }
        })
        .catch(function() {});
      });
    }
  });
}

// --- State Management ---
function refreshState() {
  chrome.runtime.sendMessage({ action: "GET_STATUS" }, function(res) {
    if (chrome.runtime.lastError) return;
    if (res) currentState.isRecording = res.isRecording;
    chrome.runtime.sendMessage({ action: "GET_STEPS" }, function(res2) {
      if (chrome.runtime.lastError) return;
      if (res2) currentState.steps = res2.steps || [];
      updateUI(); renderSteps();
    });
  });
}

function updateUI() {
  var statusDot = document.getElementById("statusDot");
  var statusText = document.getElementById("statusText");
  var stepCount = document.getElementById("stepCount");
  var freshState = document.getElementById("freshState");
  var recordingState = document.getElementById("recordingState");
  var hasStepsState = document.getElementById("hasStepsState");
  var count = currentState.steps.length;
  var countLabel = count + " step" + (count !== 1 ? "s" : "");

  freshState.style.display = "none";
  recordingState.style.display = "none";
  hasStepsState.style.display = "none";

  if (currentState.isRecording) {
    recordingState.style.display = "block";
    statusDot.className = "status-dot recording";
    statusText.textContent = "Recording... " + (count > 0 ? "(" + countLabel + ")" : "");
    stepCount.style.display = count > 0 ? "inline-block" : "none";
    stepCount.textContent = countLabel;
  } else if (count > 0) {
    hasStepsState.style.display = "block";
    statusDot.className = "status-dot has-steps";
    statusText.textContent = "Done! " + countLabel + " captured";
    stepCount.style.display = "inline-block";
    stepCount.textContent = countLabel;
  } else {
    freshState.style.display = "block";
    statusDot.className = "status-dot idle";
    statusText.textContent = "Ready to record";
    stepCount.style.display = "none";
  }
}

function renderSteps() {
  var container = document.getElementById("stepsPreview");
  if (currentState.steps.length === 0) {
    container.innerHTML = '<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg><div>Click "Start Recording" then<br>perform your workflow</div></div>';
    return;
  }
  var html = "";
  for (var i = 0; i < currentState.steps.length; i++) {
    var step = currentState.steps[i];
    html += '<div class="step-item"><div class="step-num">' + (i + 1) + '</div>';
    if (step.screenshot) html += '<img class="step-thumb" src="' + step.screenshot + '">';
    html += '<div class="step-title">' + escapeHtml(step.title) + '</div></div>';
  }
  container.innerHTML = html;
}

// --- Actions ---
function startFresh() {
  if (currentState.steps.length > 0) {
    if (!confirm("Start a new recording? This will clear " + currentState.steps.length + " existing steps.")) return;
  }
  chrome.runtime.sendMessage({ action: "START_RECORDING" }, function(res) {
    if (chrome.runtime.lastError) return;
    currentState.isRecording = true; currentState.steps = [];
    updateUI(); renderSteps();
  });
}

function continueRecording() {
  chrome.runtime.sendMessage({ action: "CONTINUE_RECORDING" }, function(res) {
    if (chrome.runtime.lastError) return;
    currentState.isRecording = true; updateUI();
  });
}

function stopRecording() {
  chrome.runtime.sendMessage({ action: "STOP_RECORDING" }, function(res) {
    if (chrome.runtime.lastError) return;
    if (res && res.steps) currentState.steps = res.steps;
    currentState.isRecording = false; updateUI(); renderSteps();
    setTimeout(refreshState, 300);
  });
}

function openEditor() {
  var exportData = { version: "1.0", exportedAt: new Date().toISOString(),
    steps: currentState.steps.map(function(step, i) {
      return { id: step.id, number: i + 1, title: step.title, description: step.description, screenshot: step.screenshot, url: step.url, pageTitle: step.pageTitle, element: step.element, annotations: step.annotations || [], timestamp: step.timestamp };
    })
  };
  try {
    chrome.storage.local.set({ exportData: exportData }, function() {
      if (chrome.runtime.lastError) console.log("Storage warning:", chrome.runtime.lastError.message);
      chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
    });
  } catch (e) { chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") }); }
}

function downloadJSON() {
  var exportData = { version: "1.0", exportedAt: new Date().toISOString(),
    steps: currentState.steps.map(function(step, i) {
      return { id: step.id, number: i + 1, title: step.title, description: step.description, screenshot: step.screenshot, url: step.url, pageTitle: step.pageTitle, element: step.element, annotations: step.annotations || [], timestamp: step.timestamp };
    })
  };
  var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  var url = URL.createObjectURL(blob); var a = document.createElement("a"); a.href = url;
  a.download = "stepwise-" + new Date().toISOString().split("T")[0] + ".json";
  a.click(); URL.revokeObjectURL(url);
}

function clearAll() {
  if (!confirm("Clear all " + currentState.steps.length + " steps? This cannot be undone.")) return;
  chrome.runtime.sendMessage({ action: "CLEAR_STEPS" }, function() {
    currentState.steps = []; currentState.isRecording = false; updateUI(); renderSteps();
  });
}

function escapeHtml(str) { var div = document.createElement("div"); div.textContent = str || ""; return div.innerHTML; }
