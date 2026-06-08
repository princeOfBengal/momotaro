const { createMangaBoxAdapter } = require('./_mangabox');

// MangaKakalot — FULL support (search, series detail, chapter list, image
// download), built on the shared MangaBox base.
//
// History: this adapter used to be search-only because every HTML page on
// www.mangakakalot.gg sits behind Cloudflare's interactive JS challenge. The
// fix — learned from Mihon/keiyoushi's Mangakakalot extension, which lists
// www.mangakakalove.com as a mirror — is that the `mangakakalove.com` mirror
// serves the *same* content (identical slugs, same 2xstorage image CDN) with
// no Cloudflare gate on any surface:
//
//   /home/search/json?searchword=…   — title autocomplete (JSON)   ✅ open
//   /manga/{slug}                     — series detail (HTML)         ✅ open
//   /api/manga/{slug}/chapters?limit=-1 — chapter list (JSON)        ✅ open
//   /manga/{slug}/{chapterSlug}       — reader page (HTML w/ images) ✅ open
//
// Verified end-to-end against Horimiya: search → series → 200+ chapters →
// reader page `chapterImages` array → real 538 KB .webp page download from
// imgs-2.2xstorage.com.
//
// `homepage` stays on the public-facing www.mangakakalot.gg so user-pasted /
// displayed URLs match what people actually see; all fetching goes through the
// mirror.

const MIRROR   = 'https://www.mangakakalove.com';
const HOMEPAGE = 'https://www.mangakakalot.gg';

module.exports = createMangaBoxAdapter({
  id:          'mangakakalot',
  label:       'MangaKakalot',
  homepage:    HOMEPAGE,
  searchBase:  MIRROR,
  contentBase: MIRROR,
  imageReferers: [`${MIRROR}/`, `${HOMEPAGE}/`],
});
