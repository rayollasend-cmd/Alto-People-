import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    // Route-level lazy loading (see App.tsx) splits each page into its own
    // chunk. The chunks below pull shared vendor code into stable buckets so
    // it's downloaded once and cached across navigations.
    //
    // Heavy deps that only one route uses (face-api.js for /kiosk,
    // @dnd-kit/core for the template editor) intentionally fall through
    // into their own caller's chunk via the route's lazy() boundary.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@radix-ui')) return 'radix';
          if (id.includes('framer-motion')) return 'motion';
          // face-api.js is a 600+ KB ML library used only by the kiosk
          // punch flow. Naming the chunk so the build output isn't a
          // confusing second `index.js`.
          if (id.includes('/face-api.js/')) return 'face-api';
          // recharts is shared between the analytics donut and the
          // compliance scorecard donut — bucket it so it's downloaded
          // once and cached across both routes.
          if (id.includes('/recharts/') || id.includes('/d3-')) {
            return 'recharts';
          }
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router') ||
            id.includes('/scheduler/')
          ) {
            return 'react-vendor';
          }
        },
      },
    },
    // Bumped from default 500 KB. The kiosk chunk legitimately exceeds it
    // because of face-api.js — gating it behind a separate route chunk is
    // already the win we wanted; warning at every build adds noise.
    chunkSizeWarningLimit: 1000,
  },
});
