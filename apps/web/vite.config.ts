import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // .env lives at the repo root, shared with the API.
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const apiUrl = env.VITE_API_URL || 'http://localhost:4000';
  const adminUrl = env.VITE_ADMIN_API_URL || `http://localhost:${env.ADMIN_PORT || 4001}`;

  return {
    plugins: [react(), tailwind()],
    envDir: path.resolve(__dirname, '../..'),
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    // The shared package is TypeScript source, not a build artifact.
    optimizeDeps: { exclude: ['@paradocs/shared'] },
    build: {
      // The server admin page is a second page in the same build. The API serves
      // it only on the admin port.
      rolldownOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          admin: path.resolve(__dirname, 'admin.html'),
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        // The server admin API, on its own port. Listed before /api, which
        // would otherwise match it first.
        '/api/admin': { target: adminUrl, changeOrigin: true },
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
