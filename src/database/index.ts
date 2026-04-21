import { SQL } from "bun";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "../config";

export type Category = "anime" | "movies" | "series";

export interface Release {
	id: number;
	category: Category;
	title: string;
	year: number | null;
	season: string | null;
	torrent_name: string;
	torrent_file: string;
	mediainfo: string;
	tags: string; // JSON array
	uploaded_at: number;
	info_hash: string | null; // 40-char hex (SHA-1 of info dict)
	trackers: string | null; // JSON array of announce URLs
	files: string | null; // JSON array of { path: string[], length: number }
	seeders: number | null;
	leechers: number | null;
	completed: number | null;
	last_scraped_at: number | null;
}

export interface ReleaseListItem {
	id: number;
	category: Category;
	title: string;
	year: number | null;
	season: string | null;
	torrent_name: string;
	tags: string[];
	uploaded_at: number;
	seeders: number | null;
	leechers: number | null;
	completed: number | null;
	last_scraped_at: number | null;
}

export interface ReleaseGroupItem {
	title: string;
	year: number | null;
	latest_uploaded_at: number;
	tags: string[]; // taken from the most recently uploaded release in the group
	releases: ReleaseListItem[]; // sorted by season, numeric-aware
}

/** Minimal shape needed by the scraper: what to scrape and where. */
export interface ScrapeTarget {
	id: number;
	category: Category;
	info_hash: string;
	trackers: string[];
}

/** Rows that need info_hash + trackers backfilled from their .torrent file. */
export interface MissingMetadataRow {
	id: number;
	category: Category;
	torrent_file: string;
}

function parseSearchQuery(raw: string): { title: string; year: number | null } {
	const trimmed = raw.trim();
	const parenMatch = trimmed.match(/\((\d{4})\)/);
	if (!parenMatch) return { title: trimmed, year: null };
	const year = parseInt(parenMatch[1]!, 10);
	const title = (trimmed.slice(0, parenMatch.index!) + trimmed.slice(parenMatch.index! + parenMatch[0].length)).replace(/\s+/g, " ").trim();
	return { title, year };
}

function parseTrackerJson(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function toListItem(r: Release): ReleaseListItem {
	return {
		id: r.id,
		category: r.category,
		title: r.title,
		year: r.year,
		season: r.season,
		torrent_name: r.torrent_name,
		tags: JSON.parse(r.tags),
		uploaded_at: Number(r.uploaded_at),
		seeders: r.seeders === null || r.seeders === undefined ? null : Number(r.seeders),
		leechers: r.leechers === null || r.leechers === undefined ? null : Number(r.leechers),
		completed: r.completed === null || r.completed === undefined ? null : Number(r.completed),
		last_scraped_at: r.last_scraped_at === null || r.last_scraped_at === undefined ? null : Number(r.last_scraped_at),
	};
}

export class Database {
	public sql: SQL;
	private driver: "sqlite" | "postgres" | "mysql";

	constructor(sql: SQL, driver: "sqlite" | "postgres" | "mysql") {
		this.sql = sql;
		this.driver = driver;
	}

	static async init(config: Config): Promise<Database> {
		const url = config.database.url;
		const driver: "sqlite" | "postgres" | "mysql" = url.startsWith("sqlite") ? "sqlite" : url.startsWith("mysql") ? "mysql" : "postgres";

		// Ensure SQLite data directory exists
		if (driver === "sqlite") {
			const path = url.replace(/^sqlite:(\/\/)?/, "");
			await mkdir(dirname(path), { recursive: true });
		}

		const sql = new SQL(url);
		const db = new Database(sql, driver);
		await db.migrate();
		return db;
	}

	private async migrate(): Promise<void> {
		const idColumn =
			this.driver === "sqlite"
				? "id INTEGER PRIMARY KEY AUTOINCREMENT"
				: this.driver === "mysql"
					? "id BIGINT PRIMARY KEY AUTO_INCREMENT"
					: "id BIGSERIAL PRIMARY KEY";

		await this.sql.unsafe(`
			CREATE TABLE IF NOT EXISTS releases (
				${idColumn},
				category VARCHAR(16) NOT NULL,
				title TEXT NOT NULL,
				year INTEGER,
				season VARCHAR(8),
				torrent_name TEXT NOT NULL,
				torrent_file TEXT NOT NULL,
				mediainfo TEXT NOT NULL,
				tags TEXT NOT NULL,
				uploaded_at BIGINT NOT NULL,
				info_hash VARCHAR(40),
				trackers TEXT,
				files TEXT,
				seeders INTEGER,
				leechers INTEGER,
				completed INTEGER,
				last_scraped_at BIGINT
			)
		`);

		const addColumnStatements = [
			"ALTER TABLE releases ADD COLUMN info_hash VARCHAR(40)",
			"ALTER TABLE releases ADD COLUMN trackers TEXT",
			"ALTER TABLE releases ADD COLUMN files TEXT",
			"ALTER TABLE releases ADD COLUMN seeders INTEGER",
			"ALTER TABLE releases ADD COLUMN leechers INTEGER",
			"ALTER TABLE releases ADD COLUMN completed INTEGER",
			"ALTER TABLE releases ADD COLUMN last_scraped_at BIGINT",
		];
		for (const stmt of addColumnStatements) {
			await this.sql.unsafe(stmt).catch(() => {});
		}

		await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_releases_category ON releases (category)`).catch(() => {});
		await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_releases_uploaded_at ON releases (uploaded_at)`).catch(() => {});
		await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_releases_info_hash ON releases (info_hash)`).catch(() => {});
	}

	async insert(entry: Omit<Release, "id">): Promise<Release> {
		const rows = await this.sql`
			INSERT INTO releases ${this.sql({
				category: entry.category,
				title: entry.title,
				year: entry.year,
				season: entry.season,
				torrent_name: entry.torrent_name,
				torrent_file: entry.torrent_file,
				mediainfo: entry.mediainfo,
				tags: entry.tags,
				uploaded_at: entry.uploaded_at,
				info_hash: entry.info_hash,
				trackers: entry.trackers,
				files: entry.files,
				seeders: entry.seeders,
				leechers: entry.leechers,
				completed: entry.completed,
				last_scraped_at: entry.last_scraped_at,
			})}
			${this.driver !== "mysql" ? this.sql`RETURNING *` : this.sql``}
		`;

		if (this.driver === "mysql") {
			const id = (rows as any).lastInsertRowid ?? (rows as any).insertId;
			const found = await this.findById(entry.category, Number(id));
			if (!found) throw new Error("Insert failed: could not retrieve new row");
			return found;
		}

		return rows[0] as Release;
	}

	async list(category: Category, options: { limit: number; offset: number; search?: string }): Promise<{ items: ReleaseListItem[]; total: number }> {
		const search = options.search?.trim();

		let items: Release[];
		let countRows: Array<{ count: number }>;

		if (search) {
			const pattern = `%${search}%`;
			items = (await this.sql`
				SELECT id, category, title, year, season, torrent_name, tags, uploaded_at, seeders, leechers, completed, last_scraped_at
				FROM releases
				WHERE category = ${category} AND title LIKE ${pattern}
				ORDER BY uploaded_at DESC
				LIMIT ${options.limit} OFFSET ${options.offset}
			`) as unknown as Release[];
			countRows = (await this.sql`
				SELECT COUNT(*) AS count FROM releases
				WHERE category = ${category} AND title LIKE ${pattern}
			`) as unknown as Array<{ count: number }>;
		} else {
			items = (await this.sql`
				SELECT id, category, title, year, season, torrent_name, tags, uploaded_at, seeders, leechers, completed, last_scraped_at
				FROM releases
				WHERE category = ${category}
				ORDER BY uploaded_at DESC
				LIMIT ${options.limit} OFFSET ${options.offset}
			`) as unknown as Release[];
			countRows = (await this.sql`
				SELECT COUNT(*) AS count FROM releases
				WHERE category = ${category}
			`) as unknown as Array<{ count: number }>;
		}

		return {
			items: items.map(toListItem),
			total: Number(countRows[0]?.count ?? 0),
		};
	}

	async listGroups(category: Category, options: { limit: number; offset: number; search?: string }): Promise<{ groups: ReleaseGroupItem[]; total: number }> {
		const parsed = options.search?.trim() ? parseSearchQuery(options.search) : null;
		const titlePattern = parsed?.title ? `%${parsed.title}%` : null;
		const year = parsed?.year ?? null;

		const titleFilter = titlePattern ? this.sql`AND title LIKE ${titlePattern}` : this.sql``;
		const yearFilter = year !== null ? this.sql`AND year = ${year}` : this.sql``;

		// 1. Count distinct (title, year) groups
		const countRows = (await this.sql`
		SELECT COUNT(*) AS count FROM (
			SELECT 1 FROM releases
			WHERE category = ${category} ${titleFilter} ${yearFilter}
			GROUP BY title, year
		) AS g
	`) as unknown as Array<{ count: number }>;
		const total = Number(countRows[0]?.count ?? 0);
		if (total === 0) return { groups: [], total: 0 };

		// 2. Fetch releases for the paginated groups in a single JOIN.
		type JoinRow = {
			id: number;
			category: Category;
			title: string;
			year: number | null;
			season: string | null;
			torrent_name: string;
			tags: string;
			uploaded_at: number;
			latest_uploaded_at: number;
			seeders: number | null;
			leechers: number | null;
			completed: number | null;
			last_scraped_at: number | null;
		};

		const rows = (await this.sql`
		SELECT
			r.id, r.category, r.title, r.year, r.season,
			r.torrent_name, r.tags, r.uploaded_at,
			r.seeders, r.leechers, r.completed, r.last_scraped_at,
			g.latest_uploaded_at
		FROM releases r
		INNER JOIN (
			SELECT title, year, MAX(uploaded_at) AS latest_uploaded_at
			FROM releases
			WHERE category = ${category} ${titleFilter} ${yearFilter}
			GROUP BY title, year
			ORDER BY latest_uploaded_at DESC
			LIMIT ${options.limit} OFFSET ${options.offset}
		) AS g
			ON r.title = g.title
			AND (r.year = g.year OR (r.year IS NULL AND g.year IS NULL))
		WHERE r.category = ${category}
		ORDER BY g.latest_uploaded_at DESC, r.title ASC, r.year ASC, r.season ASC
	`) as unknown as JoinRow[];

		// 3. Collapse rows into groups.
		const groupMap = new Map<string, ReleaseGroupItem>();
		const orderedKeys: string[] = [];

		for (const row of rows) {
			const key = `${row.title}::${row.year ?? ""}`;
			let group = groupMap.get(key);
			if (!group) {
				group = {
					title: row.title,
					year: row.year,
					latest_uploaded_at: Number(row.latest_uploaded_at),
					tags: [],
					releases: [],
				};
				groupMap.set(key, group);
				orderedKeys.push(key);
			}
			group.releases.push({
				id: row.id,
				category: row.category,
				title: row.title,
				year: row.year,
				season: row.season,
				torrent_name: row.torrent_name,
				tags: JSON.parse(row.tags),
				uploaded_at: Number(row.uploaded_at),
				seeders: row.seeders === null || row.seeders === undefined ? null : Number(row.seeders),
				leechers: row.leechers === null || row.leechers === undefined ? null : Number(row.leechers),
				completed: row.completed === null || row.completed === undefined ? null : Number(row.completed),
				last_scraped_at: row.last_scraped_at === null || row.last_scraped_at === undefined ? null : Number(row.last_scraped_at),
			});
		}

		// Sort seasons numeric-aware (S2 < S10), and take tags from the most
		// recently uploaded release in the group.
		const groups = orderedKeys.map((k) => {
			const g = groupMap.get(k)!;
			g.releases.sort((a, b) => (a.season ?? "").localeCompare(b.season ?? "", undefined, { numeric: true, sensitivity: "base" }));
			const mostRecent = g.releases.reduce((a, b) => (a.uploaded_at >= b.uploaded_at ? a : b));
			g.tags = mostRecent.tags;
			return g;
		});

		return { groups, total };
	}

	async findById(category: Category, id: number): Promise<Release | null> {
		const rows = (await this.sql`
			SELECT * FROM releases WHERE category = ${category} AND id = ${id} LIMIT 1
		`) as unknown as Release[];
		return rows[0] ?? null;
	}

	async findGroupReleases(category: Category, title: string, year: number | null): Promise<Array<{ id: number; season: string | null }>> {
		type Row = { id: number; season: string | null };
		let rows: Row[];
		if (year === null) {
			rows = (await this.sql`
			SELECT id, season FROM releases
			WHERE category = ${category} AND title = ${title} AND year IS NULL
		`) as unknown as Row[];
		} else {
			rows = (await this.sql`
			SELECT id, season FROM releases
			WHERE category = ${category} AND title = ${title} AND year = ${year}
		`) as unknown as Row[];
		}
		// Numeric-aware sort (S2 before S10)
		return rows
			.map((r) => ({ id: Number(r.id), season: r.season }))
			.sort((a, b) => (a.season ?? "").localeCompare(b.season ?? "", undefined, { numeric: true, sensitivity: "base" }));
	}

	async stats(): Promise<Record<Category, number>> {
		const rows = (await this.sql`
			SELECT category, COUNT(*) AS count FROM releases GROUP BY category
		`) as unknown as Array<{ category: Category; count: number }>;

		const result: Record<Category, number> = { anime: 0, movies: 0, series: 0 };
		for (const row of rows) {
			result[row.category] = Number(row.count);
		}
		return result;
	}

	/**
	 * Every release that has both info_hash and at least one tracker.
	 * Parsed tracker JSON is returned as string[] for direct use.
	 */
	async listScrapeTargets(): Promise<ScrapeTarget[]> {
		type Row = { id: number; category: Category; info_hash: string; trackers: string | null };
		const rows = (await this.sql`
			SELECT id, category, info_hash, trackers
			FROM releases
			WHERE info_hash IS NOT NULL AND trackers IS NOT NULL
		`) as unknown as Row[];

		return rows
			.map((r) => ({
				id: Number(r.id),
				category: r.category,
				info_hash: r.info_hash,
				trackers: parseTrackerJson(r.trackers),
			}))
			.filter((r) => r.trackers.length > 0);
	}

	/** Releases missing info_hash, trackers, or files = candidates for one-time backfill. */
	async listMissingMetadata(): Promise<MissingMetadataRow[]> {
		type Row = { id: number; category: Category; torrent_file: string };
		const rows = (await this.sql`
			SELECT id, category, torrent_file FROM releases
			WHERE info_hash IS NULL OR trackers IS NULL OR files IS NULL
		`) as unknown as Row[];
		return rows.map((r) => ({ id: Number(r.id), category: r.category, torrent_file: r.torrent_file }));
	}

	/** Fill in info_hash + trackers + files for a single release (backfill path). */
	async setTorrentMetadata(id: number, info_hash: string, trackers: string[], files: Array<{ path: string[]; length: number }>): Promise<void> {
		const trackersJson = JSON.stringify(trackers);
		const filesJson = JSON.stringify(files);
		await this.sql`
			UPDATE releases
			SET info_hash = ${info_hash},
			    trackers = ${trackersJson},
			    files = ${filesJson}
			WHERE id = ${id}
		`;
	}

	/**
	 * Apply scrape results for many torrents in one logical batch.
	 */
	async updateScrapeStatsBulk(updates: Array<{ info_hash: string; seeders: number; leechers: number; completed: number }>, scrapedAt: number): Promise<void> {
		if (updates.length === 0) return;
		for (const u of updates) {
			await this.sql`
				UPDATE releases
				SET seeders = ${u.seeders},
				    leechers = ${u.leechers},
				    completed = ${u.completed},
				    last_scraped_at = ${scrapedAt}
				WHERE info_hash = ${u.info_hash}
			`;
		}
	}
}
