import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/popup.html'),
        options: resolve(__dirname, 'src/options/options.html'),
        offscreen_html: resolve(__dirname, 'src/offscreen.html'),
        background: resolve(__dirname, 'src/background.js'),
        offscreen: resolve(__dirname, 'src/offscreen.js'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (['background', 'offscreen'].includes(chunkInfo.name)) {
            return 'src/[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
