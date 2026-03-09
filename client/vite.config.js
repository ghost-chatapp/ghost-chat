import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:3000',
      '/messages': 'http://localhost:3000',
      '/friends': 'http://localhost:3000',
      '/world': 'http://localhost:3000',
      '/groups': 'http://localhost:3000',
    },
  },
  build: {
    sourcemap: false, // No source maps in production
    rollupOptions: {
      output: {
        manualChunks: {
          crypto: ['tweetnacl', 'tweetnacl-util'],
          socket: ['socket.io-client'],
          db: ['idb'],
        },
      },
    },
  },
});
