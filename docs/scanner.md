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
- **CBZ/ZIP archives**: read with streaming `yauzl` — never extracted to disk
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
| `manga` | `bytes_on_disk` | Rollup: `SUM(chapters.bytes_on_disk) WHERE manga_id = ?` at the end of `scanMangaDirectory`. |
| `manga` | `file_count` | Rollup: `SUM(chapters.file_count) WHERE manga_id = ?`. |

Both rollups run inside `scanMangaDirectory` so that chapters skipped by the incremental mtime check are still counted — their previously-stored `bytes_on_disk` is just re-summed. The update uses a single SQL statement with two correlated subqueries, so the cost is one roundtrip per manga regardless of chapter count.

`GET /api/stats` sums `manga.bytes_on_disk` in a single query; `GET /api/manga/:id/info` reads the columns directly. Before this change both endpoints walked the library folder on every request — untenable at 8 TB.

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

**CBZ chapters skip dimension fetching at scan time.** Reading dimensions for a page inside a CBZ would require decompressing the entry, which is exactly what the streaming change is meant to avoid. Rows for CBZ pages are inserted with `width` and `height` set to `NULL`; the reader treats `null` dimensions as "unknown orientation" and falls back to single-page layout. Clients that need the true size can read it lazily once the image has been fetched.

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

## CBZ Streaming

CBZ files are read via `yauzl` in two modes and are **never extracted to disk**:

1. **At scan time** — `listCbzEntries(cbzPath)` opens the archive, walks the central directory, and returns one entry per image file inside. No compressed data is read, no file is written. For a 100 MB CBZ this is a handful of KB of disk I/O.
2. **At serve time** — `openCbzEntryStream(cbzPath, entryName)` opens the archive, locates the requested entry, and resolves with a `Readable` stream that decompresses only that one entry. The stream is piped straight through to the HTTP response in [server/src/routes/pages.js](../server/src/routes/pages.js).

### How page rows represent archive entries

For CBZ chapters, the `pages.path` column stores the **ZIP entry name** (e.g. `001.jpg` inside the archive) rather than a filesystem path. The serving route joins `pages` to `chapters` so it can see `chapters.type` and `chapters.path` (the CBZ file on disk):

- `chapters.type = 'folder'` → `pages.path` is absolute; `res.sendFile(path)`
- `chapters.type = 'cbz'` → `pages.path` is the entry name; stream it from `chapters.path`

Natural sort is applied to entry names during scanning, so `pages.page_index` matches the reader's expected order regardless of how the archive was authored.

### Why streaming instead of extraction

The previous implementation extracted every opened CBZ to `CBZ_CACHE_DIR/<chapterId>/` and enforced a 20 GB LRU ceiling on the cache. At 8 TB library scale this has two problems:

- Most chapters the user never opens would still be fine in the cache, but the first-read latency (extract-all vs stream-one) is roughly `(total pages × page size) / (one page × compressed size)`, usually 20–100× worse.
- The extract-to-disk path doubled the disk-write load during bulk reading — each opened chapter wrote ~30–100 MB before serving the first page.

Streaming serves a page with one seek-per-archive plus decompressing a single entry (the OS page cache keeps hot CBZs in RAM). There is no on-disk cache to manage.

### Legacy cache cleanup

Any `CBZ_CACHE_DIR` contents left over from a previous install are wiped on server startup in [server/src/index.js](../server/src/index.js). A log line reports the number of legacy entries removed. The directory itself is not recreated — subsequent runs detect it as missing and skip the cleanup.

The admin endpoints `GET /api/admin/cbz-cache-size` and `POST /api/admin/clear-cbz-cache` remain available for operator convenience; `limit_bytes` in the size response is always `0` now, signalling that no ceiling is enforced.

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

Local metadata is only applied when `metadata_source` is not `'anilist'` — AniList-sourced metadata is never overwritten by a local file.

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
