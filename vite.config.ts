import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    open: false,
    cors: true,
  },
  optimizeDeps: {
    include: ['pdfjs-dist', 'minisearch', 'idb-keyval', 'lucide-react'],
  },
});
