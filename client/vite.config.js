import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Momotaro',
        short_name: 'Momotaro',
        description: 'Self-hosted manga reader',
        theme_color: '#1a1a1a',
        background_color: '#0f0f0f',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        prefer_related_applications: false,
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Pre-cache every built asset: JS, CSS, HTML, images, fonts
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],

        // New SW takes control of all open tabs immediately — no "waiting" phase.
        // Safe here because the app is a SPA; there are no multi-page hard navigations
        // that could be broken by a mid-session SW swap.
        skipWaiting: true,
        clientsClaim: true,

        runtimeCaching: [
          // ── 1. Page images ────────────────────────────────────────────────────
          // Content is indexed by numeric ID and never mutated.  Safe to cache
          // for a very long time.
          {
            urlPattern: /\/api\/pages\/\d+\/image/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'page-images',
              expiration: {
                maxEntries: 5000,                  // ~150 average-length chapters
                maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },

          // ── 2. Cover thumbnails ───────────────────────────────────────────────
          // Generated once per manga; filenames are stable.
          {
            urlPattern: /\/thumbnails\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'thumbnails',
              expiration: {
                maxEntries: 2000,
                maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },

          // ── 3. Chapter page listings ──────────────────────────────────────────
          // Page paths + dimensions are written at scan time and never updated
          // for a given chapter ID.  CacheFirst eliminates a round-trip on every
          // reader open.
          {
            urlPattern: /\/api\/chapters\/\d+\/pages/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'chapter-pages-meta',
              expiration: {
                maxEntries: 1000,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },

          // ── 4. Browse & discovery data ────────────────────────────────────────
          // Library listings, manga details, chapter lists, reading lists, stats.
          // These change only on scan or metadata update, so showing cached data
          // instantly and refreshing in the background (StaleWhileRevalidate)
          // gives the best perceived performance without sacrificing freshness.
          {
            urlPattern: /\/api\/(library|libraries|manga|chapters|reading-lists|stats)/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'browse-data',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },

          // ── 5. Everything else (progress, auth, search, misc) ─────────────────
          // Progress must be accurate; search results are ephemeral.
          // Always try the network first; fall back to cache if offline.
          {
            urlPattern: /\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-misc',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days offline fallback
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/thumbnails': 'http://localhost:3000',
    },
  },
});
