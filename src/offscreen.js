import { pipeline, env } from "@huggingface/transformers";
import * as OpenCC from "opencc-js";

// Configure environment for extension
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true; // Critical: Enable browser caching to speed up model loading on subsequent runs

// Point to local assets for ONNX Runtime
const wasmBase = chrome.runtime.getURL('assets/transformers/');
env.backends.onnx.wasm.wasmPaths = {
    'ort-wasm-simd-threaded.jsep.wasm': wasmBase + 'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.wasm': wasmBase + 'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.jsep.mjs': wasmBase + 'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.mjs': wasmBase + 'ort-wasm-simd-threaded.mjs',
};

const converters = {
    'zh-tw': OpenCC.Converter({ from: "cn", to: "tw" }),
    'zh-cn': OpenCC.Converter({ from: "tw", to: "cn" })
};

let recorder = null;
let audioChunks = [];
let audioContext = null;
let stream = null;

const maybeConvert = (text, targetLang) => {
    if (text && /[\u4e00-\u9fa5]/.test(text)) {
        const converter = converters[targetLang];
        if (converter) return converter(text);
    }
    return text;
};

function logDebug(msg, color = "#d4d4d4") {
    console.log(`[DEBUG] ${msg}`);
    chrome.runtime.sendMessage({ type: "LOG_DEBUG", msg, color }).catch(() => {});
}

/**
 * Simple Energy-based VAD to filter out silence
 */
function filterSilence(audioData, sampleRate = 16000) {
    const threshold = 0.01; 
    const chunkSize = Math.floor(sampleRate * 0.1); 
    const padding = Math.floor(sampleRate * 0.4); 
    
    let speechSegments = [];
    let isSpeech = false;
    let lastSpeechEnd = -1;

    for (let i = 0; i < audioData.length; i += chunkSize) {
        let sum = 0;
        const end = Math.min(i + chunkSize, audioData.length);
        for (let j = i; j < end; j++) {
            sum += Math.abs(audioData[j]);
        }
        const avg = sum / (end - i);

        if (avg > threshold) {
            if (!isSpeech) {
                const start = Math.max(0, i - padding);
                speechSegments.push({ start });
                isSpeech = true;
            }
            lastSpeechEnd = end;
        } else if (isSpeech && (i - lastSpeechEnd) > padding) {
            speechSegments[speechSegments.length - 1].end = Math.min(audioData.length, lastSpeechEnd + padding);
            isSpeech = false;
        }
    }

    if (isSpeech) {
        speechSegments[speechSegments.length - 1].end = audioData.length;
    }

    if (speechSegments.length === 0) return new Float32Array(0);

    let totalLength = speechSegments.reduce((acc, seg) => acc + (seg.end - seg.start), 0);
    let result = new Float32Array(totalLength);
    let offset = 0;
    for (let seg of speechSegments) {
        result.set(audioData.subarray(seg.start, seg.end), offset);
        offset += (seg.end - seg.start);
    }
    return result;
}

/**
 * Centralized Model Configurations
 * Explicitly define settings for every supported model_id
 */
const MODELS_CONFIG = {
    'onnx-community/distil-large-v3.5-ONNX': {
        loader: { device: 'webgpu', dtype: 'fp16' },
        inference: {
            chunk_length_s: 25,
            stride_length_s: 5,
            max_new_tokens: 1024,
            batch_size: 4,
            num_beams: 1,
            repetition_penalty: 1.1,
	    return_timestamps: false,
            no_repeat_ngram_size: 3
        }
    },
    'onnx-community/whisper-large-v3-turbo': {
        loader: { device: 'webgpu', dtype: 'fp16' },
        inference: {
            chunk_length_s: 30,
            stride_length_s: 5,
            max_new_tokens: 448, // 448 tokens is usually sufficient for common voice inputs
            batch_size: 1, // Single stream processing: Batch size 1 is optimal for real-time inference
            num_beams: 1,
            repetition_penalty: 1.0, // Turbo models handle repetitions well; penalty 1.0 is adequate
            return_timestamps: false,
            no_repeat_ngram_size: 3
        }
    },
    'onnx-community/whisper-small': {
        loader: { device: 'webgpu', dtype: 'fp32' },
        inference: {
            chunk_length_s: 30,
            stride_length_s: 5,
            max_new_tokens: 1024,
            batch_size: 4,
            num_beams: 1,
            repetition_penalty: 1.1,
	    return_timestamps: false,
            no_repeat_ngram_size: 3
        }
    },
    'onnx-community/whisper-base': {
        loader: { device: 'webgpu', dtype: 'fp32' },
        inference: {
            chunk_length_s: 30,
            stride_length_s: 5,
            max_new_tokens: 1024,
            batch_size: 4,
            num_beams: 1,
            repetition_penalty: 1.1,
	    return_timestamps: false,
            no_repeat_ngram_size: 3
        }
    },
    'onnx-community/moonshine-base-ONNX': {
        loader: { device: 'webgpu', dtype: 'fp32' },
        inference: {
            chunk_length_s: 30,
            stride_length_s: 5,
            max_new_tokens: 1024,
            batch_size: 4,
            num_beams: 1,
            repetition_penalty: 1.1,
            no_repeat_ngram_size: 3
        }
    },
    'onnx-community/moonshine-base-zh-ONNX': {
        loader: { device: 'webgpu', dtype: 'fp32' },
        inference: {
            chunk_length_s: 30,
            stride_length_s: 5,
            max_new_tokens: 1024,
            batch_size: 4,
            num_beams: 1,
            repetition_penalty: 1.1,
            no_repeat_ngram_size: 3
        }
    }
};

let transcriber = null;
let activeDevice = "Unknown";
let activeDtype = "Unknown";
let currentSettings = null;
let modelLoadingPromise = null;

// --- Sound Effects Logic ---
const effectCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSound(type) {
    const now = effectCtx.currentTime;
    
    const playTone = (freq, start, duration, waveType = 'sine', volume = 0.1) => {
        const osc = effectCtx.createOscillator();
        const g = effectCtx.createGain();
        osc.type = waveType;
        osc.frequency.setValueAtTime(freq, start);
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(volume, start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        osc.connect(g);
        g.connect(effectCtx.destination);
        osc.start(start);
        osc.stop(start + duration);
    };

    switch (type) {
        case 'start':
            // Modern "blip-up" (E5 to A5)
            playTone(659.25, now, 0.12, 'sine', 0.08);
            playTone(880.00, now + 0.06, 0.15, 'sine', 0.07);
            break;
        case 'stop':
            // Modern "blip-down" (A5 to E5)
            playTone(880.00, now, 0.12, 'sine', 0.08);
            playTone(659.25, now + 0.06, 0.15, 'sine', 0.07);
            break;
        case 'copy':
            // Longer, relaxed "Dudu" Pulse (C4 to E4) - More substantial feel
            playTone(261.63, now, 0.25, 'sine', 0.1); // C4 (Longer)
            playTone(329.63, now + 0.15, 0.35, 'sine', 0.08); // E4 (Even longer tail)
            break;
        case 'error':
            // Quick, low double-thud (G2 to G2)
            playTone(98.00, now, 0.1, 'triangle', 0.15);
            playTone(98.00, now + 0.12, 0.1, 'triangle', 0.15);
            break;
    }
}

async function getTranscriber(modelId) {
    if (!modelId) return null;

    const currentId = transcriber ? transcriber.modelId : 'none';
    if (currentId === modelId) {
        return transcriber;
    }

    logDebug(`Model switch needed: ${currentId} -> ${modelId}`, "#ffcc00");

    if (modelLoadingPromise && modelLoadingPromise.modelId === modelId) {
        return modelLoadingPromise;
    }

    modelLoadingPromise = (async () => {
        logDebug(`Loading model: ${modelId}...`, "#9cdcfe");

        try {
            const modelCfg = MODELS_CONFIG[modelId] || { loader: { device: 'webgpu' } };
            
            let config = {
                ...modelCfg.loader,
                progress_callback: (data) => {
                    if (data.status === 'initiate') {
                        logDebug(`Download started: ${data.file.split('/').pop()}`, "#9cdcfe");
                    } else if (data.status === 'done') {
                        logDebug(`Download finished: ${data.file.split('/').pop()}`, "#4ec9b0");
                    }
                    
                    if (data.status === 'progress' || data.status === 'done') {
                        chrome.runtime.sendMessage({ 
                            type: "LOAD_PROGRESS", 
                            file: data.file, 
                            progress: data.progress,
                            status: data.status
                        }).catch(() => {});
                    }
                }
            };

            const p = await pipeline("automatic-speech-recognition", modelId, config);
            activeDevice = config.device === 'webgpu' ? "GPU (WebGPU)" : "CPU (WASM)";
            activeDtype = config.dtype || "fp32";
            
            p.modelId = modelId;
            transcriber = p;
            logDebug(`Model loaded on ${activeDevice} (${activeDtype})!`, "#4ec9b0");
            
            chrome.runtime.sendMessage({
                type: "UPDATE_MODEL_INFO",
                model: modelId.split('/').pop(),
                device: activeDevice,
                dtype: activeDtype
            }).catch(() => {});

            return p;
        } finally {
            modelLoadingPromise = null;
        }
    })();
    
    modelLoadingPromise.modelId = modelId;
    return modelLoadingPromise;
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== "offscreen") return;

    if (message.type === "START_RECORDING") {
        currentSettings = message.settings;
        logDebug(`Settings received: model=${currentSettings?.model}, lang=${currentSettings?.language}`);
        startRecording(message.settings, sendResponse);
        return true;
    } else if (message.type === "STOP_RECORDING") {
        stopRecording(currentSettings, sendResponse);
        return true;
    } else if (message.type === "PLAY_SOUND") {
        playSound(message.soundType);
        if (sendResponse) sendResponse({ success: true });
        return false;
    } else if (message.type === "GET_MODEL_INFO") {
        if (transcriber) {
            sendResponse({
                model: transcriber.modelId.split('/').pop(),
                device: activeDevice,
                dtype: activeDtype
            });
        } else {
            sendResponse(null);
        }
        return false;
    } else if (message.type === "PREWARM_MODEL") {
        currentSettings = message.settings;
        getTranscriber(message.settings.model);
        sendResponse({ success: true });
        return false;
    }
    });
async function startRecording(settings, sendResponse) {
    try {
        logDebug("--- New Session Started ---", "#dcdcaa");
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        audioChunks = [];
        
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 32;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const interval = setInterval(() => {
            if (!recorder || recorder.state !== "recording") {
                clearInterval(interval);
                return;
            }
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            const volume = Math.min(100, Math.round((sum / dataArray.length) / 128 * 100));
            chrome.runtime.sendMessage({ type: "AUDIO_VOLUME", volume }).catch(() => {});
        }, 50);

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };
        
        recorder.start();
        logDebug("Recording started...");
        if (sendResponse) sendResponse({ success: true });
    } catch (err) {
        logDebug(`Recording failed: ${err.message}`, "#f44747");
        if (sendResponse) sendResponse({ success: false, error: err.message });
    }
}

// --- Clipboard Logic ---
async function copyToClipboard(text) {
    if (!text) return;
    try {
        // Method 1: Modern Clipboard API
        await navigator.clipboard.writeText(text);
        logDebug("Copied using navigator.clipboard", "#28cd41");
    } catch (err) {
        logDebug("navigator.clipboard failed, trying execCommand fallback", "#ffcc00");
        // Method 2: Legacy execCommand('copy') - often more reliable in background contexts
        try {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            const success = document.execCommand('copy');
            document.body.removeChild(textArea);
            if (success) {
                logDebug("Copied using execCommand fallback", "#28cd41");
            } else {
                throw new Error("execCommand('copy') returned false");
            }
        } catch (fallbackErr) {
            logDebug(`All clipboard methods failed: ${fallbackErr.message}`, "#f44747");
        }
    }
}

async function stopRecording(settings, sendResponse) {
    if (!recorder || recorder.state === "inactive") {
        if (sendResponse) sendResponse({ success: false, error: "No active recorder" });
        return;
    }

    // Acknowledge immediate stop command
    if (sendResponse) sendResponse({ success: true });

    recorder.onstop = async () => {
        logDebug("Recording stopped, processing...");
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        
        try {
            const totalStart = performance.now();

            // 1. Audio Decoding
            const decodeStart = performance.now();
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioCtx = new AudioContext({ sampleRate: 16000 });
            const decoded = await audioCtx.decodeAudioData(arrayBuffer);
            let audioData = decoded.getChannelData(0);
            await audioCtx.close(); // Clean up decoding context
            const decodeEnd = performance.now();
            logDebug(`[Perf] Audio Decode: ${Math.round(decodeEnd - decodeStart)}ms`, "#d19a66");

            const originalDuration = audioData.length / 16000;
            
            // 2. VAD (Silence Filtering)
            const vadStart = performance.now();
            audioData = filterSilence(audioData, 16000);
            const vadEnd = performance.now();
            logDebug(`[Perf] VAD Process: ${Math.round(vadEnd - vadStart)}ms (${originalDuration.toFixed(1)}s -> ${(audioData.length/16000).toFixed(1)}s)`, "#d19a66");

            if (audioData.length === 0) {
                logDebug("No speech detected.");
                chrome.runtime.sendMessage({ 
                    type: "OFFSCREEN_TRANSCRIPTION_RESULT", 
                    text: "",
                    status: "No speech detected" 
                }).catch(() => {});
                return;
            }

            // 3. Model Retrieval / Pre-warm check
            const modelStart = performance.now();
            const p = await getTranscriber(settings.model);
            const modelEnd = performance.now();
            logDebug(`[Perf] Model Ready: ${Math.round(modelEnd - modelStart)}ms`, "#d19a66");

            // 4. Core AI Inference
            logDebug(`Inference started...`, "#9cdcfe");
            logDebug(`Running on: ${p.modelId} (${activeDevice} ${activeDtype})`, "#9cdcfe");
            
            const inferStart = performance.now();
            const modelCfg = MODELS_CONFIG[p.modelId] || { inference: {} };
            const inferenceSettings = modelCfg.inference || {};
            
            // Map our internal language codes to Whisper's codes
            let whisperLanguage = settings.language;
            if (whisperLanguage === "zh-tw" || whisperLanguage === "zh-cn") {
                whisperLanguage = "chinese";
            } else if (whisperLanguage === "auto") {
                whisperLanguage = null;
            }

            const output = await p(audioData, {
                language: whisperLanguage,
                task: "transcribe",
                ...inferenceSettings
            });
            const inferEnd = performance.now();
            
            const totalEnd = performance.now();
            const transcribedText = maybeConvert(output.text, settings.language);
            
            logDebug(`[Perf] Core Inference: ${Math.round(inferEnd - inferStart)}ms`, "#4ec9b0");
            logDebug(`[Perf] TOTAL TIME: ${Math.round(totalEnd - totalStart)}ms`, "#4ec9b0");
            logDebug(`Result: ${transcribedText}`);

            // Copy to clipboard directly from offscreen context
            await copyToClipboard(transcribedText);

            // Push final transcription result to the popup via runtime message
            chrome.runtime.sendMessage({ 
                type: "OFFSCREEN_TRANSCRIPTION_RESULT", 
                text: transcribedText 
            }).catch(() => {});

        } catch (err) {
            logDebug(`Error: ${err.message}`, "#f44747");
            // Critical: Always notify the background that we've finished, even if failed.
            chrome.runtime.sendMessage({ 
                type: "OFFSCREEN_TRANSCRIPTION_RESULT", 
                text: "",
                status: "Error: " + err.message
            }).catch(() => {});
        } finally {
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
                stream = null;
            }
            if (audioContext) {
                if (audioContext.state !== 'closed') {
                    audioContext.close().catch(e => console.log("AudioContext close error:", e));
                }
                audioContext = null;
            }
            recorder = null;
        }
    };

    recorder.stop();
}
