import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths so the build works from a GitHub Pages sub-path (/codehub/).
  base: './',
  plugins: [react()],
  // The start-up chunk carries CodeMirror's core (shop editor themes), the emoji data, Firebase and the
  // round 3 feature registrations (about 2.3 MB minified, 640 KB gzipped); heavy views load lazily.
  // The largest chunk is the TypeScript compiler (about 3.6 MB, 1 MB gzipped), loaded only when a
  // TypeScript/JSX game is previewed or published (src/lib/gameLangs/transpile.js).
  build: { chunkSizeWarningLimit: 3700 },
});
