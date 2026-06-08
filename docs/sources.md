# Third Party Sourcing

In-app downloader that fetches chapters from third-party sources, writes them
as CBZ archives into the user's library, and records the source linkage so a
future scheduler can re-check those series for new releases.

Title search, manual chapter selection, and scheduled auto-checks are all
wired up. Source linkage is recorded automatically on download and can also
be set manually from the per-manga URL manager. Successful per-manga
schedules dispatch missing chapters through the same download queue.

**Available source adapters** (registered in [server/src/sources/index.js](../server/src/sources/index.js); enumerated by `GET /api/sources`):

- **MangaDex** — full support (search, series detail, chapter listing, image download).
- **WeebCentral** — full support (HTML-scraping; no auth, no Cloudflare gate). See [WeebCentral notes](#weebcentral-notes) below.
- **MangaBall** — full support (uses MangaBall's own `/api/v1/` REST endpoints with Laravel-style CSRF; session warmed lazily and cached for 10 minutes). See [MangaBall notes](#mangaball-notes) below.
- **MangaTaro** — full support (uses the site's `/auth/*` JSON API; chapter list requires a time-derived MD5 token reproduced server-side, page list is open).
- **MangaDotNet** — full support (clean `/api/*` REST surface from a React Router v7 SSR app; no auth, no token).
- **ComiKuro** — full support via the site's allowlisted CORS proxy. ComiKuro is itself a metadata aggregator; chapter pages are pinned to the kaliscan upstream through `https://api.comikuro.to/api/_proxy/proxy`.
- **comix.to** — partial support (search, series detail, URL recording, cross-source linkage). Chapter listing and image fetching are gated by an obfuscated JS-VM security token; see [comix.to limitations](#comixto-limitations) below.
- **MangaKakalot** — partial support (search, series detail synthesised from the search response, URL recording). Chapter listing and image pages are blocked by Cloudflare's interactive JS challenge; see [MangaKakalot limitations](#mangakakalot-limitations) below.
- **MangaFire** — partial support (URL-paste search, series detail and **full chapter list** scraped from the openly-served series page, scheduler diff works). Image fetch is blocked by Cloudflare Turnstile on the reader AJAX; see [MangaFire limitations](#mangafire-limitations) below.

The reference projects called out in the spec —
[keiyoushi/extensions-source](https://github.com/keiyoushi/extensions-source)
(Tachiyomi/Mihon extensions) and
[manga-download/hakuneko](https://github.com/manga-download/hakuneko) — were
used as parser/UX reference for the MangaDex adapter and the chapter-naming
convention.

## UI entry point

A **Third Party Sourcing** link sits in the left sidebar (`AppSidebar`) directly
below Art Gallery on every page that mounts `AppSidebar` (Home, Library, Genres,
Art Gallery, ThirdPartySourcing itself). Clicking it routes to
[/third-party-sourcing](../client/src/pages/ThirdPartySourcing.jsx).

The page has four panes:

1. **Source picker + search** — source dropdown populated from
   `GET /api/sources` (MangaDex, WeebCentral, MangaBall, MangaTaro,
   MangaDotNet, ComiKuro, comix.to, MangaKakalot, MangaFire) and a title
   query box. When the page is opened from a per-manga *Find more sources*
   link (`/third-party-sourcing?manga_id=N`), the search box is pre-filled
   with the manga's title and the target is locked to mode='existing' for
   that manga.
2. **Search results** — title / cover / author / year / status / genres,
   click-through to a series detail.
3. **Series detail + chapter picker** — the user picks which chapters to grab,
   plus the destination:
   - **Save as a new series** — choose a library and a folder name (defaults
     to a sanitized form of the source title). The folder is created on demand.
   - **Add to existing series** — pick from a list of suggested matches
     (`GET /api/sources/match-existing` runs an FTS5 lookup against the user's
     library titles) so chapters land in the right folder. Chapter rows whose
     number matches a chapter already on disk for the chosen manga are flagged
     `already in library` and uncheckable, preventing duplicate downloads.
4. **Downloads queue** — live list of every job (queued / running / done /
   failed / cancelled) with a per-job page-progress counter and a cancel
   button. Polls `/api/sources/downloads` every 2 s while there's active work,
   every 10 s when idle.

## Server architecture

| File | Responsibility |
|---|---|
| [server/src/sources/index.js](../server/src/sources/index.js) | Registry of source adapters keyed by id |
| [server/src/sources/_pacer.js](../server/src/sources/_pacer.js) | Shared per-adapter rate-limit pacer — `createPacer(intervalMs)` returns `{ wait() }` enforcing a minimum gap between calls. Each adapter creates its own instance so upstreams are paced independently. |
| [server/src/sources/urlParser.js](../server/src/sources/urlParser.js) | URL ↔ `(source, source_id)` translation for every adapter |
| [server/src/sources/mangadex.js](../server/src/sources/mangadex.js) | MangaDex API client — search, series, chapters, MangaDex@Home image URLs |
| [server/src/sources/weebcentral.js](../server/src/sources/weebcentral.js) | WeebCentral HTML/HTMX scraper |
| [server/src/sources/mangaball.js](../server/src/sources/mangaball.js) | MangaBall `/api/v1/` client with CSRF session warmup |
| [server/src/sources/mangataro.js](../server/src/sources/mangataro.js) | MangaTaro `/auth/*` JSON client with time-derived token |
| [server/src/sources/mangadotnet.js](../server/src/sources/mangadotnet.js) | MangaDotNet `/api/*` REST client |
| [server/src/sources/comikuro.js](../server/src/sources/comikuro.js) | ComiKuro proxy-routed adapter, kaliscan-pinned for pages |
| [server/src/sources/comixto.js](../server/src/sources/comixto.js) | comix.to search + series detail; chapters/pages gated |
| [server/src/sources/mangakakalot.js](../server/src/sources/mangakakalot.js) | MangaKakalot autocomplete search; chapters/pages gated |
| [server/src/sources/mangafire.js](../server/src/sources/mangafire.js) | MangaFire URL-paste search + series-page chapter scrape |
| [server/src/downloader/queue.js](../server/src/downloader/queue.js) | Persistent FIFO download queue with configurable concurrency + per-page delay |
| [server/src/scheduler/index.js](../server/src/scheduler/index.js) | Per-manga `manga_schedules` polling loop and `checkOneManga` worker |
| [server/src/routes/sources.js](../server/src/routes/sources.js) | `/api/sources/*` REST endpoints + manga linkage + schedule routes |

### Source adapter contract

Each source module in `server/src/sources/<id>.js` exports:

```js
module.exports = {
  id:    'mangadex',
  label: 'MangaDex',
  homepage: 'https://mangadex.org',
  searchSeries(query, { limit }) -> Promise<Series[]>,
  getSeries(id)                  -> Promise<Series>,
  getChapters(id, { languages }) -> Promise<Chapter[]>,
  getChapterImages(chapterId)    -> Promise<{ files: string[], ... }>,
  USER_AGENT: 'Momotaro/1.0 (...)', // sent on image fetches too
};
```

`Series` shape: `{ id, title, author, year, status, content_rating, genres,
cover_url, description, last_chapter, available_languages }`.

`Chapter` shape: `{ id, number, volume, title, language, pages, published_at,
group, external_url }`. `external_url` is non-null when MangaDex hosts the
chapter on a third-party reader and `getChapterImages` won't work — the picker
flags those rows so the user knows in advance.

### MangaBall notes

The MangaBall adapter ([server/src/sources/mangaball.js](../server/src/sources/mangaball.js))
is the **third source after MangaDex and WeebCentral with full chapter
download support**. The site is a PHP app at `mangaball.net` exposing a
clean `/api/v1/` REST surface protected by Laravel-style CSRF.

**Auth model:** three protections that all need to be satisfied on every
API call:

1. `PHPSESSID` cookie — set by any HTML page; required on every API call
2. CSRF token — embedded in every page as `<meta name="csrf-token" content="…">`,
   sent back as the `X-CSRF-TOKEN` header on every API request
3. `X-Requested-With: XMLHttpRequest` — the API rejects requests without
   it as cross-origin

The adapter warms a session lazily on first call (GET `/` → parse
PHPSESSID + csrf-token meta) and caches it for 10 minutes. On 403/419
(CSRF rejection patterns) it re-warms and retries once.

**Endpoints used:**

- `POST /api/v1/smart-search/search/` — body (form-encoded):
  `search_input={query}`. Returns `{code:200, data:{manga:[{title, img,
  status, url, ...}, ...]}}`. The `url` field carries `/title-detail/{slug}-{ObjectId}/`,
  from which the adapter pulls the trailing 24-hex ObjectId as the source id.
- `GET /title-detail/{any-slug}-{ObjectId}/` — series detail HTML scrape.
  The slug prefix is purely SEO; the site canonicalises any non-empty
  slug to the real title slug, so the adapter uses a fixed placeholder
  `series-{ObjectId}` URL. Title is read from the JSON-LD `caption` field
  and falls back to `og:title`; cover from `og:image`.
- `POST /api/v1/chapter/chapter-listing-by-title-id/` — body (JSON):
  `{title_id: "<24-hex ObjectId>"}`. Returns `{code:200, ALL_CHAPTERS:
  [{number, number_float, title, translations: [{id, language, group,
  date, pages, url, volume}, ...]}, ...]}`. The adapter walks the
  per-language translations array and emits one chapter entry per
  (language, group) pair so the scheduler can reason about each
  translation independently. The per-translation ObjectId becomes the
  queue's `source_chapter_id`.
- `GET /chapter-detail/{translationObjectId}/` — chapter reader HTML
  scrape. Image URLs are embedded inline as `<img src="https://heracross.red-and-blue.net/storage/{titleId}/{vol}/{ch}/{group}/{lang}/{chapterId}-NNN.webp">`.
  The adapter accepts any `*.{red-and-blue,black-and-white,poke*}.net/storage/{24-hex}/...`
  pattern since the site rotates through several Pokémon-themed CDN
  hostnames (jigglypuff, heracross, bulbasaur, etc.).

**Linkage:** stored in `manga.mangaball_id` as the bare 24-hex ObjectId,
kept in sync by `syncDenormalizedLinkage` the same way `mangadex_id` is.

**Multi-language / multi-group caveat:** MangaBall typically has 3-5
scanlation groups per chapter per language, so `getChapters` returns
many more entries than other sources (720 EN rows for Horimiya across
multiple groups vs. ~130 chapters from other sources). The scheduler
diffs by chapter number, so duplicates collapse correctly there. On
manual-pick downloads the user sees every translation/group separately
and chooses which one to grab.

**Verified live with Horimiya** (`https://mangaball.net/title-detail/horimiya-68517bef5a163752cfb9d159/`):

- Search: returns 2 hits including the test case with `id=68517bef5a163752cfb9d159`,
  `status=Completed`, cover URL
- `getSeries('68517bef5a163752cfb9d159')` → `{ title: 'Horimiya', cover_url, series_url }`
- `getChapters` EN: 720 rows (groups Suicune / Raikou / Empoleon /
  Zinmanga / etc.), sorted oldest-first
- `getChapters` all langs: 1505 rows split across en/ru/pt-br/es/fr/vi
- `getChapterImages` for `68da947d1ec6dc083a2b20f8` (Ch.0 Suicune):
  82 page URLs from `jigglypuff.poke-black-and-white.net`. Earlier raw
  curl on a different chapter fetched a real 230 KB RIFF/WEBP image.
- Scheduler diff math: with local `{1,2,3,4,5}` → 700 missing EN rows

### WeebCentral notes

The WeebCentral adapter ([server/src/sources/weebcentral.js](../server/src/sources/weebcentral.js))
is the **second source after MangaDex with full chapter download support**.
The site is HTMX-driven and serves clean HTML fragments from a small set
of openly-accessible endpoints — no auth, no Cloudflare gate, no token
challenge.

**Endpoints (all open):**

- `POST /search/simple?location=main` with body `text={query}` — returns
  an HTMX fragment with one `<a href="/series/{ULID}/{slug}">` per hit
  plus inline cover image. The adapter wraps this with `HX-Request: true`
  to mirror what the site's own search box sends.
- `GET /series/{ULID}` — series detail HTML. The trailing slug is purely
  SEO; the bare ULID URL returns the same content. The adapter
  canonicalises to the bare-ULID form.
- `GET /series/{ULID}/full-chapter-list` — full chapter list as an HTMX
  fragment. Each chapter block carries the chapter ULID
  (`<a href="…/chapters/{ULID}">`), the publish timestamp
  (`x-data="checkNewChapter('ISO8601')"`), and the label
  (`<span class="">Page. N</span>` — WeebCentral's house style for
  chapter labels).
- `GET /chapters/{ULID}/images?reading_style=long_strip` — page list
  HTMX fragment with one `<img src="https://official.lowee.us/manga/…">`
  per page. **The `reading_style` query is required** — without it the
  endpoint 307s into a 400 page (the SPA's reader sets the value from a
  hidden form before triggering the swap).

**Image host:** images come from `https://official.lowee.us/manga/{Title}/{NNNN-NNN}.png`.
Verified end-to-end with a real `curl` of `0001-001.png` returning ~235 KB
of valid JPEG (the `.png` extension is a misnomer in the site's URL
template — the actual content is JFIF).

**Linkage:** stored in `manga.weebcentral_id` as the bare ULID, kept in
sync by `syncDenormalizedLinkage` the same way `mangadex_id` is.

**Verified live with Horimiya** (`https://weebcentral.com/series/01J76XY7PBJ0A3GC5PC79VET42/Horimiya`):

- Search: returns `Horimiya · 01J76XY7PBJ0A3GC5PC79VET42` with cover
- Series detail: title `Horimiya`, author `HAGIWARA Daisuke , HERO`,
  year `2011`, status `Complete`, genres `Comedy, Romance, School Life,
  Shounen, Slice of Life`, full description
- Chapters: 136 entries, sorted oldest-first (Ch.1 → Ch.130 + 6 extras),
  each with stable ULID id and ISO publish date
- Image fetch: chapter 1 returns 39 page URLs, all under `official.lowee.us`

### MangaTaro notes

The MangaTaro adapter ([server/src/sources/mangataro.js](../server/src/sources/mangataro.js))
talks to the site's small `/auth/*` JSON API (the prefix is misleading —
no auth is required for the read endpoints).

**Endpoints:**

- `POST /auth/search` — body `{query, limit}`. Returns `{results:[{id, title,
  slug, alt_titles, authors, permalink, thumbnail, description, type, status}]}`.
  `id` is the numeric series id; `slug` is the URL slug the user pastes.
- `GET /auth/manga-chapters?manga_id={id}&offset=0&limit=500&order=ASC&_t={token}&_ts={timestamp}` —
  the chapter list endpoint requires a 16-char MD5-prefix token derived from
  the timestamp plus an hour-based secret. The token algorithm is reproduced
  server-side in `generateToken()` so the adapter doesn't need to scrape the
  site bundle.
- `GET /auth/chapter-content?chapter_id={id}` — page list, no token required.
  Image URLs are absolute (`mangataro.yachts` CDN); the downloader fetches
  them directly.

**Linkage:** stored in `manga.mangataro_id` as the slug. The slug → numeric
manga_id lookup needed for the chapter-list call is resolved through the
series page on demand.

### MangaDotNet notes

The MangaDotNet adapter ([server/src/sources/mangadotnet.js](../server/src/sources/mangadotnet.js))
hits a clean REST API exposed by the site's React Router v7 SSR app. No
auth, no token, no Cloudflare gate.

**Endpoints:**

- `GET /_rr/suggestions?q={query}` — search / autocomplete. Returns
  `{suggestions:[{id, title, photo, genres, chapter_count, status, …}]}`.
- `GET /api/manga/{id}` — series detail including authors / artists (both
  JSON-string-encoded) and alt-titles.
- `GET /api/manga/{id}/chapters/list` — full chapter list. Optional `?lang=`
  and `?group_id=` filters mirror the site UI; the adapter omits them so the
  user sees every translation and post-filters client-side.
- `GET /api/chapters/{chapterId}/images` — page list with `{url, w, h}` per
  image. URLs are site-relative and absolutised by the downloader.

**Linkage:** stored in `manga.mangadotnet_id` as the numeric series id.

### ComiKuro notes

The ComiKuro adapter ([server/src/sources/comikuro.js](../server/src/sources/comikuro.js))
is structurally different from the others: ComiKuro is a **metadata
aggregator** that doesn't host chapter pages for most titles. Its SPA
scrapes pages from an upstream host per series (kaliscan, comix.to,
mangaball, zazamanga). The adapter pins kaliscan as the page upstream
since it has the broadest English coverage and the cleanest HTML.

All HTTP traffic flows through the site's allowlisted CORS proxy at
`https://api.comikuro.to/api/_proxy/proxy?url=…` so the adapter inherits
whatever headers the proxy adds.

**Endpoints (through the proxy):**

- Search → `https://api.comick.dev/v1.0/search?q={query}&limit=N`. Returns
  `[{id, hid, slug, title, desc, status, last_chapter, content_rating, country, md_covers:[{b2key}]}]`.
- Series detail → native ComiKuro `/api/_data/manga?slug={slug}`. Returns
  `{pageProps:{comic:{…}, artists:[…], authors:[…]}}`.
- Chapter list → 1) re-search kaliscan for the title to resolve its manga
  id; 2) `GET /service/backend/chaplist/?manga_id=N&manga_name=…`. Returns
  HTML the adapter parses for chapter links.
- Chapter images → `GET /manga/{kaliscan_id}-{slug}/chapter-{number}` and
  parse the inline `var chapImages = "url1,url2,…"` string. URLs carry
  time-expiring `acc=…&expires=…` tokens — the downloader fetches them
  immediately to avoid expiry.

**Linkage:** stored in `manga.comikuro_id` as the slug.

### MangaFire limitations

The MangaFire adapter ([server/src/sources/mangafire.js](../server/src/sources/mangafire.js))
is the **richest** of the three Cloudflare-affected sources. The series
detail page is openly served and contains the FULL chapter list inline —
so unlike comix.to and MangaKakalot, the scheduler can actually compute the
local-vs-remote diff against MangaFire and identify missing chapters.
Only the actual image-fetch step is gated.

**Endpoints:**

- `GET /manga/{slug}.{hid}` — open. Returns server-rendered HTML with
  every chapter row (`<li class="item" data-number="N">`), per-language
  counts, cover image (`<img itemprop="image">`), title, author, and
  status. Verified end-to-end against `https://mangafire.to/manga/horimiyaa.6nm0`.
- `GET /filter?keyword=…` — HTTP 403 (server-side blocked against this
  client). Direct keyword search isn't usable.
- `GET /ajax/read/chapter/{mangaId}` — HTTP 403 "Request is invalid".
  The reader page exposes a Cloudflare Turnstile site key
  (`var captchaKey = '0x4AAAAAAA...'`) and the AJAX call requires a valid
  Turnstile token, which only a real browser engine can produce.

**What works:**

- Pasting `https://mangafire.to/manga/{slug}.{hid}` into the search box on
  the **Third Party Sourcing** page (or into the per-manga URL manager).
  `searchSeries` detects URL-shaped queries, fetches the series page, and
  returns a single rich result. Verified for the user-supplied test case
  `https://mangafire.to/manga/horimiyaa.6nm0` — returns title `Horimiya`,
  author `Daisuke Hagiwara`, status `Completed`, cover URL, and 6
  available languages.
- `getSeries(id)` returns the same record by direct id lookup
- `getChapters(id, { languages })` scrapes the full chapter list (254 EN
  chapters for Horimiya), with per-row `number`, `volume` (Vol 0
  normalised to null), title (subtitle stripped of the "Chapter N:" prefix),
  language, published-date label, and a stable `id` of the form
  `/read/{slug.hid}/{lang}/chapter-N`. Multi-language is opt-in via the
  `languages` option; default is `['en']`.
- **Scheduler diff works against MangaFire** — at runtime, the scheduler
  walks the recorded MangaFire URL, calls `getChapters`, diffs against
  the local folder by chapter number, and identifies the missing set just
  like it does for MangaDex. Only the subsequent image-download step
  fails — the missing chapters surface in `download_jobs` as `failed`
  with the gated-error string.
- URL parser recognises both `/manga/…` and `/read/…` paths and
  canonicalises to `/manga/{slug}.{hid}`. Linkage stored in
  `manga.mangafire_id`, kept in sync by `syncDenormalizedLinkage`.

**What returns a clear error:**

- Direct keyword search (non-URL query): explainer telling the user to
  paste a URL instead
- Any download attempt: `MangaFire chapter images are loaded behind a
  Cloudflare Turnstile challenge — chapter download is not supported
  from this source.` lands in `download_jobs.error` and (for scheduled
  runs) `manga_schedules.last_result`

**Practical workflow:** the same as comix.to / MangaKakalot — pair the
MangaFire URL (which gives the scheduler a working chapter list it can
diff against) with a MangaDex URL (which actually downloads the missing
images) on the same manga. The URL store allows multiple URLs per manga;
the scheduler dedupes by `(source, source_id)` and the diff dedupes by
chapter number, so chapters identified as missing through the MangaFire
URL get downloaded through the MangaDex URL when both are present.

### MangaKakalot limitations

The MangaKakalot adapter ([server/src/sources/mangakakalot.js](../server/src/sources/mangakakalot.js))
talks to the site's own autocomplete endpoint for search, which slips
through Cloudflare:

- `GET https://www.mangakakalot.gg/home/search/json?searchword={normalized}`

The search payload is rich enough to drive the Third Party Sourcing UI
without a separate series-detail fetch: title, slug, author, latest chapter
label, thumbnail URL, and canonical series URL all come back inline. The
adapter mirrors the site's `change_alias()` normalisation (lowercase,
Unicode NFD-fold, replace non-alphanumeric runs with `_`, collapse, trim)
so what we send matches what the browser autocomplete sends.

**Cloudflare gate:** every HTML page that would carry the chapter list or
image URLs (`/manga/{slug}`, `/manga/{slug}/chapter-N`, `/manga-list/all`,
known mirrors) returns the *"Just a moment..."* interactive challenge.
Cookies, full browser headers (`Sec-Fetch-*`, `Accept-Language`,
`Referer`), and same-origin hops were all probed; none get past the JS
challenge without a real browser engine. Bundling Puppeteer (~200 MB) or
running an external FlareSolverr proxy would work but are off-spec for a
self-hosted manga server's dependency footprint.

**What works:**

- Title search via the **Third Party Sourcing** page (source dropdown now
  lists MangaKakalot alongside MangaDex and Comix.to)
- Series detail synthesised from the search response — round-trips through
  the search endpoint with the slug as query and requires an exact slug
  match in the result, so typo'd slugs surface a clear error rather than
  silently returning a different series
- Recording `https://www.mangakakalot.gg/manga/{slug}` URLs against a
  manga in the per-manga URL manager
- Linkage to `manga.mangakakalot_id`, kept in sync by
  `syncDenormalizedLinkage` the same way `mangadex_id` is

**What returns a clear error:**

- Any download attempt against a MangaKakalot URL — the worker writes
  `MangaKakalot chapter access is blocked by the site's Cloudflare
  challenge — chapter download is not supported from this source.` to
  `download_jobs.error`
- Scheduler runs against MangaKakalot-only series — same string lands in
  `manga_schedules.last_result` and shows in **Settings → Scheduling**

**Practical workflow:** the same pattern as comix.to — record both the
MangaKakalot URL (as a visual reference) and the MangaDex URL (for actual
downloads) against the same manga. The URL store allows multiple URLs per
manga; the scheduler dedupes by `(source, source_id)` and walks each.

### comix.to limitations

The comix.to adapter ([server/src/sources/comixto.js](../server/src/sources/comixto.js))
implements **search and series detail** against the site's public JSON API
at `/api/v1`. The two endpoints needed for actual chapter download are
gated:

- `GET /api/v1/manga/{hid}/chapters` → `{"status":"error","message":"Missing token.","code":403}`
- `GET /api/v1/chapters/{hid}/pages` → same

The token is derived in the browser by an obfuscated VM-bytecode module
that runs as an axios request interceptor. Reproducing it server-side
would require either JSDOM + the obfuscated module (fragile, breaks on
every site update) or bundling Puppeteer/Playwright (~200 MB) — neither
is appropriate for a self-hosted manga server's dependency footprint.

**What works:**

- Title search via the **Third Party Sourcing** page (the source dropdown
  exposes Comix.to alongside MangaDex)
- Series detail (cover, synopsis, year, status, genres, last chapter)
- Pasting `https://comix.to/title/{hid}` URLs into the per-manga URL
  manager — the URL parser recognises both bare-hid and SEO-slug forms
  (`/title/5ze6g`, `/title/5ze6g-horimiya`, `/title/5ze6g-horimiya/2602732-chapter-1`)
- Linkage to `manga.comixto_id`, kept in sync by `syncDenormalizedLinkage`
  the same way `mangadex_id` is

**What returns a clear error:**

- Any download attempt against a comix.to URL — the worker writes
  `comix.to chapter access is gated by a browser-only security token; use
  the linked MangaDex URL for actual downloads.` to `download_jobs.error`
- Scheduler runs against comix.to-only series — the same string lands in
  `manga_schedules.last_result`, visible in **Settings → Scheduling**

**Cross-source fallback:** the comix.to series response includes a
`links` block with the matching IDs at AniList, MyAnimeList,
MangaUpdates, MangaDex, and MangaBaka. Practical workflow for a series
that's available on both sites: link both URLs to your manga (the URL
manager allows multiple URLs per manga), and the MangaDex one will
handle actual downloads while the comix.to one serves as a record /
visual confirmation in the Scheduling page.

### MangaDex specifics

- All endpoints used are public (no OAuth):
  - `GET https://api.mangadex.org/manga?title=…` for search
  - `GET https://api.mangadex.org/manga/{id}/feed` for chapters
  - `GET https://api.mangadex.org/at-home/server/{chapterId}` for image hosts
- A static `User-Agent: Momotaro/1.0` header is sent on every request — MangaDex
  rejects requests without one.
- A 250 ms floor between metadata requests is enforced per-process so quick
  back-to-back searches can't burst past MangaDex's 5 req/sec global cap.
- Image fetches go through the downloader queue, which adds the user-configured
  per-page delay on top.
- All four `contentRating` buckets (`safe`, `suggestive`, `erotica`,
  `pornographic`) are included on search and chapter listing — the user is
  picking what to download, so filtering at the source level would only hide
  results.
- Languages: defaults to English (`en`); the chapter endpoint accepts
  `?lang=…,…` if a future UI exposes multi-language download.

### Download queue

`downloader/queue.js` is a single-process FIFO that picks the oldest `queued`
row from the `download_jobs` table, fetches every page via the source adapter,
zips them into a CBZ with `adm-zip`, atomically renames the result into the
target folder, and triggers `scanMangaDirectory` so the chapter is indexed
immediately.

**Concurrency knobs** (`tps_max_concurrent_chapters`, `tps_page_delay_ms`)
live in the SQLite `settings` table and are exposed in
**Settings → Third Party Sourcing**. Validation:

| Key | Range | Default |
|---|---|---|
| `tps_max_concurrent_chapters` | 1 – 8 | 1 |
| `tps_page_delay_ms` | 0 – 60 000 | 500 |

The Settings PUT route calls `downloader.applySettings()` after a successful
write, so the new concurrency takes effect on the next pump tick — no server
restart needed.

**Crash recovery:** on startup `init()` flips any `running` rows back to
`queued`. The CBZ is written via `<file>.cbz.tmp` → `rename` so a partial
download never lands at the final filename — the next worker run starts that
chapter over from page 1 without colliding with the already-rebuilt archive.
A bounded best-effort sweep also deletes leftover `.cbz.tmp` files inside
configured library paths during init.

**Cancellation:** the API route flips the row to `cancelled` and (for running
jobs) calls `AbortController.abort()` on the in-flight image fetch. The worker
also re-checks the row's status between pages, so cancellations land within one
page-delay window even if the current `fetch` has already buffered.

**Filename convention** (`buildChapterFilename` in `queue.js`):

```text
Vol. {NN} Ch. {NNNN}.cbz                 if both volume and chapter present
Ch. {NNNN}.cbz                           if chapter only
Vol. {NN}.cbz                            if volume only
{title}.cbz                              one-shots / extras
"{base} - {title}.cbz"                   when chapter title is set
```

`{NNNN}` preserves fractional chapter numbers (so 23.5 stays 23.5) but
zero-pads the integer part to 4 digits so natural-sort orders correctly. The
result is sanitized against `<>:"/\|?*` plus Windows-reserved device names
(CON, NUL, etc.).

## Source linkage

There are two layers, and they're kept in sync:

1. **`manga_source_urls`** — the authoritative log of every third-party URL
   ever associated with a manga. Multiple rows per manga are normal (alternate
   mirror, replacement after a dead link, second source like comix.to once it
   ships). Each row carries `(source, source_id, url, label, created_at,
   last_used_at)`.
2. **Per-source columns on `manga`** (`mangadex_id`, …) — denormalized
   "active" pointers used by the cover/metadata pipelines and by the future
   scheduler when picking the canonical URL to re-poll. Maintained by
   `syncDenormalizedLinkage()` in [routes/sources.js](../server/src/routes/sources.js):
   after every insert/update/delete on the URL table the column is set to the
   `source_id` of the most recent matching row, or NULL if no row of that
   source remains.

| Column | Source | Filled by |
|---|---|---|
| `mangadex_id` | MangaDex (UUID string) | Most recent `manga_source_urls` row with `source='mangadex'` |
| `comixto_id` | comix.to (hid) | Most recent `manga_source_urls` row with `source='comixto'` |
| `mangakakalot_id` | MangaKakalot (slug) | Most recent `manga_source_urls` row with `source='mangakakalot'` |
| `mangafire_id` | MangaFire (`{slug}.{hid}`) | Most recent `manga_source_urls` row with `source='mangafire'` |
| `weebcentral_id` | WeebCentral (ULID) | Most recent `manga_source_urls` row with `source='weebcentral'` |
| `mangaball_id` | MangaBall (24-hex ObjectId) | Most recent `manga_source_urls` row with `source='mangaball'` |
| `mangataro_id` | MangaTaro (slug) | Most recent `manga_source_urls` row with `source='mangataro'` |
| `mangadotnet_id` | MangaDotNet (numeric id) | Most recent `manga_source_urls` row with `source='mangadotnet'` |
| `comikuro_id` | ComiKuro (slug) | Most recent `manga_source_urls` row with `source='comikuro'` |

### Auto-recording

Every `POST /api/sources/:source/download` writes a URL row before the queue
starts work, so even a cancelled/failed download leaves a record:

- **mode='existing'** — written synchronously in the route handler (the manga
  row already exists).
- **mode='new'** — written by the queue worker right after the post-download
  rescan creates the manga row (`recordSourceUrlForPath` in
  [downloader/queue.js](../server/src/downloader/queue.js)).

Both paths bump `last_used_at` so the future scheduler can sort series by
recency-of-download when pacing checks.

### REST endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`    | `/api/manga/:id/source-urls`              | List recorded URLs for this manga |
| `POST`   | `/api/manga/:id/source-urls`              | Body: `{ url }` (auto-detect) or `{ source, source_id, url?, label? }` |
| `PATCH`  | `/api/manga/:id/source-urls/:urlId`       | Body: `{ url?, label? }` — replace the URL when a slug changes or the user moves to a mirror |
| `DELETE` | `/api/manga/:id/source-urls/:urlId`       | Remove a dead/wrong URL |

URL parsing lives in [sources/urlParser.js](../server/src/sources/urlParser.js).
A URL that doesn't match any known pattern is rejected with HTTP 400 — the
response includes the list of accepted patterns so the user knows what to
paste. Recognised today:

- `https://mangadex.org/title/{uuid}` (also `.cc` and `.com` legacy mirrors)
- `https://comix.to/title/{hid}[-{seo-slug}[/{chapter-id}-chapter-N]]`
- `https://www.mangakakalot.gg/manga/{slug}`
- `https://mangafire.to/manga/{slug}.{hid}` (also `/read/{slug}.{hid}/{lang}/chapter-N`)
- `https://weebcentral.com/series/{ULID}`
- `https://mangaball.net/title-detail/{slug}-{ObjectId}/`
- `https://mangataro.org/manga/{slug}` (also `/read/{slug}`)
- `https://mangadot.net/manga/{id}`
- `https://comikuro.to/manga/{slug}`

### Legacy direct-linkage routes

The original single-column-per-source endpoints still exist for callers that
want to set just the `<source>_id` column without going through the URL log
(e.g. a future bulk-linkage import). They write the column directly and don't
touch `manga_source_urls`:

| Method | Path | Purpose |
|---|---|---|
| `POST`   | `/api/manga/:id/link-source`            | Body: `{ source, source_id }` |
| `DELETE` | `/api/manga/:id/link-source/:source`    | Clear that source's linkage |

Prefer the `/source-urls` endpoints for any user-facing linkage work — they
keep the URL log and the denormalized column consistent.

## Scheduled auto-checking

Per-manga schedules drive automatic re-checks of every recorded source URL.
Implementation lives in [server/src/scheduler/index.js](../server/src/scheduler/index.js).

### Lifecycle

1. **Startup** — `scheduler.start()` (called from [server/src/index.js](../server/src/index.js))
   backfills `next_run_at` for any rows that lost it (e.g. after an
   export/import round-trip), starts a 60-second `setInterval`, and fires
   one tick after a 5-second delay so anything overdue from the previous
   process is handled promptly. The interval is `.unref()`'d so a pending
   tick never blocks graceful shutdown.
2. **Poll tick** — `runDueChecks()` selects every `manga_schedules` row
   where `enabled = 1 AND next_run_at <= now`, capped at 50 per tick. The
   query is backed by `idx_manga_schedules_due` so cost is `O(log n)` even
   with thousands of scheduled series.
3. **Per-manga check** — for each due row, `checkOneManga(mangaId)` runs:
   - Loads every URL in `manga_source_urls` for the manga and dedupes by
     `(source, source_id)` — multiple URLs that point at the same series at
     the same source (alternate mirror) are fetched once.
   - For each unique target, calls the adapter's `getChapters(seriesId)`.
     Failures are logged and recorded in `last_result` but never disable
     the schedule — a transient network blip shouldn't pause auto-checking.
   - Diffs the remote chapter list against the local set, computed from
     `chapters.number` (already populated by the scanner via
     `parseChapterInfo` in [chapterParser.js](../server/src/scanner/chapterParser.js),
     which recognises `Chapter 1`, `ch 01`, `c01`, `ch.1`, etc.). Numeric
     comparison uses a `1e-3` tolerance to absorb float jitter on `23.5`
     fractional chapters.
   - Enqueues every missing chapter into the existing download queue with
     `target_mode='existing'` and `target_manga_id=<this manga>`, so they
     land in the same folder.
   - Inter-manga delay of 1 second between checks within a tick keeps us
     polite when many schedules fire at the same minute.
4. **Result persistence** — `recordRunResult` writes `last_checked_at`,
   `last_result` (e.g. `"Queued 3 new chapters"`, `"No new chapters"`,
   `"error: Network timeout"`), and the new `next_run_at` to the row. The
   poll loop only ever reads indexed fields, so the per-tick query stays
   cheap regardless of run history.

### Time math

`computeNextRunAt({ frequency, day_of_week, time_of_day })` runs in **server
local time** (matches `cbzCacheSchedule`):

- **daily** — today at `HH:MM` if still in the future, otherwise tomorrow.
- **weekly** — next occurrence of (`day_of_week`, `HH:MM`) on or after now;
  if today matches and `HH:MM` hasn't passed, today wins.

Returns `null` on invalid input so the route handler can reject with 400
instead of saving a row that never fires.

### Schedule storage

`manga_schedules` (one row per manga; UNIQUE on `manga_id`):

| Column | Notes |
|---|---|
| `id` | INTEGER PK |
| `manga_id` | FK to `manga(id)` ON DELETE CASCADE — removing a manga removes its schedule |
| `enabled` | INTEGER 0/1 — when 0, `next_run_at` is set to NULL so the poll skips it cheaply |
| `frequency` | `daily` \| `weekly` |
| `day_of_week` | 0..6 (0 = Sunday) when `frequency = 'weekly'`, else NULL |
| `time_of_day` | `HH:MM` 24-hour, server local |
| `last_checked_at` | Unix seconds of the last fire |
| `last_result` | Short status string from the last fire |
| `next_run_at` | Unix seconds — the index this table is queried by |

Index: `idx_manga_schedules_due ON manga_schedules(next_run_at) WHERE enabled = 1`.

### Schedule REST endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/manga/:id/schedule` | Current schedule, or `null` when none exists |
| `PUT` | `/api/manga/:id/schedule` | Body: `{ frequency, time_of_day, day_of_week?, enabled? }` — recomputes `next_run_at` |
| `DELETE` | `/api/manga/:id/schedule` | Remove |
| `POST` | `/api/manga/:id/schedule/run-now` | One-shot check independent of the schedule; updates `last_checked_at` / `last_result` if a row exists |

### UI

The schedule editor lives inside the **Third Party Sources** modal on
MangaDetail (`ScheduleEditor` in [MangaDetail.jsx](../client/src/pages/MangaDetail.jsx)).
Sits below the URL list because both surfaces are the same conceptual
operation (point this manga at a third-party source). Has:

- Enabled toggle, frequency (daily/weekly), day-of-week (when weekly), and
  HH:MM time inputs (server local).
- **Save / Update / Remove schedule** buttons.
- **Run check now** that calls the run-now endpoint and surfaces the
  `{ ok, summary, enqueued }` response inline.
- Last-run + next-run readouts, formatted in the user's local timezone.

The editor is disabled until at least one URL has been recorded — the
scheduler has nothing to check otherwise. Adding a URL flips the buttons
back on without a reload.

## MangaDetail integration

A **Third Party Sources** button in the manga detail page (and in the mobile
Settings dropdown) opens the URL manager modal
([SourceUrlsModal in MangaDetail.jsx](../client/src/pages/MangaDetail.jsx)).
The modal:

1. Has a top button that routes to
   `/third-party-sourcing?manga_id=<id>`. The TPS page reads that query param,
   pre-fills the search box with the manga's title, locks the target picker to
   mode='existing' + this manga, and auto-runs the search — so any chapters
   the user queues land in the right folder with no extra clicks.
2. Lists every recorded URL with **Edit** (paste a corrected URL — the new
   `(source, source_id)` is re-derived from it) and **Remove** (with confirm).
3. Has a **paste a new URL** form for sources the user found themselves.

## REST endpoints

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/sources` | List available source adapters |
| `GET`  | `/api/sources/:source/search?q=…` | Title search, capped at 20 results |
| `GET`  | `/api/sources/:source/series/:id` | Single series detail |
| `GET`  | `/api/sources/:source/series/:id/chapters?lang=en[&manga_id=…]` | Chapter list, annotated with `already_downloaded` |
| `POST` | `/api/sources/:source/download` | Enqueue chapters; body documented in [routes/sources.js](../server/src/routes/sources.js) |
| `GET`  | `/api/sources/downloads?limit=50` | Recent jobs newest-first |
| `DELETE` | `/api/sources/downloads/:id` | Cancel queued or running job |
| `POST` | `/api/sources/downloads/:id/retry` | Re-queue a failed or cancelled job |
| `POST` | `/api/sources/downloads/clear-finished` | Drop done/failed/cancelled rows |
| `GET`  | `/api/sources/match-existing?title=…` | FTS5 lookup against the user's library |
| `POST` | `/api/manga/:id/link-source` | Set `<source>_id` on a manga row |
| `DELETE` | `/api/manga/:id/link-source/:source` | Clear that linkage |
| `GET`  | `/api/manga/:id/source-urls` | List recorded URLs for this manga |
| `POST` | `/api/manga/:id/source-urls` | Add a URL — body `{url}` (auto-detect) or `{source, source_id, url?, label?}` |
| `PATCH` | `/api/manga/:id/source-urls/:urlId` | Replace URL and/or label |
| `DELETE` | `/api/manga/:id/source-urls/:urlId` | Remove a URL row |
| `GET`  | `/api/schedules` | Every per-manga schedule with each manga's URLs embedded |
| `GET`  | `/api/manga/:id/schedule` | Current schedule or `null` |
| `PUT`  | `/api/manga/:id/schedule` | Upsert — body `{frequency, time_of_day, day_of_week?, enabled?}` |
| `DELETE` | `/api/manga/:id/schedule` | Remove the schedule |
| `POST` | `/api/manga/:id/schedule/run-now` | One-shot check; writes `last_checked_at`/`last_result` if a schedule exists |

## Database

`download_jobs` (added in [database.js](../server/src/db/database.js) by
`createDownloadJobsTable`):

| Column | Notes |
|---|---|
| `id` | INTEGER PK |
| `source` | TEXT — source adapter id, e.g. `mangadex` |
| `source_series_id` | TEXT — `manga.<source>_id` value |
| `source_series_title` | TEXT — frozen at enqueue time for display |
| `source_chapter_id` | TEXT |
| `chapter_number`, `chapter_volume` | REAL — preserved verbatim from the source |
| `chapter_title` | TEXT |
| `target_mode` | `new` \| `existing` |
| `target_library_id`, `target_manga_id`, `target_folder_name` | mode-dependent |
| `target_chapter_filename` | Filled by the worker once the CBZ name is decided |
| `status` | `queued` \| `running` \| `done` \| `failed` \| `cancelled` |
| `error` | First-500-chars of the error message when `status = 'failed'` |
| `pages_downloaded`, `pages_total` | Live progress counter for the UI |
| `created_at`, `started_at`, `finished_at` | Unix timestamps |

Indexes: `idx_download_jobs_status` and `idx_download_jobs_created_at` keep
the listing query and the worker's "next queued job" pick fast even after
thousands of historical rows.
