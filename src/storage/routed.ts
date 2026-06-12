import type { Storage } from "./types.ts";

const MEDIA_PREFIX = "media/";

export class RoutedStorage implements Storage {
	constructor(
		private readonly torrents: Storage,
		private readonly media: Storage,
	) {}

	private route(key: string): { store: Storage; key: string } {
		return key.startsWith(MEDIA_PREFIX) ? { store: this.media, key: key.slice(MEDIA_PREFIX.length) } : { store: this.torrents, key };
	}

	save(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		const r = this.route(key);
		return r.store.save(r.key, data, contentType);
	}

	read(key: string): Promise<Uint8Array> {
		const r = this.route(key);
		return r.store.read(r.key);
	}

	exists(key: string): Promise<boolean> {
		const r = this.route(key);
		return r.store.exists(r.key);
	}

	delete(key: string): Promise<void> {
		const r = this.route(key);
		return r.store.delete(r.key);
	}

	async list(prefix: string): Promise<string[]> {
		if (prefix.startsWith(MEDIA_PREFIX)) {
			const keys = await this.media.list(prefix.slice(MEDIA_PREFIX.length));
			return keys.map((k) => MEDIA_PREFIX + k);
		}
		const keys = await this.torrents.list(prefix);
		// A short prefix ("" .. "media/") also covers the media key space.
		if (MEDIA_PREFIX.startsWith(prefix)) {
			keys.push(...(await this.media.list("")).map((k) => MEDIA_PREFIX + k));
		}
		return keys;
	}
}
