import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The laptop server (server/, port 8787) holds the records. The dev server proxies
// /api to it, so the app and the API share one origin (no CORS, no token in URLs).
// PNEUMO_API points it at another server, e.g. a throwaway demo one.
const API = process.env.PNEUMO_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': API, '/ws': { target: API.replace(/^http/, 'ws'), ws: true } },
    fs: { allow: ['..'] },   // the lung model lives in ../models
  },
});
