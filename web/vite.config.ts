import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The API binds to 127.0.0.1 by default; target it explicitly so Node never
// resolves "localhost" to ::1 and misses it.
const api = process.env.FLOWOPS_API ?? 'http://127.0.0.1:5175'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/webhook': api,
      '/webhook-test': api,
      '/webhook-waiting': api,
    },
  },
})
