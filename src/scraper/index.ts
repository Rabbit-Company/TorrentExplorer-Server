import { lookup } from "node:dns/promises";
import type { Database, ScrapeTarget } from "../database/index.ts";
import { Logger } from "../logger.ts";
import { UdpScrapeClient, type ScrapeResult } from "./udp.ts";

const MAX_HASHES_PER_PACKET = 50;

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_UDP_TIMEOUT_MS = 5000;
const DEFAULT_STARTUP_DELAY_MS = 10_000;

export interface ScraperOptions {
	intervalMs?: number;
	udpTimeoutMs?: number;
	maxHashesPerPacket?: number;
	/** Delay before the first run after start(). Avoids colliding with startup work. */
	startupDelayMs?: number;
}

interface TrackerGroup {
	host: string;
	port: number;
	/** Set of info_hash hex strings. Deduped automatically. */
	hashes: Set<string>;
}

/**
 * Background scraper. Groups all tracked torrents by tracker URL, resolves
 * each tracker host once, opens a single shared UDP socket per cycle, and
 * batches info_hashes into scrape packets of at most MAX_HASHES_PER_PACKET.
 *
 * When the same info_hash appears on multiple trackers, the "best" numbers
 * win (highest seeders), so a dead tracker can't pin the display to 0/0.
 */
export class Scraper {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private readonly intervalMs: number;
	private readonly udpTimeoutMs: number;
	private readonly maxHashesPerPacket: number;
	private readonly startupDelayMs: number;

	constructor(
		private readonly db: Database,
		opts: ScraperOptions = {},
	) {
		this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.udpTimeoutMs = opts.udpTimeoutMs ?? DEFAULT_UDP_TIMEOUT_MS;
		this.maxHashesPerPacket = opts.maxHashesPerPacket ?? MAX_HASHES_PER_PACKET;
		this.startupDelayMs = opts.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
	}

	start(): void {
		if (this.timer) return;
		Logger.info(`Scraper: starting (interval=${Math.round(this.intervalMs / 1000)}s, batch=${this.maxHashesPerPacket}, udp_timeout=${this.udpTimeoutMs}ms)`);

		setTimeout(() => {
			this.runOnce().catch((err) => Logger.error("Scraper initial run failed:", err));
		}, this.startupDelayMs);

		this.timer = setInterval(() => {
			this.runOnce().catch((err) => Logger.error("Scraper cycle failed:", err));
		}, this.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Run a single scrape cycle. Safe to call manually; re-entry is prevented. */
	async runOnce(): Promise<void> {
		if (this.running) {
			Logger.debug("Scraper: cycle already in progress, skipping");
			return;
		}
		this.running = true;
		const startedAt = Date.now();
		try {
			const torrents = await this.db.listScrapeTargets();
			if (torrents.length === 0) {
				Logger.debug("Scraper: no torrents with info_hash + trackers");
				return;
			}

			const groups = groupByTracker(torrents);
			if (groups.size === 0) {
				Logger.debug("Scraper: no UDP trackers found");
				return;
			}

			const bestByHash = new Map<string, ScrapeResult>();

			const client = await UdpScrapeClient.create({ timeoutMs: this.udpTimeoutMs });
			try {
				for (const group of groups.values()) {
					await this.scrapeTracker(client, group, bestByHash);
				}
			} finally {
				client.close();
			}

			if (bestByHash.size === 0) {
				Logger.warn(`Scraper: no torrents updated (${torrents.length} tried across ${groups.size} trackers)`);
				return;
			}

			const now = Date.now();
			await this.db.updateScrapeStatsBulk(
				[...bestByHash.values()].map((r) => ({
					info_hash: r.infoHashHex,
					seeders: r.seeders,
					leechers: r.leechers,
					completed: r.completed,
				})),
				now,
			);

			const elapsed = Date.now() - startedAt;
			Logger.info(`Scraper: updated ${bestByHash.size}/${torrents.length} torrents across ${groups.size} trackers in ${elapsed}ms`);
		} catch (err: any) {
			Logger.error("Scraper: cycle error:", err);
		} finally {
			this.running = false;
		}
	}

	private async scrapeTracker(client: UdpScrapeClient, group: TrackerGroup, bestByHash: Map<string, ScrapeResult>): Promise<void> {
		let ip: string;
		try {
			const resolved = await lookup(group.host);
			ip = resolved.address;
		} catch (err: any) {
			Logger.debug(`Scraper: DNS lookup failed for ${group.host}: ${err.message ?? err}`);
			return;
		}

		const hashes = [...group.hashes];
		let received = 0;
		for (let i = 0; i < hashes.length; i += this.maxHashesPerPacket) {
			const batch = hashes.slice(i, i + this.maxHashesPerPacket);
			try {
				const results = await client.scrape(ip, group.port, batch);
				received += results.length;
				for (const r of results) {
					// Nonsense sentinel values some trackers emit for unknown hashes.
					// 2^32-1 would mean "u32 max" which is effectively never real.
					if (r.seeders === 0xffffffff && r.leechers === 0xffffffff) continue;
					const prev = bestByHash.get(r.infoHashHex);
					if (!prev || r.seeders > prev.seeders) {
						bestByHash.set(r.infoHashHex, r);
					}
				}
			} catch (err: any) {
				Logger.debug(`Scraper: ${group.host}:${group.port} batch failed: ${err.message ?? err}`);
				// Keep going; other trackers may still succeed for the same hashes.
			}
		}

		if (received > 0) {
			Logger.debug(`Scraper: ${group.host}:${group.port} returned ${received}/${hashes.length} hashes`);
		}
	}
}

/**
 * Group torrents by tracker endpoint. Only UDP trackers are considered.
 * Each info_hash ends up in every tracker group where it's announced.
 */
function groupByTracker(torrents: ScrapeTarget[]): Map<string, TrackerGroup> {
	const groups = new Map<string, TrackerGroup>();
	for (const t of torrents) {
		if (!t.info_hash) continue;
		for (const trackerUrl of t.trackers) {
			const endpoint = parseUdpTracker(trackerUrl);
			if (!endpoint) continue;
			const key = `${endpoint.host}:${endpoint.port}`;
			let group = groups.get(key);
			if (!group) {
				group = { host: endpoint.host, port: endpoint.port, hashes: new Set() };
				groups.set(key, group);
			}
			group.hashes.add(t.info_hash);
		}
	}
	return groups;
}

function parseUdpTracker(trackerUrl: string): { host: string; port: number } | null {
	if (!trackerUrl.startsWith("udp://")) return null;
	let parsed: URL;
	try {
		parsed = new URL(trackerUrl);
	} catch {
		return null;
	}
	const host = parsed.hostname;
	if (!host) return null;
	const port = parsed.port ? parseInt(parsed.port, 10) : 80;
	if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
	return { host, port };
}
