import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  define: {
    'global': 'globalThis',
  },
  server: {
    hmr: { host: '127.0.0.1' },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
