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
				uploaded_at BIGINT NOT NULL
			)
		`);

		await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_releases_category ON releases (category)`).catch(() => {});
		await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_releases_uploaded_at ON releases (uploaded_at)`).catch(() => {});
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
				SELECT id, category, title, year, season, torrent_name, tags, uploaded_at
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
				SELECT id, category, title, year, season, torrent_name, tags, uploaded_at
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
			items: items.map((r) => ({
				id: r.id,
				category: r.category,
				title: r.title,
				year: r.year,
				season: r.season,
				torrent_name: r.torrent_name,
				tags: JSON.parse(r.tags),
				uploaded_at: Number(r.uploaded_at),
			})),
			total: Number(countRows[0]?.count ?? 0),
		};
	}

	async findById(category: Category, id: number): Promise<Release | null> {
		const rows = (await this.sql`
			SELECT * FROM releases WHERE category = ${category} AND id = ${id} LIMIT 1
		`) as unknown as Release[];
		return rows[0] ?? null;
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
}
