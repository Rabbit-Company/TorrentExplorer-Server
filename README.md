# TorrentExplorer-Server

Backend API for TorrentExplorer.

It stores `.torrent` files (either locally or in any S3-compatible bucket) together with MediaInfo metadata, and exposes them through a small REST API.

## Quick start

```bash
bun install
cp config.example.json config.json
# edit config.json
bun run start
```

By default, the server listens on `http://0.0.0.0:3000`.

## Configuration

All configuration lives in `config.json`.

At startup, environment variables can override values from the config file:

- `HOST`
- `PORT`
- `PROXY`
- `TOKEN`
- `XMR`
- `FRONTEND_URL`
- `DATABASE_URL`
- `RELEASE_GROUP`
- `STORAGE_DRIVER`
- `SCRAPER_ENABLED`
- `SCRAPER_INTERVAL_MINUTES`
- `SCRAPER_UDP_TIMEOUT_MS`

Example:

```jsonc
{
	"server": {
		"host": "0.0.0.0",
		"port": 3000,
		"proxy": "direct",
		"token": "hux23to2isshfuyttzlyy6dfn2m9vtfdpew6iyjUbRqxKtXhgx",
	},
	"frontend": {
		"url": "https://torrents.example.com",
	},
	"brand": {
		"releaseGroup": "RabbitCompany",
	},
	"donation": {
		"xmr": "8BmrgB8NGWhe8TSjNJDNMKgHrvxEQP1ZUDTWMNWA8CnKMpQjBjZhje1DPMmkbdNyMZESZDvHgMyufe5KPtLgy41Q8MTWnBE",
	},
	"scraper": {
		"enabled": true,
		"intervalMinutes": 30,
		"udpTimeoutMs": 5000,
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

### Server options

#### `server.host`

Host interface to bind to.

Default:

```json
"0.0.0.0"
```

#### `server.port`

Port to listen on.

Default:

```json
3000
```

#### `server.token`

Bearer token required for authenticated API endpoints such as uploads.

Clients must send it as:

```http
Authorization: Bearer <your_token>
```

#### `server.proxy`

Controls how the server extracts the real client IP address.

This is important for IP-based rate limiting. If the server is behind a reverse proxy or CDN, you must configure this correctly so rate limiting is applied to the actual client IP instead of the proxy IP.

Supported presets:

- `direct`
- `cloudflare`
- `aws`
- `gcp`
- `azure`
- `vercel`
- `nginx`
- `development`

Use:

- `direct` when the server is exposed directly to the internet and not behind a proxy
- `cloudflare` when traffic passes through Cloudflare
- `aws` when deployed behind AWS proxy or load balancer infrastructure
- `gcp` when deployed behind Google Cloud infrastructure
- `azure` when deployed behind Azure infrastructure
- `vercel` when deployed on or behind Vercel
- `nginx` when using Nginx as a reverse proxy
- `development` for local development setups where forwarded headers may be inconsistent

Example:

```jsonc
{
	"server": {
		"proxy": "cloudflare",
	},
}
```

If this value is set incorrectly, rate limiting may group all requests under the proxy IP instead of the real client IP.

### Donation options

`donation.xmr` Optional Monero donation address exposed by the API for frontend display.

```json
{
	"donation": {
		"xmr": "8BmrgB8NGWhe8TSjNJDNMKgHrvxEQP1ZUDTWMNWA8CnKMpQjBjZhje1DPMmkbdNyMZESZDvHgMyufe5KPtLgy41Q8MTWnBE"
	}
}
```

### Frontend URL

`frontend.url` Public URL of the user-facing frontend (the TorrentExplorer web UI).

When set, this URL is used in the Torznab/RSS feed for `<guid>`, `<link>`, `<comments>`, and the channel `<link>`, so RSS readers and Prowlarr's "Open page" links land on the public site rather than on the backend API. The `.torrent` `<enclosure>` URL still points at the backend, since the frontend doesn't serve the binary itself.

Leave empty to fall back to the backend URL (useful for local development).

Example:

```jsonc
{
	"frontend": {
		"url": "https://torrents.example.com",
	},
}
```

If you change this value after items have been indexed by Prowlarr/Sonarr/Radarr, those tools may treat existing releases as new, since they deduplicate by `<guid>`.

### Scraper

The scraper periodically contacts the trackers announced in each stored `.torrent` and updates seeder, leecher, and completed counts, plus the `last_scraped_at` timestamp returned by `GET /api/{category}/:id`.

#### `scraper.enabled`

Whether the background scraper runs.

Set to `false` if you do not want the server to make outbound tracker requests, for example in an offline or mirror-only deployment.

Default:

```json
true
```

#### `scraper.intervalMinutes`

How often, in minutes, to scrape tracker stats for every release.

Lower values give fresher numbers at the cost of more outbound traffic and more load on the trackers. Most public trackers dislike very aggressive scraping, so keep this conservative.

Default:

```json
30
```

#### `scraper.udpTimeoutMs`

Per-request timeout, in milliseconds, for UDP tracker scrapes.

If a UDP tracker does not answer within this window, it is considered unreachable for the current cycle and the scraper moves on to the next one.

Default:

```json
5000
```

Example:

```jsonc
{
	"scraper": {
		"enabled": true,
		"intervalMinutes": 30,
		"udpTimeoutMs": 5000,
	},
}
```

### Database

`database.url` uses Bun's built-in SQL driver, so switching databases only requires changing the connection URL:

| Database   | URL                                 |
| ---------- | ----------------------------------- |
| SQLite     | `sqlite://data/torrents.db`         |
| PostgreSQL | `postgres://user:pass@host:5432/db` |
| MySQL      | `mysql://user:pass@host:3306/db`    |

The schema is migrated automatically on startup.

### Storage

#### `storage.driver`

Supported values:

- `local`
- `s3`

#### Local storage

Torrent files are stored on disk using their original filenames.

Example:

```jsonc
{
	"storage": {
		"driver": "local",
		"local": {
			"path": "./torrents",
		},
	},
}
```

#### S3 storage

Any S3-compatible provider can be used, including:

- AWS S3
- Cloudflare R2
- Backblaze B2
- MinIO

Example:

```jsonc
{
	"storage": {
		"driver": "s3",
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

## API reference

## Authentication

Upload endpoints require bearer token authentication.

Send the configured token in the `Authorization` header:

```http
Authorization: Bearer <your_token>
```

Read-only endpoints do not require authentication unless you add your own external access control.

### `GET /api/info`

Returns basic server branding and release counts by category.

Example response:

```json
{
	"releaseGroup": "RabbitCompany",
	"stats": { "anime": 42, "movies": 7, "series": 3 }
}
```

### `GET /api/{anime|movies|series}?page=1&limit=24&q=search`

Lists releases for a category.

This endpoint returns summary rows only and does not include the full MediaInfo text.

Example response:

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

Query parameters:

| Parameter | Type   | Required | Description                                      |
| --------- | ------ | -------- | ------------------------------------------------ |
| `page`    | number | no       | Page number (default: implementation-defined)    |
| `limit`   | number | no       | Items per page (default: implementation-defined) |
| `q`       | string | no       | Search query                                     |

### `GET /api/{anime|movies|series}/:id`

Returns the full release record for a single item, including the raw MediaInfo text.

The frontend is expected to parse and render the MediaInfo content itself.

### `POST /api/{anime|movies|series}`

Creates a new release by uploading a torrent file and its corresponding MediaInfo.

#### Authorization

This endpoint requires bearer token authentication.

Include the token in the `Authorization` header:

```http
Authorization: Bearer <your_token>
```

#### Request format

Send the request as `multipart/form-data`.

| Field       | Type             | Required | Notes                                                             |
| ----------- | ---------------- | -------- | ----------------------------------------------------------------- |
| `torrent`   | file             | yes      | A `.torrent` file. The original filename is preserved.            |
| `mediainfo` | file **or** text | yes      | MediaInfo text for the release. For batch uploads, use episode 1. |

#### Filename format

The uploaded torrent filename must follow one of these formats:

- **Anime / Series**  
  `[ReleaseGroup] Title (Year) - S## [Tag1][Tag2]...`

- **Movies**  
  `[ReleaseGroup] Title (Year) [Tag1][Tag2]...`

The API parses the following metadata from the filename:

- release group
- title
- year
- season (for anime/series)
- tags

Example:

```bash
curl -X POST http://localhost:3000/api/anime \
  -H "Authorization: Bearer <your_token>" \
  -F "torrent=@[RabbitCompany] Tsugumomo (2017) - S02 [Bluray-1080p][Opus 2.0][AV1].torrent" \
  -F "mediainfo=@mediainfo.txt"
```

Response:

- `201 Created` on success, with the newly created release in the response body

### `GET /api/torrent/{anime|movies|series}/:id`

Streams the original `.torrent` file back to the client using its original filename.

This is intended for direct browser download or opening in a torrent client.

### Torznab / RSS endpoints

The server exposes a [Torznab](https://torznab.github.io/spec-1.3-draft/torznab/Specification-v1.3.html)-compatible feed at `/api/torznab` and a plain RSS alias at `/api/rss`. Both emit the same XML format and can be consumed by:

- **Prowlarr** as a Generic Torznab indexer (point it at `/api/torznab`)
- **Sonarr / Radarr** indirectly, via Prowlarr
- Any standard RSS reader (use `/api/rss` for simplicity)

#### `GET /api/torznab?t=caps`

Returns the indexer's capabilities (search modes, supported categories) as XML. Prowlarr calls this when adding the indexer to discover what searches are available.

#### `GET /api/torznab?t=search`

Generic search across all categories. This is also the default when `t` is omitted.

Query parameters:

| Parameter | Type   | Required | Description                                                                                |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `q`       | string | no       | Free-text search query (matches against the torrent title)                                 |
| `cat`     | string | no       | Comma-separated newznab category IDs (e.g. `2000,5070`). Unknown IDs are silently ignored. |
| `offset`  | number | no       | Number of items to skip (default `0`)                                                      |
| `limit`   | number | no       | Max items to return (default `50`, max `100`)                                              |

Supported `cat` values:

| ID   | Name     | Internal category    |
| ---- | -------- | -------------------- |
| 2000 | Movies   | `movies`             |
| 5000 | TV       | `series` and `anime` |
| 5070 | TV/Anime | `anime`              |

#### `GET /api/torznab?t=tvsearch`

Same as `search` but constrained to TV-style content (`series` + `anime`). If `cat` is provided, it is intersected with the allowed set.

#### `GET /api/torznab?t=movie`

Same as `search` but constrained to `movies`.

#### `GET /api/rss`

Convenience alias for `GET /api/torznab?t=search`. Useful for plain RSS readers that don't need Torznab capabilities.

#### Item format

Each `<item>` includes:

- `<title>` - original torrent name
- `<guid>`, `<link>`, `<comments>` - public detail page URL (uses `frontend.url` when configured, otherwise the backend URL)
- `<pubDate>` - RFC-822 upload time
- `<enclosure>` - direct `.torrent` download URL served from the backend. A second `<enclosure>` with the magnet URI is added when available.
- `<torznab:attr>` for: `category`, `size`, `files`, `year`, `poster`, `team`, `seeders`, `leechers`, `peers`, `grabs`, `infohash`, `magneturl`, `downloadvolumefactor` (always `0` - releases are freeleech), `uploadvolumefactor` (always `1`), and `tag` (`freeleech`, `internal`)
- For movies: `imdbtitle`, `imdbyear`
- For series/anime: `tvtitle`, `season`, and `episode` when the torrent name contains an `S##E##` marker

#### Examples

- All categories: `GET /api/rss`
- Anime only: `GET /api/torznab?t=search&cat=5070`
- Search by title: `GET /api/torznab?t=search&q=tsugumomo`
- TV search with pagination: `GET /api/torznab?t=tvsearch&offset=50&limit=50`

#### Adding to Prowlarr

In Prowlarr, add a new **Generic Torznab** indexer with:

- **URL**: `https://your-backend.example.com/api/torznab`
- **API Key**: leave blank (no auth required)
- **Categories**: tick Movies (2000), TV (5000), TV/Anime (5070)

Prowlarr hits `?t=caps` to validate the indexer when you click **Test**, then begins polling `?t=search` on its normal schedule.

## Deployment

### Native binary

Build a single-file executable:

```bash
bun run build
```

Run it:

```bash
./torrent-explorer-server
```

### Docker

A multi-stage `Dockerfile` is included.

Build the image:

```bash
docker build -t torrent-explorer-server .
```

Run the container:

```bash
docker run -d \
  --name torrent-explorer-server \
  -p 3000:3000 \
  -e PROXY=direct \
  -e TOKEN=replace-with-a-long-random-token \
  -e RELEASE_GROUP=RabbitCompany \
  -v $(pwd)/torrents:/app/torrents \
  -v $(pwd)/data:/app/data \
  torrent-explorer-server
```

If the container is behind a reverse proxy or CDN, set `PROXY` to the matching preset such as `cloudflare` or `nginx` so client IPs are extracted correctly for rate limiting.

### Docker Compose

A `docker-compose.yml` example is also included.

Start the service:

```bash
docker compose up -d
```

Example Compose configuration:

```yaml
services:
  torrent-explorer:
    image: rabbitcompany/torrent-explorer:latest
    container_name: torrent-explorer
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - TZ=UTC
      - PROXY=direct
      - TOKEN=replace-with-a-long-random-token
      - RELEASE_GROUP=RabbitCompany
      - XMR=8BmrgB8NGWhe8TSjNJDNMKgHrvxEQP1ZUDTWMNWA8CnKMpQjBjZhje1DPMmkbdNyMZESZDvHgMyufe5KPtLgy41Q8MTWnBE
    volumes:
      #- ./config.json:/app/config.json
      - torrent_explorer_torrents:/app/torrents
      - torrent_explorer_data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

volumes:
  torrent_explorer_torrents:
    driver: local
  torrent_explorer_data:
    driver: local
```

If you uncomment the `config.json` bind mount, values from that file are still overridden by supported environment variables.

When deploying behind Cloudflare, Nginx, or another proxy layer, change `PROXY` from `direct` to the correct preset. Otherwise all traffic may appear to come from the proxy, which breaks per-IP rate limiting.
