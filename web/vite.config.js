import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.SM_APP_BACKEND || 'http://127.0.0.1:3939';

export default defineConfig({
  plugins: [react()],
  root: new URL('.', import.meta.url).pathname,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND,
        // The backend validates Host strictly; the browser's Host
        // (127.0.0.1:5173) must be rewritten to the backend's own
        // authority or every proxied request is rejected with 403.
        // Origin is forwarded untouched so the exact development origin
        // allowlist still applies.
        changeOrigin: true,
      },
    },
  },
});
