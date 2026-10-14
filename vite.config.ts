import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            // Native addon — must not be bundled into the Electron main chunk
            rollupOptions: {
              external: ['koffi'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
      },
      renderer: {},
    }),
  ],
})
