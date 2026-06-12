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
- `REQUESTS_ENABLED`
- `REQUESTS_RATE_LIMIT_WINDOW_MINUTES`
- `COMMENTS_ENABLED`
- `COMMENTS_MAX_LENGTH`
- `COMMENTS_RATE_LIMIT_BURST`
- `COMMENTS_RATE_LIMIT_REFILL_MINUTES`
- `NTFY_ENABLED`
- `NTFY_SERVER`
- `NTFY_TOPIC`
- `NTFY_TOKEN`
- `NTFY_USERNAME`
- `NTFY_PASSWORD`
- `ENCODERS_ENABLED`
- `ENCODERS_POLL_SECONDS`
- `ENCODER{n}_NAME` - `{n}` can be any number between 1 and 50
- `ENCODER{n}_URL` - `{n}` can be any number between 1 and 50
- `ENCODER{n}_PASSWORD` - `{n}` can be any number between 1 and 50

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
	"requests": {
		"enabled": true,
		"rateLimitWindowMinutes": 60,
	},
	"comments": {
		"enabled": true,
		"maxLength": 1000,
		"rateLimit": {
			"burst": 3,
			"refillIntervalMinutes": 5,
		},
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
	"ntfy": {
		"enabled": false,
		"server": "https://ntfy.sh",
		"topic": "topicName",
	},
	"encoders": {
		"enabled": false,
		"pollIntervalSeconds": 10,
		"list": [
			{ "name": "Main", "url": "http://192.168.1.50:3000", "password": "rabbitencoder" },
			{ "name": "GPU Box", "url": "http://192.168.1.51:3000", "password": "secret2" },
		],
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

### Requests

Visitors can ask for a title to be added by submitting its TheTVDB ID to `POST /api/requests` with a JSON body like `{ "kind": "series", "id": 359274 }`. `kind` is one of `anime`, `series`, or `movies` (anime and series both use a TheTVDB **Series ID**; movies use a **Movies ID**).

Each unique `(kind, id)` is stored once, with a counter, the time of the first request, and the time of the most recent request. Submitting the same ID again just increments the counter and refreshes the timestamp.

The endpoint is heavily rate limited per client IP (by default, one request per hour). This limit is held in memory only and is **not persisted**, so it resets whenever the server restarts. Because the limit is IP-based, `server.proxy` must be set correctly (see above) or all requests may be grouped under the proxy IP.

#### `requests.enabled`

Whether the request endpoint is available.

Set to `false` to disable it entirely. When disabled, the route is not registered and the frontend hides the request page.

Default:

```json
true
```

#### `requests.rateLimitWindowMinutes`

How long, in minutes, each client IP must wait between requests.

For example, `60` allows one request per hour per IP; `1440` would allow one per day.

Default:

```json
60
```

Example:

```jsonc
{
	"requests": {
		"enabled": true,
		"rateLimitWindowMinutes": 60,
	},
}
```

### Comments

Visitors can comment under any release. There is no registration and no login. Anyone can post, and comments with no `Authorization` header are attributed to **Anonymous**.

Threads are limited to a single level of nesting: you can reply to a top-level comment, but you cannot reply to a reply. Top-level comments and the replies beneath each one are both shown oldest-first. Deleting a top-level comment also deletes its replies.

Posting is heavily rate limited per client IP using a **token bucket**. Each IP starts with a small burst of tokens (`comments.rateLimit.burst`) and regains one token every `comments.rateLimit.refillIntervalMinutes`. Normal back-and-forth in a thread is unaffected, but anyone posting rapidly drains their bucket and is then throttled to one comment per refill interval while tokens slowly return. This limit is held in memory only and is **not persisted**, so it resets when the server restarts. Because it is IP-based, `server.proxy` must be set correctly (see above) or all comments may be grouped under the proxy IP.

#### Owner comments

If a request includes a valid `Authorization: Bearer <token>` header (the same token used for uploads), the comment is attributed to the configured `brand.releaseGroup` instead of Anonymous. Owner comments skip the rate limit and the character limit.

Token handling is strict:

- **No `Authorization` header** -> posted as Anonymous.
- **Valid token** -> posted as the release group (owner).
- **Present but wrong/malformed token** -> rejected with `401`; nothing is posted.

The web UI never shows a login or token field. If a bearer token is present in the browser's `localStorage` under the key `token`, the UI posts and deletes as the owner, shows a "responding as owner" indicator, and renders a delete control under each comment. Otherwise it behaves as an anonymous visitor.

#### `comments.enabled`

Whether the comment endpoints are available.

Set to `false` to disable them entirely. When disabled, the routes are not registered and the frontend hides the comments section.

Default:

```json
true
```

#### `comments.maxLength`

Maximum number of characters allowed in an anonymous comment.

This limit does **not** apply to owner comments (authenticated with a valid bearer token); a separate, very large hard cap protects the database regardless.

Default:

```json
1000
```

#### `comments.rateLimit.burst`

Token-bucket capacity per client IP - the number of comments that can be posted in quick succession before throttling kicks in.

Default:

```json
3
```

#### `comments.rateLimit.refillIntervalMinutes`

How long, in minutes, it takes to regain one token. At steady state this is the minimum time between comments from a single IP.

For example, `5` allows roughly one comment every five minutes (after the initial burst is spent).

Default:

```json
5
```

Example:

```jsonc
{
	"comments": {
		"enabled": true,
		"maxLength": 1000,
		"rateLimit": {
			"burst": 3,
			"refillIntervalMinutes": 5,
		},
	},
}
```

### Ntfy notifications

The server can publish push notifications to an [ntfy](https://docs.ntfy.sh/) topic so you find out immediately when something happens, without polling the API.

A notification is sent when:

- a visitor **requests** a title (`POST /api/requests`) - the notification includes the kind (movie/series/anime), the TheTVDB ID, and how many times that title has been requested in total. Tapping it opens the title on thetvdb.com.
- a visitor **posts a comment or reply** on any release - the notification includes the release title, the author (Anonymous or the release group), and the start of the comment. When `frontend.url` is set, tapping it opens the release's detail page. Notifications are fire-and-forget: a slow or unreachable ntfy server never delays or fails the API request that triggered the notification. Failed publishes are logged as warnings.

You can use the public `https://ntfy.sh` service (pick a hard-to-guess topic name - topics are essentially passwords) or any self-hosted ntfy instance.

#### `ntfy.enabled`

Whether notifications are sent at all. When `false` (the default), the feature is completely inert and no outbound requests are made.

Default:

```json
false
```

#### `ntfy.server`

Base URL of the ntfy server to publish to.

Default:

```json
"https://ntfy.sh"
```

#### `ntfy.topic`

The topic to publish to. Subscribe to the same topic in the ntfy app (Android/iOS) or web app to receive the notifications.

On the public ntfy.sh server anyone who knows the topic name can subscribe to it, so treat the topic name like a secret.

Default:

```json
"topicName"
```

#### `ntfy.token` (optional)

Access token for servers that require authentication, sent as `Authorization: Bearer <token>`. This is the recommended auth method and takes precedence over username/password when both are set.

```jsonc
{
	"ntfy": {
		"token": "tk_your_token_here",
	},
}
```

#### `ntfy.username` / `ntfy.password` (optional)

Username/password authentication, sent as HTTP Basic auth. Only used when `ntfy.token` is not set. Both values must be provided.

```jsonc
{
	"ntfy": {
		"username": "your_username",
		"password": "your_password",
	},
}
```

Full example:

```jsonc
{
	"ntfy": {
		"enabled": true,
		"server": "https://ntfy.sh",
		"topic": "topicName",
		// Optional: token authentication
		//"token": "tk_your_token_here",
		// Optional: username/password authentication
		//"username": "your_username",
		//"password": "your_password",
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

### `GET /`

Returns the server name, release group, and a plain list of all available endpoints. Useful as a quick sanity check that the server is up and reachable.

Example response:

```json
{
	"name": "torrent-explorer-server",
	"releaseGroup": "RabbitCompany",
	"endpoints": ["GET  /api/info", "GET  /api/health", "..."]
}
```

### `GET /api/health`

Lightweight health check for monitoring and container orchestration.

Example response:

```json
{ "status": "ok" }
```

### `GET /api/info`

Returns basic server branding and release counts by category.

Example response:

```json
{
	"releaseGroup": "RabbitCompany",
	"stats": { "anime": 42, "movies": 7, "series": 3 },
	"donation": {},
	"requests": {
		"enabled": true,
		"rateLimitWindowMinutes": 60
	},
	"comments": {
		"enabled": true,
		"maxLength": 1000
	}
}
```

### `GET /api/{anime|movies|series}?page=1&limit=24&q=search`

Lists releases for a category, **grouped by title and year**. Each group contains every season of the same title, sorted numerically (S2 before S10). Groups are ordered by the most recent upload within the group.

This endpoint returns summary rows only and does not include the full MediaInfo text.

Example response:

```json
{
	"groups": [
		{
			"title": "Tsugumomo",
			"year": 2017,
			"latest_uploaded_at": 1713571200000,
			"tags": ["Bluray-1080p", "Opus 2.0", "AV1"],
			"releases": [
				{
					"id": 1,
					"category": "anime",
					"title": "Tsugumomo",
					"year": 2017,
					"season": "S01",
					"torrent_name": "[RabbitCompany] Tsugumomo (2017) - S01 [Bluray-1080p][Opus 2.0][AV1]",
					"tags": ["Bluray-1080p", "Opus 2.0", "AV1"],
					"uploaded_at": 1710571200000,
					"seeders": 12,
					"leechers": 1,
					"completed": 87,
					"last_scraped_at": 1713570000000
				},
				{
					"id": 2,
					"category": "anime",
					"title": "Tsugumomo",
					"year": 2017,
					"season": "S02",
					"torrent_name": "[RabbitCompany] Tsugumomo (2017) - S02 [Bluray-1080p][Opus 2.0][AV1]",
					"tags": ["Bluray-1080p", "Opus 2.0", "AV1"],
					"uploaded_at": 1713571200000,
					"seeders": 25,
					"leechers": 3,
					"completed": 140,
					"last_scraped_at": 1713570000000
				}
			]
		}
	],
	"pagination": { "page": 1, "limit": 24, "total": 42, "pages": 2 }
}
```

`tags` on the group is taken from the most recently uploaded release in that group.

Query parameters:

| Parameter | Type   | Required | Description                                                                                           |
| --------- | ------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `page`    | number | no       | Page number (default `1`). Pagination counts **groups**, not individual releases.                     |
| `limit`   | number | no       | Groups per page (default `24`, max `100`)                                                             |
| `q`       | string | no       | Search query, matched against the title. A `(YYYY)` suffix in the query additionally filters by year. |

Responses are cached for 30 seconds.

### `GET /api/{anime|movies|series}/:id`

Returns the full release record for a single item, including the raw MediaInfo text, the magnet link, tracker scrape stats, the file list inside the torrent, and the other seasons of the same title.

The frontend is expected to parse and render the MediaInfo content itself.

Example response:

```json
{
	"id": 2,
	"category": "anime",
	"title": "Tsugumomo",
	"year": 2017,
	"season": "S02",
	"torrent_name": "[RabbitCompany] Tsugumomo (2017) - S02 [Bluray-1080p][Opus 2.0][AV1]",
	"mediainfo": "General\nComplete name ...",
	"tags": ["Bluray-1080p", "Opus 2.0", "AV1"],
	"uploaded_at": 1713571200000,
	"magnet": "magnet:?xt=urn:btih:...",
	"seeders": 25,
	"leechers": 3,
	"completed": 140,
	"last_scraped_at": 1713570000000,
	"files": [{ "path": ["Tsugumomo S02", "Tsugumomo (2017) - S02E01.mkv"], "length": 412316860 }],
	"group": [
		{ "id": 1, "season": "S01" },
		{ "id": 2, "season": "S02" }
	]
}
```

Field notes:

- `magnet`, `seeders`, `leechers`, `completed`, and `last_scraped_at` are `null` until the background scraper has run for this release.
- `files` is the file list parsed from the `.torrent`; it may be empty for releases whose torrent metadata could not be parsed.
- `group` lists every release sharing the same title and year (all seasons), sorted numerically, including the current one. Use it to render season switchers.
  Responses:

- `200 OK` with the release record
- `400 Bad Request` if the id is not a number
- `404 Not Found` if no release with that id exists in the category

### `POST /api/{anime|movies|series}`

Creates a new release by uploading a torrent file and its corresponding MediaInfo, optionally with per-episode MediaInfo files and screenshots.

**Duplicate handling:** if a release with the same category, title, year, and season already exists, the upload **overwrites** it instead of creating a new entry. The existing release keeps its `id` (so comments and links stay attached), `uploaded_at` is refreshed, scrape stats are reset, and the previous torrent file and any per-episode media that were not re-uploaded are deleted from storage.

#### Authorization

This endpoint requires bearer token authentication.

Include the token in the `Authorization` header:

```http
Authorization: Bearer <your_token>
```

#### Request format

Send the request as `multipart/form-data`.

| Field         | Type                 | Required | Notes                                                                                                                                                      |
| ------------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `torrent`     | file                 | yes      | A `.torrent` file (max 10 MB). The original filename is preserved.                                                                                         |
| `mediainfo`   | text, file, or files | yes      | Either a single legacy MediaInfo text/file, **or** one file per episode named `<episode filename without extension>.txt` (max 1 MB each).                  |
| `screenshots` | files                | no       | Per-episode screenshots named `<episode filename without extension>_<n>.<png\|jpg\|jpeg\|webp\|avif>` where `n` is 1–6. Max 10 MB each, max 6 per episode. |

Per-episode `mediainfo` files and `screenshots` are validated against the file list inside the torrent. A file whose name does not match any episode in the torrent is rejected. Full filesystem paths in "Complete name" MediaInfo fields are redacted automatically, leaving only the filename.

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
  Example (batch upload with per-episode media):

```bash
curl -X POST http://localhost:3000/api/anime \
  -H "Authorization: Bearer <your_token>" \
  -F "torrent=@[RabbitCompany] Tsugumomo (2017) - S02 [Bluray-1080p][Opus 2.0][AV1].torrent" \
  -F "mediainfo=@Tsugumomo (2017) - S02E01.txt" \
  -F "mediainfo=@Tsugumomo (2017) - S02E02.txt" \
  -F "screenshots=@Tsugumomo (2017) - S02E01_1.png" \
  -F "screenshots=@Tsugumomo (2017) - S02E01_2.png"
```

Example response:

```json
{
	"id": 2,
	"category": "anime",
	"title": "Tsugumomo",
	"year": 2017,
	"season": "S02",
	"torrent_name": "[RabbitCompany] Tsugumomo (2017) - S02 [Bluray-1080p][Opus 2.0][AV1]",
	"tags": ["Bluray-1080p", "Opus 2.0", "AV1"],
	"uploaded_at": 1713571200000,
	"replaced": false,
	"media": {
		"mediainfo_episodes": ["Tsugumomo (2017) - S02E01", "Tsugumomo (2017) - S02E02"],
		"screenshots": 2
	}
}
```

Responses:

- `201 Created` when a new release was created (`replaced: false`)
- `200 OK` when an existing release with the same title, year, and season was overwritten (`replaced: true`)
- `400 Bad Request` for unparseable filenames, missing fields, or media files that don't match the torrent contents
- `401 Unauthorized` for a missing or invalid token
- `413 Payload Too Large` when the torrent, a MediaInfo file, or a screenshot exceeds its size limit

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

### `GET /api/media/{anime|movies|series}/:id`

Returns a manifest of the per-episode media (MediaInfo and screenshots) available for a release. The manifest is derived from a storage listing; releases uploaded before per-episode media existed simply return an empty list.

Episodes are listed in torrent order. `name` is the original episode filename without its extension, and is the value to pass as `ep` to the mediainfo endpoint below. Entries in `screenshots` are the stored filenames to pass as `file` to the screenshot endpoint.

Example response:

```json
{
	"episodes": [
		{
			"name": "Tsugumomo (2017) - S02E01",
			"mediainfo": true,
			"screenshots": ["Tsugumomo (2017) - S02E01_1.png", "Tsugumomo (2017) - S02E01_2.png"]
		},
		{
			"name": "Tsugumomo (2017) - S02E02",
			"mediainfo": true,
			"screenshots": []
		}
	]
}
```

Responses are cached for 30 seconds.

### `GET /api/media/{anime|movies|series}/:id/mediainfo?ep=<episode name>`

Returns the MediaInfo for a single episode as `text/plain`.

| Parameter | Type   | Required | Description                                                         |
| --------- | ------ | -------- | ------------------------------------------------------------------- |
| `ep`      | string | yes      | The episode `name` exactly as returned by the media manifest above. |

Responses:

- `200 OK` with the MediaInfo text (served with long-lived immutable caching)
- `400 Bad Request` if `ep` is missing or longer than 512 characters
- `404 Not Found` if the release exists but has no MediaInfo for that episode

### `GET /api/media/{anime|movies|series}/:id/screenshot?file=<stored filename>`

Streams a single screenshot image.

| Parameter | Type   | Required | Description                                                                                          |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `file`    | string | yes      | A filename exactly as returned in the manifest's `screenshots` array, e.g. `My Show - S01E03_2.png`. |

Responses:

- `200 OK` with the image (`image/png`, `image/jpeg`, `image/webp`, or `image/avif`, served with long-lived immutable caching)
- `400 Bad Request` if `file` is missing or doesn't match the expected `<episode>_<n>.<ext>` pattern
- `404 Not Found` if the screenshot doesn't exist

### `POST /api/requests`

Lets visitors request a title by submitting its TheTVDB ID. No authentication is required, but the endpoint is heavily rate limited per client IP (default: one request per hour — see `requests.rateLimitWindowMinutes`). When `requests.enabled` is `false` in the config, this route is not registered at all.

#### Request body

Send the request as `application/json`.

| Field  | Type             | Required | Notes                                                                                                 |
| ------ | ---------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `kind` | string           | yes      | One of `anime`, `series`, or `movies` (`movie` is accepted as an alias for `movies`).                 |
| `id`   | number or string | yes      | A positive TheTVDB ID, digits only. Anime and series use a **Series ID**; movies use a **Movies ID**. |

Submitting the same `(kind, id)` pair again increments its counter and refreshes the timestamp instead of creating a new record.

Example:

```bash
curl -X POST http://localhost:3000/api/requests \
  -H "Content-Type: application/json" \
  -d '{ "kind": "series", "id": 359274 }'
```

Example response:

```json
{
	"id": 359274,
	"kind": "series",
	"counter": 3,
	"created": 1713571200000,
	"last_updated": 1713999999000
}
```

Responses:

- `201 Created` with the request record (`counter` is the total number of times this title has been requested)
- `400 Bad Request` for an invalid `kind` or `id`
- `429 Too Many Requests` if the per-IP rate limit is exceeded, with a `Retry-After` header

### `GET /api/{anime|movies|series}/:id/comments`

Returns the comment thread for a release. Top-level comments are sorted oldest-first, each with its replies (also oldest-first) nested one level deep.

`author` is the resolved display name: `"Anonymous"` for anonymous comments, or the release group name for owner comments. `author_type` is `"anonymous"` or `"owner"`.

Example response:

```json
{
	"comments": [
		{
			"id": 12,
			"parent_id": null,
			"author": "Anonymous",
			"author_type": "anonymous",
			"body": "Audio is completely out of sync.",
			"created_at": 1713571200000,
			"replies": [
				{
					"id": 15,
					"parent_id": 12,
					"author": "RabbitCompany",
					"author_type": "owner",
					"body": "I checked and this isn't the case. Can you try mpv?",
					"created_at": 1713571320000
				},
				{
					"id": 18,
					"parent_id": 12,
					"author": "Anonymous",
					"author_type": "anonymous",
					"body": "It works with mpv, thanks!",
					"created_at": 1713571500000
				}
			]
		}
	]
}
```

### `POST /api/{anime|movies|series}/:id/comments`

Posts a comment under a release.

#### Authorization

Optional. Omit the header to post as Anonymous, or send a valid token to post as the release group:

```http
Authorization: Bearer <your_token>
```

A present-but-invalid token is rejected with `401` and nothing is stored.

#### Request body

Send the request as `application/json`.

| Field       | Type   | Required | Notes                                                                        |
| ----------- | ------ | -------- | ---------------------------------------------------------------------------- |
| `body`      | string | yes      | The comment text. Limited to `comments.maxLength` chars for anonymous posts. |
| `parent_id` | number | no       | ID of the top-level comment being replied to. Omit for a top-level comment.  |

`parent_id` must reference an existing top-level comment on the same release; replying to a reply is rejected.

Example (anonymous top-level comment):

```bash
curl -X POST http://localhost:3000/api/anime/1/comments \
  -H "Content-Type: application/json" \
  -d '{ "body": "Audio is completely out of sync." }'
```

Example (owner reply):

```bash
curl -X POST http://localhost:3000/api/anime/1/comments \
  -H "Authorization: Bearer <your_token>" \
  -H "Content-Type: application/json" \
  -d '{ "body": "Try mpv media player.", "parent_id": 12 }'
```

Response:

- `201 Created` with the created comment in the body.
- `401 Unauthorized` if a token is supplied but invalid.
- `429 Too Many Requests` if the per-IP rate limit is exceeded, with a `Retry-After` header.

### `DELETE /api/{anime|movies|series}/:id/comments/:commentId`

Deletes a comment. **Owner only** - requires a valid bearer token; any other request (including no token) is rejected with `401`. Deleting a top-level comment also deletes its replies.

```bash
curl -X DELETE http://localhost:3000/api/anime/1/comments/12 \
  -H "Authorization: Bearer <your_token>"
```

Response:

- `200 OK` with `{ "deleted": true }` on success.
- `404 Not Found` if the comment doesn't exist on that release.

### `GET /api/encoders/queue`

Returns the public encoding queue, aggregated from the configured Rabbit Encoder instances. Jobs are grouped per title and season - no per-episode information is exposed. Returns `"enabled": false` with an empty `encoders` array when encoder polling is disabled in the config.

If an encoder cannot be reached, its last known data is kept and it is flagged `"online": false`, so the public queue page degrades gracefully instead of going blank.

Example response:

```json
{
	"enabled": true,
	"pollIntervalSeconds": 30,
	"encoders": [
		{
			"name": "encoder-01",
			"online": true,
			"paused": false,
			"lastUpdated": 1713571200000,
			"totals": { "total": 24, "done": 10, "encoding": 1, "queued": 13, "error": 0 },
			"etaMs": 7200000,
			"groups": [
				{
					"title": "Tsugumomo",
					"season": "Season 2",
					"queuePosition": 1,
					"total": 12,
					"done": 10,
					"encoding": 1,
					"queued": 1,
					"error": 0,
					"progress": 87,
					"etaMs": 1800000,
					"active": true,
					"completed": false,
					"finishedAt": null
				}
			]
		}
	]
}
```

Responses are cached for 5 seconds.

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
      - TOKEN=hux23to2isshfuyttzlyy6dfn2m9vtfdpew6iyjUbRqxKtXhgx
      - RELEASE_GROUP=RabbitCompany
      - XMR=8BmrgB8NGWhe8TSjNJDNMKgHrvxEQP1ZUDTWMNWA8CnKMpQjBjZhje1DPMmkbdNyMZESZDvHgMyufe5KPtLgy41Q8MTWnBE
      - FRONTEND_URL=https://torrents.example.com
      - NTFY_ENABLED=true
      - NTFY_SERVER=https://ntfy.sh
      - NTFY_TOPIC=torrent-explorer
    volumes:
      #- ./config.json:/app/config.json
      - torrent_explorer_torrents:/app/torrents
      - torrent_explorer_media:/app/media
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
  torrent_explorer_media:
    driver: local
```

If you uncomment the `config.json` bind mount, values from that file are still overridden by supported environment variables.

When deploying behind Cloudflare, Nginx, or another proxy layer, change `PROXY` from `direct` to the correct preset. Otherwise all traffic may appear to come from the proxy, which breaks per-IP rate limiting.
