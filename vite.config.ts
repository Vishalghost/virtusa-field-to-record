import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Field-to-Record',
        short_name: 'FieldRecord',
        description: 'Offline voice-to-structured clinical notes for first responders',
        theme_color: '#ffffff',
        background_color: '#f4f6f9',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // App shell is precached. Models and the ONNX runtime are too big for the
        // precache manifest, so they are cached on first use (see "Prepare offline").
        globPatterns: ['**/*.{js,css,html,svg,json,webmanifest}'],
        globIgnores: ['models/**', 'ort/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/models/') || url.pathname.startsWith('/ort/'),
            handler: 'CacheFirst',
            options: {
              // v2: v1 could hold the HTML fallback page cached under a model URL.
              cacheName: 'ftr-models-v2',
              expiration: { maxEntries: 64 },
              cacheableResponse: { statuses: [200] },
              plugins: [
                {
                  // A missing model file is answered with index.html (200). Never cache that
                  // as the model, or the app stays broken even after the model is installed.
                  cacheWillUpdate: async ({ response }) => (response.headers.get('content-type')?.includes('text/html') ? null : response),
                },
              ],
            },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  test: { include: ['tests/**/*.test.ts'] },
});
