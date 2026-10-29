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
        theme_color: '#0f172a',
        background_color: '#0f172a',
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
            options: { cacheName: 'ftr-models', expiration: { maxEntries: 64 }, cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  test: { include: ['tests/**/*.test.ts'] },
});
