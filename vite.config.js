import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The minified database rules as a static file next to index.html (rules.min.json), for the owner
// dashboard's "Database rules" panel (src/features/premium/components/RulesPanel.jsx): emitted by the
// build and served by the dev server, always from the current database.rules.json.
function rulesMin() {
  const src = new URL('./database.rules.json', import.meta.url);
  // Loaded at run time (not bundled into the config): the script starts with a #! line.
  const minifier = new URL('./scripts/minify-rules.mjs', import.meta.url).href;
  const make = async () => (await import(/* @vite-ignore */ minifier)).minifyRules(JSON.parse(readFileSync(src, 'utf8')));
  return {
    name: 'codehub-rules-min',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!(req.url || '').split('?')[0].endsWith('/rules.min.json')) return next();
        make().then(
          (text) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(text);
          },
          (e) => next(e),
        );
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'rules.min.json', source: await make() });
    },
  };
}

export default defineConfig({
  // Relative asset paths so the build works from a GitHub Pages sub-path (/codehub/).
  base: './',
  plugins: [react(), rulesMin()],
  // The start-up chunk carries CodeMirror's core (shop editor themes), the emoji data, Firebase and the
  // round 3 feature registrations (about 2.3 MB minified, 640 KB gzipped); heavy views load lazily.
  build: { chunkSizeWarningLimit: 2500 },
});
