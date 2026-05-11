# Third Party Sourcing

In-app downloader that fetches chapters from third-party sources, writes them
as CBZ archives into the user's library, and records the source linkage so a
future scheduler can re-check those series for new releases.

**Phase 1 (current):** MangaDex search + manual download into a chosen library
or existing series. Source linkage is recorded automatically on download and
can also be set manually from the same page.

**Future phases (not in this build):**

- comix.to adapter (HTML scraping)

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

1. **Source picker + search** — single source dropdown (only MangaDex right
   now) and a title query box.
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
| [server/src/sources/mangadex.js](../server/src/sources/mangadex.js) | MangaDex API client — search, series, chapters, MangaDex@Home image URLs |
| [server/src/downloader/queue.js](../server/src/downloader/queue.js) | Persistent FIFO download queue with configurable concurrency + per-page delay |
| [server/src/routes/sources.js](../server/src/routes/sources.js) | `/api/sources/*` REST endpoints + manga linkage routes |

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
| `POST` | `/api/sources/downloads/clear-finished` | Drop done/failed/cancelled rows |
| `GET`  | `/api/sources/match-existing?title=…` | FTS5 lookup against the user's library |
| `POST` | `/api/manga/:id/link-source` | Set `<source>_id` on a manga row |
| `DELETE` | `/api/manga/:id/link-source/:source` | Clear that linkage |

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
