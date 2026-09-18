import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev server, proxied to the API.
 *
 * Everything under /api and /health is forwarded to the API process, so
 * the browser only ever talks to one origin. That is not just
 * convenience: the refresh token is an httpOnly cookie scoped to
 * /api/v1/auth, and a cross-origin setup would need SameSite=None plus a
 * CSRF token to carry it. Same-origin in development keeps the cookie
 * behaving exactly as it will in production, where the API serves this
 * build itself.
 *
 * Port 5174, not 5173 - another project on this machine already owns
 * 5173, and two dev servers fighting over a port is a confusing half
 * hour nobody needs.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
      '/health': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
