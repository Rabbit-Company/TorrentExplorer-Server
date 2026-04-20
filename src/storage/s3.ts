import { S3Client } from "bun";
import type { Storage } from "./types.ts";
import type { Config } from "../config.ts";

export class S3Storage implements Storage {
	private client: S3Client;

	constructor(s3: Config["storage"]["s3"]) {
		if (!s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
			throw new Error("S3 storage requires bucket, accessKeyId, and secretAccessKey in config");
		}
		this.client = new S3Client({
			endpoint: s3.endpoint || undefined,
			region: s3.region || "auto",
			bucket: s3.bucket,
			accessKeyId: s3.accessKeyId,
			secretAccessKey: s3.secretAccessKey,
		});
	}

	async save(key: string, data: Uint8Array): Promise<void> {
		await this.client.write(key, data, {
			type: "application/x-bittorrent",
		});
	}

	async read(key: string): Promise<Uint8Array> {
		const file = this.client.file(key);
		const buf = await file.bytes();
		return buf;
	}

	async exists(key: string): Promise<boolean> {
		try {
			return await this.client.exists(key);
		} catch {
			return false;
		}
	}

	async delete(key: string): Promise<void> {
		await this.client.delete(key);
	}
}
