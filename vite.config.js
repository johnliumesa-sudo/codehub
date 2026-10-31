import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths so the build works from a GitHub Pages sub-path (/codehub/).
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2000 },
});
