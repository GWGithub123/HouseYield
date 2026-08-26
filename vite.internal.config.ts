import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isDev = mode !== 'production';
  const backendUrl = isDev
    ? (env.VITE_INTERNAL_BACKEND_URL || 'http://127.0.0.1:3001')
    : (env.VITE_PUSH_SERVER_URL || env.VITE_INTERNAL_BACKEND_URL || 'http://127.0.0.1:3001');

  return {
    root: path.resolve(__dirname, 'internal'),
    publicDir: path.resolve(__dirname, 'public'),
    envDir: path.resolve(__dirname),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      // Use localhost (not 127.0.0.1) — Firebase Auth allows localhost by default.
      host: 'localhost',
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': {
          target: backendUrl,
          timeout: 600000,
          proxyTimeout: 600000,
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, 'dist-internal'),
      emptyOutDir: true,
    },
  };
});
