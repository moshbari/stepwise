// ============================================================
// StepWise - Content Script
// Captures clicks, draws highlight circle at click position
// so it appears in the screenshot
// ============================================================

// Prevent double-injection (manifest auto-inject + programmatic inject)
if (window._stepwiseInjected) {
  // Already running — skip
} else {
window._stepwiseInjected = true;

var isRecording = false;
var feedbackTimeout = null;

// --- Voice Recording ---
var voiceEnabled = false;
var mediaRecorder = null;
var audioChunks = [];
var micStream = null;
var lastStepId = null; // Track previous step for voice assignment

function startVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    console.log("StepWise Voice: Already recording");
    return;
  }
  console.log("StepWise Voice: Requesting mic access...");
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    micStream = stream;
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    audioChunks = [];
    mediaRecorder.ondataavailable = function(e) {
      if (e.data.size > 0) {
        audioChunks.push(e.data);
        console.log("StepWise Voice: Audio chunk received, size:", e.data.size);
      }
    };
    mediaRecorder.start(1000); // Collect data every 1 second for reliability
    console.log("StepWise Voice: ✅ Mic recording started");
    updateVoiceIndicator(true);
  }).catch(function(err) {
    console.log("StepWise Voice: ❌ Mic access denied -", err.message);
    voiceEnabled = false;
    updateVoiceIndicator(false);
  });
}

function stopVoiceRecording() {
  console.log("StepWise Voice: Stopping voice recording");
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch(e) {}
  }
  if (micStream) {
    micStream.getTracks().forEach(function(t) { t.stop(); });
    micStream = null;
  }
  mediaRecorder = null;
  audioChunks = [];
  updateVoiceIndicator(false);
}

function captureVoiceChunk() {
  return new Promise(function(resolve) {
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
      console.log("StepWise Voice: No active recorder, skipping chunk capture");
      resolve(null);
      return;
    }

    // Save current chunks reference and recorder before stopping
    var currentChunks = audioChunks;
    var currentRecorder = mediaRecorder;

    // Set up the onstop handler BEFORE stopping
    currentRecorder.onstop = function() {
      console.log("StepWise Voice: Recorder stopped, chunks:", currentChunks.length);
      if (currentChunks.length === 0) {
        console.log("StepWise Voice: No audio chunks captured");
        resolve(null);
        startNextChunk();
        return;
      }

      var blob = new Blob(currentChunks, { type: "audio/webm" });
      console.log("StepWise Voice: Audio blob size:", blob.size, "bytes");

      // Only transcribe if blob has meaningful audio (> 500 bytes)
      if (blob.size < 500) {
        console.log("StepWise Voice: Audio too small, skipping");
        resolve(null);
        startNextChunk();
        return;
      }

      var reader = new FileReader();
      reader.onloadend = function() {
        console.log("StepWise Voice: ✅ Audio chunk ready for Whisper");
        resolve(reader.result); // base64 data URL
        startNextChunk();
      };
      reader.readAsDataURL(blob);
    };

    // Reset chunks for next recording BEFORE stopping
    audioChunks = [];

    // Stop to trigger onstop handler
    try {
      currentRecorder.stop();
    } catch(e) {
      console.log("StepWise Voice: Error stopping recorder:", e.message);
      resolve(null);
      startNextChunk();
    }
  });
}

function startNextChunk() {
  if (!voiceEnabled || !micStream || !micStream.active) {
    console.log("StepWise Voice: Cannot start next chunk - voice:", voiceEnabled, "micStream:", !!micStream, "active:", micStream ? micStream.active : false);
    return;
  }
  try {
    mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
    audioChunks = [];
    mediaRecorder.ondataavailable = function(e) {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.start(1000); // Collect data every 1 second
    console.log("StepWise Voice: ✅ Next chunk recording started");
  } catch (e) {
    console.log("StepWise Voice: ❌ Failed to restart recording:", e.message);
  }
}

function updateVoiceIndicator(active) {
  var indicator = document.getElementById("stepwise-recording-indicator");
  if (!indicator) return;
  var existing = indicator.querySelector(".stepwise-voice-badge");
  if (active && !existing) {
    var badge = document.createElement("span");
    badge.className = "stepwise-voice-badge";
    badge.textContent = "\ud83c\udfa4";
    badge.style.cssText = "margin-left:6px;font-size:12px;";
    indicator.appendChild(badge);
  } else if (!active && existing) {
    existing.remove();
  }
}

// --- Click Listener ---

document.addEventListener("click", function(e) {
  if (!isRecording) return;
  if (e.target.closest(".stepwise-overlay")) return;

  var element = e.target;

  // Walk up to nearest meaningful interactive element (button, link, etc.)
  var interactiveElement = findInteractiveParent(element);

  // Draw highlight circle at click position BEFORE screenshot
  var highlight = drawClickHighlight(e.clientX, e.clientY);

  var clickData = {
    tag: interactiveElement.tagName,
    text: getVisibleText(interactiveElement),
    id: interactiveElement.id || element.id || null,
    className: interactiveElement.className || null,
    type: interactiveElement.type || null,
    placeholder: interactiveElement.placeholder || null,
    href: interactiveElement.href || (element.closest("a") ? element.closest("a").href : null),
    ariaLabel: interactiveElement.getAttribute("aria-label") || element.getAttribute("aria-label") || null,
    role: interactiveElement.getAttribute("role") || element.getAttribute("role") || null,
    name: interactiveElement.name || null,
    xpath: getXPath(interactiveElement),
    x: e.pageX,
    y: e.pageY,
    viewportX: e.clientX,
    viewportY: e.clientY,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  };

  // Capture voice audio chunk BEFORE this click's step is created
  // This audio is what the user said AFTER the previous click = caption for PREVIOUS step
  var prevStepId = lastStepId;
  console.log("StepWise Voice: Click detected. prevStepId:", prevStepId, "voiceEnabled:", voiceEnabled, "hasRecorder:", !!mediaRecorder);
  var voicePromise = (voiceEnabled && mediaRecorder) ? captureVoiceChunk() : Promise.resolve(null);

  // Small delay to let the highlight render, then capture
  setTimeout(function() {
    chrome.runtime.sendMessage({
      action: "CLICK_DETECTED",
      data: clickData
    }, function(res) {
      // Save this step's ID so NEXT click's audio goes to THIS step
      if (res && res.step) {
        lastStepId = res.step.id;
      }

      // Send voice audio to the PREVIOUS step (user spoke about it after clicking it)
      voicePromise.then(function(audioBase64) {
        console.log("StepWise Voice: voicePromise resolved. hasAudio:", !!audioBase64, "prevStepId:", prevStepId);
        if (audioBase64 && prevStepId) {
          console.log("StepWise Voice: Sending audio to Whisper for step:", prevStepId);
          chrome.runtime.sendMessage({
            action: "WHISPER_TRANSCRIBE",
            audioBase64: audioBase64,
            stepId: prevStepId
          }, function(tRes) {
            if (tRes && tRes.success && tRes.text) {
              console.log("StepWise Voice: ✅ Transcription for step " + prevStepId + ": " + tRes.text);
            } else {
              console.log("StepWise Voice: ❌ Transcription failed:", tRes ? tRes.error : "no response");
            }
          });
        } else if (audioBase64 && !prevStepId) {
          console.log("StepWise Voice: Audio captured but no previous step to attach to (first click)");
        }
      });

      // Remove highlight after screenshot is taken
      setTimeout(function() {
        if (highlight && highlight.parentNode) {
          highlight.style.transition = "opacity 0.3s";
          highlight.style.opacity = "0";
          setTimeout(function() {
            if (highlight.parentNode) highlight.parentNode.removeChild(highlight);
          }, 300);
        }
      }, 400);
    });
  }, 100);
}, true);

// --- Draw Click Highlight ---

function drawClickHighlight(x, y) {
  var container = document.createElement("div");
  container.className = "stepwise-overlay stepwise-click-highlight";
  container.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;" +
    "left:" + (x - 24) + "px;top:" + (y - 24) + "px;width:48px;height:48px;";

  // Outer ring
  var ring = document.createElement("div");
  ring.style.cssText = "position:absolute;inset:0;border-radius:50%;" +
    "border:3px solid #ef4444;background:rgba(239,68,68,0.15);" +
    "animation:stepwise-ring-pulse 0.6s ease-out;";
  container.appendChild(ring);

  // Center dot
  var dot = document.createElement("div");
  dot.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);" +
    "width:10px;height:10px;border-radius:50%;background:#ef4444;" +
    "box-shadow:0 0 8px rgba(239,68,68,0.6);";
  container.appendChild(dot);

  document.body.appendChild(container);
  return container;
}

// --- Helpers ---

function findInteractiveParent(element) {
  // Walk up to find the nearest meaningful interactive element
  var interactiveTags = ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL"];
  var current = element;
  var depth = 0;

  while (current && depth < 5) {
    if (interactiveTags.indexOf(current.tagName) !== -1) return current;
    if (current.getAttribute("role") === "button" || current.getAttribute("role") === "link") return current;
    if (current.getAttribute("onclick")) return current;
    current = current.parentElement;
    depth++;
  }

  // No interactive parent found — return original but use parent if it's an SVG
  var svgTags = ["SVG", "PATH", "CIRCLE", "RECT", "LINE", "POLYGON", "G", "USE"];
  if (svgTags.indexOf(element.tagName) !== -1 && element.parentElement) {
    return element.parentElement;
  }

  return element;
}

function getVisibleText(element) {
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    return element.value || element.placeholder || "";
  }
  if (element.tagName === "SELECT") {
    return element.options[element.selectedIndex] ? element.options[element.selectedIndex].text : "";
  }
  if (element.tagName === "IMG") {
    return element.alt || "";
  }

  // For SVG, PATH, CIRCLE, etc — walk up to find meaningful parent text
  var svgTags = ["SVG", "PATH", "CIRCLE", "RECT", "LINE", "POLYGON", "POLYLINE", "G", "USE", "SYMBOL"];
  if (svgTags.indexOf(element.tagName) !== -1) {
    return getParentText(element);
  }

  var text = "";
  for (var i = 0; i < element.childNodes.length; i++) {
    if (element.childNodes[i].nodeType === Node.TEXT_NODE) {
      text += element.childNodes[i].textContent;
    }
  }
  text = text.trim();

  if (!text && element.innerText) {
    text = element.innerText.substring(0, 100).trim();
  }

  // If still no text, try walking up
  if (!text || text.length < 2) {
    text = getParentText(element);
  }

  return text.trim();
}

function getParentText(element) {
  // Walk up to 5 levels to find meaningful text or aria-label
  var current = element.parentElement;
  var depth = 0;

  while (current && depth < 5) {
    // Check aria-label first (most reliable for icon buttons)
    var ariaLabel = current.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim().length > 1) return ariaLabel.trim();

    // Check title attribute
    var title = current.getAttribute("title");
    if (title && title.trim().length > 1) return title.trim();

    // Check direct text content (not deep text, to avoid grabbing too much)
    var directText = "";
    for (var i = 0; i < current.childNodes.length; i++) {
      if (current.childNodes[i].nodeType === Node.TEXT_NODE) {
        directText += current.childNodes[i].textContent;
      }
    }
    directText = directText.trim();
    if (directText.length > 1 && directText.length < 80) return directText;

    // Check innerText on small elements (buttons, links, spans)
    var tag = current.tagName;
    if ((tag === "BUTTON" || tag === "A" || tag === "SPAN" || tag === "LABEL") && current.innerText) {
      var innerText = current.innerText.trim().substring(0, 80);
      if (innerText.length > 1) return innerText;
    }

    current = current.parentElement;
    depth++;
  }

  return "";
}

function getXPath(element) {
  if (!element) return "";
  if (element.id) return '//*[@id="' + element.id + '"]';
  var parts = [];
  var current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    var index = 1;
    var sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(current.tagName.toLowerCase() + (index > 1 ? "[" + index + "]" : ""));
    current = current.parentElement;
  }
  return "/" + parts.join("/");
}

// --- Recording State Messages ---

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  switch (message.action) {
    case "RECORDING_STARTED":
      isRecording = true;
      lastStepId = null;
      showRecordingIndicator();
      // Check if voice is enabled and start mic
      chrome.storage.local.get(["voiceEnabled"], function(result) {
        voiceEnabled = result.voiceEnabled || false;
        console.log("StepWise Voice: Recording started. voiceEnabled from storage:", voiceEnabled);
        if (voiceEnabled) startVoiceRecording();
      });
      break;
    case "RECORDING_STOPPED":
      isRecording = false;
      // Capture final voice chunk for the last step
      if (voiceEnabled && mediaRecorder && lastStepId) {
        console.log("StepWise Voice: Capturing final chunk for step:", lastStepId);
        var finalStepId = lastStepId;
        captureVoiceChunk().then(function(audioBase64) {
          console.log("StepWise Voice: Final chunk captured. hasAudio:", !!audioBase64);
          if (audioBase64 && finalStepId) {
            chrome.runtime.sendMessage({
              action: "WHISPER_TRANSCRIBE",
              audioBase64: audioBase64,
              stepId: finalStepId
            }, function(tRes) {
              if (tRes && tRes.success) {
                console.log("StepWise Voice: ✅ Final step transcription:", tRes.text);
              } else {
                console.log("StepWise Voice: ❌ Final transcription failed:", tRes ? tRes.error : "no response");
              }
            });
          }
          lastStepId = null;
          // NOW it's safe to stop voice recording (after chunk is captured)
          stopVoiceRecording();
        });
      } else {
        lastStepId = null;
        if (voiceEnabled) stopVoiceRecording();
      }
      hideRecordingIndicator();
      break;
    case "VOICE_STATE_CHANGED":
      voiceEnabled = message.enabled;
      if (isRecording && voiceEnabled) {
        startVoiceRecording();
      } else if (!voiceEnabled) {
        stopVoiceRecording();
      }
      break;
    case "STEP_CAPTURED":
      showCaptureFeedback(message.stepNumber);
      break;
    case "CHECK_RECORDING":
      sendResponse({ isRecording: isRecording });
      break;
  }
});

// --- UI: Recording Indicator ---

function showRecordingIndicator() {
  removeExisting("stepwise-recording-indicator");
  var indicator = document.createElement("div");
  indicator.id = "stepwise-recording-indicator";
  indicator.className = "stepwise-overlay";
  var dot = document.createElement("div");
  dot.className = "stepwise-rec-dot";
  indicator.appendChild(dot);
  var span = document.createElement("span");
  span.textContent = "StepWise Recording";
  indicator.appendChild(span);
  document.body.appendChild(indicator);
}

function hideRecordingIndicator() {
  removeExisting("stepwise-recording-indicator");
}

// --- UI: Capture Feedback ---

function showCaptureFeedback(stepNumber) {
  removeExisting("stepwise-capture-feedback");
  if (feedbackTimeout) clearTimeout(feedbackTimeout);

  var feedback = document.createElement("div");
  feedback.id = "stepwise-capture-feedback";
  feedback.className = "stepwise-overlay";
  feedback.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
    '<circle cx="12" cy="13" r="4"/></svg>' +
    '<span>Step ' + stepNumber + ' captured</span>';
  document.body.appendChild(feedback);

  var flash = document.createElement("div");
  flash.id = "stepwise-flash";
  flash.className = "stepwise-overlay";
  document.body.appendChild(flash);
  setTimeout(function() { removeExisting("stepwise-flash"); }, 200);

  feedbackTimeout = setTimeout(function() {
    removeExisting("stepwise-capture-feedback");
  }, 1500);
}

function removeExisting(id) {
  var el = document.getElementById(id);
  if (el) el.remove();
}

// --- Check initial recording state ---
chrome.runtime.sendMessage({ action: "GET_STATUS" }, function(response) {
  if (chrome.runtime.lastError) return;
  if (response && response.isRecording) {
    isRecording = true;
    showRecordingIndicator();
  }
});

} // end double-injection guard
