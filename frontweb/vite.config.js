import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const apiTarget = process.env.LOCAL_MINIDRAMA_API_TARGET || 'http://127.0.0.1:5679'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '0.0.0.0',
    port: 3013,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        proxyTimeout: 600000,
        timeout: 600000
      },
      '/static': {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
})
