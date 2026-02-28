import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/popup.html'),
        options: resolve(__dirname, 'src/options/options.html'),
        offscreen: resolve(__dirname, 'src/offscreen.html'),
        background: resolve(__dirname, 'src/background.js'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (['background'].includes(chunkInfo.name)) {
            return 'src/[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
