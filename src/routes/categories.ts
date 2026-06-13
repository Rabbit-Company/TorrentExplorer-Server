import type { Web } from "@rabbit-company/web";
import type { Database, Category } from "../database/index.ts";
import type { Storage } from "../storage/types.ts";
import { parseTorrentFilename, sanitizeStorageKey } from "../parser/filename.ts";
import { buildMagnetLink, parseTorrent } from "../bencode.ts";
import { Logger } from "../logger.ts";
import { bearerAuth } from "@rabbit-company/web-middleware/bearer-auth";
import type { Config } from "../config.ts";
import { cache } from "@rabbit-company/web-middleware/cache";
import { collectEpisodeMedia, collectScreenshots, mediaPrefix, parseFiles, saveEpisodeMedia, saveScreenshots } from "./media.ts";

const MAX_TORRENT_SIZE = 10 * 1024 * 1024; // 10 MB

interface Services {
	db: Database;
	storage: Storage;
	config: Config;
}

function parseListQuery(url: URL): {
	page: number;
	limit: number;
	search?: string;
} {
	const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
	const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "24", 10) || 24));
	const search = url.searchParams.get("q") ?? url.searchParams.get("search") ?? undefined;
	return { page, limit, search: search || undefined };
}

/**
 * Removes full paths from "Complete name" fields, leaving only the filename.
 * Example: "Complete name : /path/to/My Video.mkv" -> "Complete name : My Video.mkv"
 */
function redactMediainfoPaths(mediainfo: string): string {
	const lines = mediainfo.split("\n");
	const redactedLines = lines.map((line) => {
		// Match "Complete name" followed by optional spaces, colon, spaces, then capture the value
		const match = line.match(/^Complete name\s*:\s*(.+)$/i);
		if (!match) return line;

		const fullPath = match[1].trim();
		// Split on both forward and backward slashes, get last segment
		const parts = fullPath.split(/[/\\]/);
		const filename = parts.pop() || fullPath;

		// Reconstruct the line with the same indentation structure
		return line.replace(/^Complete name\s*:\s*.+$/i, `Complete name                            : ${filename}`);
	});
	return redactedLines.join("\n");
}

export function registerCategoryRoutes(app: Web, services: Services): void {
	const { db, storage, config } = services;

	// Shared owner-token check (constant-time-ish), reused by the upload routes.
	const validateOwnerToken = (token: string): boolean => {
		if (token.length !== config.server.token.length) {
			return !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(token));
		}
		return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.server.token));
	};

	for (const category of ["anime", "movies", "series"] as Category[]) {
		app.get(`/api/${category}`, cache({ ttl: 30, generateETags: false }), async (ctx) => {
			const url = new URL(ctx.req.url);
			const { page, limit, search } = parseListQuery(url);
			const offset = (page - 1) * limit;

			const { groups, total } = await db.listGroups(category, {
				limit,
				offset,
				search,
			});
			return ctx.json(
				{
					groups,
					pagination: {
						page,
						limit,
						total,
						pages: Math.max(1, Math.ceil(total / limit)),
					},
				},
				200,
				{ "Cache-Control": "public, max-age=30, s-maxage=30" },
			);
		});

		app.get(`/api/${category}/:id`, cache({ ttl: 30, generateETags: false }), async (ctx) => {
			const id = parseInt(ctx.params.id!, 10);
			if (!Number.isFinite(id)) {
				return ctx.json({ error: "Invalid id" }, 400, { "Cache-Control": "no-store" });
			}
			const release = await db.findById(category, id);
			if (!release) {
				return ctx.json({ error: "Not found" }, 404, { "Cache-Control": "no-store" });
			}
			const group = await db.findGroupReleases(category, release.title, release.year);

			let files: Array<{ path: string[]; length: number }> = [];
			if (release.files) {
				try {
					const parsed = JSON.parse(release.files);
					if (Array.isArray(parsed)) {
						files = parsed.filter(
							(f): f is { path: string[]; length: number } =>
								f && Array.isArray(f.path) && f.path.every((p: unknown) => typeof p === "string") && typeof f.length === "number",
						);
					}
				} catch {}
			}

			return ctx.json(
				{
					id: release.id,
					category: release.category,
					title: release.title,
					year: release.year,
					season: release.season,
					torrent_name: release.torrent_name,
					mediainfo: release.mediainfo,
					tags: JSON.parse(release.tags) as string[],
					uploaded_at: Number(release.uploaded_at),
					magnet: release.magnet,
					seeders: release.seeders === null || release.seeders === undefined ? null : Number(release.seeders),
					leechers: release.leechers === null || release.leechers === undefined ? null : Number(release.leechers),
					completed: release.completed === null || release.completed === undefined ? null : Number(release.completed),
					last_scraped_at: release.last_scraped_at === null || release.last_scraped_at === undefined ? null : Number(release.last_scraped_at),
					files,
					group,
				},
				200,
				{ "Cache-Control": "public, max-age=30, s-maxage=30" },
			);
		});

		app.post(
			`/api/${category}`,
			bearerAuth({
				validate(token, ctx) {
					return validateOwnerToken(token);
				},
			}),
			async (ctx) => {
				let form: FormData;
				try {
					form = await ctx.req.formData();
				} catch {
					return ctx.json({ error: "Expected multipart/form-data body" }, 400);
				}

				const torrent = form.get("torrent");

				if (!(torrent instanceof File)) {
					return ctx.json({ error: "Missing field: torrent (file)" }, 400);
				}
				if (torrent.size === 0) {
					return ctx.json({ error: "Torrent file is empty" }, 400);
				}
				if (torrent.size > MAX_TORRENT_SIZE) {
					return ctx.json({ error: `Torrent file exceeds ${MAX_TORRENT_SIZE} bytes` }, 413);
				}

				// The user formats torrent files nicely -> preserve the exact filename.
				const rawName = torrent.name;
				const displayName = rawName.replace(/\.torrent$/i, "");
				const parsedName = parseTorrentFilename(rawName);

				if (!parsedName.title) {
					return ctx.json(
						{
							error: "Could not parse torrent filename. Expected format like '[Group] Title (Year) - S## [Tags]'",
						},
						400,
					);
				}

				const bytes = new Uint8Array(await torrent.arrayBuffer());

				let infoHash: string | null = null;
				let trackers: string[] = [];
				let files: Array<{ path: string[]; length: number }> = [];
				let magnet: string | null = null;
				try {
					const meta = await parseTorrent(bytes);
					infoHash = meta.infoHashHex;
					trackers = meta.announceList;
					files = meta.files;
					magnet = buildMagnetLink(meta);
				} catch (err: any) {
					Logger.warn(`Could not parse torrent metadata for ${displayName}: ${err.message ?? err}`);
				}

				// mediainfo (legacy text/single file OR one file per episode) + screenshots.
				// Screenshots are optional here: with the create-then-append upload flow the
				// client sends torrent + mediainfo only, then POSTs screenshots in
				// size-bounded batches to /api/:category/:id/screenshots below.
				const collected = await collectEpisodeMedia(form, files, redactMediainfoPaths);
				if (!collected.ok) {
					return ctx.json({ error: collected.error }, collected.status);
				}
				const media = collected.media;

				// Same category + title + year + season -> overwrite instead of duplicating.
				const existing = await db.findDuplicate(category, parsedName.title, parsedName.year, parsedName.season);

				const storageKey = `${category}/${sanitizeStorageKey(displayName)}.torrent`;

				try {
					await storage.save(storageKey, bytes, "application/x-bittorrent");
				} catch (err: any) {
					Logger.error("Storage save failed:", err);
					return ctx.json({ error: "Failed to save torrent file" }, 500);
				}

				// Per-episode media. Keys are recorded as they are written so a failure
				// rolls back everything that already landed in storage.
				const mediaKeys: string[] = [];
				try {
					await saveEpisodeMedia(storage, mediaPrefix(storageKey), media, mediaKeys);
				} catch (err: any) {
					Logger.error("Media save failed:", err);
					await Promise.allSettled([...mediaKeys, storageKey].map((k) => storage.delete(k)));
					return ctx.json({ error: "Failed to save episode media" }, 500);
				}

				const now = Date.now();
				let created;
				try {
					const entry = {
						category,
						title: parsedName.title,
						year: parsedName.year,
						season: parsedName.season,
						torrent_name: displayName,
						torrent_file: storageKey,
						mediainfo: media.dbMediainfo,
						tags: JSON.stringify(parsedName.tags),
						uploaded_at: now,
						info_hash: infoHash,
						trackers: trackers.length > 0 ? JSON.stringify(trackers) : null,
						files: files.length > 0 ? JSON.stringify(files) : null,
						magnet,
						seeders: null,
						leechers: null,
						completed: null,
						last_scraped_at: null,
					};
					created = existing ? await db.replace(existing.id, entry) : await db.insert(entry);
				} catch (err: any) {
					// Roll back stored files (but never delete keys the old release still owns)
					const oldKeys = existing ? new Set([existing.torrent_file]) : new Set<string>();
					await Promise.allSettled([...mediaKeys, storageKey].filter((k) => !oldKeys.has(k)).map((k) => storage.delete(k)));
					Logger.error("DB insert failed:", err);
					return ctx.json({ error: "Failed to save release" }, 500);
				}

				// Clean up files and comments that belonged to the previous version of this release.
				if (existing) {
					try {
						await db.deleteCommentsForRelease(existing.id);
					} catch (err: any) {
						Logger.warn(`Could not delete old comments for release ${existing.id}: ${err.message ?? err}`);
					}

					const keep = new Set<string>([...mediaKeys, storageKey]);
					const stale: string[] = [];
					if (!keep.has(existing.torrent_file)) stale.push(existing.torrent_file);
					try {
						const oldMediaKeys = await storage.list(mediaPrefix(existing.torrent_file));
						stale.push(...oldMediaKeys.filter((k) => !keep.has(k)));
					} catch (err: any) {
						Logger.warn(`Could not list old media for cleanup: ${err.message ?? err}`);
					}
					if (stale.length > 0) await Promise.allSettled(stale.map((k) => storage.delete(k)));
				}

				return ctx.json(
					{
						id: created.id,
						category: created.category,
						title: created.title,
						year: created.year,
						season: created.season,
						torrent_name: created.torrent_name,
						tags: JSON.parse(created.tags) as string[],
						uploaded_at: Number(created.uploaded_at),
						replaced: !!existing,
						media: {
							mediainfo_episodes: [...media.episodeMediainfos.keys()],
							screenshots: media.screenshots.length,
						},
					},
					existing ? 200 : 201,
				);
			},
		);

		// Append screenshots to an existing release in size-bounded batches.
		//
		// This is the second half of the create-then-append upload: the torrent +
		// mediainfo are sent to POST /api/:category once (returns the id), then the
		// client posts screenshots here in batches. Validation reuses the stored torrent file list, so a
		// screenshot is only accepted if its "<stem>_<n>.<ext>" name matches an
		// episode in the torrent.
		//
		// Idempotent: keys are deterministic, so re-sending a batch just overwrites
		// identical files. A partial batch is deliberately NOT rolled back - a retry
		// rewrites the same keys and the media manifest is derived from a storage
		// listing, so partial state is harmless and self-heals on retry.
		app.post(
			`/api/${category}/:id/screenshots`,
			bearerAuth({
				validate(token, ctx) {
					return validateOwnerToken(token);
				},
			}),
			async (ctx) => {
				const id = parseInt(ctx.params.id!, 10);
				if (!Number.isFinite(id)) {
					return ctx.json({ error: "Invalid id" }, 400);
				}

				const release = await db.findById(category, id);
				if (!release) {
					return ctx.json({ error: "Not found" }, 404);
				}

				let form: FormData;
				try {
					form = await ctx.req.formData();
				} catch {
					return ctx.json({ error: "Expected multipart/form-data body" }, 400);
				}

				const files = parseFiles(release.files);
				if (files.length === 0) {
					return ctx.json({ error: "Release has no parseable torrent file list; cannot attach screenshots" }, 400);
				}

				const collected = collectScreenshots(form, files);
				if (!collected.ok) {
					return ctx.json({ error: collected.error }, collected.status);
				}
				if (collected.screenshots.length === 0) {
					return ctx.json({ error: "No screenshots in request (expected one or more 'screenshots' file fields)" }, 400);
				}

				const prefix = mediaPrefix(release.torrent_file);
				const savedKeys: string[] = [];
				try {
					await saveScreenshots(storage, prefix, collected.screenshots, savedKeys);
				} catch (err: any) {
					Logger.error("Screenshot append save failed:", err);
					return ctx.json({ error: "Failed to save screenshots" }, 500);
				}

				const shotPrefix = `${prefix}screenshots/`;
				return ctx.json(
					{
						id: release.id,
						category: release.category,
						added: savedKeys.length,
						screenshots: savedKeys.map((k) => k.slice(shotPrefix.length)),
					},
					201,
					{ "Cache-Control": "no-store" },
				);
			},
		);
	}
}
