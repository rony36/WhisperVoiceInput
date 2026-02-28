const recordBtn = document.getElementById('recordBtn');
const statusText = document.getElementById('status');
const waveformCanvas = document.getElementById('waveformCanvas');
const outputList = document.getElementById('output-list'); // 改為清單容器
const debugLog = document.getElementById('debug-log');
const toggleDebugBtn = document.getElementById('toggleDebug');
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
let closeTimer = null;

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
    for (let i = 0; i < bars; i++) {
        const target = isRecording ? (currentVolume * 0.4 * (Math.random() * 0.4 + 0.6) + 3) : 2;
        barHeights[i] = barHeights[i] * 0.7 + target * 0.3;
        const h = Math.round(barHeights[i]);
        const x = startX + i * (barWidth + barGap);
        const y = Math.round((waveformCanvas.height - h) / 2);
        ctx.fillStyle = isRecording ? '#28cd41' : '#ddd';
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

    switch (state) {
        case 'idle':
            recordBtn.disabled = false;
            recordBtn.textContent = "START";
            recordBtn.classList.remove("recording", "working");
            recordBtn.style.background = "#ff3b30";
            recordBtn.style.boxShadow = "0 6px 16px rgba(255,59,48,0.3)";
            recordBtn.style.cursor = "pointer";
            recordBtn.style.opacity = "1";
            currentVolume = 0;
            break;
        case 'loading':
            recordBtn.disabled = true;
            recordBtn.textContent = "LOADING...";
            recordBtn.classList.remove("recording");
            recordBtn.classList.add("working");
            recordBtn.style.background = "#555";
            recordBtn.style.boxShadow = "none";
            recordBtn.style.cursor = "not-allowed";
            currentVolume = 0;
            break;
        case 'recording':
            recordBtn.disabled = false;
            recordBtn.textContent = "STOP";
            recordBtn.classList.add("recording");
            recordBtn.classList.remove("working");
            recordBtn.style.background = "#28cd41";
            recordBtn.style.boxShadow = "0 6px 20px rgba(40,205,65,0.4)";
            recordBtn.style.cursor = "pointer";
            recordBtn.style.opacity = "1";
            break;
        case 'processing':
            isProcessing = true;
            recordBtn.style.background = "#0071e3";
            recordBtn.disabled = true;
            recordBtn.textContent = "PROCESSING...";
            recordBtn.classList.remove("recording");
            recordBtn.classList.add("working");
            recordBtn.style.boxShadow = "0 4px 12px rgba(0,113,227,0.3)";
            recordBtn.style.cursor = "not-allowed";
            currentVolume = 0;
            break;
    }
}

function logToUI(msg, color = "#d4d4d4", timeStr = null) {
    const time = timeStr || new Date().toLocaleTimeString();
    const logItem = document.createElement('div');
    logItem.style.marginBottom = "2px";
    logItem.style.color = color;
    logItem.innerHTML = `<span style="color: #569cd6">[${time}]</span> ${msg}`;
    debugLog.appendChild(logItem);
    debugLog.scrollTop = debugLog.scrollHeight;
}

// 渲染歷史紀錄清單
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

    // 綁定複製按鈕
    document.querySelectorAll('.mini-copy-btn').forEach(btn => {
        btn.onclick = (e) => {
            const txt = e.target.getAttribute('data-text');
            navigator.clipboard.writeText(txt).then(() => {
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
    langSelect.value = storage.language || 'en';
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
    if (!statusResponse?.isRecording && !isProcessing && !isLoading) {
        setTimeout(startRecording, 100);
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
    if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
    }

    // 將現有的最新紀錄變淺，為新結果騰出空間
    const latestItem = outputList.querySelector('.history-item:first-child');
    if (latestItem) {
        latestItem.style.background = "#fafafa";
        latestItem.style.border = "1px solid #f5f5f5";
        latestItem.style.fontWeight = "400";
        latestItem.style.color = "#666";
        latestItem.style.fontSize = "13px";
        latestItem.style.paddingLeft = "16px";
        // 隱藏藍色邊條 (透過將 width 設為 0)
        latestItem.style.setProperty('--pseudo-width', '0'); 
    }

    updateButtonState('recording');

    statusText.textContent = "Starting...";
    // outputList 不需要立刻清空，錄音完才會推入新項
    debugLog.innerHTML = "";
    chrome.runtime.sendMessage({ type: "START_RECORDING" }, (response) => {
        if (response && response.success) statusText.textContent = "Recording...";
        else {
            updateButtonState('idle');
            statusText.textContent = "Error: " + (response?.error || "Unknown");
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
        
        // 直接使用訊息中帶來的最新歷史紀錄
        if (message.history) {
            renderHistory(message.history);
        }

        if (message.text) {
            navigator.clipboard.writeText(message.text)
                .then(() => {
                    logToUI("Auto-copied to clipboard.", "#4ec9b0");
                    chrome.storage.local.get({ closeDelay: 2 }, (items) => {
                        const delayMs = items.closeDelay * 1000;
                        if (delayMs === 0) window.close();
                        else {
                            if (closeTimer) clearTimeout(closeTimer);
                            closeTimer = setTimeout(() => { window.close(); }, delayMs);
                        }
                    });
                });
        }
        updateButtonState('idle');
    }
});

toggleDebugBtn.onclick = () => {
    const isHidden = !debugLogWrapper.style.display || debugLogWrapper.style.display === "none";
    debugLogWrapper.style.display = isHidden ? "block" : "none";
    toggleDebugBtn.textContent = isHidden ? "Hide Logs" : "Show Logs";
};

settingsBtn.onclick = () => chrome.runtime.openOptionsPage();
