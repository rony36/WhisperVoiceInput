console.log("Options JS script starting...");

// Fetch and display current keyboard shortcuts
const updateShortcuts = () => {
  chrome.commands.getAll((commands) => {
    const toggleCommand = commands.find(c => c.name === "toggle-recording");
    if (toggleCommand && toggleCommand.shortcut) {
      const el = document.getElementById('toggleShortcut');
      if (el) {
        el.textContent = toggleCommand.shortcut;
      }
    }
  });
};

// Saves options to chrome.storage
const saveOptions = () => {
  const model = document.getElementById('model').value;
  const language = document.getElementById('language').value;
  const enableSounds = document.getElementById('enableSounds').checked;

  console.log("Saving options to storage:", { model, language, enableSounds });
  
  chrome.storage.local.set(
    { model, language, enableSounds },
    () => {
      console.log("Storage save callback fired.");
      // Update status to let user know options were saved.
      const status = document.getElementById('status');
      if (status) {
        status.style.display = 'block';
        setTimeout(() => {
          status.style.display = 'none';
        }, 2000);
      }
    }
  );
};

// Restores select box and checkbox state using the preferences
// stored in chrome.storage.
const restoreOptions = () => {
  console.log("Restoring options from storage...");
  chrome.storage.local.get(
    { model: 'onnx-community/whisper-large-v3-turbo', language: 'en', enableSounds: true },
    (items) => {
      console.log("Loaded items:", items);
      // Fallback for old 'zh' value if it exists
      let lang = items.language;
      if (lang === 'zh') lang = 'zh-tw';
      
      document.getElementById('model').value = items.model;
      document.getElementById('language').value = lang;
      document.getElementById('enableSounds').checked = items.enableSounds;
    }
  );
};

// --- Cache Management Logic ---
const updateCacheList = async () => {
    const cacheStatus = document.getElementById('cacheStatus');
    const cacheList = document.getElementById('cacheList');
    cacheStatus.textContent = "Scanning CacheStorage...";
    cacheList.innerHTML = "";

    try {
        const cache = await caches.open('transformers-cache');
        const keys = await cache.keys();
        const modelStats = {};

        for (const request of keys) {
            const url = request.url;
            const match = url.match(/huggingface\.co\/([^\/]+\/[^\/]+)/);
            if (match) {
                const modelId = match[1];
                const response = await cache.match(request);
                const blob = await response.blob();
                
                if (!modelStats[modelId]) {
                    modelStats[modelId] = { size: 0, files: 0 };
                }
                modelStats[modelId].size += blob.size;
                modelStats[modelId].files += 1;
            }
        }

        const modelIds = Object.keys(modelStats);
        if (modelIds.length === 0) {
            cacheStatus.textContent = "No models cached locally.";
            return;
        }

        cacheStatus.textContent = `Found ${modelIds.length} cached model(s):`;
        
        modelIds.forEach(id => {
            const stats = modelStats[id];
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
            
            const div = document.createElement('div');
            div.className = "cache-item";
            div.innerHTML = `
                <div style="flex: 1; padding-right: 15px;">
                    <div style="font-weight: bold; color: var(--text-main); margin-bottom: 2px;">${id}</div>
                    <div style="color: var(--text-secondary); font-size: 11px;">${stats.files} files · ${sizeMB} MB</div>
                </div>
                <button class="delete-cache" data-id="${id}" style="background: var(--danger-color); padding: 6px 14px; font-size: 12px; min-width: 80px;">Delete</button>
            `;
            cacheList.appendChild(div);
        });

        document.querySelectorAll('.delete-cache').forEach(btn => {
            btn.onclick = async (e) => {
                const id = e.target.getAttribute('data-id');
                if (confirm(`Are you sure you want to delete all cached files for ${id}?`)) {
                    await deleteModelCache(id);
                }
            };
        });

    } catch (err) {
        console.error("Cache scanning failed:", err);
        cacheStatus.textContent = "Error scanning cache: " + err.message;
    }
};

const deleteModelCache = async (modelId) => {
    try {
        const cache = await caches.open('transformers-cache');
        const keys = await cache.keys();
        let deletedCount = 0;

        for (const request of keys) {
            if (request.url.includes(modelId)) {
                await cache.delete(request);
                deletedCount++;
            }
        }
        console.log(`Deleted ${deletedCount} files for ${modelId}`);
        updateCacheList();
    } catch (err) {
        alert("Failed to delete cache: " + err.message);
    }
};

// Check and grant microphone permission
const checkMicPermission = async () => {
  const micWarning = document.getElementById('micWarning');
  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    console.log("Current mic permission state:", result.state);
    
    if (result.state === 'granted') {
      micWarning.style.display = 'none';
    } else {
      micWarning.style.display = 'block';
    }
    
    // Auto-update if user changes it in site settings
    result.onchange = () => {
        checkMicPermission();
    };
  } catch (err) {
    console.error("Mic permission check error:", err);
    // If query fails, it's safer to show the warning if we can't confirm it's granted
    micWarning.style.display = 'block';
  }
};

document.getElementById('grantMic').addEventListener('click', async () => {
  console.log("Grant mic button clicked.");
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    checkMicPermission();
  } catch (err) {
    console.error("getUserMedia error:", err);
    alert('Error granting permission: ' + err.message);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  console.log("DOM Content Loaded.");
  restoreOptions();
  checkMicPermission();
  updateCacheList();
  updateShortcuts();

  // Attach auto-save listeners to all configuration fields
  ['model', 'language', 'enableSounds'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('change', saveOptions);
  });
});

document.getElementById('refreshCache').addEventListener('click', updateCacheList);

document.getElementById('chromeShortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
