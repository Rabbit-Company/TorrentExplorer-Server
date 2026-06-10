import { Logger } from "./logger.ts";
import type { Config } from "./config.ts";

/**
 * Polls one or more Rabbit Encoder instances, aggregates their job queues into
 * season-level groups (no per-episode data is ever exposed), and caches the
 * public-safe result in memory.
 *
 * The cache is served to the frontend through GET /api/encoders/queue. When a
 * poll fails the previous cache is kept and the encoder is flagged offline, so
 * the public page degrades gracefully instead of going blank.
 */

type RabbitJobStatus = "queued" | "probing" | "encoding_video" | "encoding_audio" | "muxing" | "done" | "error" | "cancelled";

interface RabbitJob {
	id: string;
	filename: string;
	relativePath: string;
	status: RabbitJobStatus;
	progress: number; // 0-100
	queueOrder: number;
	startedAt?: number;
	finishedAt?: number;
	probe?: { duration?: number };
}

export interface PublicQueueGroup {
	title: string;
	season: string | null;
	queuePosition: number;
	total: number;
	done: number;
	encoding: number;
	queued: number;
	error: number;
	progress: number; // 0-100 across the whole season
	etaMs: number | null; // estimated time remaining for this season
	active: boolean;
}

export interface PublicEncoder {
	name: string;
	online: boolean;
	paused: boolean;
	lastUpdated: number | null; // epoch ms of the last successful poll
	totals: { total: number; done: number; encoding: number; queued: number; error: number };
	etaMs: number | null; // total remaining across all groups
	groups: PublicQueueGroup[];
}

export interface PublicQueuePayload {
	enabled: boolean;
	pollIntervalSeconds: number;
	encoders: PublicEncoder[];
}

const ACTIVE: ReadonlySet<RabbitJobStatus> = new Set(["probing", "encoding_video", "encoding_audio", "muxing"]);

function isActive(status: RabbitJobStatus): boolean {
	return ACTIVE.has(status);
}

// `Show Name (Year) - S01E09 - Episode Title ...` - the episode marker is the
// reliable anchor. We capture everything before it as the show title and the
// season number from it. Lazy `.+?` stops at the first ` - S<digits>E<digits>`,
// which never trips on titles like "...the Shell - Stand Alone..." (no digit).
const EPISODE_RE = /^(.+?)[ ._-]+S(\d{1,3})E\d{1,4}\b/i;
// Path segment that is purely a season marker ("Season 01", "S2", "Season 2").
const PATH_SEASON_RE = /^(?:season[\s._-]*|s)(\d{1,3})$/i;
// Trailing scene/source/episode cruft for the no-episode-marker fallback.
const EP_MARKER_RE = /\s*[-._]?\s*(?:S\d{1,3}E\d{1,4}|E\d{1,4}|\b\d{1,4}\b)\s*$/i;

function seasonLabel(n: number): string {
	return n === 0 ? "Specials" : `Season ${n}`;
}

/** Strip a trailing metadata tag like `[imdbid-tt123]` or `{tmdb-456}` from a folder name. */
function cleanShowFolder(seg: string): string {
	return seg
		.replace(/\s*\[[^\]]*\]\s*$/g, "")
		.replace(/\s*\{[^}]*\}\s*$/g, "")
		.trim();
}

function cleanTitle(raw: string): string {
	// Last-resort title for files with no episode marker (e.g. movies).
	let name = raw.replace(/\.[a-z0-9]{2,4}$/i, "");
	name = name.replace(/[._]+/g, " ").trim();
	name = name.replace(EP_MARKER_RE, "").trim();
	return name || raw;
}

/**
 * Derive a (title, season) group key for a job.
 *
 * The filename is the source of truth because `relativePath` is inconsistent in
 * practice - for the same show it can be "Show (Year) [imdbid-..]/Season 02",
 * "Season 02", "Season 01/", or "Specials". Parsing the filename's
 * `Show - SxxExx` pattern groups every season of a show together regardless of
 * how its path happens to be shaped, and never leaks the episode name.
 */
function deriveGroup(job: RabbitJob): { title: string; season: string | null } {
	const m = job.filename.match(EPISODE_RE);
	if (m) {
		const title = m[1]!.replace(/\s+/g, " ").trim();
		if (title) return { title, season: seasonLabel(parseInt(m[2]!, 10)) };
	}

	// Fallback: no SxxExx in the filename (movies, oddly-named files).
	const segs = (job.relativePath || "")
		.split(/[/\\]/)
		.map((s) => s.trim())
		.filter(Boolean);

	let season: string | null = null;
	for (const seg of segs) {
		const sm = seg.match(PATH_SEASON_RE);
		if (sm) season = seasonLabel(parseInt(sm[1]!, 10));
	}

	const showFolder = segs.find((s) => !PATH_SEASON_RE.test(s) && s.toLowerCase() !== "specials" && s.toLowerCase() !== "extras");
	const title = showFolder ? cleanShowFolder(showFolder) : cleanTitle(job.filename);

	return { title, season };
}

/** Aggregate stats and timing reference for a set of completed jobs. */
interface TimingRef {
	avgPerEpisodeMs: number | null;
	encodeRatio: number | null; // encode-ms per source-ms
}

function buildTimingRef(jobs: RabbitJob[]): TimingRef {
	const done = jobs.filter((j) => j.status === "done" && typeof j.startedAt === "number" && typeof j.finishedAt === "number");

	const avgPerEpisodeMs = done.length > 0 ? done.reduce((sum, j) => sum + (j.finishedAt! - j.startedAt!), 0) / done.length : null;

	const withDuration = done.filter((j) => j.probe && (j.probe.duration ?? 0) > 0);
	let encodeRatio: number | null = null;
	if (withDuration.length > 0) {
		const totalEncode = withDuration.reduce((sum, j) => sum + (j.finishedAt! - j.startedAt!), 0);
		const totalDuration = withDuration.reduce((sum, j) => sum + j.probe!.duration! * 1000, 0);
		if (totalDuration > 0) encodeRatio = totalEncode / totalDuration;
	}

	return { avgPerEpisodeMs, encodeRatio };
}

function estimateJobMs(job: RabbitJob, ref: TimingRef): number {
	if (ref.encodeRatio !== null && job.probe && (job.probe.duration ?? 0) > 0) {
		return job.probe.duration! * 1000 * ref.encodeRatio;
	}
	if (ref.avgPerEpisodeMs !== null) return ref.avgPerEpisodeMs;
	return 0;
}

/** Remaining-time estimate (ms) for a slice of jobs, given a timing reference. */
function estimateRemainingMs(jobs: RabbitJob[], ref: TimingRef, now: number): number {
	let remaining = 0;
	for (const job of jobs) {
		if (isActive(job.status)) {
			if (job.startedAt && job.progress > 0) {
				const elapsed = now - job.startedAt;
				if (elapsed > 3000) {
					const total = (elapsed / job.progress) * 100;
					remaining += Math.max(0, total - elapsed);
					continue;
				}
			}
			remaining += estimateJobMs(job, ref);
		} else if (job.status === "queued") {
			remaining += estimateJobMs(job, ref);
		}
	}
	return remaining;
}

function aggregate(jobs: RabbitJob[], now: number): { groups: PublicQueueGroup[]; etaMs: number | null; totals: PublicEncoder["totals"] } {
	const ref = buildTimingRef(jobs);

	const buckets = new Map<string, RabbitJob[]>();
	for (const job of jobs) {
		if (job.status === "cancelled") continue;
		const { title, season } = deriveGroup(job);
		const key = `${title}\u0000${season ?? ""}`;
		const arr = buckets.get(key);
		if (arr) arr.push(job);
		else buckets.set(key, [job]);
	}

	const groups: PublicQueueGroup[] = [];
	for (const arr of buckets.values()) {
		const total = arr.length;
		const done = arr.filter((j) => j.status === "done").length;
		const encoding = arr.filter((j) => isActive(j.status)).length;
		const queued = arr.filter((j) => j.status === "queued").length;
		const error = arr.filter((j) => j.status === "error").length;

		// Only surface seasons that still have work to do.
		if (encoding + queued === 0) continue;

		// A season's place in line is its earliest still-pending episode. The
		// encoder processes by queueOrder, so the lowest pending order = next up.
		// (Episodes of one season may be interleaved with other shows, so we key
		// off the minimum rather than assuming a contiguous block.)
		const minPendingOrder = Math.min(...arr.filter((j) => isActive(j.status) || j.status === "queued").map((j) => j.queueOrder));

		const { title, season } = deriveGroup(arr[0]!);
		const progress = total > 0 ? arr.reduce((s, j) => s + (j.status === "done" ? 100 : j.progress), 0) / total : 0;
		const etaMs = estimateRemainingMs(arr, ref, now);

		groups.push({
			title,
			season,
			queuePosition: minPendingOrder, // replaced with a 1-based rank after sorting
			total,
			done,
			encoding,
			queued,
			error,
			progress: Math.round(progress * 10) / 10,
			etaMs: etaMs > 0 ? Math.round(etaMs) : null,
			active: encoding > 0,
		});
	}

	// Order by real encode position, then collapse the raw queueOrder we stashed
	// in queuePosition into a clean 1-based rank (1 = encoding now / up next).
	groups.sort((a, b) => a.queuePosition - b.queuePosition);
	groups.forEach((g, i) => {
		g.queuePosition = i + 1;
	});

	const remainingJobs = jobs.filter((j) => isActive(j.status) || j.status === "queued");
	const etaMs = estimateRemainingMs(remainingJobs, ref, now);

	const totals = {
		total: jobs.filter((j) => j.status !== "cancelled").length,
		done: jobs.filter((j) => j.status === "done").length,
		encoding: jobs.filter((j) => isActive(j.status)).length,
		queued: jobs.filter((j) => j.status === "queued").length,
		error: jobs.filter((j) => j.status === "error").length,
	};

	return { groups, etaMs: etaMs > 0 ? Math.round(etaMs) : null, totals };
}

// Poller

interface EncoderTarget {
	name: string;
	url: string; // base url, no trailing slash
	token: string; // precomputed bearer token
}

interface CachedEncoder extends PublicEncoder {}

export class EncoderPoller {
	private targets: EncoderTarget[];
	private cache = new Map<string, CachedEncoder>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly intervalMs: number;
	private readonly enabled: boolean;

	constructor(config: Config) {
		this.enabled = config.encoders.enabled && config.encoders.list.length > 0;
		this.intervalMs = Math.max(2, config.encoders.pollIntervalSeconds) * 1000;
		this.targets = config.encoders.list.map((e) => ({
			name: e.name,
			url: e.url.replace(/\/+$/, ""),
			token: new Bun.CryptoHasher("blake2b512").update(`rabbitencoder-${e.password}`).digest("hex"),
		}));

		// Seed cache so the endpoint has entries to show before the first poll lands.
		for (const t of this.targets) {
			this.cache.set(t.name, {
				name: t.name,
				online: false,
				paused: false,
				lastUpdated: null,
				totals: { total: 0, done: 0, encoding: 0, queued: 0, error: 0 },
				etaMs: null,
				groups: [],
			});
		}
	}

	start(): void {
		if (!this.enabled) {
			Logger.info("Encoder polling: disabled");
			return;
		}
		Logger.info(`Encoder polling: ${this.targets.length} target(s) every ${this.intervalMs / 1000}s`);
		void this.pollAll();
		this.timer = setInterval(() => void this.pollAll(), this.intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	getPayload(): PublicQueuePayload {
		return {
			enabled: this.enabled,
			pollIntervalSeconds: this.intervalMs / 1000,
			encoders: this.targets.map((t) => this.cache.get(t.name)!),
		};
	}

	private async pollAll(): Promise<void> {
		await Promise.all(this.targets.map((t) => this.pollOne(t)));
	}

	private async pollOne(target: EncoderTarget): Promise<void> {
		const prev = this.cache.get(target.name)!;
		try {
			const headers = { Authorization: `Bearer ${target.token}` };
			const signal = AbortSignal.timeout(Math.min(this.intervalMs, 15000));

			const [jobsRes, queueRes] = await Promise.all([
				fetch(`${target.url}/api/jobs`, { headers, signal }),
				fetch(`${target.url}/api/queue`, { headers, signal }),
			]);

			if (!jobsRes.ok) throw new Error(`/api/jobs -> ${jobsRes.status}`);

			const jobs = (await jobsRes.json()) as RabbitJob[];
			let paused = false;
			if (queueRes.ok) {
				try {
					paused = Boolean(((await queueRes.json()) as { paused?: boolean }).paused);
				} catch {
					/* keep paused=false */
				}
			}

			const { groups, etaMs, totals } = aggregate(Array.isArray(jobs) ? jobs : [], Date.now());

			this.cache.set(target.name, {
				name: target.name,
				online: true,
				paused,
				lastUpdated: Date.now(),
				totals,
				etaMs,
				groups,
			});
		} catch (err: any) {
			// Keep the last good data; just flag the encoder offline.
			Logger.warn(`Encoder poll failed (${target.name}): ${err?.message ?? err}`);
			this.cache.set(target.name, { ...prev, online: false });
		}
	}
}
