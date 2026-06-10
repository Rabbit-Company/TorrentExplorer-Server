import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Logger } from "./logger";
import type { IpExtractionPreset } from "@rabbit-company/web-middleware/ip-extract";

export type StorageDriver = "local" | "s3";

const IP_EXTRACTION_PRESETS = ["direct", "cloudflare", "aws", "gcp", "azure", "vercel", "nginx", "development"] as const;

export function isIpExtractionPreset(value: unknown): value is IpExtractionPreset {
	return typeof value === "string" && IP_EXTRACTION_PRESETS.includes(value as IpExtractionPreset);
}

export interface Config {
	server: {
		host: string;
		port: number;
		proxy: IpExtractionPreset;
		token: string;
	};
	frontend: {
		url: string;
	};
	brand: {
		releaseGroup: string;
	};
	donation: {
		xmr?: string;
	};
	database: {
		url: string;
	};
	storage: {
		driver: StorageDriver;
		local: {
			path: string;
		};
		s3: {
			endpoint: string;
			region: string;
			bucket: string;
			accessKeyId: string;
			secretAccessKey: string;
		};
	};
	scraper: {
		enabled: boolean;
		intervalMinutes: number;
		udpTimeoutMs: number;
	};
	requests: {
		enabled: boolean;
		rateLimitWindowMinutes: number;
	};
	comments: {
		enabled: boolean;
		maxLength: number;
		rateLimit: {
			burst: number;
			refillIntervalMinutes: number;
		};
	};
	ntfy: {
		enabled: boolean;
		server: string;
		topic: string;
		/** Optional: token authentication (takes precedence over username/password). */
		token?: string;
		/** Optional: username/password authentication. */
		username?: string;
		password?: string;
	};
}

const DEFAULT_CONFIG: Config = {
	server: {
		host: "0.0.0.0",
		port: 3000,
		proxy: "direct",
		token: "hux23to2isshfuyttzlyy6dfn2m9vtfdpew6iyjUbRqxKtXhgx",
	},
	frontend: {
		url: "",
	},
	donation: {},
	brand: {
		releaseGroup: "RabbitCompany",
	},
	scraper: {
		enabled: true,
		intervalMinutes: 30,
		udpTimeoutMs: 5000,
	},
	requests: {
		enabled: true,
		rateLimitWindowMinutes: 60,
	},
	comments: {
		enabled: true,
		maxLength: 1000,
		rateLimit: { burst: 3, refillIntervalMinutes: 5 },
	},
	database: {
		url: "sqlite://data/torrents.db",
	},
	storage: {
		driver: "local",
		local: { path: "./torrents" },
		s3: {
			endpoint: "",
			region: "auto",
			bucket: "",
			accessKeyId: "",
			secretAccessKey: "",
		},
	},
	ntfy: {
		enabled: false,
		server: "https://ntfy.sh",
		topic: "torrent-explorer",
	},
};

function deepMerge<T>(base: T, overrides: Partial<T>): T {
	const result: any = Array.isArray(base) ? [...(base as any)] : { ...base };
	for (const key in overrides) {
		const overrideValue = overrides[key];
		const baseValue = (base as any)[key];
		if (overrideValue && typeof overrideValue === "object" && !Array.isArray(overrideValue) && baseValue && typeof baseValue === "object") {
			result[key] = deepMerge(baseValue, overrideValue as any);
		} else if (overrideValue !== undefined) {
			result[key] = overrideValue;
		}
	}
	return result;
}

export async function loadConfig(path: string = "./config.json"): Promise<Config> {
	const resolved = resolve(path);
	let fromFile: Partial<Config> = {};

	if (existsSync(resolved)) {
		try {
			const raw = await Bun.file(resolved).text();
			fromFile = JSON.parse(raw);
		} catch (err: any) {
			Logger.error(`Failed to parse config at ${resolved}:`, err);
			process.exit(1);
		}
	} else {
		Logger.warn(`No config found at ${resolved} (using defaults)`);
	}

	const config = deepMerge(DEFAULT_CONFIG, fromFile);

	// Environment variable overrides (useful for Docker)
	if (process.env.PORT) config.server.port = parseInt(process.env.PORT, 10);
	if (process.env.HOST) config.server.host = process.env.HOST;
	if (process.env.PROXY) config.server.proxy = isIpExtractionPreset(process.env.PROXY) ? process.env.PROXY : "direct";
	if (process.env.TOKEN) config.server.token = process.env.TOKEN;
	if (process.env.XMR) config.donation.xmr = process.env.XMR;
	if (process.env.FRONTEND_URL) config.frontend.url = process.env.FRONTEND_URL;
	if (process.env.DATABASE_URL) config.database.url = process.env.DATABASE_URL;
	if (process.env.RELEASE_GROUP) config.brand.releaseGroup = process.env.RELEASE_GROUP;
	if (process.env.STORAGE_DRIVER) config.storage.driver = process.env.STORAGE_DRIVER as StorageDriver;

	if (process.env.SCRAPER_ENABLED) config.scraper.enabled = process.env.SCRAPER_ENABLED === "true";
	if (process.env.SCRAPER_INTERVAL_MINUTES) {
		const n = parseInt(process.env.SCRAPER_INTERVAL_MINUTES, 10);
		if (Number.isFinite(n) && n > 0) config.scraper.intervalMinutes = n;
	}
	if (process.env.SCRAPER_UDP_TIMEOUT_MS) {
		const n = parseInt(process.env.SCRAPER_UDP_TIMEOUT_MS, 10);
		if (Number.isFinite(n) && n > 0) config.scraper.udpTimeoutMs = n;
	}

	if (process.env.REQUESTS_ENABLED) config.requests.enabled = process.env.REQUESTS_ENABLED === "true";
	if (process.env.REQUESTS_RATE_LIMIT_WINDOW_MINUTES) {
		const n = parseInt(process.env.REQUESTS_RATE_LIMIT_WINDOW_MINUTES, 10);
		if (Number.isFinite(n) && n > 0) config.requests.rateLimitWindowMinutes = n;
	}

	if (process.env.COMMENTS_ENABLED) config.comments.enabled = process.env.COMMENTS_ENABLED === "true";
	if (process.env.COMMENTS_MAX_LENGTH) {
		const n = parseInt(process.env.COMMENTS_MAX_LENGTH, 10);
		if (Number.isFinite(n) && n > 0) config.comments.maxLength = n;
	}
	if (process.env.COMMENTS_RATE_LIMIT_BURST) {
		const n = parseInt(process.env.COMMENTS_RATE_LIMIT_BURST, 10);
		if (Number.isFinite(n) && n > 0) config.comments.rateLimit.burst = n;
	}
	if (process.env.COMMENTS_RATE_LIMIT_REFILL_MINUTES) {
		const n = parseInt(process.env.COMMENTS_RATE_LIMIT_REFILL_MINUTES, 10);
		if (Number.isFinite(n) && n > 0) config.comments.rateLimit.refillIntervalMinutes = n;
	}

	if (process.env.NTFY_ENABLED) config.ntfy.enabled = process.env.NTFY_ENABLED === "true";
	if (process.env.NTFY_SERVER) config.ntfy.server = process.env.NTFY_SERVER;
	if (process.env.NTFY_TOPIC) config.ntfy.topic = process.env.NTFY_TOPIC;
	if (process.env.NTFY_TOKEN) config.ntfy.token = process.env.NTFY_TOKEN;
	if (process.env.NTFY_USERNAME) config.ntfy.username = process.env.NTFY_USERNAME;
	if (process.env.NTFY_PASSWORD) config.ntfy.password = process.env.NTFY_PASSWORD;

	return config;
}
