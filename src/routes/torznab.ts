import type { Web } from "@rabbit-company/web";
import type { Database, Category, Release } from "../database/index.ts";
import type { Config } from "../config.ts";

interface Services {
	db: Database;
	config: Config;
}

const TORZNAB_CATEGORY: Record<Category, number> = {
	movies: 2000,
	series: 5000,
	anime: 5070,
};

const CATEGORY_LABEL: Record<Category, string> = {
	movies: "Movies",
	series: "TV",
	anime: "TV/Anime",
};

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

// Map newznab category IDs (and ranges) to our internal category names.
function torznabCatsToInternal(catParam: string | null): Category[] {
	if (!catParam) return [];
	const ids = catParam
		.split(",")
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n));

	const cats = new Set<Category>();
	for (const id of ids) {
		if (id === 5070) cats.add("anime");
		else if (id === 5000) {
			cats.add("series");
			cats.add("anime");
		} else if (id >= 5000 && id < 6000) cats.add("series");
		else if (id >= 2000 && id < 3000) cats.add("movies");
	}
	return Array.from(cats);
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function rfc822Date(ms: number): string {
	return new Date(ms).toUTCString();
}

function totalSize(filesJson: string | null): number {
	if (!filesJson) return 0;
	try {
		const parsed = JSON.parse(filesJson);
		if (!Array.isArray(parsed)) return 0;
		let sum = 0;
		for (const f of parsed) if (f && typeof f.length === "number") sum += f.length;
		return sum;
	} catch {
		return 0;
	}
}

function fileCount(filesJson: string | null): number {
	if (!filesJson) return 0;
	try {
		const parsed = JSON.parse(filesJson);
		return Array.isArray(parsed) ? parsed.length : 0;
	} catch {
		return 0;
	}
}

function parseSeasonNumber(s: string | null): number | null {
	if (!s) return null;
	const m = s.match(/^S(\d+)/i);
	return m ? parseInt(m[1]!, 10) : null;
}

function parseEpisodeNumber(torrentName: string): number | null {
	const m = torrentName.match(/[Ss]\d+[Ee](\d+)/);
	return m ? parseInt(m[1]!, 10) : null;
}

function parseTags(json: string): string[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function getBaseUrl(req: Request): string {
	const url = new URL(req.url);
	const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
	const host = req.headers.get("x-forwarded-host") ?? url.host;
	return `${proto}://${host}`;
}

function getFrontendBaseUrl(req: Request, config: Config): string {
	const configured = config.frontend.url?.trim().replace(/\/+$/, "");
	return configured || getBaseUrl(req);
}

function errorResponse(code: number, description: string): Response {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<error code="${code}" description="${escapeXml(description)}"/>`;
	return new Response(xml, {
		status: 400,
		headers: { "Content-Type": "application/xml" },
	});
}

function capsResponse(config: Config): Response {
	const title = escapeXml(config.brand.releaseGroup);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
\t<server version="1.0" title="${title}"/>
\t<limits max="${MAX_LIMIT}" default="${DEFAULT_LIMIT}"/>
\t<searching>
\t\t<search available="yes" supportedParams="q"/>
\t\t<tv-search available="yes" supportedParams="q,season,ep"/>
\t\t<movie-search available="yes" supportedParams="q,year"/>
\t\t<music-search available="no"/>
\t\t<book-search available="no"/>
\t</searching>
\t<categories>
\t\t<category id="2000" name="Movies"/>
\t\t<category id="5000" name="TV">
\t\t\t<subcat id="5070" name="Anime"/>
\t\t</category>
\t</categories>
</caps>`;
	return new Response(xml, {
		status: 200,
		headers: {
			"Content-Type": "application/xml",
			"Cache-Control": "public, max-age=3600",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function buildItem(release: Release, backendUrl: string, frontendUrl: string, releaseGroup: string): string {
	const id = Number(release.id);
	const category = release.category;
	const title = escapeXml(release.torrent_name);
	const pubDate = rfc822Date(Number(release.uploaded_at));
	const detailUrl = `${frontendUrl}/${category}/${id}`;
	const downloadUrl = `${backendUrl}/api/torrent/${category}/${id}`;
	const size = totalSize(release.files);
	const numFiles = fileCount(release.files);
	const seasonNum = parseSeasonNumber(release.season);
	const episodeNum = parseEpisodeNumber(release.torrent_name);
	const seeders = release.seeders;
	const leechers = release.leechers;
	const grabs = release.completed;
	const peers = seeders !== null && leechers !== null ? seeders + leechers : null;

	const attrs: string[] = [];
	attrs.push(`<torznab:attr name="category" value="${TORZNAB_CATEGORY[category]}"/>`);
	if (size > 0) attrs.push(`<torznab:attr name="size" value="${size}"/>`);
	if (numFiles > 0) attrs.push(`<torznab:attr name="files" value="${numFiles}"/>`);
	if (release.year !== null) attrs.push(`<torznab:attr name="year" value="${release.year}"/>`);
	if (releaseGroup) attrs.push(`<torznab:attr name="poster" value="${escapeXml(releaseGroup)}"/>`);
	if (releaseGroup) attrs.push(`<torznab:attr name="team" value="${escapeXml(releaseGroup)}"/>`);
	if (seeders !== null) attrs.push(`<torznab:attr name="seeders" value="${seeders}"/>`);
	if (leechers !== null) attrs.push(`<torznab:attr name="leechers" value="${leechers}"/>`);
	if (peers !== null) attrs.push(`<torznab:attr name="peers" value="${peers}"/>`);
	if (grabs !== null) attrs.push(`<torznab:attr name="grabs" value="${grabs}"/>`);
	if (release.info_hash) attrs.push(`<torznab:attr name="infohash" value="${release.info_hash}"/>`);
	if (release.magnet) attrs.push(`<torznab:attr name="magneturl" value="${escapeXml(release.magnet)}"/>`);
	attrs.push(`<torznab:attr name="downloadvolumefactor" value="0"/>`);
	attrs.push(`<torznab:attr name="uploadvolumefactor" value="1"/>`);
	attrs.push(`<torznab:attr name="tag" value="freeleech"/>`);
	attrs.push(`<torznab:attr name="tag" value="internal"/>`);

	if (category === "movies") {
		attrs.push(`<torznab:attr name="imdbtitle" value="${escapeXml(release.title)}"/>`);
		if (release.year !== null) attrs.push(`<torznab:attr name="imdbyear" value="${release.year}"/>`);
	}

	if (["series", "anime"].includes(category)) {
		attrs.push(`<torznab:attr name="tvtitle" value="${escapeXml(release.title)}"/>`);
		if (seasonNum !== null) attrs.push(`<torznab:attr name="season" value="${seasonNum}"/>`);
		if (episodeNum !== null) attrs.push(`<torznab:attr name="episode" value="${episodeNum}"/>`);
	}

	return `\t\t<item>
\t\t\t<title>${title}</title>
\t\t\t<guid>${escapeXml(detailUrl)}</guid>
\t\t\t<link>${escapeXml(detailUrl)}</link>
\t\t\t<comments>${escapeXml(detailUrl)}</comments>
\t\t\t<pubDate>${pubDate}</pubDate>
\t\t\t<category>${escapeXml(CATEGORY_LABEL[category])}</category>
\t\t\t<description>${title}</description>
\t\t\t<enclosure url="${escapeXml(downloadUrl)}" length="${size}" type="application/x-bittorrent"/>
${release.magnet ? `\t\t\t<enclosure url="${escapeXml(release.magnet)}" length="${size}" type="application/x-bittorrent;x-scheme-handler/magnet"/>` : ""}
\t\t\t${attrs.join("\n\t\t\t")}
\t\t</item>`;
}

async function searchResponse(db: Database, config: Config, req: Request, fn: string): Promise<Response> {
	const url = new URL(req.url);
	const q = url.searchParams.get("q") ?? "";
	const catParam = url.searchParams.get("cat");
	const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10);
	const limitRaw = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
	const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));

	let categories = torznabCatsToInternal(catParam);

	if (fn === "tvsearch") {
		const allowed: Category[] = ["series", "anime"];
		categories = categories.length > 0 ? categories.filter((c) => allowed.includes(c)) : allowed;
	} else if (fn === "movie") {
		const allowed: Category[] = ["movies"];
		categories = categories.length > 0 ? categories.filter((c) => allowed.includes(c)) : allowed;
	}

	const { items, total } = await db.listLatestForFeed({
		limit,
		offset,
		categories: categories.length > 0 ? categories : undefined,
		search: q.trim() || undefined,
	});

	const baseUrl = getBaseUrl(req);
	const frontendUrl = getFrontendBaseUrl(req, config);
	const releaseGroup = config.brand.releaseGroup;
	const channelTitle = `${releaseGroup} Torrents`;
	const channelDescription = `Torrents from ${releaseGroup}`;
	const feedSelfUrl = `${baseUrl}${url.pathname}${url.search}`;
	const itemsXml = items.map((r) => buildItem(r, baseUrl, frontendUrl, releaseGroup)).join("\n");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
\txmlns:atom="http://www.w3.org/2005/Atom"
\txmlns:torznab="http://torznab.com/schemas/2015/feed">
\t<channel>
\t\t<atom:link href="${escapeXml(feedSelfUrl)}" rel="self" type="application/rss+xml"/>
\t\t<title>${escapeXml(channelTitle)}</title>
\t\t<description>${escapeXml(channelDescription)}</description>
\t\t<link>${escapeXml(frontendUrl)}</link>
\t\t<language>en-us</language>
\t\t<category>search</category>
\t\t<lastBuildDate>${rfc822Date(Date.now())}</lastBuildDate>
${itemsXml}
\t</channel>
</rss>
<!-- total: ${total}, offset: ${offset}, limit: ${limit} -->`;

	return new Response(xml, {
		status: 200,
		headers: {
			"Content-Type": "application/xml",
			"Cache-Control": "public, max-age=60",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

export function registerTorznabRoutes(app: Web, services: Services): void {
	const { db, config } = services;

	app.get("/api/torznab", async (ctx) => {
		const t = new URL(ctx.req.url).searchParams.get("t");

		if (t === "caps") return capsResponse(config);
		if (t === null || t === "search" || t === "tvsearch" || t === "movie") {
			return searchResponse(db, config, ctx.req, t ?? "search");
		}
		if (t === "music" || t === "book") {
			return searchResponse(db, config, ctx.req, "search");
		}
		return errorResponse(202, `Function '${t}' is not supported`);
	});

	app.get("/api/rss", (ctx) => searchResponse(db, config, ctx.req, "search"));
}
