export interface ParsedFilename {
	releaseGroup: string | null;
	title: string;
	year: number | null;
	season: string | null;
	tags: string[];
}

/**
 * Parse a torrent filename following the format:
 *   [ReleaseGroup] Title (Year) - S## [Tag1][Tag2][TagN]
 *
 * Examples:
 *   "[RabbitCompany] Valkyrie Drive - Mermaid (2015) - S01 [Bluray-1080p][Opus 2.0][AV1]"
 *   "[RabbitCompany] Some Movie (2020) [Bluray-2160p][Opus 5.1][AV1]"
 *   "[RabbitCompany] Tsugumomo (2017) - S02 [Bluray-1080p][Opus 2.0][AV1]"
 *
 * The `.torrent` extension is stripped automatically if present.
 */
export function parseTorrentFilename(filename: string): ParsedFilename {
	let name = filename.replace(/\.torrent$/i, "").trim();

	// 1. Release group at start: [Group]
	let releaseGroup: string | null = null;
	const rgMatch = name.match(/^\[([^\]]+)\]\s*/);
	if (rgMatch) {
		releaseGroup = rgMatch[1]!;
		name = name.slice(rgMatch[0].length);
	}

	// 2. Tags at end: [Tag1][Tag2]...
	const tags: string[] = [];
	while (true) {
		const m = name.match(/\s*\[([^\]]+)\]\s*$/);
		if (!m) break;
		tags.unshift(m[1]!);
		name = name.slice(0, name.length - m[0].length);
	}

	// 3. Season at end: - S## or - S###
	let season: string | null = null;
	const seasonMatch = name.match(/\s*-\s*(S\d{2,3})\s*$/);
	if (seasonMatch) {
		season = seasonMatch[1]!;
		name = name.slice(0, seasonMatch.index!);
	}

	// 4. Year: (YYYY)
	let year: number | null = null;
	const yearMatch = name.match(/\s*\((\d{4})\)/);
	if (yearMatch) {
		year = parseInt(yearMatch[1]!, 10);
		name = name.replace(yearMatch[0], "");
	}

	const title = name.trim().replace(/\s+/g, " ");

	return { releaseGroup, title, year, season, tags };
}

/**
 * Sanitize a string for use as a filename/storage key.
 * Allows only characters that are safe on all platforms.
 */
export function sanitizeStorageKey(name: string): string {
	return name
		.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
		.replace(/\s+/g, " ")
		.trim();
}
