import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

/**
 * One Vite project, one document per app.
 *
 * Each tool keeps its own HTML entry, so the big unscoped tool stylesheets
 * never share a document, while shared chunks (shell, shared-ui) dedupe
 * automatically into a single hashed `/assets/*` tree.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        judgepapers: fileURLToPath(new URL('judgepapers/index.html', import.meta.url)),
        scoremodifier: fileURLToPath(new URL('scoremodifier/index.html', import.meta.url)),
        protocolgenerator: fileURLToPath(new URL('protocolgenerator/index.html', import.meta.url)),
        banner: fileURLToPath(new URL('tools/banner/index.html', import.meta.url)),
      },
    },
  },
})
