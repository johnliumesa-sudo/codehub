import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** This build's id: the git short sha (the deploy workflow checks out the commit), else the CI sha, else a time id. */
function buildId() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{4,40}$/.test(sha)) return sha;
  } catch {
    /* no git: fall through */
  }
  const ci = process.env.GITHUB_SHA || '';
  return /^[0-9a-f]{7,40}$/i.test(ci) ? ci.slice(0, 7).toLowerCase() : `b${Date.now().toString(36)}`;
}

// Open tabs learn about a deploy from version.json (src/lib/appVersion.js): the build writes
// dist/version.json and defines the same { v, t } as __CODEHUB_BUILD__; the dev server serves it too.
function buildVersion() {
  const json = JSON.stringify({ v: buildId(), t: new Date().toISOString() });
  return {
    name: 'codehub-build-version',
    config: () => ({ define: { __CODEHUB_BUILD__: json } }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (path !== '/version.json' && path !== `${server.config.base}version.json`) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(json);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${json}\n` });
    },
  };
}

export default defineConfig({
  // Relative asset paths so the build works from a GitHub Pages sub-path (/codehub/).
  base: './',
  plugins: [react(), buildVersion()],
  // The start-up chunk carries CodeMirror's core (shop editor themes), the emoji data, Firebase and the
  // round 3 feature registrations (about 2.3 MB minified, 640 KB gzipped); heavy views load lazily.
  // The largest chunk is the TypeScript compiler (about 3.6 MB, 1 MB gzipped), loaded only when a
  // TypeScript/JSX game is previewed or published (src/lib/gameLangs/transpile.js).
  build: { chunkSizeWarningLimit: 3700 },
});
