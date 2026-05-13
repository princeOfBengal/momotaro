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
        lang: 'en',
        theme_color: '#1a1a1a',
        background_color: '#0f0f0f',
        display: 'standalone',
        // `display_override` lets browsers fall through to a usable display
        // mode when `standalone` isn't supported (older Android WebView,
        // some PWA engines). Required for Chrome Android to show the rich
        // install prompt on a few device classes.
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        start_url: '/',
        scope: '/',
        categories: ['books', 'entertainment'],
        prefer_related_applications: false,
        icons: [
          // Two `purpose: 'any'` icons — Android Chrome's installability
          // checker requires at least one any-purpose icon ≥192px AND will
          // pick the largest any-purpose icon for the home-screen launcher
          // when no maskable variant is selected by the OS theme.
          //
          // Being explicit about `purpose` is required to dodge a Chrome
          // 88+ behaviour where icons without a purpose can be inferred as
          // maskable-only on some Android versions, which then fails the
          // "any-purpose icon present" check and silently disables the
          // install prompt.
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          // The maskable variant feeds Android's adaptive-icon shape
          // (circle / rounded square / squircle depending on launcher).
          // Reusing the 512 — no dedicated maskable artwork — produces a
          // safe-zone-cropped icon on launchers that mask aggressively, but
          // the install prompt still fires.
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
          // ── 0. Search requests — NetworkOnly, NEVER cached ────────────────────
          // Every keystroke produces a unique `?search=…` URL. Letting Rule 4
          // catch them stuffed each one into the `browse-data` SWR cache
          // (capped at 500 entries via Workbox's ExpirationPlugin, which
          // tracks timestamps in IndexedDB). On mobile Chromium each cache
          // hit / put / LRU-eviction round-trips IndexedDB on the SW IO
          // thread. With repeated searching, that work stacked up and
          // stalled the SW just enough that the page appeared frozen — the
          // freeze the user reported when searching inside a library that
          // had already populated the cache through normal browsing.
          //
          // NetworkOnly means the SW just forwards the request — no cache
          // read, no cache write, no IndexedDB activity. The server also
          // sends `Cache-Control: no-store` on search responses so the
          // browser's HTTP cache doesn't accumulate them either.
          {
            urlPattern: ({ url }) => {
              if (!url.pathname.startsWith('/api/')) return false;
              return url.searchParams.has('search');
            },
            handler: 'NetworkOnly',
          },

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
          //
          // maxEntries dropped from 500 → 100. The previous cap was sized
          // assuming each entry was a stable URL, but with search URLs no
          // longer landing here (Rule 0) the working set is much smaller —
          // a hundred unique browse / detail / chapter URLs covers the
          // common case. Smaller cap = less IndexedDB activity per fetch
          // on mobile, which is what surfaced as a freeze when the SW had
          // to maintain LRU bookkeeping over a busy cache.
          {
            urlPattern: /\/api\/(library|libraries|manga|chapters|reading-lists|stats|home|genres)/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'browse-data',
              expiration: {
                maxEntries: 100,
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
