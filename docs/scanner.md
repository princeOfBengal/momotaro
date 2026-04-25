# Library Scanner

The scanner turns filesystem folders and CBZ files into database records.

## Entry Points

| File | Purpose |
|---|---|
| [server/src/scanner/libraryScanner.js](../server/src/scanner/libraryScanner.js) | Main scanner — walks directories, upserts DB rows, generates thumbnails |
| [server/src/scanner/chapterParser.js](../server/src/scanner/chapterParser.js) | Parses chapter/volume numbers from names; lists and streams CBZ entries via `yauzl` |
| [server/src/scanner/thumbnailGenerator.js](../server/src/scanner/thumbnailGenerator.js) | Generates WebP cover images via Sharp (accepts either a filesystem path or a CBZ entry descriptor) |
| [server/src/scanner/localMetadata.js](../server/src/scanner/localMetadata.js) | Reads YAML/JSON sidecar metadata from manga folders |
| [server/src/watcher/index.js](../server/src/watcher/index.js) | chokidar watcher — triggers `scanMangaDirectory` on file changes |

## Expected Library Layout

```
library/
├── My Manga Title/
│   ├── Vol. 01/               ← chapter folder
│   │   ├── 001.jpg
│   │   └── 002.jpg
│   ├── Vol. 02 Ch. 10.cbz     ← CBZ chapter
│   └── cover.jpg              ← optional explicit cover
└── Another Manga/
    └── ...
```

- Top-level subdirectories are treated as **manga**.
- Second-level entries (folders containing images, or `.cbz`/`.zip` files) are treated as **chapters**.
- Images directly inside a manga folder (not in a chapter subfolder) are ignored by the chapter scanner.

## Supported Formats

- **Folder chapters**: directories containing image files
- **CBZ/ZIP archives**: scanned via streaming `yauzl` (central-directory read only); served via a bounded on-disk extraction cache with a user-configurable cap (default 20 GB) and an optional daily/weekly auto-clear schedule (see [CBZ Serve Cache](#cbz-serve-cache))
- **Images**: `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, `.gif`

## Incremental Scanning

The scanner avoids re-processing chapters that have not changed since the last scan.

For each chapter entry:
1. `fs.statSync(chapterPath).mtimeMs` is read and stored as `chapters.file_mtime` (seconds).
2. On subsequent scans, if `existingChapter.file_mtime` matches the current mtime **and** `existingChapter.page_count > 0`, the full page re-index (CBZ entry listing + dimension fetching) is skipped.
3. For skipped chapters, the cover candidate is resolved from the existing `pages` rows rather than re-reading the filesystem.

This means a re-scan of an unchanged library does almost no I/O beyond directory listings.

## Cached Disk-Usage Columns

The scanner populates four columns that the stats and info endpoints read directly, avoiding per-request disk walks:

| Table | Column | How it's computed |
|---|---|---|
| `chapters` | `bytes_on_disk` | For `folder` chapters: sum of `fs.statSync(page).size` over all image pages. For `cbz` chapters: `fs.statSync(cbzPath).size` (the archive's on-disk size). |
| `chapters` | `file_count` | Number of image pages (equal to `page_count`). |
| `manga` | `bytes_on_disk` | Rollup of `SUM(chapters.bytes_on_disk)` for the manga. |
| `manga` | `file_count` | Rollup of `SUM(chapters.file_count)` for the manga. |

Chapters skipped by the incremental mtime check are still counted — their previously-stored `bytes_on_disk` is re-summed from the row, not recomputed from disk.

### Single-manga path (watcher, optimize route)

`scanMangaDirectory` writes the manga-level rollup itself using two correlated subqueries in one statement — a single round-trip per manga, independent of chapter count.

### Bulk library path (`scanLibrary`)

In a full library walk the per-manga rollup is suppressed — `scanLibrary` passes `{ skipRollup: true }` to each `scanMangaDirectory` call. After the per-manga work and the missing-manga cleanup pass, `scanLibrary` issues **one** grouped update for the whole library:

```sql
UPDATE manga
SET bytes_on_disk = COALESCE(agg.bytes, 0),
    file_count    = COALESCE(agg.files, 0)
FROM (
  SELECT c.manga_id,
         SUM(c.bytes_on_disk) AS bytes,
         SUM(c.file_count)    AS files
  FROM chapters c
  JOIN manga m ON m.id = c.manga_id
  WHERE m.library_id = ?
  GROUP BY c.manga_id
) AS agg
WHERE manga.id = agg.manga_id;
```

A second statement zeros out any manga left with no chapter rows so deletions propagate cleanly (the `FROM`-clause aggregate only covers manga that still have chapters).

The trade-off: at N manga with C chapters each, the per-manga path issues N statements hitting the `chapters` table N times; the bulk path replaces that with one `GROUP BY` pass. For a 10 k-manga library this eliminates ~10 k correlated-subquery round-trips per full scan.

`GET /api/stats` sums `manga.bytes_on_disk` in a single query; `GET /api/manga/:id/info` reads the columns directly. Before the cached columns existed both endpoints walked the library folder on every request — untenable at 8 TB.

## Parallel Scanning

`scanLibrary` walks manga directories with bounded concurrency rather than serially. The outer loop over manga dirs runs at `MANGA_CONCURRENCY = 4` via the internal `withLimit(n, items, fn)` helper. Each parallel worker calls `scanMangaDirectory` end-to-end (readdir → upsert manga → scan chapters → write pages → roll up stats → generate thumbnail).

DB correctness is preserved because `better-sqlite3` serialises writes on a single thread — prepared statements called from parallel workers queue up behind each other. The speedup comes from overlapping disk I/O (directory reads, CBZ central-directory reads, image-header reads for dimension fetching) across manga.

On-disk constants:

| Knob | Value | What it caps |
|---|---|---|
| `MANGA_CONCURRENCY` | `4` | Parallel manga being scanned at once |
| `IMAGE_DIM_CONCURRENCY` | `3` | Per-manga concurrent `sharp.metadata()` calls for folder-chapter pages |

Worst case concurrent sharp calls is `MANGA_CONCURRENCY × IMAGE_DIM_CONCURRENCY = 12`, which a modern SSD + 4-core machine handles without thrashing.

## Startup Skip (root-mtime shortcut)

On startup (and only on startup), `scanLibrary` compares the library root's `mtimeMs` against the `libraries.last_scan_mtime_ms` column. If they match, the walk is skipped entirely — no directory listing, no per-manga work. The column is written at the end of every full walk.

Manual scans via `POST /api/scan` and `POST /api/libraries/:id/scan` pass `force: true`, which bypasses the check.

**Caveat:** root mtime only changes when direct children of the library folder are added, removed, or renamed. An in-place edit inside an existing manga folder (e.g. dropping a new CBZ into a manga that already exists) is not reflected in the root mtime. While the server is running, the chokidar watcher catches those events and calls `scanMangaDirectory` directly, so this is only a concern for edits made while the server is stopped. Trigger a manual scan after such edits.

## Image Dimension Fetching

Page dimensions (width/height) are read with `sharp` so the reader can detect wide pages for double-page spread layout. Per-manga concurrency is capped at `IMAGE_DIM_CONCURRENCY = 3` via `withLimit`.

**CBZ chapters skip dimension fetching at scan time.** Reading dimensions for a page inside a CBZ would require decompressing the entry, which is exactly what the streaming change is meant to avoid. Rows for CBZ pages are inserted with `width` and `height` set to `NULL`.

Dimensions for CBZ pages are then filled in lazily by the API the first time the chapter is opened. `GET /api/chapters/:id/pages` ([server/src/routes/pages.js](../server/src/routes/pages.js)) detects any rows with null width/height for a CBZ chapter, decompresses each entry through `sharp.metadata()` at concurrency 4, and persists the results back into the `pages` table inside a single transaction. Every subsequent open of the same chapter hits the cached values, so the cost is paid once per CBZ chapter. This is what lets the **Double Page (Manga)** layout detect true double-page spreads inside CBZ archives — without dimensions the reader can't tell a wide spread from a normal page, and would pair them with the next page instead of rendering them solo.

Folder-chapter pages continue to have their dimensions indexed during the scan — reading a few KB of image header per file is cheap and local.

## Chapter/Volume Name Parsing

Handled in `chapterParser.js` → `parseChapterInfo(name)`.

Returns `{ chapter: float|null, volume: float|null }`.

### Volume patterns recognized

| Pattern | Example | Parses as |
|---|---|---|
| `Vol.N`, `Vol N` | `Vol.03`, `Vol 2` | volume |
| `Volume N` | `Volume 2` | volume |
| `vN`, `v.N` | `v01`, `V2` | volume |

Regex: `/\b(?:vol(?:ume)?|v)\.?\s*(\d+(?:\.\d+)?)\b/i`

### Chapter patterns recognized

| Pattern | Example | Parses as |
|---|---|---|
| `Ch.N`, `Ch N` | `Ch.023.5`, `Ch 12` | chapter |
| `Chapter N` | `Chapter 5` | chapter |
| `cN`, `c.N` | `c01`, `C01` | chapter |

Regex: `/\b(?:ch(?:apter)?|c)\.?\s*(\d+(?:\.\d+)?)\b/i`

### Fallback
If no explicit prefix is found, the first standalone number that is not a 4-digit year (1900–2099) is used as the chapter number.

### Pre-processing
Before matching, the parser:
1. Strips known archive/image extensions
2. Removes bracketed groups (`[Fansub]`, `[HQ]`)
3. Normalizes `_`, `&`, `+` to spaces

### Examples

| Input | volume | chapter |
|---|---|---|
| `Vol. 03 Ch. 023.5 - Title [Group]` | 3 | 23.5 |
| `[Fansub] Vol.02 Ch.012` | 2 | 12 |
| `Chapter 23.5` | null | 23.5 |
| `Vol 1.cbz` | 1 | null |
| `001` | null | 1 |
| `v01` | 1 | null |
| `c01` | null | 1 |

## CBZ Reads

CBZ files are read via `yauzl` in two modes:

1. **At scan time** — `listCbzEntries(cbzPath)` opens the archive, walks the central directory, and returns one entry per image file inside. No compressed data is read, no file is written. For a 100 MB CBZ this is a handful of KB of disk I/O.
2. **At serve time** — requested entries are extracted to a bounded on-disk cache on first hit (see [CBZ Serve Cache](#cbz-serve-cache) below) and sent via `res.sendFile` on subsequent hits. Dimension fetching for the reader's double-page detection still uses `openCbzEntryStream` (streams without extracting).

### Central-Directory Cache

Parsing a CBZ's central directory via `yauzl`'s `readEntry()` loop costs roughly 1 ms per entry of event-loop overhead. For a 200-page chapter, re-parsing on every single page request would add ~200 ms of latency before the archive is even seeked. To avoid that, `chapterParser.js` keeps a bounded LRU cache keyed by CBZ path:

- **Shape:** `Map<cbzPath, { mtimeMs, entries: Map<entryName, yauzlEntry> }>`
- **Capacity:** `CBZ_ENTRIES_CACHE_MAX = 500` archives (~10 MB at typical entry counts).
- **Invalidation:** every hit re-stats the file and compares `mtimeMs`. A mismatch drops the cached map and forces a re-parse.
- **Holds no file descriptors.** The cache stores only the parsed entry records. Each stream call still opens the zip fresh and relies on `autoClose: true` to close the fd when the stream ends — so there is no fd leak even under high concurrency.
- **Stream-error safety:** if `openReadStream` errors (cached offsets stale for any reason), the cache entry is dropped before the error propagates. The next caller re-parses.
- **Explicit invalidation:** `invalidateCbzCache(cbzPath)` is exported for callers that rewrite or delete archives outside the normal scan path (e.g. bulk-optimize flows).

The first read of a given archive pays the parse cost once; every subsequent page from the same archive resolves in microseconds from the `Map` lookup before `openReadStream` is called with pre-known offsets.

### How page rows represent archive entries

For CBZ chapters, the `pages.path` column stores the **ZIP entry name** (e.g. `001.jpg` inside the archive) rather than a filesystem path. The serving route joins `pages` to `chapters` so it can see `chapters.type` and `chapters.path` (the CBZ file on disk):

- `chapters.type = 'folder'` → `pages.path` is absolute; `res.sendFile(path)`
- `chapters.type = 'cbz'` → `pages.path` is the entry name; stream it from `chapters.path`

Natural sort is applied to entry names during scanning, so `pages.page_index` matches the reader's expected order regardless of how the archive was authored.

## CBZ Serve Cache

Opening a CBZ chapter extracts the entire archive into a dedicated folder under `CBZ_CACHE_DIR`. The reader then behaves exactly like a folder chapter — every page request is a plain `res.sendFile` from disk. Extracting the whole chapter in one pass (instead of streaming entries on demand) eliminated two classes of bug at once: concurrent `openReadStream` calls cross-contaminating between archives, and subdirectory-prefixed entry names sorting in an order that didn't match the reader's expected page order.

Implementation lives in [server/src/scanner/cbzCache.js](../server/src/scanner/cbzCache.js).

**Layout:**

```text
CBZ_CACHE_DIR/
└── <chapterId>_<mtimeFloor>/    (one folder per extracted chapter)
    ├── 0001.jpg                 (sequential filenames — basename natural-sort
    ├── 0002.jpg                  of the original entry names gives the order)
    ├── ...
    └── .ready                   (sentinel file written last)
```

Folding the CBZ's floor-seconds mtime into the directory name is the staleness guard — rewriting an archive bumps its mtime, so the new version resolves to a fresh directory and the old one can never be served. Old mtime directories for the same `chapterId` are cleaned up on the next extraction, and anything left over is LRU-evicted eventually.

Extracted files are renamed to `NNNN.<ext>` (zero-padded count of image entries) so directory listings natural-sort into exact page order regardless of the archive's internal naming. The original basename is preserved separately on the `pages.filename` column for display.

**Chapter-open flow** (`GET /api/chapters/:id/pages` in [server/src/routes/pages.js](../server/src/routes/pages.js)):

1. `cbzCache.ensureChapterExtracted(chapterId, cbzPath)` — cache hit returns the existing directory; cache miss extracts every image entry in one pass, deduped via an `inFlight` map so parallel requests share a single extraction.
2. On a fresh extraction (or when existing DB rows don't match the directory contents), `pages` rows for the chapter are rebuilt: `DELETE FROM pages WHERE chapter_id = ?` followed by inserts in natural-sort order, with `pages.path` set to the cache filename and page dimensions filled in from `sharp.metadata()` on the extracted files.
3. The response goes back to the client with correctly-ordered pages and real dimensions (which is what the Double Page reader mode needs for wide-spread detection).

**Page-serve flow** (`GET /api/pages/:id/image`):

1. Lookup `pages.path` + chapter meta.
2. `cbzCache.ensureChapterExtracted(...)` — if the chapter was LRU-evicted since it was opened, re-extract. Extraction is deterministic from archive bytes, so the filenames produced match what `pages.path` already stores — no row rebuild needed on the serve path.
3. `res.sendFile(<dir>/<pages.path>)`.

**Size cap:** runtime-configurable. Defaults to 20 GB (`DEFAULT_CACHE_LIMIT_BYTES = 20 × 1024³`) and is overridden at startup from the `cbz_cache_limit_bytes` row in the `settings` table if present. `setLimitBytes(n)` changes the cap live from the admin API — any chapters over the new cap are evicted immediately. Enforced on every successful extraction.

**Eviction:** whole-chapter, oldest-first. LRU order is the iteration order of an in-memory `Map` — every touch re-inserts the key at the tail. When a new extraction pushes the global total over the cap, `<chapterId>_<mtime>` directories are `rm -rf`'d one at a time until the total is back under. Evicting at page granularity would leave partially-populated chapter directories behind, forcing re-extractions mid-read; per-chapter eviction keeps the invariant that a directory is either fully present or entirely absent.

**Crash-safety:** each image file is written to `<target>.tmp` and renamed into place on `finish`. The `.ready` marker is the final step of a successful extraction — directories missing it on startup are assumed to be partial extractions from a crashed run and are deleted.

**Persistence across restarts:** `init(limitBytes?)` walks `CBZ_CACHE_DIR`, validates each subdirectory's `.ready` marker, and rebuilds the in-memory index from the files that remain. Warm cache survives a restart. [server/src/index.js](../server/src/index.js) reads the saved `cbz_cache_limit_bytes` row before calling `init()` so the rebuilt index is validated against the user's configured cap, not the 20 GB default. An immediate eviction pass runs if the rebuilt total exceeds the cap (e.g. the user lowered the limit since the last boot).

**Cover generation paths** — `POST /api/admin/regenerate-thumbnails` and `POST /api/manga/:id/set-thumbnail` for CBZ pages resolve through `cbzCache.getCbzPageFile(chapterId, cbzPath, pageIndex)`, which extracts the chapter on demand and returns the absolute path of the Nth file in natural-sort order. Scanner-time thumbnail generation still uses the streaming fast path (`openCbzEntryStream`) so the initial walk of a large library doesn't explode into gigabytes of extracted covers.

Admin endpoints `GET /api/admin/cbz-cache-size`, `POST /api/admin/clear-cbz-cache`, `GET /api/admin/cbz-cache-settings`, and `PUT /api/admin/cbz-cache-settings` expose the current size and configured cap, a manual wipe, and the size + auto-clear-schedule settings. See [api.md § Admin / Database Management](./api.md#admin--database-management).

### Auto-Clear Scheduler

Implemented in [server/src/scanner/cbzCacheSchedule.js](../server/src/scanner/cbzCacheSchedule.js). A single `setTimeout` fires the next scheduled wipe, then reschedules itself. Settings live in the same `settings` table as the size cap:

| Key | Values | Effect |
| --- | --- | --- |
| `cbz_cache_autoclear_mode` | `off` \| `daily` \| `weekly` | Schedule type. `off` disables the timer entirely. |
| `cbz_cache_autoclear_day` | `0..6` (0 = Sunday) | Day-of-week when mode is `weekly`. Ignored otherwise. |
| `cbz_cache_autoclear_time` | `HH:MM` 24-hour, server local time | Time of day to fire. |

`reschedule()` is idempotent — it's called on startup and again every time a setting changes through the admin API. The timer is `.unref()`'d so a pending wake-up never blocks graceful shutdown. On fire, `cbzCache.wipe()` removes every extracted chapter directory and the scheduler computes the next occurrence in server local time. When a daily/weekly window would already be in the past for today, the scheduler rolls forward to the next valid day.

## Local JSON Metadata

`localMetadata.js` → `findLocalMetadata(mangaPath)` searches for a JSON sidecar file in the manga directory (or its first chapter subdirectory) and maps it onto the internal metadata shape.

**File priority order:**

1. Explicit names: `metadata.json`, `info.json`, `gallery.json`, `comic.json`, `book.json`
2. Image sidecar (e.g. `cover.png.json`)
3. Any other `*.json` file

**Fields extracted:**

| Internal field | JSON keys tried (in order) |
|---|---|
| `title` | `title`, `Title`, `name`, `Name` |
| `author` | `artist`, `Artist`, `author`, `Author`, `circle`, `Circle` |
| `description` | `description`, `Description`, `summary`, `Summary` |
| `genres` | `tags`, `Tags`, `genres`, `Genres`, `categories`, `Categories` |
| `year` | `year`, `Year`, `published`, `date` (first 4 chars parsed as year) |
| `score` | `score`, `Score`, `rating`, `Rating` (auto-scaled from 0–100 to 0–10 if > 10) |

Local metadata is **always applied when a sidecar is found**, regardless of the manga's current `metadata_source`. Local has the highest display priority (see [api.md § Linkage and display priority](./api.md#linkage-and-display-priority)), so dropping a `metadata.json` into a folder switches the displayed fields to the file's contents. The scanner never touches `anilist_id`, `mal_id`, or `doujinshi_id` — adding a sidecar never breaks an external linkage; the user still sees the linkage in the Metadata modal and can swap display source via Break Linkage or by re-applying the third-party source. Removing the file and re-scanning does **not** automatically revert display: the row will still be marked `metadata_source = 'local'` until the user explicitly applies another source or runs Break Linkage.

## Stale Record Pruning

The scanner removes DB entries that no longer reflect the filesystem. Pruning happens at two levels:

### Chapter-level (inside `scanMangaDirectory`)

After building the list of valid chapter entries on disk, any DB chapter whose `folder_name` is not in that list is deleted. This runs on every call to `scanMangaDirectory`, including watcher-triggered calls.

### Manga-level (inside `scanMangaDirectory` and `scanLibrary`)

**No chapters found:** After the chapter-deletion pass, if `chapterEntries` is empty (the folder contains no recognisable chapter files or CBZ archives), the manga record is deleted and the function returns early. This covers empty folders, folders containing only metadata/image files, and folders where all chapters were deleted.

**Unreadable folder:** If `fs.readdirSync` throws (permissions error, or folder disappeared between the watcher event firing and the scan executing), the manga record is deleted before returning to avoid orphaned DB rows.

**Deleted folder (library-level pass):** After `scanLibrary` finishes iterating over all currently-present directories, it queries all manga belonging to that library and deletes any whose `path` no longer exists on disk. This handles the case where a manga folder is deleted between full scans — the file watcher does not catch directory removal events (only `unlink` for files, not `unlinkDir`).

In all pruning cases, the thumbnail file at `THUMBNAIL_DIR/<cover_image>` is also deleted. The `ON DELETE CASCADE` constraint on `chapters`, `pages`, and `progress` handles child-record cleanup automatically.

## Thumbnail Generation

Sharp resizes the first page of the lowest-numbered chapter to `300×430 px` WebP and saves it into the sharded thumbnail tree (see below). Aspect ratio is preserved with `cover` fit (cropped to fill). Thumbnails are only generated when none exists yet — re-scanning an existing manga will not regenerate its cover.

### Sharded Layout

Once a library grows past a few tens of thousands of manga, keeping every thumbnail in a single flat directory becomes a measurable drag on NTFS and ext4 — directory enumeration, `rename`, and `unlink` all slow down as the entry count grows. Thumbnails are therefore split into 256 shard subdirectories keyed on the manga's numeric ID:

```
thumbnails/
├── 00/
│   ├── 0.webp
│   ├── 256.webp
│   └── 256_anilist.webp
├── 01/
│   ├── 1.webp
│   └── 257_original.webp
└── ff/
    └── 255.webp
```

The shard for a thumbnail is `id % 256` rendered as two lowercase hex digits. Every file name in the system is prefixed with the manga's numeric id (`<id>.webp`, `<id>_anilist.webp`, `<id>_original.webp`, `<id>_<timestamp>.webp`), so the shard is derivable from the filename alone — the DB schema is unchanged, `manga.cover_image` still stores just the file name.

[server/src/scanner/thumbnailPaths.js](../server/src/scanner/thumbnailPaths.js) contains the shard helpers:

| Function | Purpose |
|---|---|
| `shardFor(filename)` | Returns the 2-char hex shard, or `null` for names without a numeric prefix |
| `thumbnailPath(filename)` | Absolute filesystem path including the shard subdirectory |
| `thumbnailUrl(filename)` | Web path under `/thumbnails/<shard>/<filename>` returned to clients |
| `ensureShardDir(filename)` | `mkdir -p` on the shard directory before a write |
| `migrateToSharded()` | One-time startup migration — moves any flat `.webp` at the root into its shard dir |

`express.static(THUMBNAIL_DIR)` serves the sharded tree unchanged — `/thumbnails/ab/5.webp` naturally resolves to `THUMBNAIL_DIR/ab/5.webp`. The matching helper on the client (`api.thumbnailUrl(filename)` in [client/src/api/client.js](../client/src/api/client.js)) applies the same shard formula so URLs constructed without a round-trip still work.

### Legacy Migration

On startup, `migrateToSharded()` walks `THUMBNAIL_DIR` at depth 0, looking for stray `.webp` files left over from the pre-sharded layout. Each such file is renamed into `<shard>/<filename>`. The migration is idempotent — once fully sharded, the root directory contains only the shard subdirectories and the walk completes with zero moves.

## File Watcher

`chokidar` watches all configured library paths at depth 0 (top-level entries only). Changes are debounced 3000 ms per manga directory to avoid thrashing during multi-file copy operations. On change, `scanMangaDirectory()` is called for the affected manga only — not a full rescan.

**Note:** The watcher listens to `add`, `addDir`, `change`, and `unlink` events but **not** `unlinkDir`. Deleting an entire manga folder will not trigger a watcher event. The manga record is cleaned up the next time a full library scan runs (via the library-level pruning pass described above).
