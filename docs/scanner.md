# Library Scanner

The scanner turns filesystem folders and CBZ files into database records.

## Entry Points

| File | Purpose |
|---|---|
| [server/src/scanner/libraryScanner.js](../server/src/scanner/libraryScanner.js) | Main scanner — walks directories, upserts DB rows, generates thumbnails |
| [server/src/scanner/chapterParser.js](../server/src/scanner/chapterParser.js) | Parses chapter/volume numbers from names; lists and streams CBZ entries via `yauzl` |
| [server/src/scanner/thumbnailGenerator.js](../server/src/scanner/thumbnailGenerator.js) | Generates WebP cover images via Sharp (accepts either a filesystem path or a CBZ entry descriptor) |
| [server/src/scanner/coverResolver.js](../server/src/scanner/coverResolver.js) | Active-cover priority resolver. Used by `applyMetadataToManga`, `POST /api/admin/reset-thumbnails`, and the post-scan reinforcement pass. See [Cover Priority](#cover-priority). |
| [server/src/scanner/localMetadata.js](../server/src/scanner/localMetadata.js) | Reads JSON sidecar (generic + scraper `primary_title` format) and `ComicInfo.xml` metadata from manga folders |
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

The scanner populates four columns that the stats endpoint reads directly, avoiding per-request disk walks (the per-manga `/info` endpoint recomputes on demand — see the note below this table):

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

`GET /api/stats` sums `manga.bytes_on_disk` in a single query — before the cached column existed it walked the library folder on every request, untenable at 8 TB. `GET /api/manga/:id/info` is the deliberate exception: it recomputes folder size and chapter count on demand (a single-manga walk is cheap, and the modal also reports missing-chapter gaps) so its figures reflect the disk's current state rather than the last scan rollup.

## Cover Priority

Every manga row stores up to five candidate cover filenames — one per third-party source plus the scanner-generated original — and a single active filename pointer:

| Column | Source | Filename pattern |
|---|---|---|
| `anilist_cover` | AniList | `<mangaId>_anilist.webp` |
| `mal_cover` | MyAnimeList | `<mangaId>_mal.webp` |
| `mangaupdates_cover` | MangaUpdates | `<mangaId>_mu.webp` |
| `doujinshi_cover` | Doujinshi.info | `<mangaId>_dj.webp` (legacy `<mangaId>_cover.webp` is backfilled — see [database.md](./database.md#migrations)) |
| `original_cover` | Scanner | `<mangaId>_original.webp` (set once on first scan, never overwritten) |
| `cover_image` | — | Always `<mangaId>.webp`, the active file content for serving |

Each `*_cover` column points at an immutable archive of that source's image. The visible `<mangaId>.webp` is a copy of one of those archives, chosen by the priority resolver in [server/src/scanner/coverResolver.js](../server/src/scanner/coverResolver.js):

```text
anilist_cover > mal_cover > mangaupdates_cover > doujinshi_cover > original_cover
```

Local JSON sidecars (`metadata_source = 'local'`) **don't enter the cover priority** — they only swap text fields. A local-displayed manga that was previously linked to AniList still shows the AniList cover by default.

### Manual user picks

`POST /api/manga/:id/set-thumbnail` (page-derived or saved-file-derived) sets `manga.cover_user_set = 1`. From that point on:

- Subsequent metadata fetches (`refresh-metadata`, `apply-metadata`, the bulk pull) only refresh the relevant `*_cover` source column. The active cover is left alone.
- The active cover stays at whatever the user picked, even if it's a generated chapter cover (`<mangaId>_<timestamp>.webp` from the page-derived form) that isn't in any `*_cover` slot.

### Reinforcement passes

The active cover is re-aligned to the priority order by `reinforceAllCovers` in `coverResolver.js`. Two callers, **two different `force` modes**:

1. **`POST /api/admin/reset-thumbnails`** — explicit user action from Settings → Database. Calls with `force = true`, which **clears `cover_user_set` and clobbers user picks**. This is the only path that ever does. Synchronous.
2. **End of every `scanLibrary` run** — runs after the per-library rollup queries finish and after the metadata-priority enforcement pass (see [End-of-scan metadata priority enforcement](#end-of-scan-metadata-priority-enforcement) below), before the watcher / runFullScan loop moves on. Calls with `force = false`, so **manga the user has manually picked a cover for are skipped entirely** — the user's pick survives every scan. Manga without a user pick re-align to the priority order normally. Logs per-source counts plus a `kept_user` bucket:

   ```text
   [Scanner] Cover priority reinforced for "library name": 301 → AniList,
       52 → MAL, 8 → MangaUpdates, 4 → Doujinshi, 18 → original,
       7 kept user pick, 49 no source on disk, 0 errors (432 total).
   ```

**Neither pings any upstream** — the resolver only re-uses cover files already on disk from earlier metadata fetches. To re-align a user-picked manga back to the priority order, the user explicitly runs Reset Thumbnails from Settings → Database.

## End-of-scan metadata priority enforcement

Right before the cover-reinforcement pass, `scanLibrary` calls `enforceMetadataPriorityForLibrary(db, libraryId)` (exported from [server/src/routes/metadata.js](../server/src/routes/metadata.js)). This pass realigns the **displayed metadata source** of every manga in the library to the highest-priority linkage that still exists, in the order:

```text
local > anilist > myanimelist > mangaupdates > doujinshi
```

**Why this exists.** Linkage IDs and `metadata_source` can drift apart over time: a manga that displayed AniList might have its AniList linkage broken via Reset Metadata, leaving `mal_id` populated but the row still flagged something else. The enforcement pass guarantees that the on-disk state and the displayed text fields agree with the priority rule on every full scan, without needing the user to click anything.

**Cache-first apply.** For each row whose `metadata_source` doesn't match the highest-priority remaining linkage, the helper calls `applyFallbackMetadata` (also in `routes/metadata.js`). That function reads the previously-saved normalized record from the on-disk per-source JSON cache (`data/metadata-cache/<source>/<id>.json`) and re-runs the standard apply path — no upstream ping when the cache hit succeeds. A live network fetch only happens as a last-resort fallback when the cache has no record for the chosen source. Local-displayed manga (`metadata_source = 'local'`) are skipped: the per-manga local-sidecar pass earlier in the scan already set them correctly, and local always outranks every third-party source.

**Logged counters.** Per-library log line written at the end of the pass:

```text
[Scanner] Metadata priority enforced for "library name": 4 switched, 1240 unchanged, 0 failed (1244 checked).
```

`switched` counts rows whose displayed source actually changed; `unchanged` counts rows already at the correct source (the steady-state majority); `failed` counts rows where neither the cache nor the network produced a usable record (logged separately). Errors here are non-fatal — `scanLibrary` continues into the cover-reinforcement pass even if enforcement throws.

**Ordering matters.** Enforcement runs *before* cover reinforcement so the cover resolver sees the post-enforcement `metadata_source` and picks the active cover that matches the freshly-chosen display source. Running them in the opposite order would briefly point `<mangaId>.webp` at the wrong source before the next scan caught up.

The same flow makes the `applyMetadataToManga` path (single refresh, single apply, bulk metadata) safe: it stores the fetched cover into the source-specific column and then calls `reinforceActiveCover` (force=false), which respects `cover_user_set` so a fresh AniList apply on a user-picked manga downloads the new AniList cover into `anilist_cover` without touching the visible `<mangaId>.webp`.

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

Dimensions for CBZ pages are filled in the first time the chapter is opened, on the same code path that extracts the archive. `GET /api/chapters/:id/pages` ([server/src/routes/pages.js](../server/src/routes/pages.js)) calls `cbzCache.ensureChapterExtracted`; on a fresh extraction (or whenever the existing rows don't match the cache directory) `rebuildCbzPageRows` deletes and re-inserts every row for the chapter — `sharp.metadata()` runs at concurrency 4 against the *already-extracted* on-disk files (no in-memory zip streaming), and the results are persisted in a single transaction. Every subsequent open of the same chapter hits the cached pages rows, so the cost is paid once per CBZ chapter unless the archive's mtime changes (a new extraction directory) or its rows go out of sync with the cache contents. This is what lets the **Double Page (Manga)** layout detect true double-page spreads inside CBZ archives — without dimensions the reader can't tell a wide spread from a normal page, and would pair them with the next page instead of rendering them solo.

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

1. **At scan time** — `listCbzEntries(cbzPath)` opens the archive, walks the central directory, and returns one entry per image file inside. No compressed data is read, no file is written. For a 100 MB CBZ this is a handful of KB of disk I/O. The bounded LRU described below caches the parsed central directory so repeat scans don't re-walk it.
2. **At serve time** — the entire chapter is extracted into a bounded on-disk cache on first hit (see [CBZ Serve Cache](#cbz-serve-cache) below) and every subsequent page request is a plain `res.sendFile` from that directory. Dimension fetching for the reader's double-page detection reads `sharp.metadata()` from the extracted on-disk files (not via `yauzl` streaming) at the time of the first chapter-open extraction.

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

For CBZ chapters, the `pages.path` column stores a **per-chapter cache filename** rather than a filesystem path. The serving route joins `pages` to `chapters` so it can see `chapters.type` and `chapters.path` (the CBZ file on disk):

- `chapters.type = 'folder'` → `pages.path` is absolute; `res.sendFile(pages.path)`.
- `chapters.type = 'cbz'` → ensure the chapter is extracted to `CBZ_CACHE_DIR/<chapterId>_<mtimeFloor>/`, then `res.sendFile(<dir>/<pages.path>)`.

Newly-scanned CBZ chapters initially store the **ZIP entry name** in `pages.path` (the scan only reads the central directory; nothing is extracted yet). The first time `GET /api/chapters/:id/pages` runs against the chapter it triggers a full extraction, then `rebuildCbzPageRows` deletes the existing rows and re-inserts them with `pages.path` set to the extracted cache filename (`0001.jpg`, `0002.jpg`, …). Natural sort is applied at extraction time on the basenames of the archive entries, so `pages.page_index` matches the reader's expected order regardless of how the archive was authored or whether entries lived in subdirectories inside the zip.

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

### Extraction modes

`ensureChapterExtracted(chapterId, cbzPath, opts)` accepts a `mode` flag with two values:

| Mode | When | What happens |
|---|---|---|
| `'full'` (default) | Reader without Fast chapter open opted in; every thumbnail / cover / metadata / `getCbzPageFile` caller | Single-shot decompress of every image entry, write `.ready`, resolve. Matches pre-feature behaviour. |
| `'fast'` | Reader with Fast chapter open opted in (`?fast=1` on `/api/chapters/:id/pages`) | Two-phase extract — see [Fast mode (first-page-fast)](#fast-mode-first-page-fast) below. |

A `full`-mode caller arriving while a `fast` Phase 2 is still running waits for Phase 2 to complete before resolving, so thumbnail/cover generation always sees a fully-extracted directory. The state's `phase2` field holds the **real** Phase 2 promise (the unhandled-rejection guard is attached separately), so a fatal error — `ARCHIVE_REMOVED` from a mid-flight rewrite/delete, or a corrupt-archive Phase 1 failure — propagates to that waiting full-mode caller instead of resolving as a false success against a directory the failing worker has already torn down.

On a failure the wait branch returns success **only if the `.ready` marker is actually present on disk**. This precisely distinguishes two failure shapes: a corrupt-archive / removal failure leaves *no* marker (the dir is partial or gone — re-throw so the caller re-extracts), whereas a rare late, non-fatal-to-disk error (e.g. `ENOSPC` writing the 0-byte marker *after* every page already extracted) leaves a complete, usable dir (return it). The success path adds no extra `fs` call.

### Fast mode (first-page-fast)

The fast path returns to the client after only a handful of pages are on disk; the rest extract in the background. Two phases:

**Phase 1** (blocks the API response):

1. `planChapterPages(cbzPath)` reads the central directory and computes deterministic per-page output filenames (`0001.jpg`, `0002.jpg`, …) without writing any image bytes.
2. `probeChapterDimensions` streams up to `CBZ_DIM_PROBE_BUFFER_BYTES` per entry through `sharp.metadata()` to learn width/height. Cheap header sniff — most image formats land their dimensions in the first few KB. Runs at `CBZ_DIM_PROBE_CONCURRENCY` workers in parallel.
3. Extract pages `[0..CBZ_FAST_PREFIX-1]` to disk (sequential, awaited). An optional `resumePage` hint extends the prefix to cover a small window around the user's resume position.
4. Phase 1 resolves with `{ dir, plannedPages, freshlyExtracted: true, extracting: true }`. The `/api/chapters/:id/pages` route then UPSERTs the page rows with Phase 1's probed dims and returns the response.

**Phase 2** (background, never blocks the response):

- Bounded by `CBZ_PHASE2_CONCURRENCY` slots across the whole library — a binge-clicker can't spawn unbounded background extracts.
- **Foreground / background priority.** The scheduler has two tiers. A real chapter open or page serve is *foreground*; the reader's next-chapter pre-extraction (`?prefetch=1`) is *background*. Foreground waiters always drain before background ones, and background extractions are additionally capped at `CBZ_PHASE2_CONCURRENCY - 1` (min 1) concurrent slots. This guarantees the chapter the user is actively reading can always acquire a slot rather than timing out behind prefetch work. The trade-off: when the background cap is hit and no foreground work is waiting, a freed slot can sit briefly idle rather than launching a second prefetch — a deliberate choice favouring foreground responsiveness over background throughput.
- **Priority is read live, and promotion is supported.** The scheduler keys on the chapter *state* and reads its foreground/background flag at grant time — it never captures a fixed priority. So when a foreground caller (a real open, a page serve, or a full-mode thumbnail/cover job) arrives for a chapter whose Phase 2 was started as a prefetch, `ensureChapterExtracted` *promotes* that extraction to foreground. A still-queued extraction is then re-picked ahead of other background work; an already-running one frees background-cap room for other prefetches. This closes the gap where following a prefetch into the next chapter would otherwise inherit background priority. Promotion is monotonic (background → foreground only), and because background-ness is derived live from the running set rather than a maintained counter, it can never leave the concurrency accounting out of sync. Regression coverage (foreground priority, background cap, promotion while queued/running, cancelled-waiter cleanup, no underflow): [server/test/phase2Scheduler.test.js](../server/test/phase2Scheduler.test.js).
- **Failed-page handling.** A single entry that fails to extract (corrupt zip entry, read/write error) is dropped from the work set — Phase 2 does not retry it. The failure is recorded on the chapter state (`failedPages`) so both current and *future* `waitForPageFile` callers reject immediately with `PAGE_EXTRACT_FAILED` instead of blocking the full `CBZ_PAGE_WAIT_TIMEOUT_MS`. The page-image route maps that to `404`, so the client stops retrying (see [reader image retry](./frontend.md)) rather than spinning forever on a page that will never land. One bad page never poisons the rest of the chapter. Regression coverage: [server/test/cbzCacheFailedPage.test.js](../server/test/cbzCacheFailedPage.test.js).
- Extracts every entry not yet on disk, in strict ascending page-index order (with priority-hint reordering — see below).
- After each successful page extract, fires an `onPageExtracted(pageIndex, absPath)` callback that the route uses to backfill any dims Phase 1's header sniff missed. Read via `sharp.metadata()` on the on-disk file (reliable where the 256 KB sniff was not). UPDATEs are batched and run only against rows whose current `width`/`height` are still NULL, so a good Phase 1 dim is never clobbered.
- Periodically re-stats the source CBZ (`CBZ_PHASE2_RESTAT_INTERVAL` pages) to detect rename / rewrite / delete mid-flight. A mismatched mtime + size aborts cleanly via `ARCHIVE_REMOVED` — the partial directory is removed and pageWaiters reject with `410 Gone`.
- `.ready` is written when the last entry has been renamed into place.

**Extraction-failure cleanup.** If Phase 1 itself fails (corrupt / truncated archive, a `planChapterPages` or dim-probe error) — or a full extract fails for any non-removal reason — the worker releases the chapter's state slot, reclaims the reserved index bytes, and removes the partial directory, for **every** error class (not just `CHAPTER_REMOVED` / `ARCHIVE_REMOVED`). Without this, a corrupt archive would leave the state wedged in `chapterStates`, so every later open would `await` the already-rejected Phase 1 promise and 500 forever until the file's mtime changed or the server restarted (and the reserved bytes would linger as a phantom index entry until the next open healed them). `runFastExtract` and `runFullExtract` handle this symmetrically — a failed extract never wrote `.ready`, so the partial dir is unusable by contract and always safe to drop. `releaseStateSlot` only drops the slot when it still points at *this* state, so it's a safe no-op against a concurrent `cancelChapter`. Regression coverage: [server/test/cbzCachePhase1Fail.test.js](../server/test/cbzCachePhase1Fail.test.js).

**Per-page waiters**: while Phase 2 is in flight, individual `/api/pages/:id/image` requests for pages not yet extracted block on `waitForPageFile(chapterDir, cacheFilename, { timeoutMs })`. The wait resolves when the rename-into-place succeeds for that specific filename; rejects on cancellation (`CHAPTER_REMOVED` → HTTP 410), archive removal, per-page extract failure (`PAGE_EXTRACT_FAILED` → HTTP 404), or timeout (`PAGE_WAIT_TIMEOUT` → HTTP 503 + `Retry-After: 2`). Capped at 32 waiters per chapter so a key-mashing user can't pin arbitrary HTTP slots. After Phase 2 completes and the state slot is released, a request for a still-absent page distinguishes *evicted mid-flight* (`.ready` missing → 503 retry) from *genuinely failed* (`.ready` present but file absent → 404).

**Priority hints**: `POST /api/chapters/:id/prioritize-pages` (called from the reader on scrubber/jump) moves the named page indices to the front of the Phase 2 work queue. Ensures that a user who scrubs ahead doesn't end up waiting on Phase 2 to reach their target in strict ascending order. No-op when there's no active fast extraction or when the chapter row has been removed.

**Page IDs are now stable across re-extractions.** Both full and fast modes UPSERT `pages` rows by `(chapter_id, page_index)` rather than the pre-feature `DELETE FROM pages` + INSERT pattern. A cache eviction followed by a re-extract preserves every row's `pages.id`, so art-gallery entries and any client-cached page-id references survive intact.

### Tunables

Read from environment variables via [server/src/config.js](../server/src/config.js) (defaults in parentheses):

| Env var | Default | Purpose |
| --- | --- | --- |
| `CBZ_FAST_PREFIX` | 6 | Pages extracted synchronously in Phase 1. Default chosen so a paged reader's first spread + prefetch lookahead are all on disk by the time Phase 1 returns. |
| `CBZ_DIM_PROBE_CONCURRENCY` | 6 | Parallel header-probe workers in Phase 1. |
| `CBZ_DIM_PROBE_BUFFER_BYTES` | 262144 (256 KB) | Per-entry cap when sniffing image headers; sharp stops as soon as it has dims. |
| `CBZ_PHASE2_CONCURRENCY` | 2 | Global cap on concurrent Phase 2 extractions across all chapters. Clamped to `>= 1` at load (a non-positive or non-numeric value would wedge the scheduler — `running.size >= 0` is always true — so it falls back to a usable floor). Background (prefetch) extractions get `value - 1` slots (min 1). |
| `CBZ_PAGE_WAIT_TIMEOUT_MS` | 30000 | Ceiling on `waitForPageFile`. |
| `CBZ_PHASE2_RESTAT_INTERVAL` | 8 | How often Phase 2 re-stats the source CBZ to catch rename / rewrite / delete. |

### Chapter-open flow

`GET /api/chapters/:id/pages` in [server/src/routes/pages.js](../server/src/routes/pages.js):

1. Pick mode from `?fast=1` (default `full`). `?prefetch=1` marks the call as a background pre-extraction (see [Foreground / background priority](#fast-mode-first-page-fast) above); foreground opens omit it.
2. `cbzCache.ensureChapterExtracted(chapterId, cbzPath, { mode, resumePage, onPageExtracted, background })`. Concurrent calls for the same chapter share state via the `chapterStates` Map; a foreground call arriving for an in-flight background extraction promotes it.
3. On a fresh extraction, UPSERT `pages` rows from `plannedPages` keyed on `(chapter_id, page_index)`. Stable IDs.
4. Heal pass: detect path mismatch (rows point at a stale filename scheme) OR any null-dim rows; in either case re-read sharp on the extracted file via `backfillDimsFromDisk`. The null-dim heal is what catches Phase 1 probe failures — without it, a dim that the 256 KB sniff missed would stay NULL until the next chapter re-open. With it, the client's late re-fetch loop picks up the corrected dim and Double Page (Manga) layout self-corrects.
5. Respond with `{ data: pages[], extracting, total_pages }`. The client uses `extracting` to schedule a re-fetch a few seconds later.

### Page-serve flow

`GET /api/pages/:id/image`:

1. Lookup `pages.path` + chapter meta.
2. `cbzCache.ensureChapterExtracted(...)` (mode inherited from `?fast=1`) — if the chapter was LRU-evicted since it was opened, re-extract. Extraction is deterministic from archive bytes, so the filenames produced match what `pages.path` already stores — no row rebuild needed on the serve path. The reader's `<img>` requests carry `?fast=1` only when the per-device *Fast chapter open* setting is on ([`api.pageImageUrl(id, { fast })`](../client/src/api/client.js)); with the setting off they arrive as `mode='full'` and resolve against the already-complete directory. **Without the `fast` flag, a serve that lands mid-extraction would take the full-mode branch and block on the entire chapter finishing — defeating per-page streaming — so the reader must send it whenever fast-open is on.**
3. If the requested file is already on disk, `res.sendFile(<dir>/<pages.path>)`.
4. Otherwise wait on `waitForPageFile`. Either resolve and `sendFile`, or map errors to 410 Gone (chapter removed), 404 (`PAGE_EXTRACT_FAILED` — the entry could not be extracted; the client should stop retrying), or 503 Retry-After (timeout / waiter overload).

### Size cap and eviction

**Size cap:** runtime-configurable. Defaults to 20 GB (`DEFAULT_CACHE_LIMIT_BYTES = 20 × 1024³`) and is overridden at startup from the `cbz_cache_limit_bytes` row in the `settings` table if present. `setLimitBytes(n)` changes the cap live from the admin API — any chapters over the new cap are evicted immediately.

**Eviction is LRU per-chapter** (insertion order of the in-memory `index` Map). When `totalBytes > cap`:

- Iterate `index` from oldest to newest.
- Skip the optional `protectedDir` (the chapter that just triggered the overflow — the caller still needs it).
- Skip every directory in `activeExtractionDirs()` — chapters whose Phase 1 or Phase 2 is still running. Wiping an in-progress extraction would corrupt the caller's view of the cache.
- Otherwise `rm -rf` the directory and remove it from the index, until total drops below cap.

Evicting at page granularity would leave partially-populated chapter directories behind, forcing re-extractions mid-read. Per-chapter eviction keeps the invariant that a directory is either fully present or entirely absent.

**In-progress eviction guard (ordering invariant):** `ensureChapterExtracted` checks `chapterStates` (active extraction → wait on it) *before* the in-memory `index`/`.ready` probe. This ordering matters because in fast mode the dir is added to `index` at the start of Phase 1 but `.ready` isn't written until Phase 2 finishes — so for the entire Phase 2 window the dir is simultaneously "indexed" and "marker-less". The reader hammers `GET /api/pages/:id/image?fast=1` during exactly that window; if the index branch ran first it would read the missing marker as corruption and `evictChapterDir()` the directory Phase 2 is still extracting into, whose next write then fails with `ENOENT … <page>.tmp`. Checking `chapterStates` first routes those concurrent callers to await the in-flight extraction instead. (Full mode never exposed this: its pages-list call blocks until `.ready` exists, so page-image requests always arrive to a complete, marked directory.) Regression coverage: [server/test/cbzCacheRace.test.js](../server/test/cbzCacheRace.test.js).

**Crash-safety:** each image file is written to `<target>.tmp` and renamed into place on `finish`. The `.ready` marker is the final step of a successful extraction — directories missing it on startup are assumed to be partial extractions from a crashed run and are deleted.

**Persistence across restarts:** `init(limitBytes?)` walks `CBZ_CACHE_DIR`, validates each subdirectory's `.ready` marker, and rebuilds the in-memory index from the files that remain. Warm cache survives a restart. [server/src/index.js](../server/src/index.js) reads the saved `cbz_cache_limit_bytes` row before calling `init()` so the rebuilt index is validated against the user's configured cap, not the 20 GB default. An immediate eviction pass runs if the rebuilt total exceeds the cap.

### Cancellation and orphan audit

CBZ cache state must survive deletions and renames cleanly — a manga or chapter removed mid-read shouldn't leave a hung extraction or an orphan directory.

**`cancelChapter(chapterId, reason)`** — wired into every chapter-deletion path:

- [`removeManga`](../server/src/scanner/libraryScanner.js) (called by `scanLibrary` cleanup and `scanMangaDirectory`).
- Chapter-pruning pass inside [`scanMangaDirectory`](../server/src/scanner/libraryScanner.js) — collects the type-CBZ chapter IDs about to be deleted and calls `cancelChapters` before the `DELETE`.
- `DELETE /api/manga/:id` — collects the manga's CBZ chapter IDs before the CASCADE.
- `DELETE /api/libraries/:id` — joins through manga to collect every CBZ chapter ID in the library.

Each cancellation aborts the chapter's `AbortController`, rejects every open page waiter with `CHAPTER_REMOVED` (mapped to HTTP 410 by the page-image route), drops the chapter's queued Phase 2 slot-waiter (`dropPhase2Waiter` — so a cancelled extraction that was still queued for a scheduler slot is removed and resolved instead of lingering to be granted and immediately self-abort), removes the cache directory, and drops the state slot. Calls against a chapter with no active extraction are no-ops.

**`auditOrphans(db)`** — closes the watcher's depth-0 / missing-`unlinkDir` blind spot. Walks `CBZ_CACHE_DIR`, parses `<chapterId>` from each subdirectory's name, drops any dir whose chapter ID is no longer present in the `chapters` table. Defensive: never touches a directory that's currently in `chapterStates` (an active extraction) even if the chapter row appears missing — concurrent rename + new-id resolution would otherwise tear an in-flight extraction. Runs:

- Once at end of `init()` (boot-time).
- Once at the end of every `scanLibrary` run, after the manga-level pruning pass.

This catches the case where a manga folder is removed while the server is down (or while it's running but the watcher missed it).

**Cover generation paths** — `POST /api/admin/regenerate-thumbnails` and `POST /api/manga/:id/set-thumbnail` for CBZ pages resolve through `cbzCache.getCbzPageFile(chapterId, cbzPath, pageIndex)`, which always uses `mode: 'full'` so the caller sees a complete directory before listing. Scanner-time thumbnail generation still uses the streaming fast path (`openCbzEntryStream`) so the initial walk of a large library doesn't explode into gigabytes of extracted covers.

Admin endpoints `GET /api/admin/cbz-cache-size`, `POST /api/admin/clear-cbz-cache`, `GET /api/admin/cbz-cache-settings`, and `PUT /api/admin/cbz-cache-settings` expose the current size and configured cap, a manual wipe, and the size + auto-clear-schedule settings. `stats()` also reports `in_progress_extractions` so operators can see how many Phase 2 workers are active. See [api.md § Admin / Database Management](./api.md#admin--database-management).

### Auto-Clear Scheduler

Implemented in [server/src/scanner/cbzCacheSchedule.js](../server/src/scanner/cbzCacheSchedule.js). A single `setTimeout` fires the next scheduled wipe, then reschedules itself. Settings live in the same `settings` table as the size cap:

| Key | Values | Effect |
| --- | --- | --- |
| `cbz_cache_autoclear_mode` | `off` \| `daily` \| `weekly` | Schedule type. `off` disables the timer entirely. |
| `cbz_cache_autoclear_day` | `0..6` (0 = Sunday) | Day-of-week when mode is `weekly`. Ignored otherwise. |
| `cbz_cache_autoclear_time` | `HH:MM` 24-hour, server local time | Time of day to fire. |

`reschedule()` is idempotent — it's called on startup and again every time a setting changes through the admin API. The timer is `.unref()`'d so a pending wake-up never blocks graceful shutdown. On fire, `cbzCache.wipe()` removes every extracted chapter directory and the scheduler computes the next occurrence in server local time. When a daily/weekly window would already be in the past for today, the scheduler rolls forward to the next valid day.

## Local Metadata

`localMetadata.js` → `findLocalMetadata(mangaPath)` searches for on-disk metadata in the manga directory (or its first chapter subdirectory yielding one) and maps it onto the internal metadata shape. Two formats are supported, tried in this order:

1. **JSON sidecar** — see file priority and field mapping below.
2. **`ComicInfo.xml`** — used as a fallback only if no usable JSON sidecar is found (same manga-dir-then-first-subdir search order).

### JSON sidecar

**File priority order:**

1. Explicit names: `metadata.json`, `info.json`, `gallery.json`, `comic.json`, `book.json`
2. Image sidecar (e.g. `cover.png.json`)
3. Any other `*.json` file

**Generic field mapping** (`normalizeLocalMeta`):

| Internal field | JSON keys tried (in order) |
|---|---|
| `title` | `title`, `Title`, `name`, `Name` |
| `author` | `artist`, `Artist`, `author`, `Author`, `circle`, `Circle` |
| `description` | `description`, `Description`, `summary`, `Summary` |
| `genres` | `tags`, `Tags`, `genres`, `Genres`, `categories`, `Categories` |
| `year` | `year`, `Year`, `published`, `date` (first 4 chars parsed as year) |
| `score` | `score`, `Score`, `rating`, `Rating` (auto-scaled from 0–100 to 0–10 if > 10) |

**Scraper format** (`normalizeScraperMeta`) — if the parsed object has a `primary_title` key (the shape produced by AniList/MangaUpdates aggregator scrapers), it is normalised with a dedicated mapping instead of the generic one:

| Internal field | Source |
|---|---|
| `title` | `primary_title` |
| `author` | `authors[]` (joined with a comma) |
| `description` | `description` |
| `genres` | `genres[]` only (the format's `tags`/`categories` are content descriptors and are intentionally **not** surfaced as genres) |
| `year` | `start_date.year`, else `year` |
| `score` | `anilist_score` (0–100, ÷10), else `mangaupdates_bayesian_rating` / `mangaupdates_rating` / `animeplanet_rating` (0–10) |

### ComicInfo.xml

`parseComicInfoXml` is a minimal namespace-tolerant regex parser: it collects every leaf element directly under `<ComicInfo>` into a `{ localName: text }` map, stripping any namespace prefix (so `<ty:PublishingStatusTachiyomi>` becomes `PublishingStatusTachiyomi`) and decoding XML entities (`&lt;`, `&amp;`, numeric `&#nn;` / `&#xnn;`, etc.). `normalizeComicInfo` then maps the tags:

| Internal field | ComicInfo tags (in order) |
|---|---|
| `title` | `Series` (the work title), falling back to `Title` (the issue/chapter title) |
| `author` | `Writer`, `Penciller`, `Inker`, `Letterer` |
| `description` | `Summary` |
| `genres` | `Genre` or `Tags` (comma-split) |
| `year` | `Year` (first 4 chars, clamped 1900–2100) |
| `score` | `CommunityRating` (0–5 in the spec, scaled ×2 to 0–10) |

All three normalizers return `null` (no metadata applied) when the source yields no title, genres, or description.

Local metadata is **always applied when a sidecar or `ComicInfo.xml` is found**, regardless of the manga's current `metadata_source`. Local has the highest display priority (see [api.md § Linkage and display priority](./api.md#linkage-and-display-priority)), so dropping a `metadata.json` into a folder switches the displayed fields to the file's contents. The scanner never touches `anilist_id`, `mal_id`, or `doujinshi_id` — adding a sidecar never breaks an external linkage; the user still sees the linkage in the Metadata modal and can swap display source via Break Linkage or by re-applying the third-party source. Removing the file and re-scanning does **not** automatically revert display: the row will still be marked `metadata_source = 'local'` until the user explicitly applies another source or runs Break Linkage.

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

### Settle-before-scan (complete population of new series)

Because the watcher runs at **depth 0** it only sees the top-level manga folder itself — it does **not** receive events for chapters being copied *inside* that folder. A new series is therefore announced by a single `addDir` fired at the very *start* of the copy, while its (potentially dozens of) chapters are still streaming in. Scanning the moment the 3000 ms debounce elapses would index only the handful of chapters written so far, leaving the series partially populated until the user pressed Rescan.

To fix this, once the debounce fires the watcher does **not** scan immediately. It first polls a cheap recursive signature of the manga folder (entry count + total size + newest mtime) every `STABLE_POLL_MS` (2000 ms) and waits until the signature holds steady across one interval — i.e. the copy has finished — before running the scan, up to a `STABLE_MAX_WAIT_MS` ceiling (5 minutes) for very large drops. A 50-chapter copy thus settles fully before a single authoritative `scanMangaDirectory` call indexes every chapter. The poll is scoped to the one affected folder, so it never reintroduces the per-directory watch cost that depth-0 watching deliberately avoids.

An in-flight guard (`scanning` set) ensures a folder that receives further events while its scan is running re-arms the debounce instead of launching a second concurrent scan of the same folder.

### Logging

Watcher-triggered scans (and every other single-folder scan — downloader, optimize, the per-manga refresh route) pass a `source` label to `scanMangaDirectory`, which bookends the work with log lines so individual folder rescans are as visible in the logs as full-library scans:

```text
[Scanner] Scanning manga folder "My Series" (watcher)
[Scanner] Done scanning "My Series": 50 chapter(s) (watcher).
```

The bulk `scanLibrary` path leaves `source` unset, so a full walk does **not** emit one line per manga (it logs at the library level instead). Recognised labels: `watcher`, `download`, `optimize`, `manual refresh`.

**Note:** The watcher listens to `add`, `addDir`, `change`, and `unlink` events but **not** `unlinkDir`. Deleting an entire manga folder will not trigger a watcher event. The manga record is cleaned up the next time a full library scan runs (via the library-level pruning pass described above). Likewise, in-place edits *inside* an existing manga folder (e.g. dropping new chapters into a series that already exists) are not seen at depth 0; those are caught by the downloader's direct `scanMangaDirectory` call, the per-manga Rescan action, or the next full scan.
