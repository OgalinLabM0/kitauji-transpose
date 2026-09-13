import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { PRIVATE_DEV_FILES, privateDevFiles } from './scripts/dev-file-access';

export default defineConfig({
  root: '.',
  base: './',
  plugins: [privateDevFiles(), react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, fs: { strict: true, deny: PRIVATE_DEV_FILES } },
});
