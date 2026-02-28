const recordBtn = document.getElementById('recordBtn');
const statusText = document.getElementById('status');
const waveformCanvas = document.getElementById('waveformCanvas');
const outputList = document.getElementById('output-list'); // Container for history item list
const debugLog = document.getElementById('debug-log');
const toggleDebugBtn = document.getElementById('toggleDebug');
const copyLogsBtn = document.getElementById('copyLogsBtn');
const debugLogWrapper = document.getElementById('debug-log-wrapper');
const settingsBtn = document.getElementById('settingsBtn');
const modelInfoDiv = document.getElementById('modelInfo');
const langSelect = document.getElementById('langSelect');

let isRecording = false;
let isProcessing = false;
let isLoading = false;
let fileProgress = {};
let currentVolume = 0;
let animationId = null;

// --- Waveform Drawing Logic ---
const ctx = waveformCanvas.getContext('2d');
const barWidth = 4;
const barGap = 2;
let bars = Math.floor((waveformCanvas.width + barGap) / (barWidth + barGap));
let barHeights = new Array(bars).fill(2);

function drawWaveform() {
    ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
    const currentBars = Math.floor((waveformCanvas.width + barGap) / (barWidth + barGap));
    if (currentBars !== bars) {
        bars = currentBars;
        barHeights = new Array(bars).fill(2);
    }
    const totalContentWidth = bars * (barWidth + barGap) - barGap;
    const startX = (waveformCanvas.width - totalContentWidth) / 2;
    
    const time = Date.now() / 1000;

    for (let i = 0; i < bars; i++) {
        let target = 2;
        if (isRecording) {
            target = (currentVolume * 0.4 * (Math.random() * 0.4 + 0.6) + 3);
        } else if (isProcessing) {
            // Scanning wave effect during processing
            const wave = Math.sin(time * 5 + i * 0.3) * 0.5 + 0.5;
            target = 4 + wave * 8;
        }

        barHeights[i] = barHeights[i] * 0.7 + target * 0.3;
        const h = Math.round(barHeights[i]);
        const x = startX + i * (barWidth + barGap);
        const y = Math.round((waveformCanvas.height - h) / 2);
        
        if (isRecording) ctx.fillStyle = '#28cd41';
        else if (isProcessing) ctx.fillStyle = '#007aff';
        else ctx.fillStyle = '#ddd';
        
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, barWidth, h, 2);
        else ctx.rect(x, y, barWidth, h);
        ctx.fill();
    }
    animationId = requestAnimationFrame(drawWaveform);
}
drawWaveform();

const port = chrome.runtime.connect({ name: "popup" });

function updateButtonState(state) {
    // Ensure we clean up flags immediately
    if (state === 'idle') {
        isRecording = false;
        isProcessing = false;
        isLoading = false;
    } else if (state === 'loading') {
        isLoading = true;
        isRecording = false;
        isProcessing = false;
    } else if (state === 'recording') {
        isRecording = true;
        isLoading = false;
        isProcessing = false;
    } else if (state === 'processing') {
        isProcessing = true;
        isRecording = false;
        isLoading = false;
    }

    // Clear all state classes first
    recordBtn.classList.remove("recording", "working", "loading");

    switch (state) {
        case 'idle':
            recordBtn.disabled = false;
            recordBtn.textContent = "START";
            recordBtn.style.background = ""; // Clear inline styles to let CSS take over
            recordBtn.style.boxShadow = "";
            currentVolume = 0;
            break;
        case 'loading':
            recordBtn.disabled = true;
            recordBtn.textContent = "LOADING...";
            recordBtn.classList.add("loading");
            recordBtn.style.background = "linear-gradient(135deg, #666, #444)";
            recordBtn.style.boxShadow = "none";
            currentVolume = 0;
            break;
        case 'recording':
            recordBtn.disabled = false;
            recordBtn.textContent = "STOP";
            recordBtn.classList.add("recording");
            recordBtn.style.background = "linear-gradient(135deg, #32d74b, #28cd41)";
            recordBtn.style.boxShadow = "0 6px 20px rgba(40,205,65,0.4)";
            break;
        case 'processing':
            recordBtn.disabled = true;
            recordBtn.textContent = "WORKING...";
            recordBtn.classList.add("working");
            // Set styles immediately and synchronously
            recordBtn.style.background = "linear-gradient(135deg, #0a84ff, #007aff)";
            recordBtn.style.boxShadow = "0 6px 20px rgba(0, 122, 255, 0.4)";
            currentVolume = 0;
            break;
    }

    // Force reflow to ensure the browser commits these changes before any other heavy logic runs
    void recordBtn.offsetWidth;
}

function logToUI(msg, color = "#d4d4d4", timeStr = null) {
    const time = timeStr || new Date().toLocaleTimeString();
    const logItem = document.createElement('div');
    logItem.style.marginBottom = "2px";
    logItem.style.color = color;
    logItem.innerHTML = `<span style="color: #007aff">[${time}]</span> ${msg}`;
    debugLog.appendChild(logItem);
    debugLog.scrollTop = debugLog.scrollHeight;
}

// Render the list of transcription history
function renderHistory(history) {
    outputList.innerHTML = "";
    if (!history || history.length === 0) return;

    history.forEach((text, index) => {
        const div = document.createElement('div');
        div.className = "history-item";
        div.innerHTML = `
            <div>${text}</div>
            <button class="mini-copy-btn" data-text="${text.replace(/"/g, '&quot;')}" title="Copy to clipboard"></button>
        `;
        outputList.appendChild(div);
    });

    // Bind click events to mini copy buttons
    document.querySelectorAll('.mini-copy-btn').forEach(btn => {
        btn.onclick = (e) => {
            const txt = e.target.getAttribute('data-text');
            navigator.clipboard.writeText(txt).then(() => {
                // Background script will check enableSounds for us
                chrome.runtime.sendMessage({ type: "PLAY_SOUND_GLOBAL", soundType: "copy" }).catch(() => {});
                e.target.classList.add('copied');
                setTimeout(() => e.target.classList.remove('copied'), 2000);
            });
        };
    });
}

updateButtonState('idle');

Promise.all([
    new Promise(resolve => chrome.runtime.sendMessage({ type: "GET_STATUS" }, resolve)),
    new Promise(resolve => chrome.runtime.sendMessage({ type: "GET_MODEL_INFO", target: "offscreen" }, resolve)),
    new Promise(resolve => chrome.runtime.sendMessage({ type: "GET_UI_STATE" }, resolve)),
    chrome.storage.local.get({ language: 'en' })
]).then(([statusResponse, modelResponse, uiState, storage]) => {
    let lang = storage.language || 'en';
    if (lang === 'zh') lang = 'zh-tw';
    langSelect.value = lang;
    if (statusResponse && statusResponse.isRecording) {
        updateButtonState('recording');
        statusText.textContent = "Recording...";
    }
    if (modelResponse) {
        modelInfoDiv.textContent = `Model: ${modelResponse.model} (${modelResponse.device} ${modelResponse.dtype})`;
    }
    if (uiState) {
        renderHistory(uiState.transcriptionHistory);
        if (uiState.logHistory && uiState.logHistory.length > 0) {
            debugLog.innerHTML = "";
            uiState.logHistory.forEach(log => logToUI(log.msg, log.color, log.time));
        }
    }
});

langSelect.onchange = () => {
    chrome.storage.local.set({ language: langSelect.value });
};

recordBtn.addEventListener('click', () => {
    if (isRecording) stopRecording();
    else startRecording();
});

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || (e.altKey && e.key.toLowerCase() === 'v')) {
        if (isRecording) {
            e.preventDefault();
            stopRecording();
        }
    }
});

function startRecording() {
    // Fade the current top item to indicate a new recording session is starting
    const latestItem = outputList.querySelector('.history-item:first-child');
    if (latestItem) {
        latestItem.style.background = "#fafafa";
        latestItem.style.border = "1px solid #f5f5f7";
        latestItem.style.fontWeight = "400";
        latestItem.style.color = "#666";
        latestItem.style.fontSize = "13px";
        latestItem.style.paddingLeft = "16px";
        // Hide the blue indicator bar (remove the class that has the ::before)
        latestItem.classList.add('faded');
    }

    updateButtonState('recording');

    statusText.textContent = "Starting...";
    // Keep existing list visible; new result will be prepended when transcription finishes
    debugLog.innerHTML = "";
    chrome.runtime.sendMessage({ type: "START_RECORDING" }, (response) => {
        if (response && response.success) statusText.textContent = "Recording...";
        else {
            updateButtonState('idle');
            const error = response?.error || "Unknown error";
            if (error.includes('Permission') || error.includes('NotAllowedError') || error.includes('denied')) {
                statusText.innerHTML = `Microphone access denied.<br/><a href="#" id="fixPermission" style="color: #007aff; text-decoration: underline; font-weight: bold;">Click here to fix in Settings</a>`;
                document.getElementById('fixPermission').onclick = (e) => {
                    e.preventDefault();
                    chrome.runtime.openOptionsPage();
                };
            } else {
                statusText.textContent = "Error: " + error;
            }
        }
    });
}

function stopRecording() {
    updateButtonState('processing');
    statusText.textContent = "Processing...";
    chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "AUDIO_VOLUME") {
        currentVolume = message.volume;
    } else if (message.type === "LOG_DEBUG") {
        logToUI(message.msg, message.color);
    } else if (message.type === "LOAD_PROGRESS") {
        if (!isRecording) {
            updateButtonState('loading');
            fileProgress[message.file] = message.progress || 100;
            const files = Object.keys(fileProgress);
            const avgProgress = Math.round(Object.values(fileProgress).reduce((a, b) => a + b, 0) / files.length);
            statusText.textContent = `Loading Model: ${avgProgress}% (${files.filter(f => fileProgress[f] === 100).length}/${files.length} files)`;
        }
    } else if (message.type === "UPDATE_MODEL_INFO") {
        modelInfoDiv.textContent = `Model: ${message.model} (${message.device} ${message.dtype})`;
        fileProgress = {}; 
        if (isLoading) {
            updateButtonState('processing');
            statusText.textContent = "Processing...";
        } else if (!isRecording && !isProcessing) {
            updateButtonState('idle');
        }
    } else if (message.type === "TRANSCRIPTION_RESULT") {
        statusText.textContent = message.status || "Done!";
        
        // Update the UI list using the history data synchronized from background
        if (message.history) {
            renderHistory(message.history);
        }

        if (message.text) {
            logToUI("Transcription finished and auto-copied.", "#28cd41");
        }
        updateButtonState('idle');
    }
});

toggleDebugBtn.onclick = () => {
    const isHidden = !debugLogWrapper.style.display || debugLogWrapper.style.display === "none";
    debugLogWrapper.style.display = isHidden ? "block" : "none";
    toggleDebugBtn.textContent = isHidden ? "Hide Logs" : "Show Logs";
};

copyLogsBtn.onclick = () => {
    const logText = debugLog.innerText;
    navigator.clipboard.writeText(logText).then(() => {
        chrome.runtime.sendMessage({ type: "PLAY_SOUND_GLOBAL", soundType: "copy" }).catch(() => {});
        copyLogsBtn.classList.add('copied');
        setTimeout(() => {
            copyLogsBtn.classList.remove('copied');
        }, 2000);
    });
};

settingsBtn.onclick = () => chrome.runtime.openOptionsPage();
