const { createMangaBoxAdapter } = require('./_mangabox');

// Natomanga / Manganato — FULL support (search, series detail, chapter list,
// image download), built on the shared MangaBox base.
//
// Natomanga is the successor to the old manganato.com / chapmanganato family
// (same operator as MangaKakalot). Mihon/keiyoushi's "Manganato" extension
// lists the mirror set: natomanga.com, nelomanga.com, nelomanga.net,
// manganato.gg.
//
// The Cloudflare challenge is per-host here, so two hosts are combined:
//
//   searchBase  = www.natomanga.com — /home/search/json is open here
//                 (it's Cloudflare-gated on manganato.gg)
//   contentBase = www.manganato.gg  — /manga/{slug}, /api/manga/{slug}/chapters
//                 and the reader pages are all open here
//                 (they're Cloudflare-gated on natomanga.com)
//
// Both are official mirrors of the same database, so the slug taken from a
// search hit resolves identically on the content host. Images come from the
// shared *.2xstorage.com CDN (Referer-gated to the family's domains).
//
// Verified end-to-end against Horimiya: search (natomanga.com) → series +
// chapters + reader (manganato.gg) → real 538 KB .webp page download from
// imgs-2.2xstorage.com.

const SEARCH_HOST  = 'https://www.natomanga.com';
const CONTENT_HOST = 'https://www.manganato.gg';

module.exports = createMangaBoxAdapter({
  id:          'natomanga',
  label:       'Natomanga',
  homepage:    SEARCH_HOST,
  searchBase:  SEARCH_HOST,
  contentBase: CONTENT_HOST,
  imageReferers: [`${CONTENT_HOST}/`, `${SEARCH_HOST}/`],
});
