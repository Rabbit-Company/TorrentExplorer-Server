import type { Web } from "@rabbit-company/web";
import type { Database, Category } from "../database/index.ts";
import type { Storage } from "../storage/types.ts";
import { sanitizeStorageKey } from "../parser/filename.ts";
import { Logger } from "../logger.ts";
import { cache } from "@rabbit-company/web-middleware/cache";

/**
 * Per-episode media (MediaInfo + screenshots) stored entirely in the Storage
 * driver - no extra database columns.
 *
 * Layout (mirrors the torrent key `{category}/{base}.torrent`):
 *
 *   media/{category}/{base}/mediainfo/{sanitized episode stem}.txt
 *   media/{category}/{base}/screenshots/{sanitized episode stem}_{n}.{png|jpg|jpeg|webp|avif}
 *
 * The episode stem is the basename of a file inside the torrent with its
 * extension removed, example: "Show (2017) - S01E03". Because the release row
 * already stores the torrent's file list, the GET endpoints can map sanitized
 * storage keys back to the original episode names without any metadata.
 */

const CATEGORIES = new Set<Category>(["anime", "movies", "series"]);

export const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024; // 10 MB per image
export const MAX_SCREENSHOTS_PER_EPISODE = 6;
const MAX_EPISODE_MEDIAINFO_SIZE = 1 * 1024 * 1024; // 1 MB, same as the legacy field

const SCREENSHOT_EXTS = new Set(["png", "jpg", "jpeg", "webp", "avif"]);
const SCREENSHOT_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	avif: "image/avif",
};

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m2ts|ts|webm|mov)$/i;

/** Basename of a torrent file entry, extension stripped. */
export function episodeStem(path: string[]): string {
	const base = path[path.length - 1] ?? "";
	return base.replace(/\.[a-z0-9]{2,5}$/i, "");
}

/** `{category}/{base}.torrent` -> `media/{category}/{base}/` */
export function mediaPrefix(torrentFileKey: string): string {
	return `media/${torrentFileKey.replace(/\.torrent$/i, "")}/`;
}

function normStem(s: string): string {
	return s.normalize("NFC").trim().toLowerCase();
}

/**
 * Build the lookup from a torrent's file list: normalized episode stem ->
 * original episode stem. Video files take precedence; if the torrent has none
 * we fall back to every file. Shared by the mediainfo and screenshot collectors
 * so a name validated for one is validated identically for the other.
 */
function buildStemLookup(torrentFiles: Array<{ path: string[]; length: number }>): {
	stemLookup: Map<string, string>;
	allStems: string[];
} {
	const stems = torrentFiles.filter((f) => VIDEO_EXT_RE.test(f.path[f.path.length - 1] ?? "")).map((f) => episodeStem(f.path));
	const allStems = stems.length > 0 ? stems : torrentFiles.map((f) => episodeStem(f.path));
	const stemLookup = new Map<string, string>(); // normalized -> original
	for (const s of allStems) stemLookup.set(normStem(s), s);
	return { stemLookup, allStems };
}

export interface CollectedMedia {
	/** Goes into the existing `mediainfo` DB column (backwards compatible). */
	dbMediainfo: string;
	/** original episode stem -> redacted mediainfo text */
	episodeMediainfos: Map<string, string>;
	/** validated screenshot uploads */
	screenshots: Array<{ stem: string; n: number; ext: string; file: File }>;
}

export type CollectResult = { ok: true; media: CollectedMedia } | { ok: false; status: 400 | 413; error: string };

export type CollectScreenshotsResult = { ok: true; screenshots: CollectedMedia["screenshots"] } | { ok: false; status: 400 | 413; error: string };

/**
 * Validate the `screenshots` multipart entries against a torrent's episode
 * stems. Pure validation - no bytes are read here (screenshots are only pulled
 * into memory in saveScreenshots), so this is cheap to call.
 *
 * Naming: `<episode stem>_<n>.<png|jpg|jpeg|webp|avif>` where 1 <= n <= 6.
 */
function collectScreenshotEntries(
	screenshotEntries: FormDataEntryValue[],
	stemLookup: Map<string, string>,
	torrentFiles: Array<{ path: string[]; length: number }>,
): CollectScreenshotsResult {
	const screenshots: CollectedMedia["screenshots"] = [];
	const perEpisodeCount = new Map<string, number>();
	const seen = new Set<string>();

	for (const entry of screenshotEntries) {
		if (!(entry instanceof File)) {
			return { ok: false, status: 400, error: "screenshots must be uploaded as files" };
		}
		if (entry.size === 0) {
			return { ok: false, status: 400, error: `Screenshot is empty: ${entry.name}` };
		}
		if (entry.size > MAX_SCREENSHOT_SIZE) {
			return { ok: false, status: 413, error: `Screenshot exceeds ${MAX_SCREENSHOT_SIZE} bytes: ${entry.name}` };
		}

		const m = entry.name.match(/^(.+)_(\d{1,2})\.([a-z0-9]+)$/i);
		if (!m) {
			return { ok: false, status: 400, error: `Screenshot "${entry.name}" must be named "<episode stem>_<n>.<png|jpg|jpeg|webp|avif>"` };
		}
		const ext = m[3]!.toLowerCase();
		if (!SCREENSHOT_EXTS.has(ext)) {
			return { ok: false, status: 400, error: `Unsupported screenshot format: ${entry.name}` };
		}
		const n = parseInt(m[2]!, 10);
		if (n < 1 || n > MAX_SCREENSHOTS_PER_EPISODE) {
			return { ok: false, status: 400, error: `Screenshot index must be 1-${MAX_SCREENSHOTS_PER_EPISODE}: ${entry.name}` };
		}
		const stem = stemLookup.get(normStem(m[1]!));
		if (!stem) {
			return { ok: false, status: 400, error: `Screenshot "${entry.name}" does not match any file inside the torrent` };
		}
		const dedupe = `${normStem(stem)}_${n}`;
		if (seen.has(dedupe)) {
			return { ok: false, status: 400, error: `Duplicate screenshot index ${n} for episode: ${stem}` };
		}
		seen.add(dedupe);
		const count = (perEpisodeCount.get(stem) ?? 0) + 1;
		if (count > MAX_SCREENSHOTS_PER_EPISODE) {
			return { ok: false, status: 400, error: `Too many screenshots for episode: ${stem}` };
		}
		perEpisodeCount.set(stem, count);

		screenshots.push({ stem, n, ext, file: entry });
	}

	if (screenshots.length > 0 && torrentFiles.length === 0) {
		return { ok: false, status: 400, error: "Screenshots require a parseable torrent file list" };
	}

	return { ok: true, screenshots };
}

/**
 * Standalone screenshot collector for the append endpoint
 * (POST /api/:category/:id/screenshots), where only `screenshots` are sent and
 * the torrent file list comes from the already-stored release row.
 */
export function collectScreenshots(form: FormData, torrentFiles: Array<{ path: string[]; length: number }>): CollectScreenshotsResult {
	const { stemLookup } = buildStemLookup(torrentFiles);
	return collectScreenshotEntries(form.getAll("screenshots"), stemLookup, torrentFiles);
}

/**
 * Parses and validates the `mediainfo` and `screenshots` multipart fields.
 *
 * Backwards compatible behaviour:
 *  - `mediainfo` as a plain text field            -> DB column only (legacy)
 *  - a single `mediainfo` file whose name doesn't
 *    match any episode in the torrent             -> DB column only (legacy)
 *  - one or more `mediainfo` files named
 *    `<episode stem>.txt`                          -> stored per episode; the
 *    one belonging to the torrent's first video file is also written to the
 *    DB column so old frontends keep working.
 *
 * `torrentFiles` is the parsed file list of the torrent. Per-episode media is
 * rejected when it is empty (we cannot validate the names without it).
 */
export async function collectEpisodeMedia(
	form: FormData,
	torrentFiles: Array<{ path: string[]; length: number }>,
	redact: (mediainfo: string) => string,
): Promise<CollectResult> {
	const mediainfoEntries = form.getAll("mediainfo");
	const screenshotEntries = form.getAll("screenshots");

	if (mediainfoEntries.length === 0) {
		return { ok: false, status: 400, error: "Missing field: mediainfo" };
	}

	// Episode stems from the torrent, in torrent order (video files first-class).
	const { stemLookup, allStems } = buildStemLookup(torrentFiles);

	const matchStem = (filename: string): string | undefined => {
		// "<stem>.txt" or "<stem>.mkv.txt" both resolve to <stem>
		let stem = filename.replace(/\.txt$/i, "");
		const direct = stemLookup.get(normStem(stem));
		if (direct) return direct;
		stem = stem.replace(VIDEO_EXT_RE, "");
		return stemLookup.get(normStem(stem));
	};

	const episodeMediainfos = new Map<string, string>();
	let legacyText: string | null = null;

	for (const entry of mediainfoEntries) {
		if (entry instanceof File) {
			if (entry.size > MAX_EPISODE_MEDIAINFO_SIZE) {
				return { ok: false, status: 413, error: `MediaInfo too large: ${entry.name}` };
			}
			const text = await entry.text();
			if (!text.trim()) {
				return { ok: false, status: 400, error: `MediaInfo is empty: ${entry.name}` };
			}

			const stem = matchStem(entry.name);
			if (stem) {
				if (episodeMediainfos.has(stem)) {
					return { ok: false, status: 400, error: `Duplicate mediainfo for episode: ${stem}` };
				}
				episodeMediainfos.set(stem, redact(text));
			} else if (mediainfoEntries.length === 1) {
				// Legacy single-file upload (example: "mediainfo.txt") - DB column only.
				legacyText = redact(text);
			} else {
				return {
					ok: false,
					status: 400,
					error: `mediainfo file "${entry.name}" does not match any file inside the torrent. Name it "<episode filename without extension>.txt".`,
				};
			}
		} else if (typeof entry === "string") {
			if (mediainfoEntries.length > 1) {
				return { ok: false, status: 400, error: "mediainfo text field cannot be combined with per-episode mediainfo files" };
			}
			if (entry.length > MAX_EPISODE_MEDIAINFO_SIZE) {
				return { ok: false, status: 413, error: "MediaInfo too large" };
			}
			if (!entry.trim()) {
				return { ok: false, status: 400, error: "MediaInfo is empty" };
			}
			legacyText = redact(entry);
		}
	}

	if (episodeMediainfos.size > 0 && torrentFiles.length === 0) {
		return { ok: false, status: 400, error: "Per-episode mediainfo requires a parseable torrent file list" };
	}

	// DB column: legacy text, otherwise the first episode (torrent order).
	let dbMediainfo = legacyText;
	if (dbMediainfo === null) {
		for (const stem of allStems) {
			const mi = episodeMediainfos.get(stem);
			if (mi) {
				dbMediainfo = mi;
				break;
			}
		}
	}
	if (dbMediainfo === null) {
		// Defensive - cannot happen given the branches above.
		return { ok: false, status: 400, error: "Missing field: mediainfo" };
	}

	// Screenshots: `<episode stem>_<n>.<ext>`
	const sc = collectScreenshotEntries(screenshotEntries, stemLookup, torrentFiles);
	if (!sc.ok) return sc;

	return { ok: true, media: { dbMediainfo, episodeMediainfos, screenshots: sc.screenshots } };
}

/**
 * Writes validated screenshots to storage, appending each written key to
 * `savedKeys`. Throws on the first failed write.
 */
export async function saveScreenshots(storage: Storage, prefix: string, screenshots: CollectedMedia["screenshots"], savedKeys: string[]): Promise<void> {
	for (const shot of screenshots) {
		const key = `${prefix}screenshots/${sanitizeStorageKey(shot.stem)}_${shot.n}.${shot.ext}`;
		await storage.save(key, new Uint8Array(await shot.file.arrayBuffer()), SCREENSHOT_MIME[shot.ext]);
		savedKeys.push(key);
	}
}

/**
 * Writes all per-episode media to storage. Returns every key written so the
 * caller can roll back on a later failure. Throws on the first failed write
 * (after which the caller should delete `savedKeys`).
 */
export async function saveEpisodeMedia(storage: Storage, prefix: string, media: CollectedMedia, savedKeys: string[]): Promise<void> {
	const encoder = new TextEncoder();

	for (const [stem, text] of media.episodeMediainfos) {
		const key = `${prefix}mediainfo/${sanitizeStorageKey(stem)}.txt`;
		await storage.save(key, encoder.encode(text), "text/plain; charset=utf-8");
		savedKeys.push(key);
	}

	await saveScreenshots(storage, prefix, media.screenshots, savedKeys);
}

interface Services {
	db: Database;
	storage: Storage;
}

export function registerMediaRoutes(app: Web, services: Services): void {
	const { db, storage } = services;

	/**
	 * GET /api/media/:category/:id
	 *
	 * Manifest of available per-episode media, derived purely from a storage
	 * listing. Old releases simply return an empty list.
	 *
	 * { "episodes": [ { "name": "<original episode stem>",
	 *                   "mediainfo": true,
	 *                   "screenshots": ["<stored filename>", ...] } ] }
	 */
	app.get("/api/media/:category/:id", cache({ ttl: 30, generateETags: false }), async (ctx) => {
		const lookup = await findRelease(ctx);
		if ("response" in lookup) return lookup.response;
		const { release } = lookup;

		const prefix = mediaPrefix(release.torrent_file);
		let keys: string[] = [];
		try {
			keys = await storage.list(prefix);
		} catch (err: any) {
			Logger.warn(`Media listing failed for ${prefix}: ${err.message ?? err}`);
		}

		// sanitized stem -> { mediainfo, screenshots[] }
		const found = new Map<string, { mediainfo: boolean; screenshots: string[] }>();
		const bucket = (stem: string) => {
			let b = found.get(stem);
			if (!b) {
				b = { mediainfo: false, screenshots: [] };
				found.set(stem, b);
			}
			return b;
		};

		for (const key of keys) {
			const rel = key.slice(prefix.length);
			let m = rel.match(/^mediainfo\/(.+)\.txt$/);
			if (m) {
				bucket(m[1]!).mediainfo = true;
				continue;
			}
			m = rel.match(/^screenshots\/(.+)_(\d{1,2})\.(png|jpe?g|webp|avif)$/i);
			if (m) {
				bucket(m[1]!).screenshots.push(rel.slice("screenshots/".length));
			}
		}

		// Map sanitized stems back to the original episode names via the
		// release's torrent file list, preserving torrent order.
		const files = parseFiles(release.files);
		const episodes: Array<{ name: string; mediainfo: boolean; screenshots: string[] }> = [];
		const claimed = new Set<string>();

		for (const f of files) {
			const stem = episodeStem(f.path);
			const sanitized = sanitizeStorageKey(stem);
			const b = found.get(sanitized);
			if (!b || claimed.has(sanitized)) continue;
			claimed.add(sanitized);
			b.screenshots.sort((a, z) => screenshotIndex(a) - screenshotIndex(z));
			episodes.push({ name: stem, mediainfo: b.mediainfo, screenshots: b.screenshots });
		}

		return ctx.json({ episodes }, 200, { "Cache-Control": "public, max-age=30, s-maxage=30" });
	});

	/**
	 * GET /api/media/:category/:id/mediainfo?ep=<original episode stem>
	 */
	app.get("/api/media/:category/:id/mediainfo", async (ctx) => {
		const lookup = await findRelease(ctx);
		if ("response" in lookup) return lookup.response;
		const { release } = lookup;

		const ep = new URL(ctx.req.url).searchParams.get("ep");
		if (!ep || ep.length > 512) {
			return ctx.json({ error: "Missing or invalid query parameter: ep" }, 400);
		}

		const key = `${mediaPrefix(release.torrent_file)}mediainfo/${sanitizeStorageKey(ep)}.txt`;
		let bytes: Uint8Array;
		try {
			bytes = await storage.read(key);
		} catch {
			return ctx.json({ error: "No mediainfo for this episode" }, 404);
		}

		return new Response(Buffer.from(bytes), {
			status: 200,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	});

	/**
	 * GET /api/media/:category/:id/screenshot?file=<stored filename>
	 *
	 * `file` is one of the names returned by the manifest, example:
	 * "My Show - S01E03_2.png" (already sanitized at upload time).
	 */
	app.get("/api/media/:category/:id/screenshot", async (ctx) => {
		const lookup = await findRelease(ctx);
		if ("response" in lookup) return lookup.response;
		const { release } = lookup;

		const file = new URL(ctx.req.url).searchParams.get("file");
		const m = file && file.length <= 512 ? file.match(/^(.+)_(\d{1,2})\.(png|jpe?g|webp|avif)$/i) : null;
		if (!m || file !== sanitizeStorageKey(m[1]!) + `_${m[2]}.${m[3]}`) {
			return ctx.json({ error: "Missing or invalid query parameter: file" }, 400);
		}

		const key = `${mediaPrefix(release.torrent_file)}screenshots/${file}`;
		let bytes: Uint8Array;
		try {
			bytes = await storage.read(key);
		} catch {
			return ctx.json({ error: "Screenshot not found" }, 404);
		}

		return new Response(Buffer.from(bytes), {
			status: 200,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Content-Type": SCREENSHOT_MIME[m[3]!.toLowerCase()] ?? "application/octet-stream",
				"Content-Length": String(bytes.byteLength),
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	});

	type Lookup = { response: Response } | { release: NonNullable<Awaited<ReturnType<Database["findById"]>>> };

	async function findRelease(ctx: any): Promise<Lookup> {
		const category = ctx.params.category as Category;
		if (!CATEGORIES.has(category)) {
			return { response: ctx.json({ error: "Invalid category" }, 400) };
		}
		const id = parseInt(ctx.params.id!, 10);
		if (!Number.isFinite(id)) {
			return { response: ctx.json({ error: "Invalid id" }, 400) };
		}
		const release = await db.findById(category, id);
		if (!release) {
			return { response: ctx.json({ error: "Not found" }, 404) };
		}
		return { release };
	}
}

export function parseFiles(raw: string | null | undefined): Array<{ path: string[]; length: number }> {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter((f): f is { path: string[]; length: number } => f && Array.isArray(f.path) && typeof f.length === "number");
		}
	} catch {}
	return [];
}

function screenshotIndex(name: string): number {
	const m = name.match(/_(\d{1,2})\.[a-z0-9]+$/i);
	return m ? parseInt(m[1]!, 10) : 0;
}
