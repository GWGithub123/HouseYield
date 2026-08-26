import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Allow ngrok and cloudflare hosts for mobile testing
    allowedHosts: [
      '.ngrok-free.app', 
      '.ngrok-free.dev',
      '.ngrok.io',
      '.ngrok.app',
      '.trycloudflare.com'
    ],
    // Lock down filesystem access — prevent serving .env, server code, etc.
    fs: {
      deny: ['.env', '.env.*', '.git', 'server', 'firestore.rules', 'firestore.indexes.json', 'firebase.json'],
    },
    headers: {
      // Prevent caching for development
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      // Allow Firebase Auth popups to work properly
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Cross-Origin-Embedder-Policy': 'unsafe-none'
    },
    proxy: {
      '/service-search': {
        target: 'http://127.0.0.1:3001',
        timeout: 600000, // 10 minutes for long requests
      },
      '/api': {
        target: 'http://127.0.0.1:3001',
        timeout: 600000, // 10 minutes for long requests like stitching
        proxyTimeout: 600000
      },
      // Proxy static files (floor overlays, etc) to backend
      '/floor-overlays': {
        target: 'http://127.0.0.1:3001'
      },
      // Proxy edited meshes to backend (mesh editing creates files on backend)
      '/edited-meshes': {
        target: 'http://127.0.0.1:3001'
      },
      // Proxy to local Playwright automation server so the browser can call it
      // without tripping site CSP (connect-src 'self'). Run server on 3055.
      '/automation': {
        target: 'http://127.0.0.1:3055',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/automation/, '')
      }
    }
  }
})
