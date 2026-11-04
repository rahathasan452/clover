import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const studioPort = process.env.STUDIO_PORT ? parseInt(process.env.STUDIO_PORT, 10) : 8088;

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'ignore-public-data-hmr',
      handleHotUpdate({ file }) {
        const norm = file.replace(/\\/g, '/');
        if (norm.includes('/public/data/') || norm.includes('/staging/') || norm.includes('/tools/')) {
          return [];
        }
      },
    },
  ],
  server: {
    port: 5173,
    open: false,
    cors: true,
    watch: {
      ignored: [
        '**/public/data/**',
        '**/staging/**',
        '**/tools/**',
        /[\\/]public[\\/]data[\\/]/,
        /[\\/]staging[\\/]/,
        /[\\/]tools[\\/]/,
        (file: string) => {
          const norm = file.replace(/\\/g, '/');
          return (
            norm.includes('/public/data/') ||
            norm.includes('/staging/') ||
            norm.includes('/tools/')
          );
        },
      ],
    },
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
