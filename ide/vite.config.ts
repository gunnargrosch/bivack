import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import importMetaUrlPlugin from '@codingame/esbuild-import-meta-url-plugin'

// monaco-vscode-api loads workers via new URL(..., import.meta.url); Vite needs
// this plugin to resolve those. base './' so the app works under any path
// (we serve it at /ide/).
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      // @xterm/addon-ligatures imports this transitively; not a Node build.
      'node:diagnostics_channel': fileURLToPath(
        new URL('./src/shims/diagnostics_channel.ts', import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [importMetaUrlPlugin],
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 10000,
    // Versioned asset dir: bumping this changes every asset URL, which is the
    // only way to dislodge a wrong-MIME response a client cached as immutable.
    assetsDir: 'assets-v2',
  },
})
