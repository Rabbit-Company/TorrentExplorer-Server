import { Web } from "@rabbit-company/web";
import { isIpExtractionPreset, loadConfig } from "./config.ts";
import { Database } from "./database/index.ts";
import type { Storage } from "./storage/types.ts";
import { LocalStorage } from "./storage/local.ts";
import { S3Storage } from "./storage/s3.ts";
import { registerInfoRoutes } from "./routes/info.ts";
import { registerCategoryRoutes } from "./routes/categories.ts";
import { registerTorrentRoutes } from "./routes/torrents.ts";
import { cors } from "@rabbit-company/web-middleware/cors";
import { logger } from "@rabbit-company/web-middleware/logger";
import { Logger } from "./logger.ts";
import { Algorithm, rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { ipExtract, type IpExtractionPreset } from "@rabbit-company/web-middleware/ip-extract";

async function main() {
	const configPath = process.env.CONFIG_PATH ?? "./config.json";
	const config = await loadConfig(configPath);

	// Database
	const db = await Database.init(config);
	Logger.info(`Database ready (${config.database.url.split("://")[0]})`);

	// Storage
	let storage: Storage;
	if (config.storage.driver === "s3") {
		storage = new S3Storage(config.storage.s3);
		Logger.info(`Storage: S3 (bucket=${config.storage.s3.bucket})`);
	} else {
		storage = new LocalStorage(config.storage.local.path);
		Logger.info(`Storage: Local (${config.storage.local.path})`);
	}

	let proxy: IpExtractionPreset = "direct";
	if (isIpExtractionPreset(config.server.proxy)) proxy = config.server.proxy;

	const app = new Web();

	app.use(ipExtract(proxy));
	app.use(
		rateLimit({
			algorithm: Algorithm.TOKEN_BUCKET,
			max: 50,
			refillRate: 1,
			refillInterval: 1000,
		}),
	);
	app.use(logger({ logger: Logger, preset: "minimal", logResponses: false }));
	app.use(cors());

	app.onError((err, ctx) => {
		Logger.error("Unhandled error:", err);
		return ctx.json({ error: "Internal server error" }, 500);
	});

	registerInfoRoutes(app, { db, config });
	registerCategoryRoutes(app, { db, storage, config });
	registerTorrentRoutes(app, { db, storage });

	app.get("/", (ctx) =>
		ctx.json({
			name: "torrent-explorer-server",
			releaseGroup: config.brand.releaseGroup,
			endpoints: [
				"GET  /api/info",
				"GET  /api/health",
				"GET  /api/{anime|movies|series}?page=&limit=&q=",
				"GET  /api/{anime|movies|series}/:id",
				"POST /api/{anime|movies|series}  (multipart: torrent + mediainfo)",
				"GET  /api/torrent/{anime|movies|series}/:id",
			],
		}),
	);

	app.listen({
		port: config.server.port,
		hostname: config.server.host,
	});

	Logger.info(`Listening on http://${config.server.host}:${config.server.port}`);
	Logger.info(`   Brand: ${config.brand.releaseGroup}`);
}

main().catch((err) => {
	Logger.error("Fatal error:", err);
	process.exit(1);
});
