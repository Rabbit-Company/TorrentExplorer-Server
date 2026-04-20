import type { Web } from "@rabbit-company/web";
import type { Database, Category } from "../database/index.ts";
import type { Storage } from "../storage/types.ts";
import { parseTorrentFilename, sanitizeStorageKey } from "../parser/filename.ts";
import { Logger } from "../logger.ts";
import { bearerAuth } from "@rabbit-company/web-middleware/bearer-auth";
import type { Config } from "../config.ts";

const MAX_TORRENT_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_MEDIAINFO_SIZE = 1 * 1024 * 1024; // 1 MB

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

export function registerCategoryRoutes(app: Web, services: Services): void {
	const { db, storage, config } = services;

	for (const category of ["anime", "movies", "series"] as Category[]) {
		app.get(`/api/${category}`, async (ctx) => {
			const url = new URL(ctx.req.url);
			const { page, limit, search } = parseListQuery(url);
			const offset = (page - 1) * limit;

			const { groups, total } = await db.listGroups(category, {
				limit,
				offset,
				search,
			});
			return ctx.json({
				groups,
				pagination: {
					page,
					limit,
					total,
					pages: Math.max(1, Math.ceil(total / limit)),
				},
			});
		});

		app.get(`/api/${category}/:id`, async (ctx) => {
			const id = parseInt(ctx.params.id!, 10);
			if (!Number.isFinite(id)) {
				return ctx.json({ error: "Invalid id" }, 400);
			}
			const release = await db.findById(category, id);
			if (!release) {
				return ctx.json({ error: "Not found" }, 404);
			}
			const group = await db.findGroupReleases(category, release.title, release.year);
			return ctx.json({
				id: release.id,
				category: release.category,
				title: release.title,
				year: release.year,
				season: release.season,
				torrent_name: release.torrent_name,
				mediainfo: release.mediainfo,
				tags: JSON.parse(release.tags) as string[],
				uploaded_at: Number(release.uploaded_at),
				group,
			});
		});

		app.post(
			`/api/${category}`,
			bearerAuth({
				validate(token, ctx) {
					if (token.length !== config.server.token.length) {
						return !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(token));
					}

					return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.server.token));
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
				const mediainfo = form.get("mediainfo");

				if (!(torrent instanceof File)) {
					return ctx.json({ error: "Missing field: torrent (file)" }, 400);
				}
				if (torrent.size === 0) {
					return ctx.json({ error: "Torrent file is empty" }, 400);
				}
				if (torrent.size > MAX_TORRENT_SIZE) {
					return ctx.json({ error: `Torrent file exceeds ${MAX_TORRENT_SIZE} bytes` }, 413);
				}

				// mediainfo can come as a File or plain text field
				let mediainfoText: string;
				if (mediainfo instanceof File) {
					if (mediainfo.size > MAX_MEDIAINFO_SIZE) {
						return ctx.json({ error: "MediaInfo too large" }, 413);
					}
					mediainfoText = await mediainfo.text();
				} else if (typeof mediainfo === "string") {
					if (mediainfo.length > MAX_MEDIAINFO_SIZE) {
						return ctx.json({ error: "MediaInfo too large" }, 413);
					}
					mediainfoText = mediainfo;
				} else {
					return ctx.json({ error: "Missing field: mediainfo" }, 400);
				}

				if (!mediainfoText.trim()) {
					return ctx.json({ error: "MediaInfo is empty" }, 400);
				}

				// The user formats torrent files nicely -> preserve the exact filename.
				const rawName = torrent.name;
				const displayName = rawName.replace(/\.torrent$/i, "");
				const parsed = parseTorrentFilename(rawName);

				if (!parsed.title) {
					return ctx.json(
						{
							error: "Could not parse torrent filename. Expected format like '[Group] Title (Year) - S## [Tags]'",
						},
						400,
					);
				}

				const bytes = new Uint8Array(await torrent.arrayBuffer());
				const storageKey = `${category}/${sanitizeStorageKey(displayName)}.torrent`;

				try {
					await storage.save(storageKey, bytes);
				} catch (err: any) {
					Logger.error("Storage save failed:", err);
					return ctx.json({ error: "Failed to save torrent file" }, 500);
				}

				const now = Date.now();
				let created;
				try {
					created = await db.insert({
						category,
						title: parsed.title,
						year: parsed.year,
						season: parsed.season,
						torrent_name: displayName,
						torrent_file: storageKey,
						mediainfo: mediainfoText,
						tags: JSON.stringify(parsed.tags),
						uploaded_at: now,
					});
				} catch (err: any) {
					// Roll back the stored file
					await storage.delete(storageKey).catch(() => {});
					Logger.error("DB insert failed:", err);
					return ctx.json({ error: "Failed to save release" }, 500);
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
					},
					201,
				);
			},
		);
	}
}
