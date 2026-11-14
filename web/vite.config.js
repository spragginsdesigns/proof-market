import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  define: { 'process.env': {} },
  build: { outDir: fileURLToPath(new URL('../dist', import.meta.url)), emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: { port: 4150, host: '127.0.0.1' },
  preview: { port: 4151, host: '127.0.0.1' },
});
