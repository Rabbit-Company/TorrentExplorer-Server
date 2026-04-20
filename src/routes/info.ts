import type { Web } from "@rabbit-company/web";
import type { Database } from "../database/index.ts";
import type { Config } from "../config.ts";
import { cache } from "@rabbit-company/web-middleware/cache";

interface Services {
	db: Database;
	config: Config;
}

export function registerInfoRoutes(app: Web, services: Services): void {
	const { db, config } = services;

	app.get("/api/info", cache({ ttl: 30, generateETags: false }), async (ctx) => {
		const stats = await db.stats();
		return ctx.json(
			{
				releaseGroup: config.brand.releaseGroup,
				stats,
				donation: { xmr: config.donation.xmr },
			},
			200,
			{ "Cache-Control": "public, max-age=30, s-maxage=30" },
		);
	});

	app.get("/api/health", (ctx) => ctx.json({ status: "ok" }));
}
