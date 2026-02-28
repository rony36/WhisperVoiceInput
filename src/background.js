async function setupOffscreen(path) {
  if (await chrome.offscreen.hasDocument()) return;
  
  try {
    await chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.CLIPBOARD],
      justification: "Local Whisper transcription and clipboard access"
    });
  } catch (err) {
    if (!err.message.includes('Only one offscreen document')) {
      throw err;
    }
  }
}

let isRecording = false;
let isProcessing = false;
let transcriptionHistory = []; // Persist only the latest 5 transcription results
let logHistory = [];
const MAX_LOGS = 100;

function updateBadge(isRecording) {
  if (isRecording) {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#FF3B30" }); // Vibrant Apple Red
    chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function getStatus() {
  const data = await chrome.storage.local.get({ isRecording: false, isProcessing: false });
  
  // Safety check: If we think we are processing but there is no offscreen document, reset it.
  if (data.isProcessing) {
    const hasDocument = await chrome.offscreen.hasDocument();
    if (!hasDocument) {
      console.log("[Whisper] Safety check: isProcessing was true but no offscreen doc found. Resetting.");
      await setProcessingState(false);
      return { ...data, isProcessing: false };
    }
  }
  
  return data;
}

async function setRecordingState(state) {
  isRecording = state; 
  await chrome.storage.local.set({ isRecording: state });
}

async function setProcessingState(state) {
  isProcessing = state;
  await chrome.storage.local.set({ isProcessing: state });
}

async function broadcastStatus() {
  const { isRecording: recording, isProcessing: processing } = await getStatus();
  chrome.runtime.sendMessage({
    type: "RECORDING_STATE_UPDATED",
    isRecording: recording,
    isProcessing: processing
  }).catch(() => {});
  updateBadge(recording);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    port.onDisconnect.addListener(() => {
      console.log("Popup closed.");
    });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-recording") {
    const { isRecording: recording, isProcessing: processing } = await getStatus();
    if (recording) {
      await setRecordingState(false);
      await setProcessingState(true);
      handleStopRecording();
      broadcastStatus();
    } else {
      // Prevent starting new recording if still processing previous one
      if (processing) {
        console.log("[Whisper] Busy processing, ignoring start command.");
        triggerSound('error');
        return;
      }
      await setRecordingState(true);
      await setProcessingState(false);
      logHistory = [];
      handleStartRecording();
      broadcastStatus();
    }
  }
});

function showNotification(title, message) {
  const notificationId = `whisper-${Date.now()}`;
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: '/assets/icons/icon128.png',
    title: title,
    message: message,
    priority: 2
  });

  // Auto-clear notification after 5 seconds to prevent tray clutter
  setTimeout(() => {
    chrome.notifications.clear(notificationId);
  }, 5000);
}

async function triggerSound(type) {
  const { enableSounds } = await chrome.storage.local.get({ enableSounds: true });
  if (!enableSounds) return;

  chrome.runtime.sendMessage({
    type: "PLAY_SOUND",
    target: "offscreen",
    soundType: type
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PLAY_SOUND_GLOBAL") {
    triggerSound(message.soundType);
    return false;
  }

  if (message.type === "GET_STATUS") {
    getStatus().then(status => {
      sendResponse({ isRecording: status.isRecording, isProcessing: status.isProcessing });
    });
    return true;
  }

  if (message.type === "GET_UI_STATE") {
    sendResponse({ transcriptionHistory, logHistory });
    return;
  }

  if (message.type === "LOG_DEBUG") {
    const logEntry = { msg: message.msg, color: message.color, time: new Date().toLocaleTimeString() };
    logHistory.push(logEntry);
    if (logHistory.length > MAX_LOGS) logHistory.shift();
    return false; 
  }

  if (message.type === "START_RECORDING") {
    getStatus().then(status => {
      if (status.isProcessing) {
        if (sendResponse) sendResponse({ success: false, error: "System busy" });
        return;
      }
      // Reset log and start
      logHistory = [];
      handleStartRecording(sendResponse);
    });
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    setRecordingState(false).then(() => {
      setProcessingState(true).then(() => {
        handleStopRecording(sendResponse);
        broadcastStatus();
      });
    });
    return true;
  }

  if (message.type === "OFFSCREEN_TRANSCRIPTION_RESULT") {
    setProcessingState(false).then(() => {
      if (message.text) {
        transcriptionHistory.unshift(message.text);
        if (transcriptionHistory.length > 5) {
          transcriptionHistory.pop();
        }
        showNotification("Transcription Complete", message.text);
        triggerSound('copy');
      } else {
        showNotification("Transcription", message.status || "Finished with no text.");
      }
      // Broadcast result and updated history to all active extension pages (e.g., popup)
      chrome.runtime.sendMessage({ 
          type: "TRANSCRIPTION_RESULT", 
          text: message.text,
          status: message.status,
          history: transcriptionHistory 
      }).catch(() => {});
      broadcastStatus();
    });
    return false;
  }
});

async function handleStartRecording(sendResponse) {
  try {
    const settings = await chrome.storage.local.get({
      model: "onnx-community/whisper-large-v3-turbo",
      language: "en"
    });

    console.log("Starting recording with settings:", settings);
    await setupOffscreen("src/offscreen.html");
    
    // Set recording state only after offscreen is ready, but before actual recording starts
    await setRecordingState(true);
    await setProcessingState(false);
    broadcastStatus();
    
    triggerSound('start');
    
    // Explicitly check for last error during message passing
    chrome.runtime.sendMessage({ 
      type: "START_RECORDING", 
      target: "offscreen",
      settings: settings
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[Whisper] Start failed (lastError):", chrome.runtime.lastError.message);
        setRecordingState(false);
        setProcessingState(false);
        broadcastStatus();
        if (sendResponse) sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      
      if (response && !response.success) {
        console.error("[Whisper] Start failed (offscreen error):", response.error);
        setRecordingState(false);
        setProcessingState(false);
        broadcastStatus();
      }
      
      if (sendResponse) sendResponse(response);
    });
  } catch (err) {
    console.error("[Whisper] Critical start error:", err.message);
    await setRecordingState(false);
    await setProcessingState(false);
    broadcastStatus();
    if (sendResponse) sendResponse({ success: false, error: err.message });
  }
}

async function handleStopRecording(sendResponse) {
  triggerSound('stop');
  chrome.runtime.sendMessage({ 
    type: "STOP_RECORDING", 
    target: "offscreen"
  }, (response) => {
    if (chrome.runtime.lastError) {
      setProcessingState(false);
      broadcastStatus();
      if (sendResponse) sendResponse({ success: false, error: chrome.runtime.lastError.message });
      return;
    }
    if (sendResponse) sendResponse(response);
  });
}
