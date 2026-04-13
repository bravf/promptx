import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

function parseAllowedHosts(rawValue = '') {
  return String(rawValue || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

const allowedHosts = parseAllowedHosts(
  process.env.PROMPTX_WEB_ALLOWED_HOSTS || ''
)

export default defineConfig({
  plugins: [vue()],
  build: {
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (id.includes('/@tiptap/') || id.includes('/prosemirror/')) {
            return 'vendor-tiptap'
          }

          if (id.includes('/lucide-vue-next/') || id.includes('/vue-draggable-plus/')) {
            return 'vendor-ui'
          }

          if (id.includes('/markdown-it/')) {
            return 'vendor-markdown'
          }

          if (id.includes('/vue-router/')) {
            return 'vendor-router'
          }

          if (id.includes('/shiki/') || id.includes('/@shikijs/')) {
            if (id.includes('/dist/langs/')) {
              return `vendor-shiki-lang-${id.split('/dist/langs/')[1].replace(/\.mjs.*$/, '').replace(/[^a-zA-Z0-9_-]/g, '-')}`
            }

            if (id.includes('/dist/themes/')) {
              return `vendor-shiki-theme-${id.split('/dist/themes/')[1].replace(/\.mjs.*$/, '').replace(/[^a-zA-Z0-9_-]/g, '-')}`
            }

            return 'vendor-shiki-core'
          }

          return 'vendor-misc'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    ...(allowedHosts.length ? { allowedHosts } : {}),
  },
})
