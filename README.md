# Momotaro

A self-hosted manga and comics server. Drop in your collection, read from any device.

## Quick Start (Docker)

```bash
# Clone / download this project
git clone <repo> momotaro
cd momotaro

# Create your library folder and add manga
mkdir library
# Drop manga folders into ./library/

# Start the server
docker compose up -d --build
```

Open **http://localhost:8080** in your browser. Click **Scan Library** to index your manga.

## Library Structure

Organize your manga like this:

```
library/
├── One Piece/
│   ├── Chapter 001/          # Folder of images
│   │   ├── 001.jpg
│   │   └── 002.jpg
│   ├── Chapter 002.cbz       # Or CBZ archives
│   └── Chapter 003.cbz
├── Berserk/
│   ├── Vol.01 Ch.001.cbz
│   └── Vol.01 Ch.002.cbz
└── My Hero Academia/
    ├── ch001/
    └── ch002/
```

**Supported formats:**
- Folders containing images (JPG, PNG, WebP, AVIF, GIF)
- CBZ files (ZIP archives of images)

**Chapter naming** — the scanner understands most common patterns:
- `Chapter 001`, `Ch. 12.5`, `chapter_042`
- `Vol.01 Ch.001`, `c001`, `001`

## Features

- **Automatic metadata** — titles, descriptions, genres, scores fetched from AniList (with MyAnimeList fallback)
- **Two reading modes** — Paged (RTL/LTR) and continuous scroll
- **Progress tracking** — remembers where you left off in every series
- **File watching** — drop new chapters in; they appear automatically
- **Mobile friendly** — swipe to navigate pages on touch screens
- **Keyboard navigation** — arrow keys, Escape to exit reader

## Remote Access

To access from outside your home network, forward port `8080` on your router to your server's local IP. For a cleaner setup, use a reverse proxy like [Caddy](https://caddyserver.com/) or [nginx Proxy Manager](https://nginxproxymanager.com/) with HTTPS.

## Configuration

Edit `docker-compose.yml` to change the port or library path:

```yaml
services:
  client:
    ports:
      - "8080:80"   # Change 8080 to your preferred port
  server:
    volumes:
      - /your/manga/path:/library:ro   # Point to your manga folder
      - ./data:/app/data               # Database and thumbnails
```

## Development

```bash
# Server
cd server
npm install
npm run dev   # starts on :3000

# Client (in another terminal)
cd client
npm install
npm run dev   # starts on :5173, proxies API to :3000
```

## Tech Stack

- **Backend**: Node.js, Express, SQLite (better-sqlite3), chokidar, sharp
- **Frontend**: React 18, Vite, React Router
- **Metadata**: AniList GraphQL API, Jikan (MyAnimeList)
- **Docker**: nginx + Node Alpine
