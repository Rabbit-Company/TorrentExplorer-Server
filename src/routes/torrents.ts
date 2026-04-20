import type { Web } from "@rabbit-company/web";
import type { Database, Category } from "../database/index.ts";
import type { Storage } from "../storage/types.ts";
import { Logger } from "../logger.ts";

interface Services {
	db: Database;
	storage: Storage;
}

const CATEGORIES = new Set<Category>(["anime", "movies", "series"]);

export function registerTorrentRoutes(app: Web, services: Services): void {
	const { db, storage } = services;

	app.get("/api/torrent/:category/:id", async (ctx) => {
		const category = ctx.params.category as Category;
		if (!CATEGORIES.has(category)) {
			return ctx.json({ error: "Invalid category" }, 400);
		}
		const id = parseInt(ctx.params.id!, 10);
		if (!Number.isFinite(id)) {
			return ctx.json({ error: "Invalid id" }, 400);
		}

		const release = await db.findById(category, id);
		if (!release) {
			return ctx.json({ error: "Not found" }, 404);
		}

		let bytes: Uint8Array;
		try {
			bytes = await storage.read(release.torrent_file);
		} catch (err: any) {
			Logger.error("Storage read failed:", err);
			return ctx.json({ error: "Torrent file not available" }, 500);
		}

		const safeName = release.torrent_name.replace(/[\r\n"]/g, "");
		const encoded = encodeURIComponent(`${safeName}.torrent`);

		return new Response(Buffer.from(bytes), {
			status: 200,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Content-Type": "application/x-bittorrent",
				"Content-Disposition": `attachment; filename="${safeName}.torrent"; filename*=UTF-8''${encoded}`,
				"Content-Length": String(bytes.byteLength),
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	});
}
