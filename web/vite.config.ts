import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7233',
      '/health': 'http://localhost:7233',
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
})
