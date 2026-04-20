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
- `DATABASE_URL`
- `RELEASE_GROUP`
- `STORAGE_DRIVER`

Example:

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
  `[ReleaseGroup] Title (Year) - S## [Tag1][Tag2]…`

- **Movies**  
  `[ReleaseGroup] Title (Year) [Tag1][Tag2]…`

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
