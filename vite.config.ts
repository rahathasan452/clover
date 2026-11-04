import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const studioPort = process.env.STUDIO_PORT ? parseInt(process.env.STUDIO_PORT, 10) : 8088;

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    open: false,
    cors: true,
    proxy: {
      '/api/studio': {
        target: `http://127.0.0.1:${studioPort}`,
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    include: ['pdfjs-dist', 'minisearch', 'idb-keyval', 'lucide-react'],
    exclude: ['@huggingface/transformers'],
  },
});
