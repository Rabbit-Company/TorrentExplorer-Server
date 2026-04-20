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
}

const DEFAULT_CONFIG: Config = {
	server: {
		host: "0.0.0.0",
		port: 3000,
		proxy: "direct",
		token: "hux23to2isshfuyttzlyy6dfn2m9vtfdpew6iyjUbRqxKtXhgx",
	},
	donation: {},
	brand: {
		releaseGroup: "RabbitCompany",
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
	if (process.env.DATABASE_URL) config.database.url = process.env.DATABASE_URL;
	if (process.env.RELEASE_GROUP) config.brand.releaseGroup = process.env.RELEASE_GROUP;
	if (process.env.STORAGE_DRIVER) config.storage.driver = process.env.STORAGE_DRIVER as StorageDriver;

	return config;
}
