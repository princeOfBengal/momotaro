# Library Scanner

The scanner turns filesystem folders and CBZ files into database records.

## Entry Points

| File | Purpose |
|---|---|
| [server/src/scanner/libraryScanner.js](../server/src/scanner/libraryScanner.js) | Main scanner — walks directories, upserts DB rows, generates thumbnails |
| [server/src/scanner/chapterParser.js](../server/src/scanner/chapterParser.js) | Parses chapter/volume numbers from names; extracts CBZ pages |
| [server/src/scanner/thumbnailGenerator.js](../server/src/scanner/thumbnailGenerator.js) | Generates WebP cover images via Sharp |
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
- **CBZ/ZIP archives**: extracted to `CBZ_CACHE_DIR` on first read
- **Images**: `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, `.gif`

## Incremental Scanning

The scanner avoids re-processing chapters that have not changed since the last scan.

For each chapter entry:
1. `fs.statSync(chapterPath).mtimeMs` is read and stored as `chapters.file_mtime` (seconds).
2. On subsequent scans, if `existingChapter.file_mtime` matches the current mtime **and** `existingChapter.page_count > 0`, the full page re-index (extraction + dimension fetching) is skipped.
3. For skipped chapters, the cover candidate is resolved from the existing `pages` rows rather than re-reading the filesystem.

This means a re-scan of an unchanged library does almost no I/O beyond directory listings.

## Image Dimension Fetching

Page dimensions (width/height) are read with `sharp` so the reader can detect wide pages for double-page spread layout. To prevent spawning hundreds of concurrent sharp processes on large chapters, fetching is limited to **4 concurrent operations** via an internal `withLimit(4, pages, fn)` helper.

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

## CBZ Extraction

CBZ files are extracted to `CBZ_CACHE_DIR/<chapterId>/` on first access. Subsequent reads validate the cache using an mtime marker file (`.mtime`) written after each extraction:

1. On cache hit: read `.mtime`, compare against current `fs.statSync(cbzPath).mtimeMs`. If they match, serve cached pages.
2. On mtime mismatch (CBZ replaced on disk): re-extract, overwrite cache, update `.mtime`.

Image files are renamed to zero-padded indices (`00000.jpg`, `00001.png`, …) to ensure correct sort order regardless of original archive entry names.

## Thumbnail Generation

Sharp resizes the first page of the lowest-numbered chapter to `300×430 px` WebP and saves it to `THUMBNAIL_DIR/<mangaId>.webp`. Aspect ratio is preserved with `cover` fit (cropped to fill). Thumbnails are only generated when none exists yet — re-scanning an existing manga will not regenerate its cover.

## File Watcher

`chokidar` watches all configured library paths at depth 0 (top-level entries only). Changes are debounced 3000 ms per manga directory to avoid thrashing during multi-file copy operations. On change, `scanMangaDirectory()` is called for the affected manga only — not a full rescan.
