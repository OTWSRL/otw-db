import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * One script and one stylesheet, named by their content (the app has no dynamic imports). The base is a placeholder that
 * scripts/pack-assets.mjs turns into %OTW_DB_BASE%, which the server fills in with wherever
 * the host mounts it.
 */
export default defineConfig({
  plugins: [react()],
  base: '/__OTW_DB_BASE__/',
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: false,
    // React and CodeMirror make one 700 KB script (220 KB gzipped), kept a year by browsers.
    chunkSizeWarningLimit: 1000,
  },
})
