# TorrentExplorer-Server

Backend API for the torrent explorer.

Stores torrent files (locally or in any S3-compatible bucket) along with MediaInfo metadata, then serves them back through a small REST API.

## Quick start

```bash
bun install
cp config.example.json config.json
# edit config.json
bun run start
```

Server listens on `http://0.0.0.0:3000` by default.

## Configuration

All options live in `config.json`. Environment variables override the file at startup (`PORT`, `HOST`, `PROXY`, `TOKEN`, `DATABASE_URL`, `RELEASE_GROUP`, `STORAGE_DRIVER`).

```jsonc
{
	"server": {
		"host": "0.0.0.0",
		"port": 3000,
		"proxy": "direct",
		"token": "hux23to2isshfuyttzlyy6dfn2m9vtfdpew6iyjUbRqxKtXhgx",
	},
	"brand": {
		"releaseGroup": "RabbitCompany",
	},
	"database": {
		"url": "sqlite://data/torrents.db",
	},
	"storage": {
		"driver": "local",
		"local": {
			"path": "./torrents",
		},
		"s3": {
			"endpoint": "https://s3.example.com",
			"region": "auto",
			"bucket": "torrents",
			"accessKeyId": "...",
			"secretAccessKey": "...",
		},
	},
}
```

### Database

`database.url` uses Bun's built-in SQL driver — one URL swaps the backend:

| Database   | URL                                 |
| ---------- | ----------------------------------- |
| SQLite     | `sqlite://data/torrents.db`         |
| PostgreSQL | `postgres://user:pass@host:5432/db` |
| MySQL      | `mysql://user:pass@host:3306/db`    |

Schema is auto-migrated on startup.

### Storage

- **local** — torrent files are written to the configured path with their original names preserved.
- **s3** — any S3-compatible provider (AWS, Cloudflare R2, Backblaze B2, MinIO, etc).

## API reference

No authentication is implemented — the upload endpoints are intended to be fronted by your own auth layer.

### `GET /api/info`

```json
{
	"releaseGroup": "RabbitCompany",
	"stats": { "anime": 42, "movies": 7, "series": 3 }
}
```

### `GET /api/{anime|movies|series}?page=1&limit=24&q=search`

Lists releases for a category. Returns summary rows without the (potentially large) mediainfo text.

```json
{
	"items": [
		{
			"id": 1,
			"category": "anime",
			"title": "Tsugumomo",
			"year": 2017,
			"season": "S02",
			"torrent_name": "[RabbitCompany] Tsugumomo (2017) - S02 [Bluray-1080p][Opus 2.0][AV1]",
			"tags": ["Bluray-1080p", "Opus 2.0", "AV1"],
			"uploaded_at": 1713571200000
		}
	],
	"pagination": { "page": 1, "limit": 24, "total": 42, "pages": 2 }
}
```

### `GET /api/{anime|movies|series}/:id`

Full detail, including the raw mediainfo text. The frontend parses this itself.

### `POST /api/{anime|movies|series}`

Multipart form upload:

| Field       | Type             | Required | Notes                                                       |
| ----------- | ---------------- | -------- | ----------------------------------------------------------- |
| `torrent`   | file             | yes      | `.torrent` file. Original filename is preserved.            |
| `mediainfo` | file **or** text | yes      | MediaInfo text for the release (first episode for batches). |

The filename must follow the format  
`[ReleaseGroup] Title (Year) - S## [Tag1][Tag2]…` for series/anime or  
`[ReleaseGroup] Title (Year) [Tag1][Tag2]…` for movies.  
Title, year, season, and tags are parsed from the filename.

```bash
curl -X POST http://localhost:3000/api/anime \
  -F "torrent=@[RabbitCompany] Tsugumomo (2017) - S02 [Bluray-1080p][Opus 2.0][AV1].torrent" \
  -F "mediainfo=@mediainfo.txt"
```

Returns `201 Created` with the new release.

### `GET /api/torrent/{anime|movies|series}/:id`

Streams the `.torrent` file back with its original name (ready for the user to download and open in their client).

## Deployment

```bash
bun run build   # produces a single-file executable
./torrent-explorer-server
```
