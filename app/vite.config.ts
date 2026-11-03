import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The laptop server (server/, port 8787) holds the records. The dev server proxies
// /api to it, so the app and the API share one origin (no CORS, no token in URLs).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/ws': { target: 'ws://localhost:8787', ws: true } },
    fs: { allow: ['..'] },   // the lung model lives in ../models
  },
});
