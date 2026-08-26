import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isDev = mode !== 'production';
  const backendUrl = isDev
    ? (env.VITE_MAINTENANCE_BACKEND_URL || env.VITE_INTERNAL_BACKEND_URL || 'http://127.0.0.1:3001')
    : (env.VITE_PUSH_SERVER_URL || env.VITE_MAINTENANCE_BACKEND_URL || 'http://127.0.0.1:3001');

  return {
    root: path.resolve(__dirname, 'maintenance'),
    publicDir: path.resolve(__dirname, 'public'),
    envDir: path.resolve(__dirname),
    plugins: [react()],
    define: {
      'import.meta.env.VITE_PRODUCT_MODE': JSON.stringify('maintenance'),
      // Local maintenance UI should talk through the Vite /api proxy, not Cloud Run.
      // (Avoids CORS failures from http://localhost:5175 → *.run.app)
      ...(isDev ? { 'import.meta.env.VITE_PUSH_SERVER_URL': JSON.stringify('') } : {}),
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      // Bind IPv4+IPv6 so http://localhost:5175 and http://127.0.0.1:5175 both work.
      // host:'localhost' often binds only [::1] on macOS, which breaks module fetches
      // when the browser resolves localhost → 127.0.0.1 (classic "Failed to fetch
      // dynamically imported module" for lazy routes like PortfolioPage).
      host: true,
      port: 5175,
      strictPort: true,
      allowedHosts: [
        '.ngrok-free.app',
        '.ngrok-free.dev',
        '.ngrok.io',
        '.ngrok.app',
        '.trycloudflare.com',
      ],
      fs: {
        allow: [path.resolve(__dirname)],
        deny: ['.env', '.env.*', '.git', 'server', 'firestore.rules', 'firestore.indexes.json', 'firebase.json'],
      },
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
        'Cross-Origin-Embedder-Policy': 'unsafe-none',
      },
      proxy: {
        '/api': {
          target: backendUrl,
          timeout: 600000,
          proxyTimeout: 600000,
        },
        '/service-search': {
          target: backendUrl,
          timeout: 600000,
        },
        '/floor-overlays': {
          target: backendUrl,
        },
        '/edited-meshes': {
          target: backendUrl,
        },
        '/auth': {
          target: backendUrl,
        },
        '/healthz': {
          target: backendUrl,
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, 'dist-maintenance'),
      emptyOutDir: true,
    },
  };
});
