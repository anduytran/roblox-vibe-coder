import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [
      react(),
      {
        // The dev server needs a websocket for hot reload; the shipped app's CSP doesn't allow it.
        name: 'hangar-production-csp',
        apply: 'build',
        transformIndexHtml: (html: string) => html.replace(' ws://localhost:*', '')
      }
    ]
  }
})
