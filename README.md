# Whisper Voice Input Chrome Extension

A privacy-focused, high-performance local AI voice input tool running entirely in your browser. Powered by Transformers.js and WebGPU acceleration, it provides fast and secure speech-to-text service.

## 🌟 Key Features

- **WebGPU Hardware Acceleration**: Leverages modern GPU performance to significantly boost Whisper model inference speeds.
- **Total Privacy**: All audio processing and AI inference are performed locally on your device. No data is ever uploaded to a server.
- **Premium UI/UX**: Clean Apple-inspired interface with smooth animations and real-time volume waveform visualization.
- **Multi-Model Support**: Supports a wide range of models from Base to Large-v3-Turbo, including the latest **Distil-Large-v3.5**.
- **Traditional Chinese Optimization**: Built-in OpenCC conversion ensures accurate Traditional Chinese output.
- **Efficient Workflow**:
  - `Alt + V`: Open the extension and start recording automatically.
  - `Space`: Press Space while recording to stop and begin transcription immediately.
  - **Auto-Copy**: Text is automatically copied to your clipboard once transcription is complete.

## 🛠 Tech Stack

- **Core Engine**: [@huggingface/transformers](https://huggingface.co/docs/transformers.js) (ONNX runtime)
- **Acceleration**: WebGPU (Primary)
- **Chinese Conversion**: OpenCC-js
- **Development**: Vite, Vanilla CSS

## 🚀 Quick Start

### Installation & Development
```bash
npm install
npm run build
```

### Loading the Extension
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable "**Developer mode**" in the top right corner.
3. Click "**Load unpacked**" and select the `dist/` folder from this project.

## 📂 Project Structure

- `src/popup/`: Main UI handling recording visualization, history, and clipboard logic.
- `src/options/`: Settings page for model switching, cache management, and usage instructions.
- `src/offscreen.js`: The core background layer handling audio recording and AI model inference.
- `src/background.js`: Manages extension lifecycle, background services, and global shortcut bindings.

## ⚠️ Important Notes

- **Initial Download**: When switching to a new model for the first time, weight files will be downloaded. Progress is displayed in the status bar. Models are cached in the browser's Cache Storage for instant subsequent launches.
- **Automatic Fallback**: If WebGPU is not supported by your hardware or if a model fails to load, the system automatically switches to **WASM + Quantized** mode to ensure functionality remains available.
- **Microphone Access**: You must grant microphone permission for the extension to work. It is recommended to perform a one-time authorization on the Settings page.
