import type { Web } from "@rabbit-company/web";
import type { Database, Category } from "../database/index.ts";
import type { Config } from "../config.ts";
import { Algorithm, rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Logger } from "../logger.ts";
import type { Ntfy } from "../notifications/ntfy.ts";

interface Services {
	db: Database;
	config: Config;
	ntfy: Ntfy;
}

const VALID_KINDS: ReadonlySet<Category> = new Set<Category>(["anime", "series", "movies"]);
const MAX_TVDB_ID = 9_999_999_999;

function parseTvdbId(raw: unknown): number | null {
	if (typeof raw === "number") {
		if (!Number.isInteger(raw) || raw < 1 || raw > MAX_TVDB_ID) return null;
		return raw;
	}

	if (typeof raw === "string") {
		const s = raw.trim();
		if (!/^[1-9][0-9]{0,9}$/.test(s)) return null;
		const n = Number(s);
		if (!Number.isInteger(n) || n < 1 || n > MAX_TVDB_ID) return null;
		return n;
	}

	return null;
}

/** Normalise a kind string from the client. Accepts the singular "movie" as an alias for "movies". */
function normaliseKind(raw: unknown): Category | null {
	if (typeof raw !== "string") return null;
	const k = raw.trim().toLowerCase();
	const mapped = k === "movie" ? "movies" : k;
	return VALID_KINDS.has(mapped as Category) ? (mapped as Category) : null;
}

/** Human-friendly description of the rate-limit window, used in error messages. */
function windowLabel(minutes: number): string {
	if (minutes === 60) return "hour";
	if (minutes === 1) return "minute";
	if (minutes % 60 === 0) return `${minutes / 60} hours`;
	return `${minutes} minutes`;
}

export function registerRequestRoutes(app: Web, services: Services): void {
	const { db, config, ntfy } = services;

	if (!config.requests.enabled) {
		Logger.info("Requests: disabled by config");
		return;
	}

	const minutes = Math.max(1, Math.floor(config.requests.rateLimitWindowMinutes) || 60);
	const windowMs = minutes * 60_000;
	const message = `You can only submit one request per ${windowLabel(minutes)}. Please try again later.`;

	app.post(
		"/api/requests",
		rateLimit({
			algorithm: Algorithm.FIXED_WINDOW,
			windowMs,
			max: 1,
			message,
			headers: true,
		}),
		async (ctx) => {
			let body: { kind?: unknown; id?: unknown } | null = null;
			try {
				body = await ctx.body<{ kind?: unknown; id?: unknown }>();
			} catch {
				return ctx.json({ error: 'Expected a JSON body like { "kind": "series", "id": 359274 }' }, 400);
			}

			if (!body || typeof body !== "object") {
				return ctx.json({ error: 'Expected a JSON body like { "kind": "series", "id": 359274 }' }, 400);
			}

			const kind = normaliseKind(body.kind);
			if (!kind) {
				return ctx.json({ error: "Field 'kind' must be one of: anime, series, movies" }, 400);
			}

			const tvdbId = parseTvdbId(body.id);
			if (tvdbId === null) {
				return ctx.json(
					{
						error:
							kind === "movies"
								? "Field 'id' must be a positive TheTVDB Movies ID (digits only)"
								: "Field 'id' must be a positive TheTVDB Series ID (digits only)",
					},
					400,
				);
			}

			try {
				const record = await db.recordRequest(kind, tvdbId);

				const label = kind === "movies" ? "Movie" : kind === "series" ? "Series" : "Anime";
				ntfy.notify({
					title: `New ${label.toLowerCase()} request`,
					message: `${label} with TheTVDB ID ${tvdbId} was requested (${record.counter}× total).`,
					tags: ["inbox_tray", kind === "movies" ? "clapper" : "tv"],
					click: `https://thetvdb.com/dereferrer/${kind === "movies" ? "movie" : "series"}/${tvdbId}`,
				});

				return ctx.json(
					{
						id: record.tvdb_id,
						kind: record.kind,
						counter: record.counter,
						created: record.created,
						last_updated: record.last_updated,
					},
					201,
					{ "Cache-Control": "no-store" },
				);
			} catch (err: any) {
				Logger.error("Failed to record request:", err);
				return ctx.json({ error: "Failed to store request" }, 500);
			}
		},
	);

	Logger.info(`Requests: enabled (max 1 per ${windowLabel(minutes)} per IP)`);
}
