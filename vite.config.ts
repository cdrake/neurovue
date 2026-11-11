import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// shortcut: Vite 5 hashes bun.lockb but not bun's text bun.lock, so a dependency
// bump kept serving stale pre-bundled deps in dev. Key the cache on bun.lock;
// drop this once Vite hashes bun.lock itself.
const lockHash = createHash('sha256')
  .update(readFileSync(new URL('./bun.lock', import.meta.url)))
  .digest('hex')
  .slice(0, 12)

// `--mode web` builds the browser version for neurovue-web: Tauri's modules
// are swapped for fetch-backed stand-ins, and asset URLs stay relative so the
// app works under a proxy prefix (Neurodesk).
const tauriShims = {
  '@tauri-apps/api/core': 'core',
  '@tauri-apps/api/event': 'event',
  '@tauri-apps/api/webviewWindow': 'webviewWindow',
  '@tauri-apps/plugin-dialog': 'dialog',
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  ...(mode === 'web' && {
    base: './',
    build: { outDir: 'dist-web' },
    resolve: {
      alias: Object.entries(tauriShims).map(([find, shim]) => ({
        find: new RegExp(`^${find}$`),
        replacement: fileURLToPath(
          new URL(`./src/web/${shim}.ts`, import.meta.url),
        ),
      })),
    },
  }),
  clearScreen: false,
  cacheDir: `node_modules/.vite/${lockHash}`,
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
}))
