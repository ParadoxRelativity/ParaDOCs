import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // .env lives at the repo root, shared with the API.
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const apiUrl = env.VITE_API_URL || 'http://localhost:4000';

  return {
    plugins: [react(), tailwind()],
    envDir: path.resolve(__dirname, '../..'),
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    // The shared package is TypeScript source, not a build artifact.
    optimizeDeps: { exclude: ['@paradocs/shared'] },
    server: {
      port: 5173,
      proxy: {
        // Same-origin in dev so the session cookie behaves exactly as in production.
        '/api': { target: apiUrl, changeOrigin: true },
        '/uploads': { target: apiUrl, changeOrigin: true },
        // Collaboration and chat websockets. Same origin so the session cookie
        // is sent with the handshake.
        '/collab': { target: apiUrl, ws: true, changeOrigin: true },
        '/chat': { target: apiUrl, ws: true, changeOrigin: true },
        // Voice signalling, which the API relays to LiveKit.
        '/rtc': { target: apiUrl, ws: true, changeOrigin: true },
      },
    },
  };
});
