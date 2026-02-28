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
let transcriptionHistory = []; // Persist only the latest 3 transcription results
let logHistory = [];
const MAX_LOGS = 100;

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "RECORDING_STATE_UPDATED",
    isRecording,
    isProcessing
  }).catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    port.onDisconnect.addListener(() => {
      console.log("Popup closed.");
    });
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-recording") {
    if (isRecording) {
      isRecording = false;
      isProcessing = true;
      handleStopRecording();
    } else {
      isRecording = true;
      isProcessing = false;
      logHistory = [];
      handleStartRecording();
    }
    broadcastStatus();
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
    sendResponse({ isRecording, isProcessing });
    return;
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
    isRecording = true;
    isProcessing = false;
    logHistory = [];
    handleStartRecording(sendResponse);
    broadcastStatus();
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    isRecording = false;
    isProcessing = true;
    handleStopRecording(sendResponse);
    broadcastStatus();
    return true;
  }

  if (message.type === "OFFSCREEN_TRANSCRIPTION_RESULT") {
    isProcessing = false;
    if (message.text) {
      transcriptionHistory.unshift(message.text);
      if (transcriptionHistory.length > 3) {
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
    triggerSound('start');
    chrome.runtime.sendMessage({ 
      type: "START_RECORDING", 
      target: "offscreen",
      settings: settings
    }, (response) => {
      if (sendResponse) sendResponse(response);
    });
  } catch (err) {
    if (sendResponse) sendResponse({ success: false, error: err.message });
  }
}

async function handleStopRecording(sendResponse) {
  triggerSound('stop');
  chrome.runtime.sendMessage({ 
    type: "STOP_RECORDING", 
    target: "offscreen"
  }, (response) => {
    if (sendResponse) sendResponse(response);
  });
}
