import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// shortcut: Vite 5 hashes bun.lockb but not bun's text bun.lock, so a dependency
// bump kept serving stale pre-bundled deps in dev. Key the cache on bun.lock;
// drop this once Vite hashes bun.lock itself.
const lockHash = createHash('sha256')
  .update(readFileSync(new URL('./bun.lock', import.meta.url)))
  .digest('hex')
  .slice(0, 12)

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  cacheDir: `node_modules/.vite/${lockHash}`,
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
})
