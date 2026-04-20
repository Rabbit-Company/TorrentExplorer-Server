import { mkdir, readFile, unlink, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Storage } from "./types.ts";

export class LocalStorage implements Storage {
	private basePath: string;

	constructor(basePath: string) {
		this.basePath = resolve(basePath);
	}

	private resolveKey(key: string): string {
		// Prevent path traversal
		const full = resolve(join(this.basePath, key));
		if (!full.startsWith(this.basePath)) {
			throw new Error(`Invalid key: path traversal detected`);
		}
		return full;
	}

	async save(key: string, data: Uint8Array): Promise<void> {
		const path = this.resolveKey(key);
		await mkdir(dirname(path), { recursive: true });
		await Bun.write(path, data);
	}

	async read(key: string): Promise<Uint8Array> {
		const path = this.resolveKey(key);
		const buf = await readFile(path);
		return new Uint8Array(buf);
	}

	async exists(key: string): Promise<boolean> {
		try {
			await access(this.resolveKey(key));
			return true;
		} catch {
			return false;
		}
	}

	async delete(key: string): Promise<void> {
		await unlink(this.resolveKey(key));
	}
}
