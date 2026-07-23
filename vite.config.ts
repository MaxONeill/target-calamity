import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Fastify API listens on this port (see server/index.ts). During `vite dev`
// the browser talks to Vite on 5173 and same-origin `/api/*` calls are proxied
// here, so there is no CORS surface in development.
const API_PORT = 3001;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  // shared/ and src/ resolve via tsconfig "moduleResolution: bundler"; no aliases
  // needed as long as imports are relative or package-qualified.
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
